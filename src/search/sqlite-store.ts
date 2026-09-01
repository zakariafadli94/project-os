import type {
  CanonicalSearchRecord,
  CanonicalSnapshotRequest,
  DocumentBatchRequest,
  ManagedDocumentSearchRecord,
  SearchIndexProjectStatus,
  SearchRecord
} from "./contract";

export interface SearchApplyResult {
  status: "applied" | "idempotent" | "stale";
}

interface HeadRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  active_generation: number;
  canonical_revision_indexed: number;
  canonical_snapshot_hash: string;
  document_epoch: string | null;
  document_epoch_started_at: string | null;
  document_generation_indexed: number;
  document_snapshot_hash: string | null;
  rebuild_state: string;
  last_error: string | null;
  updated_at: string;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

export function initializeSearchIndexSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS search_project_heads (
      project_id TEXT PRIMARY KEY,
      active_generation INTEGER NOT NULL,
      canonical_revision_indexed INTEGER NOT NULL,
      canonical_snapshot_hash TEXT NOT NULL,
      document_epoch TEXT,
      document_epoch_started_at TEXT,
      document_generation_indexed INTEGER NOT NULL,
      document_snapshot_hash TEXT,
      rebuild_state TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_records (
      project_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      record_id TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      document_id TEXT,
      version_id TEXT,
      title TEXT NOT NULL,
      status TEXT,
      zone TEXT,
      logical_path TEXT,
      stage_or_collection TEXT,
      reconciliation_status TEXT,
      content_hash TEXT NOT NULL,
      canonical_revision INTEGER,
      body_text TEXT,
      authority_ref_json TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY(project_id, generation, record_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      project_id UNINDEXED,
      generation UNINDEXED,
      record_id UNINDEXED,
      title,
      body_text,
      tokenize = 'unicode61'
    );

    CREATE INDEX IF NOT EXISTS idx_search_records_kind
      ON search_records(project_id, generation, record_kind);
    CREATE INDEX IF NOT EXISTS idx_search_records_entity
      ON search_records(project_id, generation, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_search_records_document
      ON search_records(project_id, generation, document_id);
    CREATE INDEX IF NOT EXISTS idx_search_records_zone
      ON search_records(project_id, generation, zone);
    CREATE INDEX IF NOT EXISTS idx_search_records_status
      ON search_records(project_id, generation, status);
  `);
}

export class SearchIndexStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  status(projectId: string): SearchIndexProjectStatus {
    assertProjectId(projectId);
    const head = this.head(projectId);
    if (!head) {
      return {
        project_id: projectId,
        freshness: "unknown",
        active_generation: null,
        canonical_revision_indexed: 0,
        document_generation_indexed: 0,
        rebuild_state: "missing"
      };
    }
    return {
      project_id: projectId,
      freshness: head.last_error ? "failed" : head.rebuild_state === "rebuilding" ? "rebuilding" : "current",
      active_generation: head.active_generation,
      canonical_revision_indexed: head.canonical_revision_indexed,
      canonical_snapshot_hash: head.canonical_snapshot_hash,
      ...(head.document_epoch ? { document_epoch: head.document_epoch } : {}),
      ...(head.document_epoch_started_at ? { document_epoch_started_at: head.document_epoch_started_at } : {}),
      document_generation_indexed: head.document_generation_indexed,
      ...(head.document_snapshot_hash ? { document_snapshot_hash: head.document_snapshot_hash } : {}),
      rebuild_state: head.rebuild_state,
      ...(head.last_error ? { last_error: head.last_error } : {}),
      updated_at: head.updated_at
    };
  }

  applyCanonical(request: CanonicalSnapshotRequest): SearchApplyResult {
    validateCanonicalSnapshot(request);
    const existing = this.head(request.project_id);
    if (existing) {
      if (request.canonical_revision < existing.canonical_revision_indexed) return { status: "stale" };
      if (request.canonical_revision === existing.canonical_revision_indexed) {
        if (request.snapshot_hash !== existing.canonical_snapshot_hash) {
          throw new Error("CANONICAL_SNAPSHOT_HASH_MISMATCH");
        }
        return { status: "idempotent" };
      }
    }

    const generation = existing?.active_generation ?? 1;
    const updatedAt = new Date().toISOString();
    this.storage.transactionSync(() => {
      const current = this.head(request.project_id);
      if (current) {
        if (request.canonical_revision < current.canonical_revision_indexed) return;
        if (request.canonical_revision === current.canonical_revision_indexed) {
          if (request.snapshot_hash !== current.canonical_snapshot_hash) {
            throw new Error("CANONICAL_SNAPSHOT_HASH_MISMATCH");
          }
          return;
        }
      }

      this.deleteRecordKind(request.project_id, generation, "canonical_entity");
      for (const record of request.records) this.insertRecord(record, generation);

      if (current) {
        this.storage.sql.exec(
          `UPDATE search_project_heads
           SET canonical_revision_indexed = ?, canonical_snapshot_hash = ?, last_error = NULL, updated_at = ?
           WHERE project_id = ?`,
          request.canonical_revision,
          request.snapshot_hash,
          updatedAt,
          request.project_id
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO search_project_heads (
             project_id, active_generation, canonical_revision_indexed, canonical_snapshot_hash,
             document_epoch, document_epoch_started_at, document_generation_indexed, document_snapshot_hash,
             rebuild_state, last_error, updated_at
           ) VALUES (?, 1, ?, ?, NULL, NULL, 0, NULL, 'ready', NULL, ?)`,
          request.project_id,
          request.canonical_revision,
          request.snapshot_hash,
          updatedAt
        );
      }
    });
    return { status: "applied" };
  }

  applyDocuments(request: DocumentBatchRequest): SearchApplyResult {
    validateDocumentBatch(request);
    const existing = this.head(request.project_id);
    if (!existing) throw new Error("SEARCH_PROJECT_NOT_INITIALIZED");

    const epochMode = documentEpochMode(existing, request);
    if (epochMode === "stale") throw new Error("DOCUMENT_EPOCH_STALE");
    if (epochMode === "new" && !request.full_snapshot) {
      throw new Error("DOCUMENT_EPOCH_REQUIRES_FULL_SNAPSHOT");
    }
    if (epochMode === "new" && request.document_generation !== 1) {
      throw new Error("DOCUMENT_EPOCH_REQUIRES_GENERATION_ONE");
    }

    if (epochMode === "same") {
      if (request.document_epoch_started_at !== existing.document_epoch_started_at) {
        throw new Error("DOCUMENT_EPOCH_START_MISMATCH");
      }
      if (request.document_generation < existing.document_generation_indexed) return { status: "stale" };
      if (request.document_generation === existing.document_generation_indexed) {
        if (request.snapshot_hash !== existing.document_snapshot_hash) {
          throw new Error("DOCUMENT_SNAPSHOT_HASH_MISMATCH");
        }
        return { status: "idempotent" };
      }
      if (request.document_generation !== existing.document_generation_indexed + 1) {
        throw new Error("DOCUMENT_GENERATION_GAP");
      }
    }

    const generation = existing.active_generation;
    const updatedAt = new Date().toISOString();
    this.storage.transactionSync(() => {
      const current = this.requireHead(request.project_id);
      const currentMode = documentEpochMode(current, request);
      if (currentMode === "stale") throw new Error("DOCUMENT_EPOCH_STALE");
      if (currentMode === "new") {
        if (!request.full_snapshot) throw new Error("DOCUMENT_EPOCH_REQUIRES_FULL_SNAPSHOT");
        if (request.document_generation !== 1) throw new Error("DOCUMENT_EPOCH_REQUIRES_GENERATION_ONE");
      } else {
        if (request.document_epoch_started_at !== current.document_epoch_started_at) {
          throw new Error("DOCUMENT_EPOCH_START_MISMATCH");
        }
        if (request.document_generation < current.document_generation_indexed) return;
        if (request.document_generation === current.document_generation_indexed) {
          if (request.snapshot_hash !== current.document_snapshot_hash) {
            throw new Error("DOCUMENT_SNAPSHOT_HASH_MISMATCH");
          }
          return;
        }
        if (request.document_generation !== current.document_generation_indexed + 1) {
          throw new Error("DOCUMENT_GENERATION_GAP");
        }
      }

      if (request.full_snapshot) {
        this.deleteRecordKind(request.project_id, generation, "managed_document");
      } else {
        for (const documentId of request.removed_document_ids) {
          this.deleteRecord(request.project_id, generation, `document:${documentId}`);
        }
      }
      for (const record of request.records) {
        this.deleteRecord(request.project_id, generation, record.record_id);
        this.insertRecord(record, generation);
      }

      this.storage.sql.exec(
        `UPDATE search_project_heads
         SET document_epoch = ?, document_epoch_started_at = ?, document_generation_indexed = ?,
             document_snapshot_hash = ?, last_error = NULL, updated_at = ?
         WHERE project_id = ?`,
        request.document_epoch,
        request.document_epoch_started_at,
        request.document_generation,
        request.snapshot_hash,
        updatedAt,
        request.project_id
      );
    });
    return { status: "applied" };
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

  private deleteRecordKind(projectId: string, generation: number, kind: SearchRecord["record_kind"]): void {
    const rows = this.storage.sql.exec<{ [key: string]: SqlStorageValue; record_id: string }>(
      `SELECT record_id FROM search_records
       WHERE project_id = ? AND generation = ? AND record_kind = ?`,
      projectId,
      generation,
      kind
    ).toArray();
    for (const row of rows) this.deleteFtsRecord(projectId, generation, row.record_id);
    this.storage.sql.exec(
      `DELETE FROM search_records WHERE project_id = ? AND generation = ? AND record_kind = ?`,
      projectId,
      generation,
      kind
    );
  }

  private deleteRecord(projectId: string, generation: number, recordId: string): void {
    this.deleteFtsRecord(projectId, generation, recordId);
    this.storage.sql.exec(
      `DELETE FROM search_records WHERE project_id = ? AND generation = ? AND record_id = ?`,
      projectId,
      generation,
      recordId
    );
  }

  private deleteFtsRecord(projectId: string, generation: number, recordId: string): void {
    this.storage.sql.exec(
      `DELETE FROM search_fts WHERE project_id = ? AND generation = ? AND record_id = ?`,
      projectId,
      generation,
      recordId
    );
  }

  private requireHead(projectId: string): HeadRow {
    const head = this.head(projectId);
    if (!head) throw new Error("SEARCH_PROJECT_NOT_INITIALIZED");
    return head;
  }

  private head(projectId: string): HeadRow | null {
    const rows = this.storage.sql.exec<HeadRow>(
      `SELECT project_id, active_generation, canonical_revision_indexed, canonical_snapshot_hash,
              document_epoch, document_epoch_started_at, document_generation_indexed, document_snapshot_hash,
              rebuild_state, last_error, updated_at
       FROM search_project_heads WHERE project_id = ?`,
      projectId
    ).toArray();
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error(`Search project head duplicated: ${projectId}`);
    return rows[0];
  }
}

