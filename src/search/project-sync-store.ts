export interface SearchSyncStatus {
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation_requested: number;
  document_generation_indexed: number;
  document_full_rebuild_required: boolean;
  last_error: string | null;
}

export interface DocumentSyncBatch {
  generation: number;
  full_snapshot: boolean;
  document_ids: string[];
  attempts: number;
  last_error: string | null;
}

export type SearchSyncFailure =
  | { scope: "canonical"; message: string }
  | { scope: "document"; generation: number; message: string };

export type SearchSyncFailureRef =
  | { scope: "canonical" }
  | { scope: "document"; generation: number };

interface ControlRow {
  [key: string]: SqlStorageValue;
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation_requested: number;
  document_generation_indexed: number;
  last_error: string | null;
}

interface BatchRow {
  [key: string]: SqlStorageValue;
  generation: number;
  full_snapshot: number;
  document_ids_json: string;
  status: string;
  attempts: number;
  last_error: string | null;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

export function initializeProjectSearchSyncSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS search_sync_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      canonical_revision_requested INTEGER NOT NULL,
      canonical_revision_indexed INTEGER NOT NULL,
      document_epoch TEXT NOT NULL,
      document_epoch_started_at TEXT NOT NULL,
      document_generation_requested INTEGER NOT NULL,
      document_generation_indexed INTEGER NOT NULL,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS search_document_batches (
      generation INTEGER PRIMARY KEY,
      full_snapshot INTEGER NOT NULL CHECK (full_snapshot IN (0, 1)),
      document_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);

  storage.transactionSync(() => {
    const existing = storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM search_sync_control WHERE singleton = 1"
    ).one().count;
    if (existing > 0) return;

    const epoch = crypto.randomUUID();
    const epochStartedAt = new Date().toISOString();
    storage.sql.exec(
      `INSERT INTO search_sync_control (
         singleton,
         canonical_revision_requested,
         canonical_revision_indexed,
         document_epoch,
         document_epoch_started_at,
         document_generation_requested,
         document_generation_indexed,
         last_error
       ) VALUES (1, 0, 0, ?, ?, 1, 0, NULL)`,
      epoch,
      epochStartedAt
    );
    storage.sql.exec(
      `INSERT INTO search_document_batches (
         generation, full_snapshot, document_ids_json, status, attempts, last_error
       ) VALUES (1, 1, '[]', 'pending', 0, NULL)`
    );
  });
}

