import { documentIdFor, type ManagedProviderObservation } from "../domain/managed-document";
import type { MutationIntentRecord } from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import type { DropboxFileMetadata, DropboxTransport } from "../dropbox/client";
import { workspaceProjectRoot } from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { DocumentLedgerRepository } from "../documents/repository";
import { sha256Text } from "../documents/hash";
import { MutationGateRepository } from "./repository";

export type MutationGateClassification =
  | { kind: "not_final_zone" }
  | { kind: "governed_current"; documentId?: string; requestId?: string }
  | { kind: "governed_inflight"; requestId: string }
  | { kind: "external_candidate" };

export class MutationGateClassifier {
  private readonly transport: ResilientDropboxTransport;
  private readonly documents: DocumentLedgerRepository;
  private readonly mutations: MutationGateRepository;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
    this.documents = new DocumentLedgerRepository(transport);
    this.mutations = new MutationGateRepository(transport);
  }

  async classify(
    state: ProjectState,
    path: string,
    metadata: DropboxFileMetadata
  ): Promise<MutationGateClassification> {
    const zone = strictZone(state, path);
    if (!zone) return { kind: "not_final_zone" };
    if (metadata.path !== path) throw new Error(`Mutation classification metadata path mismatch: ${metadata.path} != ${path}`);

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
          && version.provider_file_id === metadata.id
          && version.provider_rev === metadata.rev
          && version.provider_content_hash === metadata.content_hash
          && version.size === metadata.size
        ) {
          return { kind: "governed_current", documentId };
        }
      }
    }

    const intents = await this.mutations.listArtifactIntentsForDestination(state.project_id, path);
    if (intents.length > 0) {
      const visible = await this.transport.download(path);
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

function intentExplainsProviderChange(intent: MutationIntentRecord, metadata: DropboxFileMetadata): boolean {
  if (intent.provider_precondition.kind === "absent") return true;
  return metadata.id !== intent.provider_precondition.file_id
    || metadata.rev !== intent.provider_precondition.rev
    || metadata.content_hash !== intent.provider_precondition.content_hash
    || metadata.size !== intent.provider_precondition.size;
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
  return null;
}

function sameObservation(value: ManagedProviderObservation | undefined, metadata: DropboxFileMetadata): boolean {
  return !!value
    && value.path === metadata.path
    && value.file_id === metadata.id
    && value.rev === metadata.rev
    && value.content_hash === metadata.content_hash
    && value.size === metadata.size;
}
