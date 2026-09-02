import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

describe("search rebuild admin diagnostic", () => {
  beforeEach(() => installDropboxMock());

  it("accepts a direct rebuild after the initial search sync is current", async () => {
    const created = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-SEARCH-REBUILD-DIAGNOSTIC-CREATE",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-09-01T15:00:00+01:00",
        payload: {
          name: "Search Rebuild Diagnostic",
          slug: "search-rebuild-diagnostic",
          aliases: [],
          objective: "diagnose direct search rebuild"
        }
      })
    }), testEnv, createExecutionContext());
    expect(created.status).toBe(200);
    const receipt = await created.json<{ status: string; project_id: string }>();
    expect(receipt.status).toBe("committed");

    const projectGuard = testEnv.PROJECT_GUARD.getByName(receipt.project_id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!await runDurableObjectAlarm(projectGuard)) break;
    }

    const source = await projectGuard.fetch("https://project-guard.internal/search-sync-status");
    expect(source.status).toBe(200);
    const sourceBody = await source.clone().text();

    const searchIndex = testEnv.SEARCH_INDEX_GUARD.getByName("global");
    const rebuild = await searchIndex.fetch("https://search-index.internal/rebuild-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: receipt.project_id })
    });
    const rebuildBody = await rebuild.clone().text();
    if (rebuild.status !== 202) {
      console.error("Direct search rebuild diagnostic", {
        project_id: receipt.project_id,
        source: sourceBody,
        status: rebuild.status,
        body: rebuildBody
      });
    }
    expect(rebuild.status).toBe(202);
  });
});
