import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

async function createEmptyProject(): Promise<string> {
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-SEARCH-REBUILD-EMPTY-PROJECT",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-01T15:00:00+01:00",
      payload: {
        name: "Search Rebuild Empty Project",
        slug: "search-rebuild-empty-project",
        aliases: [],
        objective: "Rebuild search without managed documents"
      }
    })
  }), testEnv, createExecutionContext());

  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

describe("SearchIndex rebuild for an empty project", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("starts a generation-safe rebuild after the initial empty-document search generation", async () => {
    const projectId = await createEmptyProject();
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!await runDurableObjectAlarm(projectGuard)) break;
    }

    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    const response = await searchGuard.fetch("https://search-index.internal/rebuild-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId })
    });
    const diagnostic = await response.clone().text();

    expect(response.status, diagnostic).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId,
      active_generation: 1,
      staging_generation: 2,
      target_canonical_revision: 1,
      target_document_generation: 1,
      pending_items: 0
    });
  });
});
