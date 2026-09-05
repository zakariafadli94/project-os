import type { InlineArtifactWriteRequest } from "../domain/artifact-write";
import {
  documentIdFor,
  documentIdForProviderFile,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import { ArtifactContentConflictError } from "../persistence/repository-core";
import { resolveArtifactDestination, type ResolvedArtifactDestination } from "../persistence/artifact-routing";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../persistence/compatibility/dropbox-v1-evidence";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { DocumentLedgerRepository } from "./repository";
import { sha256Text } from "./hash";

type ManagedArtifactDestination =
  | { zone: "deliverables"; path: string; logicalPath: string }
  | { zone: "references"; path: string; logicalPath: string; collectionPath: string };

export async function ensureLegacyArtifactRequestProvenance(
  state: ProjectState,
  request: InlineArtifactWriteRequest,
  input: PersistenceInput
): Promise<void> {
  const destination = classifyManagedDestination(state, request, resolveArtifactDestination(state, request.relative_path));
  if (!destination) return;

  const runtime = asProjectOsPersistence(input);
  const ledger = new DocumentLedgerRepository(runtime);
  const metadata = await runtime.objects.getMetadata(destination.path);
  if (!metadata) throw new ArtifactContentConflictError(destination.path);
  const visible = await runtime.objects.readText(destination.path);
  if (visible !== request.content) throw new ArtifactContentConflictError(destination.path);
  const evidence = requireDropboxV1Evidence(metadata);
  const payloadPath = await ledger.storeTextPayload(request.project_id, request.content_sha256, request.content);

  if (destination.zone === "deliverables") {
    const documentId = await documentIdFor(request.project_id, destination.logicalPath);
    const versionId = await legacyVersionIdFor(request.request_id, "published");
    const replay = await ledger.readVersion(request.project_id, documentId, versionId);
    if (replay) {
      assertReplay(replay, request, destination.path);
      return;
    }
    const head = await readOrRestoreHead(ledger, request.project_id, documentId);
    if (head && (head.kind !== "work_product" || head.working_version_id || head.review_version_id)) {
      throw new ArtifactContentConflictError(destination.path);
    }
    const record: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      version_id: versionId,
      ...(head?.published_version_id ? { parent_version_id: head.published_version_id } : {}),
      kind: "work_product",
      stage: "published",
      logical_path: destination.logicalPath,
      source: "legacy_artifact_api",
      created_at: metadata.modifiedAt ?? new Date().toISOString(),
      immutable_payload_path: payloadPath,
      content_sha256: request.content_sha256,
      provider_content_hash: evidence.content_hash,
      provider_file_id: evidence.file_id,
      provider_rev: evidence.rev,
      provider_path: destination.path,
      size: evidence.size,
      request_id: request.request_id
    };
    await ledger.writeVersion(record);
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      kind: "work_product",
      logical_path: destination.logicalPath,
      published_version_id: versionId,
      provider: { published: observation(destination.path, metadata) },
      reconciliation_status: "clean"
    });
    return;
  }

  const binding = await ledger.readProviderFileBinding(request.project_id, evidence.file_id);
  const documentId = binding?.document_id ?? await documentIdForProviderFile(request.project_id, evidence.file_id);
  const versionId = await legacyVersionIdFor(request.request_id, "reference");
  const replay = await ledger.readVersion(request.project_id, documentId, versionId);
  if (replay) {
    assertReplay(replay, request, destination.path);
    return;
  }
  const head = await readOrRestoreHead(ledger, request.project_id, documentId);
  if (head && head.kind !== "reference") throw new ArtifactContentConflictError(destination.path);

  const record: DocumentVersionRecord = {
    schema_version: "1.0",
    project_id: request.project_id,
    document_id: documentId,
    version_id: versionId,
    ...(head?.reference_version_id ? { parent_version_id: head.reference_version_id } : {}),
    kind: "reference",
    stage: "reference",
    logical_path: destination.logicalPath,
    source: "legacy_artifact_api",
    created_at: metadata.modifiedAt ?? new Date().toISOString(),
    immutable_payload_path: payloadPath,
    content_sha256: request.content_sha256,
    provider_content_hash: evidence.content_hash,
    provider_file_id: evidence.file_id,
    provider_rev: evidence.rev,
    provider_path: destination.path,
    size: evidence.size,
    request_id: request.request_id
  };
  await ledger.writeVersion(record);
  await ledger.writeHead({
    schema_version: "1.0",
    project_id: request.project_id,
    document_id: documentId,
    kind: "reference",
    logical_path: destination.logicalPath,
    collection_path: destination.collectionPath,
    reference_version_id: versionId,
    provider: { reference: observation(destination.path, metadata) },
    reconciliation_status: "clean"
  });
  await ledger.writeProviderFileBinding({
    schema_version: "1.0",
    project_id: request.project_id,
    provider_file_id: evidence.file_id,
    document_id: documentId
  });
  await ledger.writeReferenceFingerprint({
    schema_version: "1.0",
    project_id: request.project_id,
    provider_content_hash: evidence.content_hash,
    document_id: documentId,
    version_id: versionId
  });
}

