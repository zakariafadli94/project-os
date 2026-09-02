import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { ProjectSearchSyncStore, type SearchSyncStatus } from "../src/search/project-sync-store";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T13:20:00+01:00";

async function createProject(projectId: string, slug: string, suffix: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: `TXN-SEARCH-BOUNDARY-${suffix}-CREATE`,
        project_id: projectId,
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: `Search boundary ${suffix}`,
          slug,
          aliases: [],
          objective: "Prove search synchronization crash and replay boundaries"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });
  return receipt;
}

async function searchStatus(guard: DurableObjectStub): Promise<SearchSyncStatus & { canonical_revision: number }> {
  const response = await guard.fetch("https://project-guard.internal/search-sync-status");
  expect(response.status).toBe(200);
  return response.json<SearchSyncStatus & { canonical_revision: number }>();
}

async function writeWorking(guard: DurableObjectStub, projectId: string, requestId: string, logicalPath: string) {
  const content = `# ${logicalPath}\n\nSearch synchronization boundary proof.`;
  const response = await guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "working.write",
      request_id: requestId,
      project_id: projectId,
      logical_path: logicalPath,
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; document_id: string; version_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function search(projectId: string, text: string) {
  const response = await testEnv.SEARCH_INDEX_GUARD.getByName("global").fetch(
    "https://search-index.internal/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [projectId], text, limit: 20 })
    }
  );
  expect(response.status).toBe(200);
  return response.json<{ hits: Array<{ document_id?: string; record_id: string }> }>();
}

describe("ProjectGuard search synchronization boundaries", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("repairs a lost canonical outbox request and tolerates replay after SearchIndex applied but local mark was lost", async () => {
    const projectId = "PRJ-7150";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId, "search-boundary-repair", "7150");

    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE search_sync_control
         SET canonical_revision_requested = 0, canonical_revision_indexed = 0, last_error = NULL
         WHERE singleton = 1`
      );
    });

    const repaired = await guard.fetch("https://project-guard.internal/reconcile-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json<SearchSyncStatus>()).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 0
    });
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await searchStatus(guard)).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 1
    });

    // Simulate SearchIndex commit success followed by loss of the local indexed mark.
    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE search_sync_control SET canonical_revision_indexed = 0 WHERE singleton = 1"
      );
    });
    const replay = await guard.fetch("https://project-guard.internal/reconcile-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(replay.status).toBe(200);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await searchStatus(guard)).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 1,
      last_error: null
    });
  });

  it("queues exactly the changed governed document IDs reported by change-feed reconciliation", async () => {
    const projectId = "PRJ-7151";
    const slug = "search-boundary-change-feed";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId, slug, "7151");

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);

    const document = await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-BOUNDARY-7151",
      "strategy/commercial.md"
    );
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await searchStatus(guard)).toMatchObject({
      document_generation_requested: 2,
      document_generation_indexed: 2
    });

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);
    expect(await baseline.json()).toMatchObject({ baseline: true, changed_document_ids: [] });

    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-${slug}/WORKING/strategy/commercial.md`;
    await dropbox.writeExternal(visiblePath, "# Strategy\n\nExternal governed edit");

    const incremental = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(incremental.status).toBe(200);
    expect(await incremental.json()).toMatchObject({
      baseline: false,
      captured: 1,
      changed_document_ids: [document.document_id]
    });

    expect(await searchStatus(guard)).toMatchObject({
      document_generation_requested: 3,
      document_generation_indexed: 2
    });
    await runInDurableObject(guard, async (_instance, state) => {
      const next = new ProjectSearchSyncStore(state.storage).nextDocumentBatch();
      expect(next).toMatchObject({
        generation: 3,
        full_snapshot: false,
        document_ids: [document.document_id]
      });
    });
  });

  it("queues one conservative full-document generation for a real legacy artifact receipt and exact replay", async () => {
    const projectId = "PRJ-7152";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId, "search-boundary-artifact", "7152");

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);

    const content = "# Legacy artifact\n\nConservative managed-document refresh.";
    const body = {
      request_id: "ART-SEARCH-BOUNDARY-7152",
      project_id: projectId,
      relative_path: "playbooks/search-boundary.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    const first = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(await first.json()).toMatchObject({ status: "committed", request_id: body.request_id });
    expect(await searchStatus(guard)).toMatchObject({
      document_generation_requested: 2,
      document_generation_indexed: 1,
      document_full_rebuild_required: true
    });

    await runInDurableObject(guard, async (_instance, state) => {
      expect(new ProjectSearchSyncStore(state.storage).nextDocumentBatch()).toMatchObject({
        generation: 2,
        full_snapshot: true,
        document_ids: []
      });
    });

    const replay = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(await replay.json()).toMatchObject({ status: "committed", request_id: body.request_id });
    expect(await searchStatus(guard)).toMatchObject({ document_generation_requested: 2 });
  });

  it("indexes a governed head through the initial full-document generation before its later direct delta", async () => {
    const projectId = "PRJ-7153";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId, "search-boundary-initial-full", "7153");
    const document = await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-BOUNDARY-7153",
      "initial/full-proof.md"
    );

    expect(await runDurableObjectAlarm(guard)).toBe(true); // canonical
    expect(await runDurableObjectAlarm(guard)).toBe(true); // generation-1 full snapshot

    expect(await searchStatus(guard)).toMatchObject({
      document_generation_requested: 2,
      document_generation_indexed: 1
    });
    const result = await search(projectId, "full-proof");
    expect(result.hits.some((hit) => hit.document_id === document.document_id)).toBe(true);
  });

  it("keeps search lagging when SearchIndex conflicts even if materialization is independently blocked", async () => {
    const projectId = "PRJ-7154";
    const slug = "search-boundary-dual-failure";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await createProject(projectId, slug, "7154");

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await searchStatus(guard)).toMatchObject({
      canonical_revision_requested: 1,
      canonical_revision_indexed: 1,
      document_generation_indexed: 1
    });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-${slug}`;
    dropbox.files.set(`${root}/BRIEF.md`, "human edit outside Project OS");

    const seeded = await testEnv.SEARCH_INDEX_GUARD.getByName("global").fetch(
      "https://search-index.internal/apply-canonical",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          canonical_revision: 2,
          snapshot_hash: "f".repeat(64),
          records: []
        })
      }
    );
    expect(seeded.status).toBe(200);

    const mutation = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-SEARCH-BOUNDARY-7154-CONSTRAINT",
        project_id: projectId,
        base_revision: 1,
        operation: "constraint.add",
        created_at: at,
        payload: {
          constraint_id: "CON-SEARCH7154",
          title: "Dual derived failure proof",
          description: "Search and materialization remain independently incomplete"
        }
      })
    });
    expect(await mutation.json<Receipt>()).toMatchObject({ status: "committed", new_revision: 2 });

    expect(await runDurableObjectAlarm(guard)).toBe(true);

    expect(await searchStatus(guard)).toMatchObject({
      canonical_revision: 2,
      canonical_revision_requested: 2,
      canonical_revision_indexed: 1
    });
    expect((await searchStatus(guard)).last_error).toMatch(/CANONICAL_SNAPSHOT_HASH_MISMATCH/);

    const materialization = await guard.fetch("https://project-guard.internal/materialization-status");
    expect(materialization.status).toBe(200);
    expect(await materialization.json()).toMatchObject({
      canonical_revision: 2,
      materialized_head: { revision: 1 }
    });
  });
});
