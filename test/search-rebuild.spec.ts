import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentVersionPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-02T17:45:00+01:00";

interface DocumentReceipt {
  status: string;
  document_id: string;
  version_id: string;
}

interface RebuildStatus {
  project_id: string;
  active_generation: number | null;
  staging_generation: number;
  phase: string;
  target_canonical_revision: number;
  target_document_generation: number;
  pending_items: number;
  completed_items: number;
  failed_items: number;
  last_error: string | null;
}

async function createProject(projectId: string): Promise<void> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: `TXN-SEARCH-REBUILD-${projectId.slice(4)}-CREATE`,
        project_id: projectId,
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: `Search rebuild ${projectId}`,
          slug: `search-rebuild-${projectId.slice(4)}`,
          aliases: [],
          objective: "Prove generation-safe reconstructible search"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  expect(await response.json<Receipt>()).toMatchObject({ status: "committed", new_revision: 1 });
}

async function writeWorking(
  projectId: string,
  requestId: string,
  logicalPath: string,
  content: string,
  expectedVersionId?: string
): Promise<DocumentReceipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/document",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: requestId,
        project_id: projectId,
        logical_path: logicalPath,
        content,
        content_sha256: await sha256Text(content),
        ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
        created_at: at
      })
    }
  );
  expect(response.status).toBe(200);
  const receipt = await response.json<DocumentReceipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function waitForSearchSyncAlarm(syncGuard: DurableObjectStub): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const alarm = await runInDurableObject(syncGuard, async (_instance, state) => state.storage.getAlarm());
    if (alarm !== null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const alarm = await runInDurableObject(syncGuard, async (_instance, state) => state.storage.getAlarm());
  expect(alarm).not.toBeNull();
}

async function drainSearchSync(projectId: string, alarms: number): Promise<void> {
  const syncGuard = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
  for (let index = 0; index < alarms; index += 1) {
    await waitForSearchSyncAlarm(syncGuard);
    expect(await runDurableObjectAlarm(syncGuard)).toBe(true);
  }
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

async function startRebuild(projectId: string): Promise<Response> {
  return testEnv.SEARCH_INDEX_GUARD.getByName("global").fetch(
    "https://search-index.internal/rebuild-project",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId })
    }
  );
}

async function rebuildStatus(projectId: string): Promise<RebuildStatus> {
  const response = await testEnv.SEARCH_INDEX_GUARD.getByName("global").fetch(
    `https://search-index.internal/rebuild-status?project_id=${encodeURIComponent(projectId)}`
  );
  expect(response.status).toBe(200);
  return response.json<RebuildStatus>();
}

async function generationRecordCount(
  searchGuard: DurableObjectStub,
  projectId: string,
  generation: number
): Promise<number> {
  return runInDurableObject(searchGuard, async (_instance, state) => state.storage.sql.exec<{
    [key: string]: SqlStorageValue;
    count: number;
  }>(
    `SELECT COUNT(*) AS count FROM search_records WHERE project_id = ? AND generation = ?`,
    projectId,
    generation
  ).one().count);
}

