import type { ProjectState } from "../domain/project-state";
import { DocumentLedgerRepository } from "../documents/repository";
import { buildCanonicalSearchRecords } from "./canonical-records";
import type { CanonicalSnapshotRequest, DocumentBatchRequest, ManagedDocumentSearchRecord } from "./contract";
import { buildManagedDocumentSearchRecords } from "./document-records";
import { hashSearchRecords, hashSearchValue } from "./hash";
import { ProjectSearchSyncStore } from "./project-sync-store";

export type ProjectSearchSyncUnit = "canonical" | "documents";

export interface ProjectSearchSyncRunResult {
  attempted: ProjectSearchSyncUnit | null;
  succeeded: boolean;
  more_work: boolean;
  error: string | null;
}

type SearchIndexFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ProjectSearchSynchronizer {
  constructor(
    private readonly projectId: string,
    private readonly store: ProjectSearchSyncStore,
    private readonly ledger: DocumentLedgerRepository,
    private readonly fetchSearchIndex: SearchIndexFetch
  ) {}

  async runNext(state: ProjectState): Promise<ProjectSearchSyncRunResult> {
    this.assertState(state);

    // Canonical authority can advance before the local derived outbox request is
    // recorded (for example after an eviction/crash boundary). Repair that gap
    // every time derived work runs, then coalesce directly to the newest state.
    this.store.requestCanonical(state.revision);

    const status = this.store.status();
    if (status.canonical_revision_requested > status.canonical_revision_indexed) {
      return this.deliverCanonical(state);
    }

    const batch = this.store.nextDocumentBatch();
    if (batch) return this.deliverDocuments(batch);

    return {
      attempted: null,
      succeeded: true,
      more_work: false,
      error: null
    };
  }

  private async deliverCanonical(state: ProjectState): Promise<ProjectSearchSyncRunResult> {
    try {
      const records = await buildCanonicalSearchRecords(state);
      const request: CanonicalSnapshotRequest = {
        project_id: this.projectId,
        canonical_revision: state.revision,
        snapshot_hash: await hashSearchRecords(records),
        records
      };
      const response = await this.fetchSearchIndex("https://search-index.internal/apply-canonical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw new Error(await responseFailure(response, "canonical"));

      this.store.clearFailure({ scope: "canonical" });
      this.store.markCanonicalIndexed(state.revision);
      return {
        attempted: "canonical",
        succeeded: true,
        more_work: this.store.needsWork(),
        error: null
      };
    } catch (error) {
      const message = safeError(error);
      this.store.markFailure({ scope: "canonical", message });
      return {
        attempted: "canonical",
        succeeded: false,
        more_work: true,
        error: message
      };
    }
  }

  private async deliverDocuments(batch: ReturnType<ProjectSearchSyncStore["nextDocumentBatch"]> extends infer T
    ? Exclude<T, null>
    : never): Promise<ProjectSearchSyncRunResult> {
    try {
      const status = this.store.status();
      const documentIds = batch.full_snapshot
        ? await this.ledger.listHeadIds(this.projectId)
        : batch.document_ids;
      const records = (await buildManagedDocumentSearchRecords(
        this.ledger,
        this.projectId,
        documentIds
      )).sort((left, right) => left.record_id.localeCompare(right.record_id));
      const indexedIds = new Set(records.map((record) => record.document_id));
      const removedDocumentIds = batch.full_snapshot
        ? []
        : documentIds.filter((documentId) => !indexedIds.has(documentId));

      const request: DocumentBatchRequest = {
        project_id: this.projectId,
        document_epoch: status.document_epoch,
        document_epoch_started_at: status.document_epoch_started_at,
        document_generation: batch.generation,
        full_snapshot: batch.full_snapshot,
        snapshot_hash: await documentBatchHash({
          project_id: this.projectId,
          document_epoch: status.document_epoch,
          document_epoch_started_at: status.document_epoch_started_at,
          document_generation: batch.generation,
          full_snapshot: batch.full_snapshot,
          records,
          removed_document_ids: removedDocumentIds
        }),
        records,
        removed_document_ids: removedDocumentIds
      };
      const response = await this.fetchSearchIndex("https://search-index.internal/apply-documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw new Error(await responseFailure(response, "documents"));

      this.store.clearFailure({ scope: "document", generation: batch.generation });
      this.store.markDocumentIndexed(batch.generation);
      return {
        attempted: "documents",
        succeeded: true,
        more_work: this.store.needsWork(),
        error: null
      };
    } catch (error) {
      const message = safeError(error);
      this.store.markFailure({ scope: "document", generation: batch.generation, message });
      return {
        attempted: "documents",
        succeeded: false,
        more_work: true,
        error: message
      };
    }
  }

  private assertState(state: ProjectState): void {
    if (state.project_id !== this.projectId) {
      throw new Error(`Project search synchronizer binding mismatch: expected ${this.projectId}, got ${state.project_id}`);
    }
  }
}

async function documentBatchHash(input: {
  project_id: string;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation: number;
  full_snapshot: boolean;
  records: ManagedDocumentSearchRecord[];
  removed_document_ids: string[];
}): Promise<string> {
  return hashSearchValue({
    ...input,
    records: [...input.records].sort((left, right) => left.record_id.localeCompare(right.record_id)),
    removed_document_ids: [...input.removed_document_ids].sort()
  });
}

async function responseFailure(response: Response, scope: ProjectSearchSyncUnit): Promise<string> {
  let code = `SEARCH_INDEX_${scope.toUpperCase()}_FAILED`;
  let message = `SearchIndex ${scope} synchronization returned ${response.status}`;
  try {
    const body = await response.json<{ error?: unknown; message?: unknown }>();
    if (typeof body.error === "string" && body.error) code = body.error;
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    // Keep status-only diagnostics when the internal response is not JSON.
  }
  return `${code}: ${message}`.slice(0, 2_000);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
}