export class ProjectSearchSyncStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  requestCanonical(revision: number): void {
    assertRevision(revision, "canonical revision");
    const control = this.control();
    if (revision <= control.canonical_revision_requested) return;
    this.storage.sql.exec(
      `UPDATE search_sync_control
       SET canonical_revision_requested = ?
       WHERE singleton = 1`,
      revision
    );
  }

  requestDocuments(documentIds: readonly string[]): void {
    const ids = normalizeDocumentIds(documentIds);
    if (ids.length === 0) return;
    this.enqueueDocumentBatch(false, ids);
  }

  requestFullDocumentSnapshot(): void {
    this.enqueueDocumentBatch(true, []);
  }

  nextDocumentBatch(): DocumentSyncBatch | null {
    const control = this.control();
    if (control.document_generation_requested === control.document_generation_indexed) return null;
    if (control.document_generation_requested < control.document_generation_indexed) {
      throw new Error("Search document synchronization watermarks are invalid");
    }

    const expected = control.document_generation_indexed + 1;
    const rows = this.storage.sql.exec<BatchRow>(
      `SELECT generation, full_snapshot, document_ids_json, status, attempts, last_error
       FROM search_document_batches
       WHERE generation = ?`,
      expected
    ).toArray();
    if (rows.length !== 1) {
      throw new Error(`Search document synchronization generation gap at ${expected}`);
    }
    const row = rows[0];
    if (row.status !== "pending") {
      throw new Error(`Search document synchronization generation ${expected} is not pending`);
    }
    return parseBatchRow(row);
  }

  markCanonicalIndexed(revision: number): void {
    assertRevision(revision, "canonical indexed revision");
    const control = this.control();
    if (revision < control.canonical_revision_indexed) {
      throw new Error(
        `Cannot move canonical indexed revision backward: indexed=${control.canonical_revision_indexed} requested=${revision}`
      );
    }
    if (revision > control.canonical_revision_requested) {
      throw new Error(
        `Cannot index canonical revision beyond requested watermark: requested=${control.canonical_revision_requested} indexed=${revision}`
      );
    }
    this.storage.sql.exec(
      `UPDATE search_sync_control
       SET canonical_revision_indexed = ?
       WHERE singleton = 1`,
      revision
    );
  }

  markDocumentIndexed(generation: number): void {
    assertGeneration(generation);
    this.storage.transactionSync(() => {
      const control = this.control();
      const expected = control.document_generation_indexed + 1;
      if (generation !== expected) {
        throw new Error(`Search document generation must advance exactly to next generation ${expected}, got ${generation}`);
      }
      if (generation > control.document_generation_requested) {
        throw new Error(
          `Cannot index document generation beyond requested watermark: requested=${control.document_generation_requested} indexed=${generation}`
        );
      }
      const rows = this.storage.sql.exec<BatchRow>(
        `SELECT generation, full_snapshot, document_ids_json, status, attempts, last_error
         FROM search_document_batches
         WHERE generation = ?`,
        generation
      ).toArray();
      if (rows.length !== 1 || rows[0].status !== "pending") {
        throw new Error(`Search document generation ${generation} is missing or not pending`);
      }
      parseBatchRow(rows[0]);
      this.storage.sql.exec(
        `UPDATE search_document_batches
         SET status = 'completed', last_error = NULL
         WHERE generation = ? AND status = 'pending'`,
        generation
      );
      this.storage.sql.exec(
        `UPDATE search_sync_control
         SET document_generation_indexed = ?
         WHERE singleton = 1`,
        generation
      );
    });
  }

  markFailure(failure: SearchSyncFailure): void {
    if (failure.scope === "canonical") {
      this.storage.sql.exec(
        "UPDATE search_sync_control SET last_error = ? WHERE singleton = 1",
        safeError(failure.message)
      );
      return;
    }

    assertGeneration(failure.generation);
    const next = this.nextDocumentBatch();
    if (!next || next.generation !== failure.generation) {
      throw new Error(`Cannot fail non-current search document generation ${failure.generation}`);
    }
    this.storage.sql.exec(
      `UPDATE search_document_batches
       SET attempts = attempts + 1, last_error = ?
       WHERE generation = ? AND status = 'pending'`,
      safeError(failure.message),
      failure.generation
    );
  }

  clearFailure(ref: SearchSyncFailureRef): void {
    if (ref.scope === "canonical") {
      this.storage.sql.exec("UPDATE search_sync_control SET last_error = NULL WHERE singleton = 1");
      return;
    }
    assertGeneration(ref.generation);
    this.storage.sql.exec(
      `UPDATE search_document_batches
       SET last_error = NULL
       WHERE generation = ? AND status = 'pending'`,
      ref.generation
    );
  }

  status(): SearchSyncStatus {
    const control = this.control();
    return {
      canonical_revision_requested: control.canonical_revision_requested,
      canonical_revision_indexed: control.canonical_revision_indexed,
      document_epoch: control.document_epoch,
      document_epoch_started_at: control.document_epoch_started_at,
      document_generation_requested: control.document_generation_requested,
      document_generation_indexed: control.document_generation_indexed,
      document_full_rebuild_required: this.pendingFullSnapshotCount(control.document_generation_indexed) > 0,
      last_error: control.last_error
    };
  }

  needsWork(): boolean {
    const control = this.control();
    if (control.canonical_revision_requested > control.canonical_revision_indexed) return true;
    return this.nextDocumentBatch() !== null;
  }

  private enqueueDocumentBatch(fullSnapshot: boolean, documentIds: readonly string[]): void {
    this.storage.transactionSync(() => {
      const control = this.control();
      if (control.document_generation_requested < control.document_generation_indexed) {
        throw new Error("Search document synchronization watermarks are invalid");
      }
      const generation = control.document_generation_requested + 1;
      this.storage.sql.exec(
        `INSERT INTO search_document_batches (
           generation, full_snapshot, document_ids_json, status, attempts, last_error
         ) VALUES (?, ?, ?, 'pending', 0, NULL)`,
        generation,
        fullSnapshot ? 1 : 0,
        JSON.stringify(documentIds)
      );
      this.storage.sql.exec(
        `UPDATE search_sync_control
         SET document_generation_requested = ?
         WHERE singleton = 1`,
        generation
      );
    });
  }

  private pendingFullSnapshotCount(indexedGeneration: number): number {
    return this.storage.sql.exec<CountRow>(
      `SELECT COUNT(*) AS count
       FROM search_document_batches
       WHERE status = 'pending' AND full_snapshot = 1 AND generation > ?`,
      indexedGeneration
    ).one().count;
  }

  private control(): ControlRow {
    const rows = this.storage.sql.exec<ControlRow>(
      `SELECT
         canonical_revision_requested,
         canonical_revision_indexed,
         document_epoch,
         document_epoch_started_at,
         document_generation_requested,
         document_generation_indexed,
         last_error
       FROM search_sync_control
       WHERE singleton = 1`
    ).toArray();
    if (rows.length !== 1) throw new Error("Search synchronization control row is missing or duplicated");
    const row = rows[0];
    assertRevision(row.canonical_revision_requested, "canonical requested revision");
    assertRevision(row.canonical_revision_indexed, "canonical indexed revision");
    assertGenerationOrZero(row.document_generation_requested, "document requested generation");
    assertGenerationOrZero(row.document_generation_indexed, "document indexed generation");
    if (row.canonical_revision_indexed > row.canonical_revision_requested) {
      throw new Error("Search canonical synchronization watermarks are invalid");
    }
    if (row.document_generation_indexed > row.document_generation_requested) {
      throw new Error("Search document synchronization watermarks are invalid");
    }
    if (!row.document_epoch || !row.document_epoch_started_at) {
      throw new Error("Search document synchronization epoch is missing");
    }
    return row;
  }
}

