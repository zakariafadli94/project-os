import {
  documentIdFor,
  documentIdForProviderFile,
  externalVersionIdFor,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import type { DropboxChangeEntry, DropboxFileMetadata, DropboxTransport } from "../dropbox/client";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedDocumentPath,
  workspaceProjectRoot
} from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { DocumentLedgerRepository } from "./repository";

export interface ManagedDocumentReconcileSummary {
  scanned: number;
  ignored: number;
  captured: number;
  ingested: number;
  restored: number;
  conflicts: number;
}

export class ManagedDocumentReconciler {
  private readonly transport: ResilientDropboxTransport;
  private readonly ledger: DocumentLedgerRepository;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
    this.ledger = new DocumentLedgerRepository(transport);
  }

  async reconcileChanges(state: ProjectState, changes: DropboxChangeEntry[]): Promise<ManagedDocumentReconcileSummary> {
    const summary: ManagedDocumentReconcileSummary = {
      scanned: changes.length,
      ignored: 0,
      captured: 0,
      ingested: 0,
      restored: 0,
      conflicts: 0
    };
    if (state.status === "archived") {
      summary.ignored = changes.length;
      return summary;
    }

    for (const change of changes) {
      if (change.tag !== "file") {
        summary.ignored += 1;
        continue;
      }
      const classified = classifyManagedPath(state, change.path);
      if (!classified) {
        summary.ignored += 1;
        continue;
      }
      if (classified.zone === "deliverables" && isProjectedDeliverableMetadata(state, classified.relativePath)) {
        summary.ignored += 1;
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

  private async captureWorkProductEdit(
    state: ProjectState,
    zone: "working" | "review",
    logicalPath: string,
    visiblePath: string,
    metadata: DropboxFileMetadata
  ): Promise<boolean> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product") return false;
    const currentObservation = zone === "working" ? head.provider?.working : head.provider?.review;
    if (sameObservation(currentObservation, metadata)) return false;

    const parentVersionId = zone === "working" ? head.working_version_id : head.review_version_id;
    if (!parentVersionId) return false;
    const parent = await this.requireVersion(state.project_id, documentId, parentVersionId);
    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
      await this.ledger.writeVersion(externalVersion(parent, {
        versionId,
        stage: zone,
        createdAt: metadata.server_modified,
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
    metadata: DropboxFileMetadata
  ): Promise<boolean> {
    const documentId = await documentIdForProviderFile(state.project_id, metadata.id);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "reference" || !head.reference_version_id) return false;
    if (sameObservation(head.provider?.reference, metadata)) return false;
    const parent = await this.requireVersion(state.project_id, documentId, head.reference_version_id);

    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
      await this.ledger.writeVersion(externalVersion(parent, {
        versionId,
        stage: "reference",
        createdAt: metadata.server_modified,
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
    return true;
  }

  private async ingestInput(
    state: ProjectState,
    logicalPath: string,
    inputPath: string,
    metadata: DropboxFileMetadata
  ): Promise<"ingested" | "ignored"> {
    const documentId = await documentIdForProviderFile(state.project_id, metadata.id);
    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (existing) return "ignored";

    await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, inputPath, metadata);
    const targetPath = workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      `UNCLASSIFIED/${logicalPath}`
    );
    if (!this.transport.copy || !this.transport.delete) {
      throw new Error("Dropbox transport does not support binary-safe input ingestion");
    }

    let targetMetadata: DropboxFileMetadata;
    try {
      targetMetadata = await this.transport.copy(inputPath, targetPath);
    } catch (error) {
      const target = await this.metadataMaybe(targetPath);
      if (!target || target.content_hash !== metadata.content_hash || target.size !== metadata.size) throw error;
      targetMetadata = target;
    }
    await this.transport.delete(inputPath);

    await this.ledger.writeVersion({
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      kind: "reference",
      stage: "reference",
      logical_path: logicalPath,
      source: "input_ingest",
      created_at: metadata.server_modified ?? new Date().toISOString(),
      immutable_payload_path: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
      provider_content_hash: targetMetadata.content_hash,
      provider_file_id: targetMetadata.id,
      provider_rev: targetMetadata.rev,
      provider_path: targetPath,
      size: targetMetadata.size
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
    return "ingested";
  }

  private async reconcilePublishedEdit(
    state: ProjectState,
    logicalPath: string,
    publishedPath: string,
    eventMetadata: DropboxFileMetadata
  ): Promise<"working" | "conflict" | "ignored"> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product" || !head.published_version_id) return "ignored";

    const currentPublished = await this.metadataMaybe(publishedPath);
    if (currentPublished && sameObservation(head.provider?.published, currentPublished)) return "ignored";
    const metadata = currentPublished ?? eventMetadata;
    const published = await this.requireVersion(state.project_id, documentId, head.published_version_id);

    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, publishedPath, metadata);
    }

    const workingPath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", logicalPath);
    const workingMetadata = await this.metadataMaybe(workingPath);
    const canPromoteToWorking = !head.working_version_id && !head.review_version_id && !workingMetadata;

    if (canPromoteToWorking) {
      await this.transport.move(publishedPath, workingPath);
      const movedMetadata = await this.requireMetadata(workingPath);
      if (!existing) {
        await this.ledger.writeVersion(externalVersion(published, {
          versionId,
          stage: "working",
          createdAt: metadata.server_modified,
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
        createdAt: metadata.server_modified,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        providerPath: publishedPath,
        metadata
      }));
    }
    if (currentPublished && this.transport.delete) await this.transport.delete(publishedPath);
    const restoredMetadata = await this.restorePublished(published, publishedPath);
    await this.ledger.writeHead({
      ...head,
      provider: { ...(head.provider ?? {}), published: observation(publishedPath, restoredMetadata) },
      reconciliation_status: "conflict"
    });
    return "conflict";
  }

  private async restorePublished(version: DocumentVersionRecord, publishedPath: string): Promise<DropboxFileMetadata> {
    if (!this.transport.copy) throw new Error("Dropbox transport does not support published document restore");
    return this.transport.copy(version.immutable_payload_path, publishedPath);
  }

  private async metadataFor(change: DropboxChangeEntry): Promise<DropboxFileMetadata | null> {
    const current = await this.metadataMaybe(change.path);
    if (current) return current;
    if (change.id && change.rev && change.content_hash && change.size !== undefined) {
      return {
        id: change.id,
        path: change.path,
        rev: change.rev,
        content_hash: change.content_hash,
        size: change.size,
        ...(change.server_modified ? { server_modified: change.server_modified } : {})
      };
    }
    return null;
  }

  private async metadataMaybe(path: string): Promise<DropboxFileMetadata | null> {
    if (!this.transport.getMetadata) throw new Error("Dropbox transport does not support managed-document metadata");
    return this.transport.getMetadata(path);
  }

  private async requireMetadata(path: string): Promise<DropboxFileMetadata> {
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
    metadata: DropboxFileMetadata;
  }
): DocumentVersionRecord {
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
    provider_content_hash: input.metadata.content_hash,
    provider_file_id: input.metadata.id,
    provider_rev: input.metadata.rev,
    provider_path: input.providerPath,
    size: input.metadata.size,
    ...(parent.media_type ? { media_type: parent.media_type } : {})
  };
}

function sameObservation(observationValue: ManagedProviderObservation | undefined, metadata: DropboxFileMetadata): boolean {
  return !!observationValue
    && observationValue.rev === metadata.rev
    && observationValue.file_id === metadata.id
    && observationValue.content_hash === metadata.content_hash
    && observationValue.size === metadata.size;
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

function updateWorkHead(
  head: ManagedDocumentHead,
  zone: "working" | "review",
  versionId: string,
  visiblePath: string,
  metadata: DropboxFileMetadata,
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
