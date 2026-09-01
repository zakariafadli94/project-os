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
import { InputIntakeRepository } from "./input-intake-repository";
import { InputIntakeService, type InputIntakeResult } from "./input-intake-service";
import { DocumentLedgerRepository, type ReferenceFingerprintRecord } from "./repository";

export interface ManagedDocumentReconcileSummary {
  scanned: number;
  ignored: number;
  captured: number;
  ingested: number;
  duplicates: number;
  restored: number;
  conflicts: number;
  intake_completed: number;
  duplicate_cleaned: number;
  withdrawn: number;
  intake_resumed: number;
  changed_document_ids: string[];
}

export class ManagedDocumentReconciler {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly intakeRepository: InputIntakeRepository;
  private readonly intakeService: InputIntakeService;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.intakeRepository = new InputIntakeRepository(this.runtime.objects);
    this.intakeService = new InputIntakeService(this.runtime);
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
      conflicts: 0,
      intake_completed: 0,
      duplicate_cleaned: 0,
      withdrawn: 0,
      intake_resumed: 0,
      changed_document_ids: []
    };
    if (state.status === "archived") {
      summary.ignored = changes.length;
      return summary;
    }

    const changedDocumentIds = new Set<string>();

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
          const restoredDocumentId = await this.restoreDeletedWorkProduct(
            state,
            classified.zone,
            classified.relativePath,
            change.path
          );
          summary.restored += restoredDocumentId ? 1 : 0;
          summary.ignored += restoredDocumentId ? 0 : 1;
          if (restoredDocumentId) changedDocumentIds.add(restoredDocumentId);
        } else if (classified.zone === "inputs") {
          const result = await this.reconcileDeletedInput(state, change.path);
          if (!result) {
            summary.ignored += 1;
          } else {
            this.applyInputIntakeResult(summary, result);
          }
        } else {
          // REFERENCES deletion remains visible to higher-level recovery instead
          // of guessing document identity from the path alone.
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
        const evidence = requireDropboxV1Evidence(metadata);
        const expectedDocumentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
        const beforeHead = await this.ledger.readHead(state.project_id, expectedDocumentId);
        const beforeReferenceVersionId = beforeHead?.kind === "reference" ? beforeHead.reference_version_id : undefined;
        const result = await this.intakeService.ingest(state, {
          sourcePath: change.path,
          relativeInputPath: classified.relativePath,
          metadata
        });
        this.applyInputIntakeResult(summary, result);
        if (result.status === "completed" && result.document_id) {
          const afterHead = await this.ledger.readHead(state.project_id, result.document_id);
          if (
            afterHead?.kind === "reference"
            && afterHead.reference_version_id
            && (beforeHead?.document_id !== result.document_id || beforeReferenceVersionId !== afterHead.reference_version_id)
          ) {
            changedDocumentIds.add(result.document_id);
          }
        }
        continue;
      }
      if (classified.zone === "references") {
        const capturedDocumentId = await this.captureReferenceEdit(state, classified.relativePath, change.path, metadata);
        summary.captured += capturedDocumentId ? 1 : 0;
        summary.ignored += capturedDocumentId ? 0 : 1;
        if (capturedDocumentId) changedDocumentIds.add(capturedDocumentId);
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
        const capturedDocumentId = await this.captureWorkProductEdit(
          state,
          classified.zone,
          classified.relativePath,
          change.path,
          metadata
        );
        summary.captured += capturedDocumentId ? 1 : 0;
        summary.ignored += capturedDocumentId ? 0 : 1;
        if (capturedDocumentId) changedDocumentIds.add(capturedDocumentId);
        continue;
      }
      const result = await this.reconcilePublishedEdit(state, classified.relativePath, change.path, metadata);
      if (result.outcome === "working") summary.captured += 1;
      if (result.outcome === "conflict") summary.conflicts += 1;
      if (result.outcome !== "ignored") summary.restored += 1;
      else summary.ignored += 1;
      if (result.document_id) changedDocumentIds.add(result.document_id);
    }

    summary.changed_document_ids = [...changedDocumentIds].sort();
    return summary;
  }

  private applyInputIntakeResult(summary: ManagedDocumentReconcileSummary, result: InputIntakeResult): void {
    if (result.status === "completed") {
      summary.ingested += 1;
      summary.intake_completed += 1;
    } else if (result.status === "duplicate_cleaned") {
      summary.duplicates += 1;
      summary.duplicate_cleaned += 1;
    } else if (result.status === "withdrawn") {
      summary.withdrawn += 1;
    } else {
      summary.conflicts += 1;
    }
    if (result.resumed) summary.intake_resumed += 1;
  }

  private async reconcileDeletedInput(state: ProjectState, sourcePath: string): Promise<InputIntakeResult | null> {
    // A deleted event can be stale if a human already placed a new object at the
    // same path. Never apply the old binding to a new provider reality.
    if (await this.metadataMaybe(sourcePath)) return null;

    const binding = await this.intakeRepository.readSourcePathBinding(
      state.project_id,
      this.runtime.providerId,
      sourcePath
    );
    if (!binding) return null;

    let intake = await this.intakeRepository.read(state.project_id, binding.intake_id);
    if (!intake || intake.source.provider_path !== sourcePath || intake.source.revision_token !== binding.revision_token) {
      return {
        status: "conflict",
        intake_id: binding.intake_id,
        resumed: true
      };
    }

    if (intake.phase === "COMPLETE") {
      return { status: "completed", intake_id: intake.intake_id, resumed: true };
    }
    if (intake.phase === "DUPLICATE_CLEANED") {
      return { status: "duplicate_cleaned", intake_id: intake.intake_id, resumed: true };
    }
    if (intake.phase === "WITHDRAWN") {
      return { status: "withdrawn", intake_id: intake.intake_id, resumed: true };
    }
    if (intake.phase === "CONFLICT") {
      return { status: "conflict", intake_id: intake.intake_id, resumed: true };
    }

    if (intake.phase === "DETECTED" || intake.phase === "SNAPSHOTTED") {
      intake = await this.intakeRepository.advance(state.project_id, intake.intake_id, "WITHDRAWN", new Date().toISOString());
      return { status: "withdrawn", intake_id: intake.intake_id, resumed: true };
    }

    if (intake.phase === "REFERENCE_COMMITTED") {
      intake = await this.intakeRepository.advance(state.project_id, intake.intake_id, "SOURCE_REMOVED", new Date().toISOString());
    }
    if (intake.phase === "SOURCE_REMOVED") {
      intake = await this.intakeRepository.advance(state.project_id, intake.intake_id, "COMPLETE", new Date().toISOString());
    }
    return { status: "completed", intake_id: intake.intake_id, resumed: true };
  }

  private async restoreDeletedWorkProduct(
    state: ProjectState,
    zone: "working" | "review" | "deliverables",
    logicalPath: string,
    visiblePath: string
  ): Promise<string | null> {
    const current = await this.metadataMaybe(visiblePath);
    if (current) return null;

    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return null;
    const versionId = zone === "working"
      ? head.working_version_id
      : zone === "review"
        ? head.review_version_id
        : head.published_version_id;
    if (!versionId) return null;

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
    return documentId;
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
  ): Promise<string | null> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return null;
    const currentObservation = zone === "working" ? head.provider?.working : head.provider?.review;
    if (sameObservation(currentObservation, metadata)) return null;

    const parentVersionId = zone === "working" ? head.working_version_id : head.review_version_id;
    if (!parentVersionId) return null;
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
    return documentId;
  }

  private async captureReferenceEdit(
    state: ProjectState,
    relativePath: string,
    visiblePath: string,
    metadata: ProviderObjectMetadata
  ): Promise<string | null> {
    const evidence = requireDropboxV1Evidence(metadata);
    const binding = await this.ledger.readProviderFileBinding(state.project_id, evidence.file_id);
    const directDocumentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
    const documentId = binding?.document_id ?? directDocumentId;
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "reference" || !head.reference_version_id) return null;
    if (sameObservation(head.provider?.reference, metadata)) return null;
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
    return documentId;
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
  ): Promise<{ outcome: "working" | "conflict" | "ignored"; document_id?: string }> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product" || !head.published_version_id) return { outcome: "ignored" };

    const currentPublished = await this.metadataMaybe(publishedPath);
    if (currentPublished && sameObservation(head.provider?.published, currentPublished)) return { outcome: "ignored" };
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
      return { outcome: "working", document_id: documentId };
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
    return { outcome: "conflict", document_id: documentId };
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
