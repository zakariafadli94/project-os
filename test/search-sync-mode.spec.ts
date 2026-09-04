import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { reconcileSearchIndexes } from "../src/index-neutral";
import { searchSyncEnabled } from "../src/search/sync-mode";
import { installDropboxMock } from "./helpers/mock-dropbox";

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

async function createTransitionProject(): Promise<string> {
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-SYNC-TRANSITION-CREATE",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-03T16:40:00+01:00",
      payload: {
        name: "Sync Transition Probe",
        slug: "sync-transition-probe",
        aliases: [],
        objective: "prove on off on wake recovery"
      }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const body = await response.json<{ project_id: string; status: string }>();
  expect(body.status).toBe("committed");
  return body.project_id;
}

async function commitTransitionTask(projectId: string, baseRevision: number, suffix: string): Promise<void> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-SYNC-TRANSITION-${suffix}`,
      project_id: projectId,
      base_revision: baseRevision,
      operation: "task.create",
      created_at: "2026-09-03T16:41:00+01:00",
      payload: {
        task_id: `TASK-TRANSITION${suffix}`,
        title: `Transition ${suffix}`,
        description: "derived sync wake must remain recoverable"
      }
    })
  }), testEnv, ctx);
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
}

async function waitForAlarm(stub: DurableObjectStub, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    if (alarm !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())).not.toBeNull();
}

describe("PROJECT_OS_SEARCH_SYNC_MODE production gate", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it("recovers wake scheduling across an on to off to on transition", async () => {
    installDropboxMock();
    const projectId = await createTransitionProject();
    await commitTransitionTask(projectId, 1, "A001");

    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    const syncGuard = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    await waitForAlarm(syncGuard);

    await runInDurableObject(projectGuard, async (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_SEARCH_SYNC_MODE = "off";
    });
    await runInDurableObject(syncGuard, async (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_SEARCH_SYNC_MODE = "off";
    });

    expect(await runDurableObjectAlarm(syncGuard)).toBe(true);
    expect(await runDurableObjectAlarm(syncGuard)).toBe(false);

    await runInDurableObject(projectGuard, async (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_SEARCH_SYNC_MODE = "on";
    });
    await runInDurableObject(syncGuard, async (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_SEARCH_SYNC_MODE = "on";
    });

    await commitTransitionTask(projectId, 2, "A002");
    await waitForAlarm(syncGuard);
    expect(await runDurableObjectAlarm(syncGuard)).toBe(true);
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
