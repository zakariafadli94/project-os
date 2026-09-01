import type { Env } from "../env";
import { DocumentLedgerRepository } from "../documents/repository";
import { createProductionPersistence } from "../persistence/production-factory";
import { ProjectRepository } from "../persistence/repository-core";
import { buildCanonicalSearchRecords } from "./canonical-records";
import type { SearchRecord } from "./contract";
import { buildManagedDocumentSearchRecord } from "./document-records";
import { hashSearchRecords, hashSearchValue } from "./hash";

const MAX_DOCUMENTS_PER_ALARM = 32;
const MAX_CLEANUP_RECORDS_PER_ALARM = 32;

type RebuildPhase = "enumerating" | "indexing" | "validating" | "failed";

interface SourceSearchStatus {
  project_id: string;
  canonical_revision: number;
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation_requested: number;
  document_generation_indexed: number;
}

interface RebuildJobRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  staging_generation: number;
  target_canonical_revision: number;
  target_canonical_snapshot_hash: string;
  target_document_epoch: string;
  target_document_epoch_started_at: string;
  target_document_generation: number;
  phase: RebuildPhase;
  started_at: string;
  last_error: string | null;
}

interface RebuildItemRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  staging_generation: number;
  document_id: string;
  status: "pending" | "completed";
  attempts: number;
  last_error: string | null;
  searchable: number | null;
}

interface HeadGenerationRow {
  [key: string]: SqlStorageValue;
  active_generation: number;
}

interface CleanupRecordRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  generation: number;
  record_id: string;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface SumRow {
  [key: string]: SqlStorageValue;
  total: number | null;
}

interface RootRow {
  [key: string]: SqlStorageValue;
  record_id: string;
  content_hash: string;
}

export interface SearchRebuildStatus {
  project_id: string;
  active_generation: number | null;
  staging_generation: number;
  phase: RebuildPhase;
  target_canonical_revision: number;
  target_document_generation: number;
  pending_items: number;
  completed_items: number;
  failed_items: number;
  last_error: string | null;
}

