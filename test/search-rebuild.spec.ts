import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentTextPayloadPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T13:24:00+01:00";

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

async function createProject(projectId: string, slug: string): Promise<Receipt> {
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
          slug,
          aliases: [],
          objective: "Prove generation-safe reconstructible search"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });
  return receipt;
}

async function writeWorking(
  guard: DurableObjectStub,
  projectId: string,
  requestId: string,
  logicalPath: string,
  content: string,
  expectedVersionId?: string
): Promise<DocumentReceipt> {
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
      ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
      created_at: at
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<DocumentReceipt>();
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

async function drainProjectSearch(guard: DurableObjectStub, alarms: number): Promise<void> {
  for (let index = 0; index < alarms; index += 1) {
    expect(await runDurableObjectAlarm(guard)).toBe(true);
  }
}

describe("SearchIndex generation-safe rebuild", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("keeps G1 queryable while G2 stages and promotes only after authoritative validation", async () => {
    const projectId = "PRJ-7160";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId, "search-rebuild-generation");

    const oldContent = "# Rebuild document\n\nlegacy-generation-phrase";
    const first = await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-A",
      "rebuild/generation.md",
      oldContent
    );
    await drainProjectSearch(guard, 3);
    expect((await search(projectId, "legacy-generation-phrase")).hits.some((hit) => hit.document_id === first.document_id)).toBe(true);

    const freshContent = "# Rebuild document\n\nfresh-generation-phrase";
    await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-B",
      "rebuild/generation.md",
      freshContent,
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

    // Queries remain pinned to G1 while G2 is only staging.
    expect((await search(projectId, "legacy-generation-phrase")).hits.some((hit) => hit.document_id === first.document_id)).toBe(true);
    expect((await search(projectId, "fresh-generation-phrase")).hits).toEqual([]);

    expect(await runDurableObjectAlarm(searchGuard)).toBe(true);
    const indexStatus = await searchGuard.fetch(`https://search-index.internal/status?project_id=${projectId}`);
    expect(await indexStatus.json()).toMatchObject({
      project_id: projectId,
      active_generation: 2,
      canonical_revision_indexed: 1,
      document_generation_indexed: 3,
      rebuild_state: "ready"
    });
    expect((await search(projectId, "fresh-generation-phrase")).hits.some((hit) => hit.document_id === first.document_id)).toBe(true);
    expect((await search(projectId, "legacy-generation-phrase")).hits).toEqual([]);
  });

  it("preserves completed staging items across a failed document and resumes without rebuilding them", async () => {
    const projectId = "PRJ-7161";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId, "search-rebuild-resume");

    const aOld = "# A\n\nold-alpha-rebuild";
    const bOld = "# B\n\nold-beta-rebuild";
    const a = await writeWorking(guard, projectId, "DOCREQ-SEARCH-REBUILD-7161-A1", "rebuild/a.md", aOld);
    const b = await writeWorking(guard, projectId, "DOCREQ-SEARCH-REBUILD-7161-B1", "rebuild/b.md", bOld);
    await drainProjectSearch(guard, 4);

    const aFresh = "# A\n\nfresh-alpha-rebuild";
    const bFresh = "# B\n\nfresh-beta-rebuild";
    const a2 = await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-REBUILD-7161-A2",
      "rebuild/a.md",
      aFresh,
      a.version_id
    );
    const b2 = await writeWorking(
      guard,
      projectId,
      "DOCREQ-SEARCH-REBUILD-7161-B2",
      "rebuild/b.md",
      bFresh,
      b.version_id
    );

    const byId = new Map([
      [a2.document_id, aFresh],
      [b2.document_id, bFresh]
    ]);
    const orderedIds = [...byId.keys()].sort();
    const failedId = orderedIds[1];
    const failedContent = byId.get(failedId)!;
    const failedPayload = machineDocumentTextPayloadPath(projectId, await sha256Text(failedContent));

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
    expect(originalPayload).toBe(failedContent);
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

    // The active generation is still G1 despite partial G2 progress.
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
    const indexStatus = await searchGuard.fetch(`https://search-index.internal/status?project_id=${projectId}`);
    expect(await indexStatus.json()).toMatchObject({ active_generation: 2, document_generation_indexed: 5 });
    expect((await search(projectId, "fresh-alpha-rebuild")).hits.length).toBeGreaterThan(0);
    expect((await search(projectId, "fresh-beta-rebuild")).hits.length).toBeGreaterThan(0);
  });
});
