import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type {
  CanonicalSearchRecord,
  CanonicalSnapshotRequest,
  DocumentBatchRequest,
  ManagedDocumentSearchRecord
} from "../src/search/contract";
import {
  initializeSearchIndexSchema,
  SearchIndexStore
} from "../src/search/sqlite-store";

const searchEnv = env as unknown as Env & { SEARCH_INDEX_GUARD: DurableObjectNamespace };
const searchStub = () => searchEnv.SEARCH_INDEX_GUARD.getByName("global");

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface RecordRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  record_id: string;
  record_kind: string;
}

const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function canonicalRecord(
  projectId: string,
  entityId: string,
  revision: number,
  title = entityId
): CanonicalSearchRecord {
  return {
    project_id: projectId,
    record_id: `task:${entityId}`,
    record_kind: "canonical_entity",
    entity_type: "task",
    entity_id: entityId,
    title,
    status: "active",
    body_text: `${title} searchable body`,
    content_hash: hash(entityId.includes("A") ? "a" : "b"),
    canonical_revision: revision,
    authority_ref: {
      kind: "canonical_entity",
      project_id: projectId,
      entity_type: "task",
      entity_id: entityId,
      canonical_revision: revision
    }
  };
}

function canonicalSnapshot(
  projectId: string,
  revision: number,
  snapshotHash: string,
  records: CanonicalSearchRecord[]
): CanonicalSnapshotRequest {
  return {
    project_id: projectId,
    canonical_revision: revision,
    snapshot_hash: snapshotHash,
    records
  };
}

function documentRecord(
  projectId: string,
  documentId: string,
  versionId: string,
  logicalPath: string,
  bodyText = "governed searchable document"
): ManagedDocumentSearchRecord {
  return {
    project_id: projectId,
    record_id: `document:${documentId}`,
    record_kind: "managed_document",
    document_id: documentId,
    version_id: versionId,
    title: logicalPath.split("/").at(-1)!.replace(/\.[^.]+$/, ""),
    logical_path: logicalPath,
    zone: "working",
    stage_or_collection: "working",
    reconciliation_status: "clean",
    body_text: bodyText,
    media_type: "text/markdown",
    content_hash: hash(documentId.includes("A") ? "c" : "d"),
    authority_ref: {
      kind: "managed_document",
      project_id: projectId,
      document_id: documentId,
      version_id: versionId,
      logical_path: logicalPath,
      content_sha256: hash("e")
    }
  };
}

function documentBatch(input: {
  projectId: string;
  epoch: string;
  epochStartedAt: string;
  generation: number;
  fullSnapshot: boolean;
  snapshotHash: string;
  records?: ManagedDocumentSearchRecord[];
  removed?: string[];
}): DocumentBatchRequest {
  return {
    project_id: input.projectId,
    document_epoch: input.epoch,
    document_epoch_started_at: input.epochStartedAt,
    document_generation: input.generation,
    full_snapshot: input.fullSnapshot,
    snapshot_hash: input.snapshotHash,
    records: input.records ?? [],
    removed_document_ids: input.removed ?? []
  };
}

async function withStore<T>(fn: (store: SearchIndexStore, storage: DurableObjectStorage) => T | Promise<T>): Promise<T> {
  return runInDurableObject(searchStub(), async (_instance, state) => {
    initializeSearchIndexSchema(state.storage);
    return fn(new SearchIndexStore(state.storage), state.storage);
  });
}

describe("SearchIndexGuard binding", () => {
  it("returns an explicit unknown status before a project has any indexed snapshot", async () => {
    const response = await searchStub().fetch("https://search-index.internal/status?project_id=PRJ-7201", {
      method: "GET"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_id: "PRJ-7201",
      freshness: "unknown",
      active_generation: null,
      canonical_revision_indexed: 0,
      document_generation_indexed: 0
    });
  });

  it("accepts canonical and document snapshots through internal routes", async () => {
    const projectId = "PRJ-7202";
    const canonical = canonicalSnapshot(
      projectId,
      3,
      hash("1"),
      [canonicalRecord(projectId, "TASK-ROUTE7202", 3)]
    );
    const canonicalResponse = await searchStub().fetch("https://search-index.internal/apply-canonical", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(canonical)
    });
    expect(canonicalResponse.status).toBe(200);

    const documents = documentBatch({
      projectId,
      epoch: "epoch-route-7202",
      epochStartedAt: "2026-09-01T10:00:00.000Z",
      generation: 1,
      fullSnapshot: true,
      snapshotHash: hash("2"),
      records: [documentRecord(
        projectId,
        "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
        "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA",
        "notes/route.md"
      )]
    });
    const documentResponse = await searchStub().fetch("https://search-index.internal/apply-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(documents)
    });
    expect(documentResponse.status).toBe(200);

    const status = await searchStub().fetch(`https://search-index.internal/status?project_id=${projectId}`);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      active_generation: 1,
      canonical_revision_indexed: 3,
      canonical_snapshot_hash: hash("1"),
      document_epoch: "epoch-route-7202",
      document_generation_indexed: 1,
      document_snapshot_hash: hash("2")
    });
  });
});

