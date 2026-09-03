import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { reconcileManagedDocuments, reconcileMaterializations } from "../src/index-neutral";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

async function createProject(suffix: string): Promise<string> {
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-SYNC-OFF-CREATE-${suffix}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-03T16:30:00+01:00",
      payload: {
        name: `Sync Off ${suffix}`,
        slug: `sync-off-${suffix.toLowerCase()}`,
        aliases: [],
        objective: "prove search sync off is inert"
      }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const body = await response.json<{ project_id: string; status: string }>();
  expect(body.status).toBe("committed");
  return body.project_id;
}

async function addTask(projectId: string, revision: number, suffix: string): Promise<void> {
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-SYNC-OFF-TASK-${suffix}`,
      project_id: projectId,
      base_revision: revision,
      operation: "task.create",
      created_at: "2026-09-03T16:31:00+01:00",
      payload: {
        task_id: `TASK-SYNCOFF${suffix}`,
        title: `Sync off task ${suffix}`,
        description: "canonical work must commit without derived search wake"
      }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "committed", new_revision: revision + 1 });
}

async function sourceStatus(projectId: string): Promise<Record<string, unknown>> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/search-sync-status",
    { method: "GET" }
  );
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>>();
}

describe("PROJECT_OS_SEARCH_SYNC_MODE real off environment", () => {
  beforeEach(() => installDropboxMock());

  it("commits canonical work while direct wake remains inert", async () => {
    const projectId = await createProject("A001");
    await addTask(projectId, 1, "A001");

    const syncGuard = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    const wake = await syncGuard.fetch("https://search-sync.internal/wake", { method: "POST" });
    expect(wake.status).toBe(200);
    await expect(wake.json()).resolves.toMatchObject({
      project_id: projectId,
      pending: false,
      sync_enabled: false
    });
    expect(await runDurableObjectAlarm(syncGuard)).toBe(false);
  });

  it("keeps a valid multi-project shadow query observation-only while public search stays off", async () => {
    const left = await createProject("B001");
    const right = await createProject("B002");
    await addTask(left, 1, "B001");
    await addTask(right, 1, "B002");

    const beforeLeft = await sourceStatus(left);
    const beforeRight = await sourceStatus(right);
    expect(await runDurableObjectAlarm(testEnv.SEARCH_SYNC_GUARD.getByName(left))).toBe(false);
    expect(await runDurableObjectAlarm(testEnv.SEARCH_SYNC_GUARD.getByName(right))).toBe(false);

    const publicResponse = await worker.fetch(new Request("https://project-os.test/v1/search", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project_ids: [left, right], text: "Sync off" })
    }), testEnv, createExecutionContext());
    expect(publicResponse.status).toBe(404);

    const shadow = await worker.fetch(new Request("https://project-os.test/v1/admin/search/shadow", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project_ids: [left, right], text: "Sync off", limit: 20 })
    }), testEnv, createExecutionContext());
    expect(shadow.status).toBe(200);
    const shadowBody = await shadow.json<{ hits: unknown[]; freshness: Array<{ project_id: string }> }>();
    expect(shadowBody.hits).toEqual([]);
    expect(new Set(shadowBody.freshness.map((item) => item.project_id))).toEqual(new Set([left, right]));

    expect(await sourceStatus(left)).toEqual(beforeLeft);
    expect(await sourceStatus(right)).toEqual(beforeRight);
    expect(await runDurableObjectAlarm(testEnv.SEARCH_SYNC_GUARD.getByName(left))).toBe(false);
    expect(await runDurableObjectAlarm(testEnv.SEARCH_SYNC_GUARD.getByName(right))).toBe(false);
  });

  it("preserves non-search maintenance while search synchronization is off", async () => {
    const maintenanceCalls: string[] = [];
    const maintenanceEnv = {
      PROJECT_OS_SEARCH_SYNC_MODE: "off",
      REGISTRY_GUARD: {
        getByName: () => ({
          fetch: async () => Response.json({ projects: [{ project_id: "PRJ-9001", slug: "maintenance-probe" }] })
        })
      },
      MATERIALIZATION_GUARD: {
        getByName: (projectId: string) => ({
          fetch: async () => {
            maintenanceCalls.push(`materialization:${projectId}`);
            return Response.json({
              project_id: projectId,
              canonical_revision: 1,
              projection_version: 3,
              materialized_head: { revision: 1, projection_version: 3 },
              requested: null,
              active: null,
              blocked_error: null
            });
          }
        })
      },
      PROJECT_GUARD: {
        getByName: (projectId: string) => ({
          fetch: async () => {
            maintenanceCalls.push(`documents:${projectId}`);
            return Response.json({
              scanned: 0,
              captured: 0,
              ingested: 0,
              duplicates: 0,
              restored: 0,
              conflicts: 0,
              cursor_reset: false,
              changed_document_ids: []
            });
          }
        })
      }
    } as unknown as Env;

    await expect(reconcileMaterializations(maintenanceEnv)).resolves.toMatchObject({
      scanned: 1,
      current: 1,
      failed: 0
    });
    await expect(reconcileManagedDocuments(maintenanceEnv)).resolves.toMatchObject({
      projects_scanned: 1,
      projects_failed: 0
    });
    expect(maintenanceCalls).toEqual(["materialization:PRJ-9001", "documents:PRJ-9001"]);
  });

  it("fails closed authentication when INGRESS_TOKEN is absent, empty or incorrect, and accepts only the exact token", async () => {
    const malformedBody = JSON.stringify({ text: "missing scope" });
    const request = (authorization: string) => new Request("https://project-os.test/v1/admin/search/shadow", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: malformedBody
    });

    const absent = { ...testEnv } as Record<string, unknown>;
    delete absent.INGRESS_TOKEN;
    expect((await worker.fetch(request("Bearer undefined"), absent as unknown as Env, createExecutionContext())).status).toBe(401);

    const empty = { ...testEnv, INGRESS_TOKEN: "" } as Env;
    expect((await worker.fetch(request("Bearer "), empty, createExecutionContext())).status).toBe(401);

    expect((await worker.fetch(request("Bearer wrong-token"), testEnv, createExecutionContext())).status).toBe(401);
    expect((await worker.fetch(request(`Bearer ${testEnv.INGRESS_TOKEN}`), testEnv, createExecutionContext())).status).toBe(400);
  });
});