function validateCanonicalSnapshot(request: CanonicalSnapshotRequest): void {
  assertProjectId(request.project_id);
  assertRevision(request.canonical_revision);
  assertHash(request.snapshot_hash, "canonical snapshot hash");
  const ids = new Set<string>();
  for (const record of request.records) {
    if (record.record_kind !== "canonical_entity") throw new Error("Canonical snapshot contains non-canonical record");
    if (record.project_id !== request.project_id) throw new Error("Canonical snapshot project binding mismatch");
    if (record.canonical_revision !== request.canonical_revision) throw new Error("Canonical snapshot revision binding mismatch");
    if (record.authority_ref.project_id !== request.project_id) throw new Error("Canonical authority project binding mismatch");
    assertHash(record.content_hash, "canonical record content hash");
    if (ids.has(record.record_id)) throw new Error(`Duplicate canonical search record: ${record.record_id}`);
    ids.add(record.record_id);
  }
}

function validateDocumentBatch(request: DocumentBatchRequest): void {
  assertProjectId(request.project_id);
  if (!request.document_epoch || request.document_epoch.length > 256) throw new Error("Invalid document epoch");
  if (!Number.isFinite(Date.parse(request.document_epoch_started_at))) throw new Error("Invalid document epoch start");
  if (!Number.isSafeInteger(request.document_generation) || request.document_generation < 1) {
    throw new Error(`Invalid document generation: ${request.document_generation}`);
  }
  assertHash(request.snapshot_hash, "document snapshot hash");
  const recordIds = new Set<string>();
  const documentIds = new Set<string>();
  for (const record of request.records) {
    if (record.record_kind !== "managed_document") throw new Error("Document batch contains non-document record");
    if (record.project_id !== request.project_id) throw new Error("Document batch project binding mismatch");
    if (record.authority_ref.project_id !== request.project_id) throw new Error("Document authority project binding mismatch");
    assertDocumentId(record.document_id);
    assertHash(record.content_hash, "document record content hash");
    if (recordIds.has(record.record_id)) throw new Error(`Duplicate managed document search record: ${record.record_id}`);
    recordIds.add(record.record_id);
    documentIds.add(record.document_id);
  }
  const removed = new Set<string>();
  for (const documentId of request.removed_document_ids) {
    assertDocumentId(documentId);
    if (removed.has(documentId)) throw new Error(`Duplicate removed document id: ${documentId}`);
    if (documentIds.has(documentId)) throw new Error(`Document cannot be upserted and removed in the same batch: ${documentId}`);
    removed.add(documentId);
  }
  if (request.full_snapshot && request.removed_document_ids.length > 0) {
    throw new Error("Full document snapshot cannot carry removed_document_ids");
  }
}

function documentEpochMode(head: HeadRow, request: DocumentBatchRequest): "same" | "new" | "stale" {
  if (head.document_epoch === request.document_epoch) return "same";
  if (!head.document_epoch || !head.document_epoch_started_at) return "new";
  const current = Date.parse(head.document_epoch_started_at);
  const incoming = Date.parse(request.document_epoch_started_at);
  return incoming > current ? "new" : "stale";
}

function assertProjectId(value: string): void {
  if (!/^PRJ-[0-9]{4,}$/.test(value)) throw new Error(`Invalid search project id: ${value}`);
}

function assertDocumentId(value: string): void {
  if (!/^DOC-[A-F0-9]{24}$/.test(value)) throw new Error(`Invalid search document id: ${value}`);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid canonical revision: ${value}`);
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}
