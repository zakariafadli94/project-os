import type { ManagedProviderObservation } from "../domain/managed-document";
import { isStagedArtifactWriteRequest, parseArtifactWriteRequest } from "../domain/artifact-write";
import {
  matchesStagedArtifactPayload,
  matchesStagedArtifactRollbackBackup,
  parseStagedArtifactRollbackEvidence,
  samePayload
} from "../artifacts/staged-publication";
import type { ProjectState } from "../domain/project-state";
import { DocumentLedgerRepository } from "../documents/repository";
import { sha256Text } from "../documents/hash";
import { WorkProductIdentityResolver } from "../documents/work-product-identity";
import { requireDropboxV1Evidence } from "../persistence/compatibility/dropbox-v1-evidence";
import {
  toProviderObjectMetadata,
  type LegacyDropboxFileMetadata
} from "../persistence/compatibility/dropbox-v1-legacy-data";
import {
  machineArtifactReceiptPath,
  machineArtifactRollbackEvidencePath,
  workspaceProjectRoot
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import type { CurrentMutationIntentRecord } from "../schema/mutation-gate";
import { MutationGateRepository } from "./repository";

export type MutationGateClassification =
  | { kind: "not_final_zone" }
  | { kind: "governed_current"; documentId?: string; requestId?: string }
  | { kind: "governed_inflight"; requestId: string }
  | { kind: "external_candidate" };

type StrictZone =
  | { kind: "working" | "review" | "deliverables"; logicalPath: string }
  | { kind: "artifacts" };

export class MutationGateClassifier {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly documents: DocumentLedgerRepository;
  private readonly workProducts: WorkProductIdentityResolver;
  private readonly mutations: MutationGateRepository;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.documents = new DocumentLedgerRepository(this.runtime);
    this.workProducts = new WorkProductIdentityResolver(this.runtime);
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

    const intents = await this.mutations.listArtifactIntentsForDestination(state.project_id, path);
    if (intents.length > 0) {
      for (const intent of intents) {
        const frozen = parseArtifactWriteRequest(JSON.parse(intent.request_json));
        if (!isStagedArtifactWriteRequest(frozen)) continue;
        const publishedPayload = matchesStagedArtifactPayload(frozen, metadata)
          && intentExplainsProviderChange(intent, metadata, this.runtime.providerId);
        const restoredPayload = await this.matchesActiveRollbackEvidence(intent, metadata);
        if (publishedPayload || restoredPayload) {
          return { kind: "governed_inflight", requestId: intent.request_id };
        }
      }

      const inlineIntents = intents.filter((intent) => {
        const frozen = parseArtifactWriteRequest(JSON.parse(intent.request_json));
        return !isStagedArtifactWriteRequest(frozen);
      });
      if (inlineIntents.length > 0) {
        const visible = await this.runtime.objects.readText(path);
        if (visible !== null) {
          const contentSha256 = await sha256Text(visible);
          const exact = inlineIntents.find((intent) =>
            intent.expected_content_sha256 === contentSha256
            && intentExplainsProviderChange(intent, metadata, this.runtime.providerId)
          );
          if (exact) return { kind: "governed_inflight", requestId: exact.request_id };
        }
      }
    }

    if (zone.kind === "working" || zone.kind === "review" || zone.kind === "deliverables") {
      const resolution = await this.workProducts.resolveVisible(
        state.project_id,
        zone.logicalPath,
        path,
        metadata
      );
      if (resolution.kind === "resolved" && resolution.head?.kind === "work_product") {
        const head = resolution.head;
        const versionId = zone.kind === "working"
          ? head.working_version_id
          : zone.kind === "review"
            ? head.review_version_id
            : head.published_version_id;
        const observation = zone.kind === "working"
          ? head.provider?.working
          : zone.kind === "review"
            ? head.provider?.review
            : head.provider?.published;

        if (versionId && observation) {
          if (zone.kind !== "deliverables" && observation.file_id === evidence.file_id) {
            // WORKING/REVIEW are editable collaboration zones. A new provider
            // revision of the same governed object is captured by the document
            // reconciler as a new immutable version rather than treated as an
            // ungoverned competing head.
            return { kind: "governed_current", documentId: resolution.documentId };
          }
          if (sameObservation(observation, metadata)) {
            return { kind: "governed_current", documentId: resolution.documentId };
          }
          const version = await this.documents.readVersion(state.project_id, resolution.documentId, versionId);
          if (
            version
            && version.provider_path === path
            && version.provider_file_id === evidence.file_id
            && version.provider_rev === evidence.rev
            && version.provider_content_hash === evidence.content_hash
            && version.size === evidence.size
          ) {
            return { kind: "governed_current", documentId: resolution.documentId };
          }
        }
      }
      // Unknown files, orphaned identities and a second visible path carrying an
      // existing document_id are all deterministic external candidates. We do
      // not infer lineage from filenames such as v0.1/v0.2.
      return { kind: "external_candidate" };
    }

    return { kind: "external_candidate" };
  }

  private async matchesActiveRollbackEvidence(
    intent: CurrentMutationIntentRecord,
    metadata: ProviderObjectMetadata
  ): Promise<boolean> {
    if (intent.mode !== "replace" || intent.provider_precondition.kind !== "existing") return false;
    if (await this.runtime.objects.readText(machineArtifactReceiptPath(intent.request_id)) !== null) return false;
    const raw = await this.runtime.objects.readText(machineArtifactRollbackEvidencePath(intent.request_id));
    if (raw === null) return false;
    const evidence = parseStagedArtifactRollbackEvidence(JSON.parse(raw));
    if (
      evidence.project_id !== intent.project_id
      || evidence.request_id !== intent.request_id
      || evidence.destination_path !== intent.destination_path
      || evidence.provider_id !== this.runtime.providerId
    ) return false;
    const backup = await this.runtime.objects.getMetadata(evidence.backup.path);
    if (!backup || !matchesStagedArtifactRollbackBackup(evidence, backup)) return false;
    return samePayload(backup, metadata);
  }
}

function intentExplainsProviderChange(
  intent: CurrentMutationIntentRecord,
  metadata: ProviderObjectMetadata,
  providerId: string
): boolean {
  const precondition = intent.provider_precondition;
  if (precondition.provider_id !== providerId) return false;
  if (precondition.kind === "absent") return true;

  if (providerId === "dropbox") {
    const evidence = requireDropboxV1Evidence(metadata);
    return evidence.file_id !== precondition.object_id
      || evidence.rev !== precondition.revision_token
      || evidence.content_hash !== precondition.integrity_hash.value
      || precondition.integrity_hash.algorithm !== "dropbox-content-hash"
      || evidence.size !== precondition.size;
  }

  return metadata.objectId !== precondition.object_id
    || metadata.revisionToken !== precondition.revision_token
    || metadata.integrityHash?.algorithm !== precondition.integrity_hash.algorithm
    || metadata.integrityHash?.value !== precondition.integrity_hash.value
    || metadata.size !== precondition.size;
}

function strictZone(state: ProjectState, path: string): StrictZone | null {
  const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
  if (!path.startsWith(root)) return null;
  const relative = path.slice(root.length);
  if (relative.startsWith("WORKING/") && relative.length > "WORKING/".length) {
    return { kind: "working", logicalPath: relative.slice("WORKING/".length) };
  }
  if (relative.startsWith("REVIEW/") && relative.length > "REVIEW/".length) {
    return { kind: "review", logicalPath: relative.slice("REVIEW/".length) };
  }
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