async function readOrRestoreHead(
  ledger: DocumentLedgerRepository,
  projectId: string,
  documentId: string
): Promise<ManagedDocumentHead | null> {
  return await ledger.readHead(projectId, documentId) ?? await ledger.restoreHeadFromVersions(projectId, documentId);
}

function assertReplay(record: DocumentVersionRecord, request: InlineArtifactWriteRequest, path: string): void {
  if (
    record.source !== "legacy_artifact_api"
    || record.content_sha256 !== request.content_sha256
    || record.request_id !== request.request_id
  ) {
    throw new ArtifactContentConflictError(path);
  }
}

function classifyManagedDestination(
  state: ProjectState,
  request: InlineArtifactWriteRequest,
  destination: ResolvedArtifactDestination
): ManagedArtifactDestination | null {
  const root = workspaceProjectRoot(state.project_id, state.slug);
  const deliverablesPrefix = `${root}/DELIVERABLES/`;
  if (destination.path.startsWith(deliverablesPrefix)) {
    return {
      zone: "deliverables",
      path: destination.path,
      logicalPath: destination.path.slice(deliverablesPrefix.length)
    };
  }

  const referencesPrefix = `${root}/REFERENCES/`;
  if (!destination.path.startsWith(referencesPrefix)) return null;
  const physicalRelative = destination.path.slice(referencesPrefix.length);
  const targetPrefix = destination.route?.target_prefix;
  const collectionPath = targetPrefix === "REFERENCES"
    ? "UNCLASSIFIED"
    : targetPrefix?.startsWith("REFERENCES/")
      ? targetPrefix.slice("REFERENCES/".length)
      : "UNCLASSIFIED";
  const collectionPrefix = collectionPath === "UNCLASSIFIED" ? "" : `${collectionPath}/`;
  const physicalLogicalPath = collectionPrefix && physicalRelative.startsWith(collectionPrefix)
    ? physicalRelative.slice(collectionPrefix.length)
    : physicalRelative;
  const logicalPath = destination.route && request.relative_path.startsWith(`${destination.route.source_prefix}/`)
    ? request.relative_path.slice(destination.route.source_prefix.length + 1)
    : physicalLogicalPath;

  return {
    zone: "references",
    path: destination.path,
    logicalPath: logicalPath || physicalLogicalPath,
    collectionPath
  };
}

async function legacyVersionIdFor(requestId: string, stage: "reference" | "published"): Promise<string> {
  const digest = await sha256Text(`${requestId}\n${stage}`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

function observation(path: string, metadata: ProviderObjectMetadata): ManagedProviderObservation {
  return toManagedProviderObservation({ ...metadata, path });
}
