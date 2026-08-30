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
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../persistence/compatibility/dropbox-v1-evidence";
import {
  asProjectOsPersistence,
  toProviderChangeEntry,
  type LegacyDropboxChangeEntry,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedDocumentPath,
  workspaceProjectRoot
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  ManagedDocumentIdentityConflictError,
  assertManagedMarkdownIdentityIfPresent
} from "./identity-frontmatter";
import { DocumentLedgerRepository, type ReferenceFingerprintRecord } from "./repository";

export interface ManagedDocumentReconcileSummary {
  scanned: number;
  ignored: number;
  captured: number;
  ingested: number;
  duplicates: number;
  restored: number;
  conflicts: number;
}

export class ManagedDocumentReconciler {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
  }

  async reconcileChanges(
    state: ProjectState,
    changes: Array<ProviderChangeEntry | LegacyDropboxChangeEntry>
  ): Promise<ManagedDocumentReconcileSummary> {
    const summary: ManagedDocumentReconcileSummary = {
      scanned: changes.length,
      ignored: 0,
      captured: 0,
      ingested: 0,
      duplicates: 0,
      restored: 0,
      conflicts: 0
    };
    if (state.status === "archived") {
      summary.ignored = changes.length;
      return summary;
    }

    for (const changeInput of changes) {
      const change = toProviderChangeEntry(changeInput);
      const classified = classifyManagedPath(state, change.path);
      if (!classified) {
        summary.ignored += 1;
        continue;
      }
      if (classified.zone === "deliverables" && isProjectedDeliverableMetadata(state, classified.relativePath)) {
        summary.ignored += 1;
        continue;
      }

      if (change.kind === "deleted") {
        if (classified.zone === "working" || classified.zone === "review" || classified.zone === "deliverables") {
          const restored = await this.restoreDeletedWorkProduct(
            state,
            classified.zone,
            classified.relativePath,
            change.path
          );
          summary.restored += restored ? 1 : 0;
          summary.ignored += restored ? 0 : 1;
        } else {
          // INPUTS deletion is a legitimate withdrawal. Deleted change entries do
          // not carry a stable object id, so REFERENCES deletion remains visible
          // to higher-level recovery instead of guessing an identity from its path.
          summary.ignored += 1;
        }
        continue;
      }

      const metadata = await this.metadataFor(change);
      if (!metadata) {
        summary.ignored += 1;
        continue;
      }

      if (classified.zone === "inputs") {
        const result = await this.ingestInput(state, classified.relativePath, change.path, metadata);
        summary.ingested += result === "ingested" ? 1 : 0;
        summary.duplicates += result === "duplicate" ? 1 : 0;
        summary.ignored += result === "ignored" ? 1 : 0;
        continue;
      }
      if (classified.zone === "references") {
        const captured = await this.captureReferenceEdit(state, classified.relativePath, change.path, metadata);
        summary.captured += captured ? 1 : 0;
        summary.ignored += captured ? 0 : 1;
        continue;
      }
      if (classified.zone === "working" || classified.zone === "review") {
        const identityConflict = await this.hasVisibleIdentityConflict(
          state,
          classified.relativePath,
          change.path
        );
        if (identityConflict) {
          summary.conflicts += 1;
          continue;
        }
        const captured = await this.captureWorkProductEdit(
          state,
          classified.zone,
          classified.relativePath,
          change.path,
          metadata
        );
        summary.captured += captured ? 1 : 0;
        summary.ignored += captured ? 0 : 1;
        continue;
      }
      const result = await this.reconcilePublishedEdit(state, classified.relativePath, change.path, metadata);
      if (result === "working") summary.captured += 1;
      if (result === "conflict") summary.conflicts += 1;
      if (result !== "ignored") summary.restored += 1;
      else summary.ignored += 1;
    }
    return summary;
  }

  private async restoreDeletedWorkProduct(
    state: ProjectState,
    zone: "working" | "review" | "deliverables",
    logicalPath: string,
    visiblePath: string
  ): Promise<boolean> {
    const current = await this.metadataMaybe(visiblePath);
    if (current) return false;

    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return false;
    const versionId = zone === "working"
      ? head.working_version_id
      : zone === "review"
        ? head.review_version_id
        : head.published_version_id;
    if (!versionId) return false;

    const version = await this.requireVersion(state.project_id, documentId, versionId);
    const restored = await this.runtime.serverSideCopy.copyObject(version.immutable_payload_path, visiblePath);
    const provider = { ...(head.provider ?? {}) };
    if (zone === "working") provider.working = observation(visiblePath, restored);
    if (zone === "review") provider.review = observation(visiblePath, restored);
    if (zone === "deliverables") provider.published = observation(visiblePath, restored);
    await this.ledger.writeHead({
      ...head,
      provider,
      reconciliation_status: head.reconciliation_status
    });
    return true;
  }

  private async hasVisibleIdentityConflict(
    state: ProjectState,
    logicalPath: string,
    visiblePath: string
  ): Promise<boolean> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return false;

    const content = await this.runtime.objects.readText(visiblePath);
    if (content === null) return false;
    try {
      assertManagedMarkdownIdentityIfPresent(content, {
        projectId: state.project_id,
        documentId: head.document_id,
        logicalPath: head.logical_path
      });
      return false;
    } catch (error) {
      if (error instanceof ManagedDocumentIdentityConflictError) return true;
      throw error;
    }
  }

  private async captureWorkProductEdit(
    state: ProjectState,
    zone: "working" | "review",
    logicalPath: string,
    visiblePath: string,
    metadata: ProviderObjectMetadata
  ): Promise<boolean> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return false;
    const currentObservation = zone === "working" ? head.provider?.working : head.provider?.review;
    if (sameObservation(currentObservation, metadata)) return false;

    const parentVersionId = zone === "working" ? head.working_version_id : head.review_version_id;
    if (!parentVersionId) return false;
    const parent = await this.requireVersion(state.project_id, documentId, parentVersionId);
    const evidence = requireDropboxV1Evidence(metadata);
    const versionId = await externalVersionIdFor(evidence.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
      await this.ledger.writeVersion(externalVersion(parent, {
        versionId,
        stage: zone,
        createdAt: metadata.modifiedAt,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        providerPath: visiblePath,
        metadata
      }));
    }
    await this.ledger.writeHead(updateWorkHead(head, zone, versionId, visiblePath, metadata, "clean"));
    return true;
  }

  private async captureReferenceEdit(
    state: ProjectState,
    relativePath: string,
    visiblePath: string,
    metadata: ProviderObjectMetadata
  ): Promise<boolean> {
    const evidence = requireDropboxV1Evidence(metadata);
    const binding = await this.ledger.readProviderFileBinding(state.project_id, evidence.file_id);
    const directDocumentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
    const documentId = binding?.document_id ?? directDocumentId;
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "reference" || !head.reference_version_id) return false;
    if (sameObservation(head.provider?.reference, metadata)) return false;
    const parent = await this.requireVersion(state.project_id, documentId, head.reference_version_id);

    const versionId = await externalVersionIdFor(evidence.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
      await this.ledger.writeVersion(externalVersion(parent, {
        versionId,
        stage: "reference",
        createdAt: metadata.modifiedAt,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        providerPath: visiblePath,
        metadata
      }));
    }
    const collectionPath = inferReferenceCollection(relativePath, head.logical_path) ?? head.collection_path ?? "UNCLASSIFIED";
    await this.ledger.writeHead({
      ...head,
      collection_path: collectionPath,
      reference_version_id: versionId,
      provider: { reference: observation(visiblePath, metadata) },
      reconciliation_status: "clean"
    });
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_file_id: evidence.file_id,
      document_id: documentId
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_content_hash: evidence.content_hash,
      document_id: documentId,
      version_id: versionId
    });
    return true;
  }

  private async ingestInput(
    state: ProjectState,
    logicalPath: string,
    inputPath: string,
    metadata: ProviderObjectMetadata
  ): Promise<"ingested" | "duplicate" | "ignored"> {
    const evidence = requireDropboxV1Evidence(metadata);
    const documentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
    const versionId = await externalVersionIdFor(evidence.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (existing) return "ignored";

    const fingerprint = await this.ledger.readReferenceFingerprint(state.project_id, evidence.content_hash);
    if (fingerprint && await this.isCurrentReferenceFingerprint(state.project_id, evidence.content_hash, fingerprint)) {
      await this.runtime.objects.delete(inputPath);
      return "duplicate";
    }

    await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, inputPath, metadata);
    const targetPath = workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      `UNCLASSIFIED/${logicalPath}`
    );

    let targetMetadata: ProviderObjectMetadata;
    try {
      targetMetadata = await this.runtime.serverSideCopy.copyObject(inputPath, targetPath);
    } catch (error) {
      const target = await this.metadataMaybe(targetPath);
      if (!target) throw error;
      const targetEvidence = requireDropboxV1Evidence(target);
      if (targetEvidence.content_hash !== evidence.content_hash || targetEvidence.size !== evidence.size) throw error;
      targetMetadata = target;
    }
    await this.runtime.objects.delete(inputPath);
    const targetEvidence = requireDropboxV1Evidence(targetMetadata);

    await this.ledger.writeVersion({
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      kind: "reference",
      stage: "reference",
      logical_path: logicalPath,
      source: "input_ingest",
      created_at: metadata.modifiedAt ?? new Date().toISOString(),
      immutable_payload_path: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
      provider_content_hash: targetEvidence.content_hash,
      provider_file_id: targetEvidence.file_id,
      provider_rev: targetEvidence.rev,
      provider_path: targetPath,
      size: targetEvidence.size
    });
    await this.ledger.writeHead({
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      kind: "reference",
      logical_path: logicalPath,
      collection_path: "UNCLASSIFIED",
      reference_version_id: versionId,
      provider: { reference: observation(targetPath, targetMetadata) },
      reconciliation_status: "clean"
    });
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_file_id: targetEvidence.file_id,
      document_id: documentId
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_content_hash: targetEvidence.content_hash,
      document_id: documentId,
      version_id: versionId
    });
    return "ingested";
  }

  private async isCurrentReferenceFingerprint(
    projectId: string,
    contentHash: string,
    fingerprint: ReferenceFingerprintRecord
  ): Promise<boolean> {
    const head = await this.ledger.readHead(projectId, fingerprint.document_id);
    if (!head || head.kind !== "reference" || !head.reference_version_id || !head.provider?.reference) return false;
    const currentVersion = await this.ledger.readVersion(projectId, fingerprint.document_id, head.reference_version_id);
    if (!currentVersion || currentVersion.kind !== "reference" || currentVersion.provider_content_hash !== contentHash) return false;
    const currentMetadata = await this.metadataMaybe(head.provider.reference.path);
    if (!currentMetadata) return false;
    const currentEvidence = requireDropboxV1Evidence(currentMetadata);
    return currentEvidence.content_hash === contentHash
      && sameObservation(head.provider.reference, currentMetadata);
  }

  private async reconcilePublishedEdit(
    state: ProjectState,
    logicalPath: string,
    publishedPath: string,
    eventMetadata: ProviderObjectMetadata
  ): Promise<"working" | "conflict" | "ignored"> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product" || !head.published_version_id) return "ignored";

    const currentPublished = await this.metadataMaybe(publishedPath);
    if (currentPublished && sameObservation(head.provider?.published, currentPublished)) return "ignored";
    const metadata = currentPublished ?? eventMetadata;
    const evidence = requireDropboxV1Evidence(metadata);
    const published = await this.requireVersion(state.project_id, documentId, head.published_version_id);

    const versionId = await externalVersionIdFor(evidence.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, publishedPath, metadata);
    }

    const workingPath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", logicalPath);
    const workingMetadata = await this.metadataMaybe(workingPath);
    const canPromoteToWorking = !head.working_version_id && !head.review_version_id && !workingMetadata;

    if (canPromoteToWorking) {
      await this.runtime.objects.move(publishedPath, workingPath);
      const movedMetadata = await this.requireMetadata(workingPath);
      if (!existing) {
        await this.ledger.writeVersion(externalVersion(published, {
          versionId,
          stage: "working",
          createdAt: metadata.modifiedAt,
          immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
          providerPath: workingPath,
          metadata: movedMetadata
        }));
      }
      const restoredMetadata = await this.restorePublished(published, publishedPath);
      await this.ledger.writeHead({
        ...head,
        working_version_id: versionId,
        provider: {
          ...(head.provider ?? {}),
          working: observation(workingPath, movedMetadata),
          published: observation(publishedPath, restoredMetadata)
        },
        reconciliation_status: "clean"
      });
      return "working";
    }

    if (!existing) {
      await this.ledger.writeVersion(externalVersion(published, {
        versionId,
        stage: "recovered_external",
        createdAt: metadata.modifiedAt,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        providerPath: publishedPath,
        metadata
      }));
    }
    if (currentPublished) await this.runtime.objects.delete(publishedPath);
    const restoredMetadata = await this.restorePublished(published, publishedPath);
    await this.ledger.writeHead({
      ...head,
      provider: { ...(head.provider ?? {}), published: observation(publishedPath, restoredMetadata) },
      reconciliation_status: "conflict"
    });
    return "conflict";
  }

  private restorePublished(version: DocumentVersionRecord, publishedPath: string): Promise<ProviderObjectMetadata> {
    return this.runtime.serverSideCopy.copyObject(version.immutable_payload_path, publishedPath);
  }

  private async metadataFor(change: ProviderChangeEntry): Promise<ProviderObjectMetadata | null> {
    const current = await this.metadataMaybe(change.path);
    return current ?? change.metadata ?? null;
  }

  private metadataMaybe(path: string): Promise<ProviderObjectMetadata | null> {
    return this.runtime.objects.getMetadata(path);
  }

  private async requireMetadata(path: string): Promise<ProviderObjectMetadata> {
    const metadata = await this.metadataMaybe(path);
    if (!metadata) throw new Error(`Managed document provider file missing: ${path}`);
    return metadata;
  }

  private async requireVersion(projectId: string, documentId: string, versionId: string): Promise<DocumentVersionRecord> {
    const version = await this.ledger.readVersion(projectId, documentId, versionId);
    if (!version) throw new Error(`Managed document version missing: ${documentId}/${versionId}`);
    return version;
  }
}

