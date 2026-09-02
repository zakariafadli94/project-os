import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
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
        logical_path: "rebuild/generation.md",
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

async function drainSearchSync(projectId: string, alarms: number): Promise<void> {
  const syncGuard = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
  for (let index = 0; index < alarms; index += 1) {
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

describe("SearchIndex generation-safe rebuild", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("keeps G1 queryable while G2 stages and promotes only after authoritative validation", async () => {
    const projectId = "PRJ-7160";
    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    await createProject(projectId);

    const first = await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-A",
      "# Rebuild document\n\nlegacy-generation-phrase"
    );
    await drainSearchSync(projectId, 3);
    expect((await search(projectId, "legacy-generation-phrase")).hits.some(
      (hit) => hit.document_id === first.document_id
    )).toBe(true);

    await writeWorking(
      projectId,
      "DOCREQ-SEARCH-REBUILD-7160-B",
      "# Rebuild document\n\nfresh-generation-phrase",
      first.version_id
    );

    const started = await searchGuard.fetch("https://search-index.internal/rebuild-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId })
    });
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
});