export function initializeSearchRebuildSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS search_rebuild_jobs (
      project_id TEXT PRIMARY KEY,
      staging_generation INTEGER NOT NULL,
      target_canonical_revision INTEGER NOT NULL,
      target_canonical_snapshot_hash TEXT NOT NULL,
      target_document_epoch TEXT NOT NULL,
      target_document_epoch_started_at TEXT NOT NULL,
      target_document_generation INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('enumerating', 'indexing', 'validating', 'failed')),
      started_at TEXT NOT NULL,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS search_rebuild_items (
      project_id TEXT NOT NULL,
      staging_generation INTEGER NOT NULL,
      document_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      searchable INTEGER CHECK (searchable IN (0, 1) OR searchable IS NULL),
      PRIMARY KEY(project_id, staging_generation, document_id)
    );

    CREATE INDEX IF NOT EXISTS idx_search_rebuild_items_pending
      ON search_rebuild_items(project_id, staging_generation, status, document_id);
  `);
}

export class SearchRebuildCoordinator {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env
  ) {
    initializeSearchRebuildSchema(storage);
  }

  async start(projectId: string): Promise<SearchRebuildStatus> {
    assertProjectId(projectId);
    const source = await this.sourceStatus(projectId);
    const state = await this.authoritativeState(projectId);
    if (state.revision !== source.canonical_revision_requested) {
      throw new Error("SOURCE_CHANGED_DURING_REBUILD");
    }

    const existing = this.job(projectId);
    if (existing && sameTarget(existing, source)) {
      if (existing.phase === "failed") {
        this.storage.transactionSync(() => {
          this.storage.sql.exec(
            `UPDATE search_rebuild_jobs SET phase = 'indexing', last_error = NULL WHERE project_id = ?`,
            projectId
          );
          this.storage.sql.exec(
            `UPDATE search_rebuild_items SET last_error = NULL
             WHERE project_id = ? AND staging_generation = ? AND status = 'pending'`,
            projectId,
            existing.staging_generation
          );
          this.markHeadRebuilding(projectId);
        });
      }
      return this.requireStatus(projectId);
    }

    if (existing) this.discardStaging(existing);

    const canonicalRecords = await buildCanonicalSearchRecords(state);
    const canonicalSnapshotHash = await hashSearchRecords(canonicalRecords);
    const runtime = createProductionPersistence(this.env, projectId);
    const ledger = new DocumentLedgerRepository(runtime);
    const documentIds = await ledger.listHeadIds(projectId);
    const activeGeneration = this.activeGeneration(projectId);
    const stagingGeneration = (activeGeneration ?? 0) + 1;
    const startedAt = new Date().toISOString();

    this.storage.transactionSync(() => {
      this.deleteGeneration(projectId, stagingGeneration);
      this.storage.sql.exec(
        `INSERT INTO search_rebuild_jobs (
           project_id, staging_generation, target_canonical_revision, target_canonical_snapshot_hash,
           target_document_epoch, target_document_epoch_started_at, target_document_generation,
           phase, started_at, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, NULL)`,
        projectId,
        stagingGeneration,
        source.canonical_revision_requested,
        canonicalSnapshotHash,
        source.document_epoch,
        source.document_epoch_started_at,
        source.document_generation_requested,
        startedAt
      );
      for (const record of canonicalRecords) this.insertRecord(record, stagingGeneration);
      for (const documentId of documentIds) {
        this.storage.sql.exec(
          `INSERT INTO search_rebuild_items (
             project_id, staging_generation, document_id, status, attempts, last_error, searchable
           ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL)`,
          projectId,
          stagingGeneration,
          documentId
        );
      }
      this.markHeadRebuilding(projectId);
    });

    return this.requireStatus(projectId);
  }

  status(projectId: string): SearchRebuildStatus | null {
    assertProjectId(projectId);
    const job = this.job(projectId);
    if (!job) return null;
    const pending = this.countItems(job, "status = 'pending'");
    const completed = this.countItems(job, "status = 'completed'");
    const failed = this.countItems(job, "status = 'pending' AND last_error IS NOT NULL");
    return {
      project_id: projectId,
      active_generation: this.activeGeneration(projectId),
      staging_generation: job.staging_generation,
      phase: job.phase,
      target_canonical_revision: job.target_canonical_revision,
      target_document_generation: job.target_document_generation,
      pending_items: pending,
      completed_items: completed,
      failed_items: failed,
      last_error: job.last_error
    };
  }

  hasRunnableWork(): boolean {
    const rebuildCount = this.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM search_rebuild_jobs WHERE phase IN ('indexing', 'validating')`
    ).one().count;
    if (rebuildCount > 0) return true;

    return this.storage.sql.exec<CleanupRecordRow>(
      `SELECT records.project_id, records.generation, records.record_id
       FROM search_records records
       JOIN search_project_heads heads ON heads.project_id = records.project_id
       WHERE records.generation < heads.active_generation
       ORDER BY records.project_id, records.generation, records.record_id
       LIMIT 1`
    ).toArray().length > 0;
  }

  async runNext(): Promise<void> {
    const job = this.storage.sql.exec<RebuildJobRow>(
      `SELECT project_id, staging_generation, target_canonical_revision, target_canonical_snapshot_hash,
              target_document_epoch, target_document_epoch_started_at, target_document_generation,
              phase, started_at, last_error
       FROM search_rebuild_jobs
       WHERE phase IN ('indexing', 'validating')
       ORDER BY started_at, project_id
       LIMIT 1`
    ).toArray()[0];
    if (!job) {
      this.cleanupOldGenerationBatch();
      return;
    }

    if (job.phase === "indexing") {
      const pending = this.storage.sql.exec<RebuildItemRow>(
        `SELECT project_id, staging_generation, document_id, status, attempts, last_error, searchable
         FROM search_rebuild_items
         WHERE project_id = ? AND staging_generation = ? AND status = 'pending'
         ORDER BY document_id
         LIMIT ?`,
        job.project_id,
        job.staging_generation,
        MAX_DOCUMENTS_PER_ALARM
      ).toArray();

      if (pending.length > 0) {
        const runtime = createProductionPersistence(this.env, job.project_id);
        const ledger = new DocumentLedgerRepository(runtime);
        for (const item of pending) {
          try {
            const record = await buildManagedDocumentSearchRecord(ledger, job.project_id, item.document_id);
            this.storage.transactionSync(() => {
              if (record) this.upsertRecord(record, job.staging_generation);
              this.storage.sql.exec(
                `UPDATE search_rebuild_items
                 SET status = 'completed', attempts = attempts + 1, last_error = NULL, searchable = ?
                 WHERE project_id = ? AND staging_generation = ? AND document_id = ? AND status = 'pending'`,
                record ? 1 : 0,
                job.project_id,
                job.staging_generation,
                item.document_id
              );
            });
          } catch (error) {
            const message = safeError(error);
            this.storage.transactionSync(() => {
              this.storage.sql.exec(
                `UPDATE search_rebuild_items
                 SET attempts = attempts + 1, last_error = ?
                 WHERE project_id = ? AND staging_generation = ? AND document_id = ? AND status = 'pending'`,
                message,
                job.project_id,
                job.staging_generation,
                item.document_id
              );
              this.failJob(job.project_id, message);
            });
            return;
          }
        }
      }

      if (this.countItems(job, "status = 'pending'") > 0) return;
      this.storage.sql.exec(
        `UPDATE search_rebuild_jobs SET phase = 'validating', last_error = NULL WHERE project_id = ?`,
        job.project_id
      );
    }

    await this.validateAndPromote(this.requireJob(job.project_id));
  }

  private async validateAndPromote(job: RebuildJobRow): Promise<void> {
    const source = await this.sourceStatus(job.project_id);
    if (!sameTarget(job, source)) {
      this.failJob(job.project_id, "SOURCE_CHANGED_DURING_REBUILD");
      return;
    }
    const state = await this.authoritativeState(job.project_id);
    if (state.revision !== job.target_canonical_revision) {
      this.failJob(job.project_id, "SOURCE_CHANGED_DURING_REBUILD");
      return;
    }

    const pending = this.countItems(job, "status = 'pending'");
    if (pending !== 0) {
      this.failJob(job.project_id, "REBUILD_ITEMS_STILL_PENDING");
      return;
    }

    const canonicalCount = this.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM search_records
       WHERE project_id = ? AND generation = ? AND record_kind = 'canonical_entity'
         AND canonical_revision = ?`,
      job.project_id,
      job.staging_generation,
      job.target_canonical_revision
    ).one().count;
    if (canonicalCount < 1) {
      this.failJob(job.project_id, "REBUILD_CANONICAL_SNAPSHOT_MISSING");
      return;
    }

    const searchableExpected = this.storage.sql.exec<SumRow>(
      `SELECT SUM(CASE WHEN searchable = 1 THEN 1 ELSE 0 END) AS total
       FROM search_rebuild_items WHERE project_id = ? AND staging_generation = ?`,
      job.project_id,
      job.staging_generation
    ).one().total ?? 0;
    const searchableActual = this.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM search_records
       WHERE project_id = ? AND generation = ? AND record_kind = 'managed_document'`,
      job.project_id,
      job.staging_generation
    ).one().count;
    if (searchableActual !== searchableExpected) {
      this.failJob(job.project_id, "REBUILD_DOCUMENT_COUNT_MISMATCH");
      return;
    }

    const rootRows = this.storage.sql.exec<RootRow>(
      `SELECT record_id, content_hash FROM search_records
       WHERE project_id = ? AND generation = ? ORDER BY record_id`,
      job.project_id,
      job.staging_generation
    ).toArray();
    const rootHash = await hashSearchValue(rootRows.map((row) => [row.record_id, row.content_hash]));
    const updatedAt = new Date().toISOString();

    this.storage.transactionSync(() => {
      const current = this.requireJob(job.project_id);
      if (current.staging_generation !== job.staging_generation || current.phase !== "validating") {
        throw new Error("REBUILD_JOB_CHANGED_DURING_PROMOTION");
      }
      const active = this.activeGeneration(job.project_id);
      if (active === null) {
        this.storage.sql.exec(
          `INSERT INTO search_project_heads (
             project_id, active_generation, canonical_revision_indexed, canonical_snapshot_hash,
             document_epoch, document_epoch_started_at, document_generation_indexed, document_snapshot_hash,
             rebuild_state, last_error, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?)`,
          job.project_id,
          job.staging_generation,
          job.target_canonical_revision,
          job.target_canonical_snapshot_hash,
          job.target_document_epoch,
          job.target_document_epoch_started_at,
          job.target_document_generation,
          `rebuild:${rootHash}`,
          updatedAt
        );
      } else {
        this.storage.sql.exec(
          `UPDATE search_project_heads
           SET active_generation = ?, canonical_revision_indexed = ?, canonical_snapshot_hash = ?,
               document_epoch = ?, document_epoch_started_at = ?, document_generation_indexed = ?,
               document_snapshot_hash = ?, rebuild_state = 'ready', last_error = NULL, updated_at = ?
           WHERE project_id = ?`,
          job.staging_generation,
          job.target_canonical_revision,
          job.target_canonical_snapshot_hash,
          job.target_document_epoch,
          job.target_document_epoch_started_at,
          job.target_document_generation,
          `rebuild:${rootHash}`,
          updatedAt,
          job.project_id
        );
      }
      this.storage.sql.exec(`DELETE FROM search_rebuild_items WHERE project_id = ?`, job.project_id);
      this.storage.sql.exec(`DELETE FROM search_rebuild_jobs WHERE project_id = ?`, job.project_id);
    });
  }

  private async sourceStatus(projectId: string): Promise<SourceSearchStatus> {
    const response = await this.env.PROJECT_GUARD.getByName(projectId).fetch(
      "https://project-guard.internal/search-sync-status",
      { method: "GET" }
    );
    if (!response.ok) throw new Error(`SEARCH_REBUILD_SOURCE_STATUS_${response.status}`);
    const status = await response.json<SourceSearchStatus>();
    if (
      status.project_id !== projectId
      || !Number.isSafeInteger(status.canonical_revision_requested)
      || !Number.isSafeInteger(status.document_generation_requested)
      || !status.document_epoch
      || !status.document_epoch_started_at
    ) {
      throw new Error("SEARCH_REBUILD_SOURCE_STATUS_INVALID");
    }
    return status;
  }

  private async authoritativeState(projectId: string) {
    const runtime = createProductionPersistence(this.env, projectId);
    const repository = new ProjectRepository(runtime, "v2");
    const state = await repository.readProjectState(projectId);
    if (!state) throw new Error("SEARCH_REBUILD_CANONICAL_STATE_MISSING");
    return state;
  }

  private job(projectId: string): RebuildJobRow | null {
    return this.storage.sql.exec<RebuildJobRow>(
      `SELECT project_id, staging_generation, target_canonical_revision, target_canonical_snapshot_hash,
              target_document_epoch, target_document_epoch_started_at, target_document_generation,
              phase, started_at, last_error
       FROM search_rebuild_jobs WHERE project_id = ?`,
      projectId
    ).toArray()[0] ?? null;
  }

  private requireJob(projectId: string): RebuildJobRow {
    const job = this.job(projectId);
    if (!job) throw new Error("SEARCH_REBUILD_JOB_MISSING");
    return job;
  }

  private requireStatus(projectId: string): SearchRebuildStatus {
    const status = this.status(projectId);
    if (!status) throw new Error("SEARCH_REBUILD_JOB_MISSING");
    return status;
  }

  private activeGeneration(projectId: string): number | null {
    const row = this.storage.sql.exec<HeadGenerationRow>(
      `SELECT active_generation FROM search_project_heads WHERE project_id = ?`,
      projectId
    ).toArray()[0];
    return row?.active_generation ?? null;
  }

  private countItems(job: RebuildJobRow, predicate: string): number {
    return this.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM search_rebuild_items
       WHERE project_id = ? AND staging_generation = ? AND ${predicate}`,
      job.project_id,
      job.staging_generation
    ).one().count;
  }

  private markHeadRebuilding(projectId: string): void {
    this.storage.sql.exec(
      `UPDATE search_project_heads
       SET rebuild_state = 'rebuilding', last_error = NULL, updated_at = ?
       WHERE project_id = ?`,
      new Date().toISOString(),
      projectId
    );
  }

  private failJob(projectId: string, messageInput: string): void {
    const message = safeError(messageInput);
    this.storage.sql.exec(
      `UPDATE search_rebuild_jobs SET phase = 'failed', last_error = ? WHERE project_id = ?`,
      message,
      projectId
    );
    this.storage.sql.exec(
      `UPDATE search_project_heads
       SET rebuild_state = 'failed', last_error = ?, updated_at = ? WHERE project_id = ?`,
      message,
      new Date().toISOString(),
      projectId
    );
  }

  private cleanupOldGenerationBatch(): void {
    const staleRecords = this.storage.sql.exec<CleanupRecordRow>(
      `SELECT records.project_id, records.generation, records.record_id
       FROM search_records records
       JOIN search_project_heads heads ON heads.project_id = records.project_id
       WHERE records.generation < heads.active_generation
       ORDER BY records.project_id, records.generation, records.record_id
       LIMIT ?`,
      MAX_CLEANUP_RECORDS_PER_ALARM
    ).toArray();
    if (staleRecords.length === 0) return;

    this.storage.transactionSync(() => {
      for (const record of staleRecords) {
        this.deleteRecord(record.project_id, record.generation, record.record_id);
      }
    });
  }

  private discardStaging(job: RebuildJobRow): void {
    this.storage.transactionSync(() => {
      this.deleteGeneration(job.project_id, job.staging_generation);
      this.storage.sql.exec(`DELETE FROM search_rebuild_items WHERE project_id = ?`, job.project_id);
      this.storage.sql.exec(`DELETE FROM search_rebuild_jobs WHERE project_id = ?`, job.project_id);
    });
  }

  private upsertRecord(record: SearchRecord, generation: number): void {
    this.deleteRecord(record.project_id, generation, record.record_id);
    this.insertRecord(record, generation);
  }

  private insertRecord(record: SearchRecord, generation: number): void {
    const canonical = record.record_kind === "canonical_entity" ? record : null;
    const document = record.record_kind === "managed_document" ? record : null;
    this.storage.sql.exec(
      `INSERT INTO search_records (
         project_id, generation, record_id, record_kind, entity_type, entity_id, document_id, version_id,
         title, status, zone, logical_path, stage_or_collection, reconciliation_status, content_hash,
         canonical_revision, body_text, authority_ref_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.project_id,
      generation,
      record.record_id,
      record.record_kind,
      canonical?.entity_type ?? null,
      canonical?.entity_id ?? null,
      document?.document_id ?? null,
      document?.version_id ?? null,
      record.title,
      canonical?.status ?? null,
      document?.zone ?? null,
      document?.logical_path ?? null,
      document?.stage_or_collection ?? null,
      document?.reconciliation_status ?? null,
      record.content_hash,
      canonical?.canonical_revision ?? null,
      record.body_text ?? null,
      JSON.stringify(record.authority_ref),
      record.updated_at ?? null
    );
    this.storage.sql.exec(
      `INSERT INTO search_fts (project_id, generation, record_id, title, body_text)
       VALUES (?, ?, ?, ?, ?)`,
      record.project_id,
      generation,
      record.record_id,
      record.title,
      record.body_text ?? ""
    );
  }

  private deleteRecord(projectId: string, generation: number, recordId: string): void {
    this.storage.sql.exec(
      `DELETE FROM search_fts WHERE project_id = ? AND generation = ? AND record_id = ?`,
      projectId,
      generation,
      recordId
    );
    this.storage.sql.exec(
      `DELETE FROM search_records WHERE project_id = ? AND generation = ? AND record_id = ?`,
      projectId,
      generation,
      recordId
    );
  }

  private deleteGeneration(projectId: string, generation: number): void {
    this.storage.sql.exec(
      `DELETE FROM search_fts WHERE project_id = ? AND generation = ?`,
      projectId,
      generation
    );
    this.storage.sql.exec(
      `DELETE FROM search_records WHERE project_id = ? AND generation = ?`,
      projectId,
      generation
    );
  }
}

function sameTarget(job: RebuildJobRow, source: SourceSearchStatus): boolean {
  return job.target_canonical_revision === source.canonical_revision_requested
    && job.target_document_epoch === source.document_epoch
    && job.target_document_epoch_started_at === source.document_epoch_started_at
    && job.target_document_generation === source.document_generation_requested;
}

function assertProjectId(projectId: string): void {
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("INVALID_PROJECT_ID");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
}