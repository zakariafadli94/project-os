import type { ArtifactWriteRequest } from "../domain/artifact-write";
import {
  documentIdFor,
  documentIdForProviderFile,
  externalVersionIdFor,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import {
  resolveArtifactDestination,
  type ResolvedArtifactDestination
} from "../dropbox/artifact-routing";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../dropbox/client";
import { workspaceProjectRoot } from "../dropbox/layout";
import { ArtifactContentConflictError } from "../dropbox/repository";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { ManagedDocumentBootstrapper } from "./bootstrap";
import { sha256Text } from "./hash";
import { DocumentLedgerRepository } from "./repository";

export type LegacyManagedArtifactWriteResult = "written" | "idempotent";

type ManagedArtifactDestination =
  | { zone: "deliverables"; path: string; logicalPath: string; archivePath?: string }
  | { zone: "references"; path: string; logicalPath: string; collectionPath: string; archivePath?: string };

export class LegacyArtifactDocumentWriter {
  private readonly transport: ResilientDropboxTransport;
  private readonly ledger: DocumentLedgerRepository;
  private readonly bootstrapper: ManagedDocumentBootstrapper;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
    this.ledger = new DocumentLedgerRepository(transport);
    this.bootstrapper = new ManagedDocumentBootstrapper(transport);
  }

  async writeIfManaged(
    state: ProjectState,
    request: ArtifactWriteRequest
  ): Promise<LegacyManagedArtifactWriteResult | null> {
    if (request.project_id !== state.project_id) throw new Error("Artifact request project_id does not match project state");
    if (state.status === "archived") throw new Error("Archived projects do not accept artifact writes");

    const destination = resolveArtifactDestination(state, request.relative_path);
    const managed = classifyManagedDestination(state, request, destination);
    if (!managed) return null;

    const payloadPath = await this.ledger.storeTextPayload(request.project_id, request.content_sha256, request.content);
    return managed.zone === "deliverables"
      ? this.writePublished(state, request, managed, payloadPath)
      : this.writeReference(state, request, managed, payloadPath);
  }

  private async writePublished(
    state: ProjectState,
    request: ArtifactWriteRequest,
    destination: Extract<ManagedArtifactDestination, { zone: "deliverables" }>,
    payloadPath: string
  ): Promise<LegacyManagedArtifactWriteResult> {
    const documentId = await documentIdFor(request.project_id, destination.logicalPath);
    const versionId = await legacyVersionIdFor(request.request_id, "published");
    const replay = await this.ledger.readVersion(request.project_id, documentId, versionId);
    if (replay) return this.validateReplay(replay, request, destination.path);

    let metadata = await this.metadataMaybe(destination.path);
    let head = await this.readOrRestoreHead(request.project_id, documentId);

    if (metadata && !head) {
      head = (await this.bootstrapper.bootstrapExistingManagedPath(
        state,
        destination.path,
        metadata,
        "published"
      )).head;
    }

    if (head && head.kind !== "work_product") throw new ArtifactContentConflictError(destination.path);
    if (head?.working_version_id || head?.review_version_id) throw new ArtifactContentConflictError(destination.path);

    const currentContent = metadata ? await this.transport.download(destination.path) : null;
    if (metadata && currentContent === null) throw new ArtifactContentConflictError(destination.path);

    if (metadata && currentContent === request.content) {
      if (
        sameObservation(head?.provider?.published, metadata)
        && await this.activeVersionProvesLegacyContent(head, "published", request.content_sha256)
      ) return "idempotent";
      await this.persistPublishedVersion(request, destination, payloadPath, documentId, versionId, head, metadata);
      return "idempotent";
    }

    if (metadata && request.mode === "create") throw new ArtifactContentConflictError(destination.path);
    if (!metadata && head?.published_version_id) throw new ArtifactContentConflictError(destination.path);

    if (metadata) {
      await this.assertPublishedBaseline(head, metadata, destination.path);
      if (destination.archivePath && currentContent !== null) {
        await this.archiveExisting(destination.archivePath, currentContent);
      }
      metadata = await this.conditionalReplace(destination.path, request.content, metadata.rev);
    } else {
      metadata = await this.createVisible(destination.path, request.content);
    }

    await this.persistPublishedVersion(request, destination, payloadPath, documentId, versionId, head, metadata);
    return "written";
  }

  private async writeReference(
    state: ProjectState,
    request: ArtifactWriteRequest,
    destination: Extract<ManagedArtifactDestination, { zone: "references" }>,
    payloadPath: string
  ): Promise<LegacyManagedArtifactWriteResult> {
    let metadata = await this.metadataMaybe(destination.path);
    let documentId: string;
    let head: ManagedDocumentHead | null = null;

    if (metadata) {
      const binding = await this.ledger.readProviderFileBinding(request.project_id, metadata.id);
      documentId = binding?.document_id ?? await documentIdForProviderFile(request.project_id, metadata.id);
      head = await this.readOrRestoreHead(request.project_id, documentId);
      if (!head) head = await this.adoptExistingReference(state, destination, metadata, documentId);
    } else {
      documentId = "";
    }

    const knownDocumentId = documentId || undefined;
    const versionId = await legacyVersionIdFor(request.request_id, "reference");
    if (knownDocumentId) {
      const replay = await this.ledger.readVersion(request.project_id, knownDocumentId, versionId);
      if (replay) return this.validateReplay(replay, request, destination.path);
    }

    if (head && head.kind !== "reference") throw new ArtifactContentConflictError(destination.path);
    const currentContent = metadata ? await this.transport.download(destination.path) : null;
    if (metadata && currentContent === null) throw new ArtifactContentConflictError(destination.path);

    if (metadata && currentContent === request.content) {
      if (
        sameObservation(head?.provider?.reference, metadata)
        && await this.activeVersionProvesLegacyContent(head, "reference", request.content_sha256)
      ) return "idempotent";
      await this.persistReferenceVersion(
        request,
        destination,
        payloadPath,
        knownDocumentId!,
        versionId,
        head,
        metadata
      );
      return "idempotent";
    }

    if (metadata && request.mode === "create") throw new ArtifactContentConflictError(destination.path);
    if (!metadata && head?.reference_version_id) throw new ArtifactContentConflictError(destination.path);

    if (metadata) {
      await this.assertReferenceBaseline(head, metadata, destination.path);
      if (destination.archivePath && currentContent !== null) {
        await this.archiveExisting(destination.archivePath, currentContent);
      }
      metadata = await this.conditionalReplace(destination.path, request.content, metadata.rev);
      documentId = knownDocumentId!;
    } else {
      metadata = await this.createVisible(destination.path, request.content);
      documentId = await documentIdForProviderFile(request.project_id, metadata.id);
      head = await this.readOrRestoreHead(request.project_id, documentId);
    }

    await this.persistReferenceVersion(request, destination, payloadPath, documentId, versionId, head, metadata);
    return "written";
  }

  private async adoptExistingReference(
    state: ProjectState,
    destination: Extract<ManagedArtifactDestination, { zone: "references" }>,
    metadata: DropboxFileMetadata,
    documentId: string
  ): Promise<ManagedDocumentHead> {
    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      const snapshot = await this.ledger.snapshotProviderFile(
        state.project_id,
        documentId,
        versionId,
        destination.path,
        metadata
      );
      await this.ledger.writeVersion({
        schema_version: "1.0",
        project_id: state.project_id,
        document_id: documentId,
        version_id: versionId,
        kind: "reference",
        stage: "reference",
        logical_path: destination.logicalPath,
        source: "external_human",
        created_at: metadata.server_modified ?? new Date().toISOString(),
        immutable_payload_path: snapshot.path,
        provider_content_hash: metadata.content_hash,
        provider_file_id: metadata.id,
        provider_rev: metadata.rev,
        provider_path: destination.path,
        size: metadata.size
      });
    }
    const head: ManagedDocumentHead = {
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      kind: "reference",
      logical_path: destination.logicalPath,
      collection_path: destination.collectionPath,
      reference_version_id: versionId,
      provider: { reference: observation(destination.path, metadata) },
      reconciliation_status: "clean"
    };
    await this.ledger.writeHead(head);
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_file_id: metadata.id,
      document_id: documentId
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_content_hash: metadata.content_hash,
      document_id: documentId,
      version_id: versionId
    });
    return head;
  }

  private async persistPublishedVersion(
    request: ArtifactWriteRequest,
    destination: Extract<ManagedArtifactDestination, { zone: "deliverables" }>,
    payloadPath: string,
    documentId: string,
    versionId: string,
    head: ManagedDocumentHead | null,
    metadata: DropboxFileMetadata
  ): Promise<void> {
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
      created_at: metadata.server_modified ?? new Date().toISOString(),
      immutable_payload_path: payloadPath,
      content_sha256: request.content_sha256,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: destination.path,
      size: metadata.size,
      request_id: request.request_id
    };
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      kind: "work_product",
      logical_path: destination.logicalPath,
      published_version_id: versionId,
      provider: { published: observation(destination.path, metadata) },
      reconciliation_status: "clean"
    });
  }

  private async persistReferenceVersion(
    request: ArtifactWriteRequest,
    destination: Extract<ManagedArtifactDestination, { zone: "references" }>,
    payloadPath: string,
    documentId: string,
    versionId: string,
    head: ManagedDocumentHead | null,
    metadata: DropboxFileMetadata
  ): Promise<void> {
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
      created_at: metadata.server_modified ?? new Date().toISOString(),
      immutable_payload_path: payloadPath,
      content_sha256: request.content_sha256,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: destination.path,
      size: metadata.size,
      request_id: request.request_id
    };
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
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
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: request.project_id,
      provider_file_id: metadata.id,
      document_id: documentId
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: request.project_id,
      provider_content_hash: metadata.content_hash,
      document_id: documentId,
      version_id: versionId
    });
  }

  private async readOrRestoreHead(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    return await this.ledger.readHead(projectId, documentId)
      ?? await this.ledger.restoreHeadFromVersions(projectId, documentId);
  }

  private async activeVersionProvesLegacyContent(
    head: ManagedDocumentHead | null,
    stage: "reference" | "published",
    contentSha256: string
  ): Promise<boolean> {
    if (!head) return false;
    const activeVersionId = stage === "published" ? head.published_version_id : head.reference_version_id;
    if (!activeVersionId) return false;
    const active = await this.ledger.readVersion(head.project_id, head.document_id, activeVersionId);
    return active?.source === "legacy_artifact_api" && active.content_sha256 === contentSha256;
  }

  private async assertPublishedBaseline(
    head: ManagedDocumentHead | null,
    metadata: DropboxFileMetadata,
    path: string
  ): Promise<void> {
    if (!head?.published_version_id) throw new ArtifactContentConflictError(path);
    const observationValue = head.provider?.published;
    if (observationValue && !sameObservation(observationValue, metadata)) throw new ArtifactContentConflictError(path);
    if (!observationValue) {
      const version = await this.ledger.readVersion(head.project_id, head.document_id, head.published_version_id);
      if (!version?.provider_rev || version.provider_rev !== metadata.rev) throw new ArtifactContentConflictError(path);
    }
  }

  private async assertReferenceBaseline(
    head: ManagedDocumentHead | null,
    metadata: DropboxFileMetadata,
    path: string
  ): Promise<void> {
    if (!head?.reference_version_id) throw new ArtifactContentConflictError(path);
    const observationValue = head.provider?.reference;
    if (observationValue && !sameObservation(observationValue, metadata)) throw new ArtifactContentConflictError(path);
    if (!observationValue) {
      const version = await this.ledger.readVersion(head.project_id, head.document_id, head.reference_version_id);
      if (!version?.provider_rev || version.provider_rev !== metadata.rev) throw new ArtifactContentConflictError(path);
    }
  }

  private async createVisible(path: string, content: string): Promise<DropboxFileMetadata> {
    try {
      await this.transport.upload(path, content, "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const current = await this.transport.download(path);
      if (current !== content) throw new ArtifactContentConflictError(path);
    }
    const metadata = await this.metadataMaybe(path);
    if (!metadata) throw new Error(`Legacy managed artifact provider metadata missing after create: ${path}`);
    const persisted = await this.transport.download(path);
    if (persisted !== content) throw new ArtifactContentConflictError(path);
    return metadata;
  }

  private async conditionalReplace(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    if (!this.transport.uploadConditional) throw new Error("Dropbox transport does not support legacy managed artifact CAS");
    try {
      return await this.transport.uploadConditional(path, content, expectedRev);
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      throw new ArtifactContentConflictError(path);
    }
  }

  private async metadataMaybe(path: string): Promise<DropboxFileMetadata | null> {
    if (!this.transport.getMetadata) throw new Error("Dropbox transport does not support legacy managed artifact metadata");
    return this.transport.getMetadata(path);
  }

  private validateReplay(
    record: DocumentVersionRecord,
    request: ArtifactWriteRequest,
    path: string
  ): LegacyManagedArtifactWriteResult {
    if (record.source !== "legacy_artifact_api" || record.content_sha256 !== request.content_sha256 || record.request_id !== request.request_id) {
      throw new ArtifactContentConflictError(path);
    }
    return "idempotent";
  }

  private async archiveExisting(basePath: string, content: string): Promise<void> {
    const hash = await sha256Text(content);
    const slash = basePath.lastIndexOf("/");
    const dot = basePath.lastIndexOf(".");
    const hasExtension = dot > slash;
    const archivePath = hasExtension
      ? `${basePath.slice(0, dot)}.previous-${hash.slice(0, 12)}${basePath.slice(dot)}`
      : `${basePath}.previous-${hash.slice(0, 12)}`;
    await this.safeAdd(archivePath, content);
  }

  private async safeAdd(path: string, content: string): Promise<void> {
    try {
      await this.transport.upload(path, content, "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.download(path);
      if (existing !== content) throw new Error(`Immutable legacy archive conflict with different content: ${path}`);
    }
  }
}

function classifyManagedDestination(
  state: ProjectState,
  request: ArtifactWriteRequest,
  destination: ResolvedArtifactDestination
): ManagedArtifactDestination | null {
  const root = workspaceProjectRoot(state.project_id, state.slug);
  const deliverablesPrefix = `${root}/DELIVERABLES/`;
  if (destination.path.startsWith(deliverablesPrefix)) {
    return {
      zone: "deliverables",
      path: destination.path,
      logicalPath: destination.path.slice(deliverablesPrefix.length),
      ...(destination.archive_path ? { archivePath: destination.archive_path } : {})
    };
  }

  const referencesPrefix = `${root}/REFERENCES/`;
  if (!destination.path.startsWith(referencesPrefix)) return null;
  const physicalRelative = destination.path.slice(referencesPrefix.length);
  const targetPrefix = destination.route?.target_prefix;
  const routeCollection = targetPrefix === "REFERENCES"
    ? "UNCLASSIFIED"
    : targetPrefix?.startsWith("REFERENCES/")
      ? targetPrefix.slice("REFERENCES/".length)
      : "UNCLASSIFIED";
  const physicalCollectionPrefix = routeCollection === "UNCLASSIFIED" ? "" : `${routeCollection}/`;
  const logicalPath = physicalCollectionPrefix && physicalRelative.startsWith(physicalCollectionPrefix)
    ? physicalRelative.slice(physicalCollectionPrefix.length)
    : physicalRelative;
  const sourceSuffix = destination.route && request.relative_path.startsWith(`${destination.route.source_prefix}/`)
    ? request.relative_path.slice(destination.route.source_prefix.length + 1)
    : logicalPath;

  return {
    zone: "references",
    path: destination.path,
    logicalPath: sourceSuffix || logicalPath,
    collectionPath: routeCollection,
    ...(destination.archive_path ? { archivePath: destination.archive_path } : {})
  };
}

async function legacyVersionIdFor(requestId: string, stage: "reference" | "published"): Promise<string> {
  const digest = await sha256Text(`${requestId}\n${stage}`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

function observation(path: string, metadata: DropboxFileMetadata): ManagedProviderObservation {
  return {
    path,
    file_id: metadata.id,
    rev: metadata.rev,
    content_hash: metadata.content_hash,
    size: metadata.size
  };
}

function sameObservation(value: ManagedProviderObservation | undefined, metadata: DropboxFileMetadata): boolean {
  return !!value
    && value.path === metadata.path
    && value.file_id === metadata.id
    && value.rev === metadata.rev
    && value.content_hash === metadata.content_hash
    && value.size === metadata.size;
}