function parseBatchRow(row: BatchRow): DocumentSyncBatch {
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
    throw new Error(`Invalid search document batch generation: ${row.generation}`);
  }
  if (row.full_snapshot !== 0 && row.full_snapshot !== 1) {
    throw new Error(`Invalid search document batch full_snapshot flag: ${row.full_snapshot}`);
  }
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 0) {
    throw new Error(`Invalid search document batch attempts: ${row.attempts}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document_ids_json);
  } catch {
    throw new Error(`Invalid search document batch JSON for generation ${row.generation}`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`Invalid search document batch document IDs for generation ${row.generation}`);
  }
  const documentIds = normalizeDocumentIds(parsed as string[]);
  if (JSON.stringify(documentIds) !== JSON.stringify(parsed)) {
    throw new Error(`Search document batch IDs are not canonical for generation ${row.generation}`);
  }
  if (row.full_snapshot === 1 && documentIds.length !== 0) {
    throw new Error(`Full search document snapshot generation ${row.generation} must not carry explicit document IDs`);
  }

  return {
    generation: row.generation,
    full_snapshot: row.full_snapshot === 1,
    document_ids: documentIds,
    attempts: row.attempts,
    last_error: row.last_error
  };
}

function normalizeDocumentIds(values: readonly string[]): string[] {
  const result = [...new Set(values.map(assertDocumentId))].sort();
  return result;
}

function assertDocumentId(value: string): string {
  if (!/^DOC-[A-F0-9]{24}$/.test(value)) throw new Error(`Unsafe managed document id for search sync: ${value}`);
  return value;
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}: ${value}`);
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid search document generation: ${value}`);
}

function assertGenerationOrZero(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}: ${value}`);
}

function safeError(value: string): string {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
}