describe("SearchIndexStore", () => {
  it("creates generation 1 and atomically replaces canonical rows on newer snapshots", async () => {
    await withStore((store, storage) => {
      const projectId = "PRJ-7210";
      store.applyCanonical(canonicalSnapshot(
        projectId,
        5,
        hash("3"),
        [canonicalRecord(projectId, "TASK-A7210", 5, "First task")]
      ));
      expect(store.status(projectId)).toMatchObject({
        active_generation: 1,
        canonical_revision_indexed: 5,
        canonical_snapshot_hash: hash("3")
      });

      store.applyCanonical(canonicalSnapshot(
        projectId,
        8,
        hash("4"),
        [canonicalRecord(projectId, "TASK-B7210", 8, "Replacement task")]
      ));
      const rows = storage.sql.exec<RecordRow>(
        `SELECT project_id, record_id, record_kind FROM search_records
         WHERE project_id = ? AND generation = 1 AND record_kind = 'canonical_entity'
         ORDER BY record_id`,
        projectId
      ).toArray();
      expect(rows).toEqual([{
        project_id: projectId,
        record_id: "task:TASK-B7210",
        record_kind: "canonical_entity"
      }]);
      expect(store.status(projectId).canonical_revision_indexed).toBe(8);
    });
  });

  it("treats stale and duplicate canonical snapshots idempotently and rejects same-revision hash drift", async () => {
    await withStore((store) => {
      const projectId = "PRJ-7211";
      const current = canonicalSnapshot(
        projectId,
        5,
        hash("5"),
        [canonicalRecord(projectId, "TASK-A7211", 5)]
      );
      store.applyCanonical(current);
      store.applyCanonical(current);
      store.applyCanonical(canonicalSnapshot(
        projectId,
        4,
        hash("6"),
        [canonicalRecord(projectId, "TASK-OLD7211", 4)]
      ));
      expect(store.status(projectId)).toMatchObject({
        canonical_revision_indexed: 5,
        canonical_snapshot_hash: hash("5")
      });

      expect(() => store.applyCanonical(canonicalSnapshot(
        projectId,
        5,
        hash("7"),
        [canonicalRecord(projectId, "TASK-A7211", 5)]
      ))).toThrow(/CANONICAL_SNAPSHOT_HASH_MISMATCH/);
    });
  });

  it("applies ordered document batches without touching canonical rows", async () => {
    await withStore((store, storage) => {
      const projectId = "PRJ-7212";
      store.applyCanonical(canonicalSnapshot(
        projectId,
        2,
        hash("8"),
        [canonicalRecord(projectId, "TASK-A7212", 2)]
      ));
      const firstDoc = "DOC-AAAAAAAAAAAAAAAAAAAAAAAA";
      const secondDoc = "DOC-BBBBBBBBBBBBBBBBBBBBBBBB";
      store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-7212",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 1,
        fullSnapshot: true,
        snapshotHash: hash("9"),
        records: [documentRecord(projectId, firstDoc, "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA", "docs/first.md")]
      }));
      store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-7212",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 2,
        fullSnapshot: false,
        snapshotHash: hash("a"),
        records: [documentRecord(projectId, secondDoc, "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB", "docs/second.md")],
        removed: [firstDoc]
      }));

      expect(store.status(projectId)).toMatchObject({
        canonical_revision_indexed: 2,
        document_epoch: "epoch-7212",
        document_generation_indexed: 2,
        document_snapshot_hash: hash("a")
      });
      expect(storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM search_records
         WHERE project_id = ? AND generation = 1 AND record_kind = 'canonical_entity'`,
        projectId
      ).one().count).toBe(1);
      expect(storage.sql.exec<RecordRow>(
        `SELECT project_id, record_id, record_kind FROM search_records
         WHERE project_id = ? AND generation = 1 AND record_kind = 'managed_document'`,
        projectId
      ).toArray()).toEqual([{
        project_id: projectId,
        record_id: `document:${secondDoc}`,
        record_kind: "managed_document"
      }]);
    });
  });

  it("rejects document generation gaps and same-generation hash drift", async () => {
    await withStore((store) => {
      const projectId = "PRJ-7213";
      store.applyCanonical(canonicalSnapshot(projectId, 1, hash("b"), []));
      const first = documentBatch({
        projectId,
        epoch: "epoch-7213",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 1,
        fullSnapshot: true,
        snapshotHash: hash("c")
      });
      store.applyDocuments(first);
      store.applyDocuments(first);

      expect(() => store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-7213",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 1,
        fullSnapshot: true,
        snapshotHash: hash("d")
      }))).toThrow(/DOCUMENT_SNAPSHOT_HASH_MISMATCH/);

      expect(() => store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-7213",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 3,
        fullSnapshot: false,
        snapshotHash: hash("e")
      }))).toThrow(/DOCUMENT_GENERATION_GAP/);
    });
  });

  it("switches to a newer document epoch only through a full snapshot", async () => {
    await withStore((store, storage) => {
      const projectId = "PRJ-7214";
      const oldDoc = "DOC-AAAAAAAAAAAAAAAAAAAAAAAA";
      const newDoc = "DOC-BBBBBBBBBBBBBBBBBBBBBBBB";
      store.applyCanonical(canonicalSnapshot(projectId, 1, hash("f"), []));
      store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-old-7214",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 1,
        fullSnapshot: true,
        snapshotHash: hash("1"),
        records: [documentRecord(projectId, oldDoc, "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA", "docs/old.md")]
      }));

      expect(() => store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-new-7214",
        epochStartedAt: "2026-09-01T11:00:00.000Z",
        generation: 1,
        fullSnapshot: false,
        snapshotHash: hash("2")
      }))).toThrow(/DOCUMENT_EPOCH_REQUIRES_FULL_SNAPSHOT/);

      store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-new-7214",
        epochStartedAt: "2026-09-01T11:00:00.000Z",
        generation: 1,
        fullSnapshot: true,
        snapshotHash: hash("3"),
        records: [documentRecord(projectId, newDoc, "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB", "docs/new.md")]
      }));
      expect(store.status(projectId)).toMatchObject({
        document_epoch: "epoch-new-7214",
        document_epoch_started_at: "2026-09-01T11:00:00.000Z",
        document_generation_indexed: 1,
        document_snapshot_hash: hash("3")
      });
      expect(storage.sql.exec<RecordRow>(
        `SELECT project_id, record_id, record_kind FROM search_records
         WHERE project_id = ? AND generation = 1 AND record_kind = 'managed_document'`,
        projectId
      ).toArray()).toEqual([{
        project_id: projectId,
        record_id: `document:${newDoc}`,
        record_kind: "managed_document"
      }]);

      expect(() => store.applyDocuments(documentBatch({
        projectId,
        epoch: "epoch-old-7214",
        epochStartedAt: "2026-09-01T10:00:00.000Z",
        generation: 2,
        fullSnapshot: false,
        snapshotHash: hash("4")
      }))).toThrow(/DOCUMENT_EPOCH_STALE/);
    });
  });

  it("isolates identical record IDs by project inside the installation-scoped index", async () => {
    await withStore((store, storage) => {
      const sharedEntityId = "TASK-SHARED";
      store.applyCanonical(canonicalSnapshot(
        "PRJ-7215",
        1,
        hash("5"),
        [canonicalRecord("PRJ-7215", sharedEntityId, 1)]
      ));
      store.applyCanonical(canonicalSnapshot(
        "PRJ-7216",
        1,
        hash("6"),
        [canonicalRecord("PRJ-7216", sharedEntityId, 1)]
      ));

      expect(storage.sql.exec<RecordRow>(
        `SELECT project_id, record_id, record_kind FROM search_records
         WHERE record_id = ? ORDER BY project_id`,
        `task:${sharedEntityId}`
      ).toArray()).toEqual([
        { project_id: "PRJ-7215", record_id: `task:${sharedEntityId}`, record_kind: "canonical_entity" },
        { project_id: "PRJ-7216", record_id: `task:${sharedEntityId}`, record_kind: "canonical_entity" }
      ]);
    });
  });
});