function classifyManagedPath(
  state: ProjectState,
  path: string
): { zone: "inputs" | "references" | "working" | "review" | "deliverables"; relativePath: string } | null {
  const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
  if (!path.startsWith(root)) return null;
  const relative = path.slice(root.length);
  const zones = [
    ["INPUTS/", "inputs"],
    ["REFERENCES/", "references"],
    ["WORKING/", "working"],
    ["REVIEW/", "review"],
    ["DELIVERABLES/", "deliverables"]
  ] as const;
  for (const [prefix, zone] of zones) {
    if (relative.startsWith(prefix) && relative.length > prefix.length) {
      return { zone, relativePath: relative.slice(prefix.length) };
    }
  }
  return null;
}

function externalVersion(
  parent: DocumentVersionRecord,
  input: {
    versionId: string;
    stage: DocumentVersionRecord["stage"];
    createdAt?: string;
    immutablePayloadPath: string;
    providerPath: string;
    metadata: ProviderObjectMetadata;
  }
): DocumentVersionRecord {
  const evidence = requireDropboxV1Evidence(input.metadata);
  return {
    schema_version: "1.0",
    project_id: parent.project_id,
    document_id: parent.document_id,
    version_id: input.versionId,
    parent_version_id: parent.version_id,
    kind: parent.kind,
    stage: input.stage,
    logical_path: parent.logical_path,
    source: "external_human",
    created_at: input.createdAt ?? new Date().toISOString(),
    immutable_payload_path: input.immutablePayloadPath,
    provider_content_hash: evidence.content_hash,
    provider_file_id: evidence.file_id,
    provider_rev: evidence.rev,
    provider_path: input.providerPath,
    size: evidence.size,
    ...(parent.media_type ? { media_type: parent.media_type } : {})
  };
}

