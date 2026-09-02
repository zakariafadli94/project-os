import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  initializeProjectSearchSyncSchema,
  ProjectSearchSyncStore
} from "../src/search/project-sync-store";

async function withStore<T>(
  projectId: string,
  fn: (store: ProjectSearchSyncStore) => T | Promise<T>
): Promise<T> {
  const stub = env.PROJECT_GUARD.getByName(projectId);
  return runInDurableObject(stub, async (_instance, state) => {
    initializeProjectSearchSyncSchema(state.storage);
    return fn(new ProjectSearchSyncStore(state.storage));
  });
}

describe("ProjectSearchSyncStore source idempotency", () => {
  it("registers one document generation for an exact source replay", async () => {
    await withStore("PRJ-7130", (store) => {
      store.markDocumentIndexed(1);
      const documentId = "DOC-AAAAAAAAAAAAAAAAAAAAAAAA";

      expect(store.requestDocumentsOnce("document:REQ-7130", [documentId])).toBe(true);
      expect(store.status().document_generation_requested).toBe(2);
      expect(store.requestDocumentsOnce("document:REQ-7130", [documentId])).toBe(false);
      expect(store.status().document_generation_requested).toBe(2);
      expect(store.nextDocumentBatch()).toMatchObject({
        generation: 2,
        full_snapshot: false,
        document_ids: [documentId]
      });
    });
  });

  it("registers one full snapshot generation for an exact legacy artifact replay", async () => {
    await withStore("PRJ-7131", (store) => {
      store.markDocumentIndexed(1);

      expect(store.requestFullDocumentSnapshotOnce("artifact:ARTREQ-7131")).toBe(true);
      expect(store.status().document_generation_requested).toBe(2);
      expect(store.requestFullDocumentSnapshotOnce("artifact:ARTREQ-7131")).toBe(false);
      expect(store.status().document_generation_requested).toBe(2);
      expect(store.nextDocumentBatch()).toMatchObject({
        generation: 2,
        full_snapshot: true,
        document_ids: []
      });
    });
  });
});