describe("SearchIndex generation-safe rebuild", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("keeps G1 queryable while G2 stages and promotes only after authoritative validation", async () => {
    const projectId = "PRJ-7160";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);

    const first = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-A",
      "rebuild/generation.md",
      "# Rebuild document\n\nlegacy-generation-phrase"
    );
    await drainSearchSync(projectId, 3);
    expect((await search(projectId, "legacy-generation-phrase")).hits.some(
      (hit) => hit.document_id === first.document_id
    )).toBe(true);

    await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-B",
      "rebuild/generation.md",
      "# Rebuild document\n\nfresh-generation-phrase",
      first.version_id
    );

    const started = await startRebuild(projectId);
    expect(started.status).toBe(202);
    expect(await started.json<RebuildStatus>()).toMatchObject({
      project_id: projectId,
      active_generation: 1,
      staging_generation: 2,
      phase: "indexing",
      target_canonical_revision: 1,
      target_document_generation: 3,
      pending_items: 1,
      completed_items: 0
    });

    expect((await search(projectId, "legacy-generation-phrase")).hits.some(
      (hit) => hit.document_id === first.document_id
    )).toBe(true);
    expect((await search(projectId, "fresh-generation-phrase")).hits).toEqual([]);

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const status = await searchGuard.fetch(
      `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      active_generation: 2,
      canonical_revision_indexed: 1,
      document_generation_indexed: 3,
      rebuild_state: "ready"
    });
    expect((await search(projectId, "fresh-generation-phrase")).hits.some(
      (hit) => hit.document_id === first.document_id
    )).toBe(true);
    expect((await search(projectId, "legacy-generation-phrase")).hits).toEqual([]);
  });

  it("preserves completed staging items across a failed document and resumes without rebuilding them", async () => {
    const projectId = "PRJ-7161";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);

    const aOld = "# A\n\nold-alpha-rebuild";
    const bOld = "# B\n\nold-beta-rebuild";
    const a = await writeWorking(projectId, "DOCREQ-SEARCH-REBUILD-7161-A1", "rebuild/a.md", aOld);
    const b = await writeWorking(projectId, "DOCREQ-SEARCH-REBUILD-7161-B1", "rebuild/b.md", bOld);
    await drainSearchSync(projectId, 4);

    const aFresh = "# A\n\nfresh-alpha-rebuild";
    const bFresh = "# B\n\nfresh-beta-rebuild";
    const a2 = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7161-A2",
      "rebuild/a.md",
      aFresh,
      a.version_id
    );
    const b2 = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7161-B2",
      "rebuild/b.md",
      bFresh,
      b.version_id
    );

    const orderedIds = [a2.document_id, b2.document_id].sort();
    const failedId = orderedIds[1];
    const failedReceipt = failedId === a2.document_id ? a2 : b2;
    const failedVersionPath = machineDocumentVersionPath(
      projectId,
      failedReceipt.document_id,
      failedReceipt.version_id
    );
    const failedVersionRaw = dropbox.files.get(failedVersionPath);
    expect(failedVersionRaw).toBeDefined();
    const failedVersion = JSON.parse(failedVersionRaw!) as { immutable_payload_path: string };
    const failedPayload = failedVersion.immutable_payload_path;

    const started = await startRebuild(projectId);
    expect(started.status).toBe(202);
    expect(await started.json<RebuildStatus>()).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      phase: "indexing",
      target_document_generation: 5,
      pending_items: 2
    });

    const originalPayload = dropbox.files.get(failedPayload);
    expect(originalPayload).toBeDefined();
    dropbox.files.delete(failedPayload);

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const failed = await rebuildStatus(projectId);
    expect(failed).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      phase: "failed",
      pending_items: 1,
      completed_items: 1,
      failed_items: 1
    });
    expect(failed.last_error).toMatch(/payload|missing/i);

    expect((await search(projectId, "old-alpha-rebuild")).hits.length).toBeGreaterThan(0);
    expect((await search(projectId, "fresh-alpha-rebuild")).hits).toEqual([]);

    dropbox.files.set(failedPayload, originalPayload!);
    const resumed = await startRebuild(projectId);
    expect(resumed.status).toBe(202);
    expect(await resumed.json<RebuildStatus>()).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      phase: "indexing",
      pending_items: 1,
      completed_items: 1
    });

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const indexStatus = await searchGuard.fetch(
      `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`
    );
    expect(await indexStatus.json()).toMatchObject({ active_generation: 2, document_generation_indexed: 5 });
    expect((await search(projectId, "fresh-alpha-rebuild")).hits.length).toBeGreaterThan(0);
    expect((await search(projectId, "fresh-beta-rebuild")).hits.length).toBeGreaterThan(0);
  });

  it("processes at most 32 rebuild documents per alarm", async () => {
    const projectId = "PRJ-7162";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);
    await drainSearchSync(projectId, 1);

    for (let index = 0; index < 33; index += 1) {
      await writeWorking(
        projectId,
        `DOCREQ-SEARCH-REBUILD-7162-${index.toString().padStart(2, "0")}`,
        `bounded/doc-${index.toString().padStart(2, "0")}.md`,
        `# Bounded ${index}\n\nbounded-rebuild-${index}`
      );
    }

    const started = await startRebuild(projectId);
    expect(started.status).toBe(202);
    expect(await started.json<RebuildStatus>()).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      pending_items: 33,
      completed_items: 0
    });

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    expect(await rebuildStatus(projectId)).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      phase: "indexing",
      pending_items: 1,
      completed_items: 32
    });

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const status = await searchGuard.fetch(
      `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`
    );
    expect(await status.json()).toMatchObject({ active_generation: 2, document_generation_indexed: 34 });
  });

  it("fails closed when source watermarks move before promotion", async () => {
    const projectId = "PRJ-7163";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);

    const first = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7163-A",
      "drift/proof.md",
      "# Drift\n\nold-drift-generation"
    );
    await drainSearchSync(projectId, 3);

    const target = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7163-B",
      "drift/proof.md",
      "# Drift\n\ntarget-drift-generation",
      first.version_id
    );
    expect((await startRebuild(projectId)).status).toBe(202);

    await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7163-C",
      "drift/proof.md",
      "# Drift\n\nnewer-source-after-rebuild-start",
      target.version_id
    );

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    expect(await rebuildStatus(projectId)).toMatchObject({
      active_generation: 1,
      staging_generation: 2,
      phase: "failed",
      last_error: "SOURCE_CHANGED_DURING_REBUILD"
    });
    expect((await search(projectId, "old-drift-generation")).hits.length).toBeGreaterThan(0);
    expect((await search(projectId, "target-drift-generation")).hits).toEqual([]);
  });

  it("rebuilds directly from authority after complete SearchIndex project loss", async () => {
    const projectId = "PRJ-7164";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);
    const document = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7164-A",
      "loss/proof.md",
      "# Loss recovery\n\ndirect-rebuild-authority-proof"
    );
    await drainSearchSync(projectId, 3);
    expect((await search(projectId, "direct-rebuild-authority-proof")).hits.some(
      (hit) => hit.document_id === document.document_id
    )).toBe(true);

    await runInDurableObject(searchGuard, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM search_fts WHERE project_id = ?", projectId);
      state.storage.sql.exec("DELETE FROM search_records WHERE project_id = ?", projectId);
      state.storage.sql.exec("DELETE FROM search_project_heads WHERE project_id = ?", projectId);
    });
    expect((await search(projectId, "direct-rebuild-authority-proof")).hits).toEqual([]);

    const started = await startRebuild(projectId);
    expect(started.status).toBe(202);
    expect(await started.json<RebuildStatus>()).toMatchObject({
      active_generation: null,
      staging_generation: 1,
      phase: "indexing",
      pending_items: 1
    });
    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);

    const status = await searchGuard.fetch(
      `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`
    );
    expect(await status.json()).toMatchObject({ active_generation: 1, rebuild_state: "ready" });
    expect((await search(projectId, "direct-rebuild-authority-proof")).hits.some(
      (hit) => hit.document_id === document.document_id
    )).toBe(true);
  });

  it("cleans old generations only after promotion and in bounded alarm batches", async () => {
    const projectId = "PRJ-7165";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);
    await drainSearchSync(projectId, 1);

    await runInDurableObject(searchGuard, async (_instance, state) => {
      for (let index = 0; index < 40; index += 1) {
        const recordId = `seed:cleanup:${index.toString().padStart(2, "0")}`;
        state.storage.sql.exec(
          `INSERT INTO search_records (
             project_id, generation, record_id, record_kind, entity_type, entity_id, title,
             content_hash, canonical_revision, body_text, authority_ref_json
           ) VALUES (?, 1, ?, 'canonical_entity', 'task', ?, ?, ?, 1, ?, ?)`,
          projectId,
          recordId,
          `TASK-CLEANUP-${index.toString().padStart(2, "0")}`,
          `Cleanup ${index}`,
          `hash-${index}`,
          `cleanup-body-${index}`,
          JSON.stringify({
            kind: "canonical_entity",
            project_id: projectId,
            entity_type: "task",
            entity_id: `TASK-CLEANUP-${index.toString().padStart(2, "0")}`,
            canonical_revision: 1
          })
        );
        state.storage.sql.exec(
          `INSERT INTO search_fts (project_id, generation, record_id, title, body_text)
           VALUES (?, 1, ?, ?, ?)`,
          projectId,
          recordId,
          `Cleanup ${index}`,
          `cleanup-body-${index}`
        );
      }
    });
    const oldCount = await generationRecordCount(searchGuard, projectId, 1);
    expect(oldCount).toBeGreaterThan(32);

    expect((await startRebuild(projectId)).status).toBe(202);
    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const promoted = await searchGuard.fetch(
      `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`
    );
    expect(await promoted.json()).toMatchObject({ active_generation: 2, rebuild_state: "ready" });
    expect(await generationRecordCount(searchGuard, projectId, 1)).toBe(oldCount);

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const afterFirstCleanup = await generationRecordCount(searchGuard, projectId, 1);
    expect(afterFirstCleanup).toBeGreaterThan(0);
    expect(afterFirstCleanup).toBeLessThan(oldCount);

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    expect(await generationRecordCount(searchGuard, projectId, 1)).toBe(0);
  });
});