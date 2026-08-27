import { documentIdFor, type ManagedProviderObservation } from "../domain/managed-document";
import type { MutationIntentRecord } from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import { DocumentLedgerRepository } from "../documents/repository";
import { sha256Text } from "../documents/hash";
import { requireDropboxV1Evidence } from "../persistence/compatibility/dropbox-v1-evidence";
import {
  toProviderObjectMetadata,
  type LegacyDropboxFileMetadata
} from "../persistence/compatibility/dropbox-v1-legacy-data";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { MutationGateRepository } from "./repository";

export type MutationGateClassification =
  | { kind: "not_final_zone" }
  | { kind: "governed_current"; documentId?: string; requestId?: string }
  | { kind: "governed_inflight"; requestId: string }
  | { kind: "external_candidate" };

export class MutationGateClassifier {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly documents: DocumentLedgerRepository;
  private readonly mutations: MutationGateRepository;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.documents = new DocumentLedgerRepository(this.runtime);
    this.mutations = new MutationGateRepository(this.runtime);
  }

  async classify(
    state: ProjectState,
    path: string,
    metadataInput: ProviderObjectMetadata | LegacyDropboxFileMetadata
  ): Promise<MutationGateClassification> {
    const zone = strictZone(state, path);
    if (!zone) return { kind: "not_final_zone" };

    const metadata = toProviderObjectMetadata(metadataInput);
    if (metadata.path !== path) {
      throw new Error(`Mutation classification metadata path mismatch: ${metadata.path} != ${path}`);
    }
    const evidence = requireDropboxV1Evidence(metadata);

    if (zone.kind === "deliverables") {
      const documentId = await documentIdFor(state.project_id, zone.logicalPath);
      const head = await this.documents.readHead(state.project_id, documentId);
      if (head?.kind === "work_product" && head.published_version_id) {
        if (sameObservation(head.provider?.published, metadata)) {
          return { kind: "governed_current", documentId };
        }
        const version = await this.documents.readVersion(state.project_id, documentId, head.published_version_id);
        if (
          version
          && version.provider_path === path
          && version.provider_file_id === evidence.file_id
          && version.provider_rev === evidence.rev
          && version.provider_content_hash === evidence.content_hash
          && version.size === evidence.size
        ) {
          return { kind: "governed_current", documentId };
        }
      }
    }

    const intents = await this.mutations.listArtifactIntentsForDestination(state.project_id, path);
    if (intents.length > 0) {
      const visible = await this.runtime.objects.readText(path);
      if (visible !== null) {
        const contentSha256 = await sha256Text(visible);
        const exact = intents.find((intent) =>
          intent.expected_content_sha256 === contentSha256 && intentExplainsProviderChange(intent, metadata)
        );
        if (exact) return { kind: "governed_inflight", requestId: exact.request_id };
      }
    }

    return { kind: "external_candidate" };
  }
}

function intentExplainsProviderChange(intent: MutationIntentRecord, metadata: ProviderObjectMetadata): boolean {
  if (intent.provider_precondition.kind === "absent") return true;
  const evidence = requireDropboxV1Evidence(metadata);
  return evidence.file_id !== intent.provider_precondition.file_id
    || evidence.rev !== intent.provider_precondition.rev
    || evidence.content_hash !== intent.provider_precondition.content_hash
    || evidence.size !== intent.provider_precondition.size;
}

function strictZone(
  state: ProjectState,
  path: string
): { kind: "deliverables"; logicalPath: string } | { kind: "artifacts" } | null {
  const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
  if (!path.startsWith(root)) return null;
  const relative = path.slice(root.length);
  if (relative.startsWith("DELIVERABLES/") && relative.length > "DELIVERABLES/".length) {
    return { kind: "deliverables", logicalPath: relative.slice("DELIVERABLES/".length) };
  }
  if (relative.startsWith("ARTIFACTS/") && relative.length > "ARTIFACTS/".length) {
    return { kind: "artifacts" };
  }
  if (Object.values(state.artifact_routes).some((route) =>
    routeTargetIsStrict(route.target_prefix) && pathMatchesPrefix(relative, route.target_prefix)
  )) {
    return { kind: "artifacts" };
  }
  return null;
}

function routeTargetIsStrict(prefix: string): boolean {
  return prefix !== "REFERENCES" && !prefix.startsWith("REFERENCES/");
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function sameObservation(value: ManagedProviderObservation | undefined, metadata: ProviderObjectMetadata): boolean {
  if (!value) return false;
  const evidence = requireDropboxV1Evidence(metadata);
  return value.path === metadata.path
    && value.file_id === evidence.file_id
    && value.rev === evidence.rev
    && value.content_hash === evidence.content_hash
    && value.size === evidence.size;
}