function sameObservation(observationValue: ManagedProviderObservation | undefined, metadata: ProviderObjectMetadata): boolean {
  if (!observationValue) return false;
  const evidence = requireDropboxV1Evidence(metadata);
  return observationValue.rev === evidence.rev
    && observationValue.file_id === evidence.file_id
    && observationValue.content_hash === evidence.content_hash
    && observationValue.size === evidence.size;
}

function observation(path: string, metadata: ProviderObjectMetadata): ManagedProviderObservation {
  return toManagedProviderObservation({ ...metadata, path });
}

function updateWorkHead(
  head: ManagedDocumentHead,
  zone: "working" | "review",
  versionId: string,
  visiblePath: string,
  metadata: ProviderObjectMetadata,
  reconciliationStatus: ManagedDocumentHead["reconciliation_status"]
): ManagedDocumentHead {
  const provider = { ...(head.provider ?? {}) };
  if (zone === "working") provider.working = observation(visiblePath, metadata);
  else provider.review = observation(visiblePath, metadata);
  return {
    ...head,
    ...(zone === "working" ? { working_version_id: versionId } : { review_version_id: versionId }),
    provider,
    reconciliation_status: reconciliationStatus
  };
}

function inferReferenceCollection(relativePath: string, logicalPath: string): string | null {
  if (!relativePath.endsWith(logicalPath)) return null;
  const prefix = relativePath.slice(0, relativePath.length - logicalPath.length).replace(/\/$/, "");
  return prefix || null;
}

function isProjectedDeliverableMetadata(state: ProjectState, relativePath: string): boolean {
  if (relativePath.includes("/") || !relativePath.endsWith(".md")) return false;
  return Object.prototype.hasOwnProperty.call(state.deliverables, relativePath.slice(0, -3));
}
