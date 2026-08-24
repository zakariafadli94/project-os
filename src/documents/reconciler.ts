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
      if (classified.zone === "deliverables") {
        const result = await this.reconcilePublishedEdit(state, classified.relativePath, change.path, metadata);
        if (result === "working") summary.captured += 1;
        if (result === "conflict") summary.conflicts += 1;
        if (result !== "ignored") summary.restored += 1;
        else summary.ignored += 1;
      }
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
    const parentVersionId = zone === "working" ? head.working_version_id : head.review_version_id;
    if (!parentVersionId) return false;
    const parent = await this.ledger.readVersion(state.project_id, documentId, parentVersionId);
    if (!parent) throw new Error(`Managed document parent version missing: ${documentId}/${parentVersionId}`);
    if (sameProvider(parent, metadata)) return false;

    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (existing) {
      await this.ledger.writeHead(updateWorkHead(head, zone, versionId, visiblePath, metadata, "clean"));
      return true;
    }
    const snapshot = await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
    const record = externalVersion(parent, {
      versionId,
      stage: zone,
      source: "external_human",
      createdAt: metadata.server_modified,
      immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
      metadata
    });
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead(updateWorkHead(head, zone, versionId, visiblePath, metadata, "clean"));
    void snapshot;
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
    const parent = await this.ledger.readVersion(state.project_id, documentId, head.reference_version_id);
    if (!parent) throw new Error(`Reference parent version missing: ${documentId}/${head.reference_version_id}`);
    if (sameProvider(parent, metadata)) return false;

    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, visiblePath, metadata);
      await this.ledger.writeVersion(externalVersion(parent, {
        versionId,
        stage: "reference",
        source: "external_human",
        createdAt: metadata.server_modified,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
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
    const targetRelative = `UNCLASSIFIED/${logicalPath}`;
    const targetPath = workspaceManagedDocumentPath(state.project_id, state.slug, "references", targetRelative);
    await this.transport.move(inputPath, targetPath);
    const targetMetadata = await this.requireMetadata(targetPath);
    const record: DocumentVersionRecord = {
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
      size: targetMetadata.size
    };
    await this.ledger.writeVersion(record);
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
    metadata: DropboxFileMetadata
  ): Promise<"working" | "conflict" | "ignored"> {
    const documentId = await documentIdFor(state.project_id, logicalPath);
    const head = await this.ledger.readHead(state.project_id, documentId);
    if (!head || head.kind !== "work_product" || !head.published_version_id) return "ignored";
    const published = await this.ledger.readVersion(state.project_id, documentId, head.published_version_id);
    if (!published) throw new Error(`Published managed document version missing: ${documentId}/${head.published_version_id}`);
    if (sameProvider(published, metadata)) return "ignored";

    const versionId = await externalVersionIdFor(metadata.rev);
    const existing = await this.ledger.readVersion(state.project_id, documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(state.project_id, documentId, versionId, publishedPath, metadata);
    }

    const workingPath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", logicalPath);
    const workingMetadata = await this.metadataMaybe(workingPath);
    if (!head.working_version_id && !workingMetadata) {
      if (!existing) {
        await this.transport.move(publishedPath, workingPath);
        const movedMetadata = await this.requireMetadata(workingPath);
        await this.ledger.writeVersion(externalVersion(published, {
          versionId,
          stage: "working",
          source: "external_human",
          createdAt: metadata.server_modified,
          immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
          metadata: movedMetadata
        }));
        await this.restorePublished(published, publishedPath);
        const restoredMetadata = await this.requireMetadata(publishedPath);
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
      } else {
        await this.restorePublishedIfMissing(published, publishedPath);
        const restoredMetadata = await this.requireMetadata(publishedPath);
        const currentWorking = await this.requireMetadata(workingPath);
        await this.ledger.writeHead({
          ...head,
          working_version_id: versionId,
          provider: {
            ...(head.provider ?? {}),
            working: observation(workingPath, currentWorking),
            published: observation(publishedPath, restoredMetadata)
          },
          reconciliation_status: "clean"
        });
      }
      return "working";
    }

    if (!existing) {
      await this.ledger.writeVersion(externalVersion(published, {
        versionId,
        stage: "recovered_external",
        source: "external_human",
        createdAt: metadata.server_modified,
        immutablePayloadPath: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        metadata
      }));
    }
    if (this.transport.delete) await this.transport.delete(publishedPath);
    await this.restorePublished(published, publishedPath);
    const restoredMetadata = await this.requireMetadata(publishedPath);
    await this.ledger.writeHead({
      ...head,
      provider: { ...(head.provider ?? {}), published: observation(publishedPath, restoredMetadata) },
      reconciliation_status: "conflict"
    });
    return "conflict";
  }

  private async restorePublished(version: DocumentVersionRecord, publishedPath: string): Promise<void> {
    if (!this.transport.copy) throw new Error("Dropbox transport does not support published document restore");
    await this.transport.copy(version.immutable_payload_path, publishedPath);
  }

  private async restorePublishedIfMissing(version: DocumentVersionRecord, publishedPath: string): Promise<void> {
    if (await this.metadataMaybe(publishedPath)) return;
    await this.restorePublished(version, publishedPath);
  }

  private async metadataFor(change: DropboxChangeEntry): Promise<DropboxFileMetadata | null> {
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
    return this.metadataMaybe(change.path);
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
}

function classifyManagedPath(state: ProjectState, path: string): { zone: "inputs" | "references" | "working" | "review" | "deliverables"; relativePath: string } | null {
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
    source: "external_human";
    createdAt?: string;
    immutablePayloadPath: string;
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
    source: input.source,
    created_at: input.createdAt ?? new Date().toISOString(),
    immutable_payload_path: input.immutablePayloadPath,
    provider_content_hash: input.metadata.content_hash,
    provider_file_id: input.metadata.id,
    provider_rev: input.metadata.rev,
    size: input.metadata.size,
    ...(parent.media_type ? { media_type: parent.media_type } : {})
  };
}

function sameProvider(version: DocumentVersionRecord, metadata: DropboxFileMetadata): boolean {
  return version.provider_rev === metadata.rev
    && version.provider_file_id === metadata.id
    && version.provider_content_hash === metadata.content_hash
    && version.size === metadata.size;
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
  status: "clean" | "conflict"
): ManagedDocumentHead {
  return {
    ...head,
    ...(zone === "working" ? { working_version_id: versionId } : { review_version_id: versionId }),
    provider: {
      ...(head.provider ?? {}),
      ...(zone === "working"
        ? { working: observation(visiblePath, metadata) }
        : { review: observation(visiblePath, metadata) })
    },
    reconciliation_status: status
  };
}

function inferReferenceCollection(relativePath: string, logicalPath: string): string | null {
  if (relativePath === logicalPath) return null;
  const suffix = `/${logicalPath}`;
  if (!relativePath.endsWith(suffix)) return null;
  return relativePath.slice(0, -suffix.length) || null;
}
