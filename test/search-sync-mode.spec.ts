import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { reconcileSearchIndexes } from "../src/index-neutral";
import { searchSyncEnabled } from "../src/search/sync-mode";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

function envWithSyncMode(mode?: string): Env {
  const candidate = { ...testEnv } as Record<string, unknown>;
  if (mode === undefined) delete candidate.PROJECT_OS_SEARCH_SYNC_MODE;
  else candidate.PROJECT_OS_SEARCH_SYNC_MODE = mode;
  return candidate as unknown as Env;
}

describe("PROJECT_OS_SEARCH_SYNC_MODE production gate", () => {
  it.each([
    [undefined, false],
    ["off", false],
    ["ON", false],
    ["true", false],
    ["1", false],
    [" on", false],
    ["on ", false],
    ["", false],
    ["on", true]
  ])("accepts only exact on: %j", (mode, expected) => {
    expect(searchSyncEnabled(envWithSyncMode(mode as string | undefined))).toBe(expected);
  });

  it("makes fleet reconciliation fully inert before touching registry or search durable objects when off", async () => {
    const guarded = new Proxy({ PROJECT_OS_SEARCH_SYNC_MODE: "off" } as Record<string, unknown>, {
      get(target, property) {
        if (property in target) return target[property as string];
        throw new Error(`unexpected env access while sync is off: ${String(property)}`);
      }
    }) as unknown as Env;

    await expect(reconcileSearchIndexes(guarded)).resolves.toEqual({
      scanned: 0,
      scheduled: 0,
      current: 0,
      rebuilding: 0,
      failed: 0
    });
  });

  it("does not schedule derived search wake work from canonical commits when off", async () => {
    const offEnv = envWithSyncMode("off");
    const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-SEARCH-SYNC-OFF-PROBE",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-09-03T16:00:00+01:00",
        payload: {
          name: "Search Sync Off Probe",
          slug: "search-sync-off-probe",
          aliases: [],
          objective: "prove derived sync remains inert"
        }
      })
    }), offEnv, createExecutionContext());
    expect(response.status).toBe(200);
    const receipt = await response.json<{ project_id: string; status: string }>();
    expect(receipt.status).toBe("committed");

    const syncGuard = offEnv.SEARCH_SYNC_GUARD.getByName(receipt.project_id);
    expect(await runDurableObjectAlarm(syncGuard)).toBe(false);
  });

  it("keeps public search off while allowing an authenticated operator shadow query surface", async () => {
    const envWithPublicReadOff = {
      ...envWithSyncMode("on"),
      PROJECT_OS_SEARCH_READ_MODE: "off"
    } as Env;

    const publicSearch = await worker.fetch(new Request("https://project-os.test/v1/search", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project_ids: ["PRJ-0002"], text: "probe" })
    }), envWithPublicReadOff, createExecutionContext());
    expect(publicSearch.status).toBe(404);

    const unauthenticatedShadow = await worker.fetch(new Request("https://project-os.test/v1/admin/search/shadow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_ids: ["PRJ-0002"], text: "probe" })
    }), envWithPublicReadOff, createExecutionContext());
    expect(unauthenticatedShadow.status).toBe(401);

    const malformedShadow = await worker.fetch(new Request("https://project-os.test/v1/admin/search/shadow", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "missing explicit project scope" })
    }), envWithPublicReadOff, createExecutionContext());
    expect(malformedShadow.status).toBe(400);
    await expect(malformedShadow.json()).resolves.toEqual({ error: "invalid_search_query" });
  });
});
