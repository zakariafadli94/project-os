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

async function createProject(label: string): Promise<string> {
  const suffix = label.toLowerCase();
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-SEARCH-REBUILD-EMPTY-${label}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-01T15:00:00+01:00",
      payload: {
        name: `Search Rebuild Empty ${label}`,
        slug: `search-rebuild-empty-${suffix}`,
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

describe("SearchIndex rebuild for an empty core_v2-floor project", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("starts a generation-safe rebuild for empty PRJ-0005 after initial search convergence", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await createProject(`SEED-${index}`);
    }
    const projectId = await createProject("TARGET");
    expect(projectId).toBe("PRJ-0005");

    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!await runDurableObjectAlarm(projectGuard)) break;
    }

    const sourceResponse = await projectGuard.fetch("https://project-guard.internal/search-sync-status");
    const sourceDiagnostic = await sourceResponse.clone().text();

    const searchGuard = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    const response = await searchGuard.fetch("https://search-index.internal/rebuild-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId })
    });
    const rebuildDiagnostic = await response.clone().text();

    if (response.status !== 202) {
      throw new Error(
        `EMPTY_PRJ0005_REBUILD status=${response.status} source=${sourceDiagnostic} rebuild=${rebuildDiagnostic}`
      );
    }

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
