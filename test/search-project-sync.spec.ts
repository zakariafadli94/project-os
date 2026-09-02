import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  initializeProjectSearchSyncSchema,
  ProjectSearchSyncStore,
  type DocumentSyncBatch,
  type SearchSyncStatus
} from "../src/search/project-sync-store";

async function withStore<T>(
  projectId: string,
  fn: (store: ProjectSearchSyncStore, storage: DurableObjectStorage) => T | Promise<T>
): Promise<T> {
  const stub = env.PROJECT_GUARD.getByName(projectId);
  return runInDurableObject(stub, async (_instance, state) => {
    initializeProjectSearchSyncSchema(state.storage);
    return fn(new ProjectSearchSyncStore(state.storage), state.storage);
  });
}

function expectInitialStatus(status: SearchSyncStatus): void {
  expect(status).toMatchObject({
    canonical_revision_requested: 0,
    canonical_revision_indexed: 0,
    document_generation_requested: 1,
    document_generation_indexed: 0,
    document_full_rebuild_required: true,
    last_error: null
  });
  expect(status.document_epoch).toMatch(/^[0-9a-f-]{36}$/i);
  expect(Number.isNaN(Date.parse(status.document_epoch_started_at))).toBe(false);
}

function expectBatch(
  batch: DocumentSyncBatch | null,
  expected: Partial<DocumentSyncBatch>
): DocumentSyncBatch {
  expect(batch).not.toBeNull();
  expect(batch).toMatchObject(expected);
  return batch!;
}

describe("ProjectSearchSyncStore", () => {
  it("initializes with a durable generation-1 full document snapshot", async () => {
    await withStore("PRJ-7101", (store) => {
      expectInitialStatus(store.status());
      expectBatch(store.nextDocumentBatch(), {
        generation: 1,
        full_snapshot: true,
        document_ids: [],
        attempts: 0,
        last_error: null
      });
      expect(store.needsWork()).toBe(true);
    });
  });

  it("keeps initialization idempotent and preserves the same document epoch", async () => {
    const projectId = "PRJ-7102";
    const stub = env.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      initializeProjectSearchSyncSchema(state.storage);
      const first = new ProjectSearchSyncStore(state.storage).status();
      initializeProjectSearchSyncSchema(state.storage);
      const second = new ProjectSearchSyncStore(state.storage).status();

      expect(second.document_epoch).toBe(first.document_epoch);
      expect(second.document_epoch_started_at).toBe(first.document_epoch_started_at);
      expect(second.document_generation_requested).toBe(1);
      expectBatch(new ProjectSearchSyncStore(state.storage).nextDocumentBatch(), {
        generation: 1,
        full_snapshot: true
      });
    });
  });

  it("coalesces canonical requests to the highest revision and advances monotonically", async () => {
    await withStore("PRJ-7103", (store) => {
      store.requestCanonical(2);
      store.requestCanonical(2);
      store.requestCanonical(7);
      store.requestCanonical(4);
      expect(store.status().canonical_revision_requested).toBe(7);

      store.markCanonicalIndexed(5);
      expect(store.status().canonical_revision_indexed).toBe(5);
      expect(() => store.markCanonicalIndexed(8)).toThrow(/requested|revision/i);
      expect(() => store.markCanonicalIndexed(4)).toThrow(/indexed|revision/i);

      store.markCanonicalIndexed(7);
      expect(store.status().canonical_revision_indexed).toBe(7);
    });
  });

  it("queues document generations FIFO and deduplicates ids inside each batch", async () => {
    await withStore("PRJ-7104", (store) => {
      store.markDocumentIndexed(1);
      expect(store.status().document_full_rebuild_required).toBe(false);

      store.requestDocuments([
        "DOC-BBBBBBBBBBBBBBBBBBBBBBBB",
        "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
        "DOC-BBBBBBBBBBBBBBBBBBBBBBBB"
      ]);
      store.requestDocuments(["DOC-CCCCCCCCCCCCCCCCCCCCCCCC"]);

      expect(store.status()).toMatchObject({
        document_generation_requested: 3,
        document_generation_indexed: 1
      });
      expectBatch(store.nextDocumentBatch(), {
        generation: 2,
        full_snapshot: false,
        document_ids: [
          "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
          "DOC-BBBBBBBBBBBBBBBBBBBBBBBB"
        ]
      });
      expect(() => store.markDocumentIndexed(3)).toThrow(/generation|next/i);

      store.markDocumentIndexed(2);
      expectBatch(store.nextDocumentBatch(), {
        generation: 3,
        document_ids: ["DOC-CCCCCCCCCCCCCCCCCCCCCCCC"]
      });
      store.markDocumentIndexed(3);
      expect(store.nextDocumentBatch()).toBeNull();
    });
  });

  it("keeps a failed document batch pending and increments attempts until success", async () => {
    await withStore("PRJ-7105", (store) => {
      const first = expectBatch(store.nextDocumentBatch(), { generation: 1, attempts: 0 });
      store.markFailure({ scope: "document", generation: first.generation, message: "temporary index outage" });

      expectBatch(store.nextDocumentBatch(), {
        generation: 1,
        attempts: 1,
        last_error: "temporary index outage"
      });
      expect(store.status().document_generation_indexed).toBe(0);

      store.clearFailure({ scope: "document", generation: 1 });
      expectBatch(store.nextDocumentBatch(), { generation: 1, attempts: 1, last_error: null });
      store.markDocumentIndexed(1);
      expect(store.nextDocumentBatch()).toBeNull();
    });
  });

  it("tracks canonical failure separately without losing requested work", async () => {
    await withStore("PRJ-7106", (store) => {
      store.markDocumentIndexed(1);
      store.requestCanonical(9);
      store.markFailure({ scope: "canonical", message: "search index unavailable" });
      expect(store.status()).toMatchObject({
        canonical_revision_requested: 9,
        canonical_revision_indexed: 0,
        last_error: "search index unavailable"
      });
      expect(store.needsWork()).toBe(true);

      store.clearFailure({ scope: "canonical" });
      expect(store.status().last_error).toBeNull();
      store.markCanonicalIndexed(9);
      expect(store.needsWork()).toBe(false);
    });
  });

  it("queues an explicit full document snapshot as a new ordered generation", async () => {
    await withStore("PRJ-7107", (store) => {
      store.markDocumentIndexed(1);
      store.requestDocuments(["DOC-AAAAAAAAAAAAAAAAAAAAAAAA"]);
      store.requestFullDocumentSnapshot();

      expectBatch(store.nextDocumentBatch(), { generation: 2, full_snapshot: false });
      store.markDocumentIndexed(2);
      expectBatch(store.nextDocumentBatch(), {
        generation: 3,
        full_snapshot: true,
        document_ids: []
      });
      expect(store.status().document_full_rebuild_required).toBe(true);
    });
  });

  it("fails closed on malformed durable batch JSON", async () => {
    await withStore("PRJ-7108", (store, storage) => {
      storage.sql.exec(
        "UPDATE search_document_batches SET document_ids_json = ? WHERE generation = 1",
        "not-json"
      );
      expect(() => store.nextDocumentBatch()).toThrow(/document|batch|JSON/i);
    });
  });

  it("starts independent projects with distinct opaque document epochs", async () => {
    let firstEpoch = "";
    await withStore("PRJ-7109", (store) => {
      firstEpoch = store.status().document_epoch;
    });
    await withStore("PRJ-7110", (store) => {
      expect(store.status().document_epoch).not.toBe(firstEpoch);
      expectInitialStatus(store.status());
    });
  });
});
