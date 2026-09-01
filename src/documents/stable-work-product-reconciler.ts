import { externalVersionIdFor, type DocumentVersionRecord, type ManagedDocumentHead, type ManagedProviderObservation } from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import { requireDropboxV1Evidence, toManagedProviderObservation } from "../persistence/compatibility/dropbox-v1-evidence";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineDocumentProviderPayloadPath, workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import { ManagedDocumentActivePathIndex } from "./active-path-index";
import { DocumentLedgerRepository } from "./repository";
import { WorkProductIdentityResolver } from "./work-product-identity";

export interface StableWorkProductReconcileResult {
  handled: boolean;
  captured: number;
  restored: number;
  conflicts: number;
}

type WorkZone = "working" | "review";

export class StableWorkProductReconciler {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly identities: WorkProductIdentityResolver;
  private readonly activePaths: ManagedDocumentActivePathIndex;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.identities = new WorkProductIdentityResolver(this.runtime);
    this.activePaths = new ManagedDocumentActivePathIndex(this.runtime);
  }

  async reconcile(state: ProjectState, change: ProviderChangeEntry): Promise<StableWorkProductReconcileResult> {
    const classified = classifyWorkZone(state, change.path);
    if (!classified) return empty(false);

    if (change.kind === "deleted") {
      return this.restoreDeleted(state, classified.zone, classified.logicalPath, change.path);
    }
    if (change.kind !== "file") return empty(true);

    const metadata = change.metadata ?? await this.runtime.objects.getMetadata(change.path);
    if (!metadata) return empty(true);
    const resolution = await this.identities.resolveVisible(
      state.project_id,
      classified.logicalPath,
      change.path,
      metadata
    );
    if (resolution.kind === "conflict") return conflict();
    if (!resolution.head) return empty(false);

    const head = resolution.head;
    const activeVersionId = classified.zone === "working" ? head.working_version_id : head.review_version_id;
    const currentObservation = classified.zone === "working" ? head.provider?.working : head.provider?.review;
    if (!activeVersionId) {
      // The path belongs to this document but its lifecycle says another stage
      // is active. Keeping it visible would create a second active head.
      return conflict();
    }
    if (sameObservation(currentObservation, metadata)) {
      await this.ensureIndexes(state.project_id, classified.logicalPath, resolution.documentId, metadata);
      return empty(true);
    }

    const parent = await this.requireVersion(state.project_id, resolution.documentId, activeVersionId);
    const evidence = requireDropboxV1Evidence(metadata);
    if (currentObservation?.file_id && currentObservation.file_id !== evidence.file_id) {
      return conflict();
    }

    const versionId = await externalVersionIdFor(evidence.rev);
    const existing = await this.ledger.readVersion(state.project_id, resolution.documentId, versionId);
    if (!existing) {
      await this.ledger.snapshotProviderFile(
        state.project_id,
        resolution.documentId,
        versionId,
        change.path,
        metadata
      );
      const version: DocumentVersionRecord = {
        schema_version: "1.0",
        project_id: state.project_id,
        document_id: resolution.documentId,
        version_id: versionId,
        parent_version_id: parent.version_id,
        kind: "work_product",
        stage: classified.zone,
        logical_path: classified.logicalPath,
        source: "external_human",
        created_at: metadata.modifiedAt ?? new Date().toISOString(),
        immutable_payload_path: machineDocumentProviderPayloadPath(state.project_id, resolution.documentId, versionId),
        provider_content_hash: evidence.content_hash,
        provider_file_id: evidence.file_id,
        provider_rev: evidence.rev,
        provider_path: change.path,
        size: evidence.size
      };
      await this.ledger.writeVersion(version);
    }

    await this.ledger.writeHead(updateHead(head, classified.zone, versionId, change.path, metadata));
    await this.ensureIndexes(state.project_id, classified.logicalPath, resolution.documentId, metadata);
    return { handled: true, captured: 1, restored: 0, conflicts: 0 };
  }

  private async restoreDeleted(
    state: ProjectState,
    zone: WorkZone,
    logicalPath: string,
    visiblePath: string
  ): Promise<StableWorkProductReconcileResult> {
    if (await this.runtime.objects.getMetadata(visiblePath)) return empty(true);
    const resolution = await this.identities.resolveDeleted(state.project_id, logicalPath);
    if (resolution.kind === "conflict") return conflict();
    if (!resolution.head) return empty(false);

    const head = resolution.head;
    const versionId = zone === "working" ? head.working_version_id : head.review_version_id;
    if (!versionId) return conflict();
    const version = await this.requireVersion(state.project_id, resolution.documentId, versionId);
    const restored = await this.runtime.serverSideCopy.copyObject(version.immutable_payload_path, visiblePath);
    await this.ledger.writeHead(updateHead(head, zone, versionId, visiblePath, restored));
    await this.ensureIndexes(state.project_id, logicalPath, resolution.documentId, restored);
    return { handled: true, captured: 0, restored: 1, conflicts: 0 };
  }

  private async ensureIndexes(
    projectId: string,
    logicalPath: string,
    documentId: string,
    metadata: ProviderObjectMetadata
  ): Promise<void> {
    await this.activePaths.bind(projectId, logicalPath, documentId);
    const evidence = requireDropboxV1Evidence(metadata);
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: projectId,
      provider_file_id: evidence.file_id,
      document_id: documentId
    });
  }

  private async requireVersion(projectId: string, documentId: string, versionId: string): Promise<DocumentVersionRecord> {
    const version = await this.ledger.readVersion(projectId, documentId, versionId);
    if (!version) throw new Error(`Managed document version missing: ${documentId}/${versionId}`);
    return version as DocumentVersionRecord;
  }
}

function classifyWorkZone(
  state: ProjectState,
  path: string
): { zone: WorkZone; logicalPath: string } | null {
  const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
  if (!path.startsWith(root)) return null;
  const relative = path.slice(root.length);
  if (relative.startsWith("WORKING/") && relative.length > "WORKING/".length) {
    return { zone: "working", logicalPath: relative.slice("WORKING/".length) };
  }
  if (relative.startsWith("REVIEW/") && relative.length > "REVIEW/".length) {
    return { zone: "review", logicalPath: relative.slice("REVIEW/".length) };
  }
  return null;
}

function updateHead(
  head: ManagedDocumentHead,
  zone: WorkZone,
  versionId: string,
  path: string,
  metadata: ProviderObjectMetadata
): ManagedDocumentHead {
  const observation = toManagedProviderObservation({ ...metadata, path });
  if (zone === "working") {
    return {
      ...head,
      working_version_id: versionId,
      provider: { ...(head.provider ?? {}), working: observation },
      reconciliation_status: "clean"
    };
  }
  return {
    ...head,
    review_version_id: versionId,
    provider: { ...(head.provider ?? {}), review: observation },
    reconciliation_status: "clean"
  };
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

function empty(handled: boolean): StableWorkProductReconcileResult {
  return { handled, captured: 0, restored: 0, conflicts: 0 };
}

function conflict(): StableWorkProductReconcileResult {
  return { handled: true, captured: 0, restored: 0, conflicts: 1 };
}
