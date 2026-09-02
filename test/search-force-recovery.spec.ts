import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import type { SearchSyncStatus } from "../src/search/project-sync-store";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T13:15:00+01:00";

async function createProject(projectId: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: `TXN-SEARCH-RECOVERY-${projectId.slice(4)}-CREATE`,
        project_id: projectId,
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: `Search recovery ${projectId}`,
          slug: `search-recovery-${projectId.slice(4).toLowerCase()}`,
          aliases: [],
          objective: "Recover the derived search index without changing authority"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });
  return receipt;
}

async function writeWorking(guard: DurableObjectStub, projectId: string) {
  const content = "# Recovery proof\n\nGoverned text must survive total search-index loss.";
  const response = await guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "working.write",
      request_id: `DOCREQ-SEARCH-RECOVERY-${projectId.slice(4)}`,
      project_id: projectId,
      logical_path: "recovery/proof.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; document_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function search(projectId: string) {
  const response = await testEnv.SEARCH_INDEX_GUARD.getByName("global").fetch(
    "https://search-index.internal/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [projectId], text: "Recovery proof", limit: 20 })
    }
  );
  expect(response.status).toBe(200);
  return response.json<{ hits: Array<{ document_id?: string }> }>();
}

describe("ProjectGuard forced search recovery", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("starts a fresh document epoch at generation 1 after complete SearchIndex loss", async () => {
    const projectId = "PRJ-7140";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId);
    const document = await writeWorking(guard, projectId);

    // Canonical snapshot, initial full-document generation, then direct document delta.
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect((await search(projectId)).hits.some((hit) => hit.document_id === document.document_id)).toBe(true);

    const beforeResponse = await guard.fetch("https://project-guard.internal/search-sync-status");
    const before = await beforeResponse.json<SearchSyncStatus>();
    expect(before).toMatchObject({
      canonical_revision_indexed: 1,
      document_generation_requested: 2,
      document_generation_indexed: 2
    });

    // Simulate total loss of the reconstructible installation-scoped search state.
    const searchStub = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await runInDurableObject(searchStub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM search_fts WHERE project_id = ?", projectId);
      state.storage.sql.exec("DELETE FROM search_records WHERE project_id = ?", projectId);
      state.storage.sql.exec("DELETE FROM search_project_heads WHERE project_id = ?", projectId);
    });

    const missing = await search(projectId);
    expect(missing.hits).toEqual([]);

    const reconcile = await guard.fetch("https://project-guard.internal/reconcile-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force_full: true })
    });
    expect(reconcile.status).toBe(200);
    const requested = await reconcile.json<SearchSyncStatus>();
    expect(requested.document_epoch).not.toBe(before.document_epoch);
    expect(requested).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 0,
      document_generation_requested: 1,
      document_generation_indexed: 0,
      document_full_rebuild_required: true
    });

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);

    const afterResponse = await guard.fetch("https://project-guard.internal/search-sync-status");
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json<SearchSyncStatus>()).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 1,
      document_generation_requested: 1,
      document_generation_indexed: 1,
      document_full_rebuild_required: false,
      last_error: null
    });
    expect((await search(projectId)).hits.some((hit) => hit.document_id === document.document_id)).toBe(true);
  });
});
