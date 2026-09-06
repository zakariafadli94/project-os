import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env & {
  DROPBOX_CHANGE_GUARD: DurableObjectNamespace;
};

interface ChangeGuardStatus {
  requested_generation: number;
  completed_generation: number;
  alarm_scheduled: boolean;
  alarm_at: number | null;
  processing_generation: number | null;
  last_error: string | null;
  failure_count: number;
}

async function createProject(transactionId: string, slug: string) {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-31T15:20:00+01:00",
      payload: {
        name: `Dropbox change ${slug}`,
        slug,
        aliases: [],
        objective: "Dropbox durable change handoff test"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

function guard(name = "global") {
  return testEnv.DROPBOX_CHANGE_GUARD.getByName(name);
}

async function notify(stub = guard()) {
  return stub.fetch("https://dropbox-change-guard.internal/notify", { method: "POST" });
}

async function status(stub = guard()): Promise<ChangeGuardStatus> {
  const response = await stub.fetch("https://dropbox-change-guard.internal/status", { method: "GET" });
  expect(response.status).toBe(200);
  return response.json<ChangeGuardStatus>();
}

function interceptProjectList(
  mock: ReturnType<typeof installDropboxMock>,
  behavior: (path: string) => Promise<Response | null>
) {
  const delegate = mock.spy.getMockImplementation();
  if (!delegate) throw new Error("Dropbox mock implementation unavailable");
  mock.spy.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder") {
      const body = JSON.parse(await request.clone().text()) as { path?: string };
      if (typeof body.path === "string" && body.path.startsWith("/PROJECT_OS/WORKSPACE/PROJECTS/")) {
        const response = await behavior(body.path);
        if (response) return response;
      }
    }
    return delegate(input, init);
  });
}

describe("DropboxChangeGuard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("durably coalesces duplicate notifications and completes one pending generation", async () => {
    installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0001", "change-guard-one");
    const stub = guard("coalesce");

    expect((await notify(stub)).status).toBe(200);
    expect((await notify(stub)).status).toBe(200);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      alarm_scheduled: true,
      processing_generation: null,
      failure_count: 0
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 1,
      processing_generation: null,
      last_error: null,
      failure_count: 0
    });
  });

  it("keeps a failed generation pending, records the failure and re-arms for retry", async () => {
    const mock = installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0002", "change-guard-two");
    const stub = guard("retry");
    let fail = true;
    interceptProjectList(mock, async () => fail
      ? new Response(JSON.stringify({ error_summary: "invalid_arg/test_failure" }), { status: 400 })
      : null);

    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      alarm_scheduled: true,
      processing_generation: null,
      failure_count: 1
    });
    expect((await status(stub)).last_error).not.toBeNull();

    fail = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 1,
      processing_generation: null,
      last_error: null,
      failure_count: 0
    });
  });

  it("keeps a generation open and re-arms while a durable document job remains pending", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-guard-pending-job";
    const projectId = await createProject("TXN-CHANGE-GUARD-0006", slug);
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const baseline = await projectGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-${slug}`;
    const badInput = `${root}/INPUTS/retry.pdf`;
    faults.push({
      endpoint: "/2/files/copy_v2",
      occurrence: 1,
      status: 409,
      error_summary: "to/conflict/file/...",
      path: badInput
    });
    await mock.writeExternal(badInput, "%PDF retry later");

    const stub = guard("pending-document-job");
    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    let pendingJobs: Array<{ status: string; attempts: number; last_error: string | null }> = [];
    await runInDurableObject(projectGuard, async (_instance, state) => {
      pendingJobs = state.storage.sql.exec<{ status: string; attempts: number; last_error: string | null }>(
        `SELECT status, attempts, last_error
         FROM managed_document_change_jobs
         WHERE status = 'pending'`
      ).toArray();
    });
    expect(pendingJobs).toHaveLength(1);
    expect(pendingJobs[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(pendingJobs[0].last_error).not.toBeNull();

    const observed = await status(stub);
    expect(observed).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      alarm_scheduled: true,
      processing_generation: null,
      failure_count: 1
    });
    expect(observed.last_error).not.toBeNull();
    expect(observed.alarm_at).not.toBeNull();
  });

  it("defers persistent reconciliation failures after five rapid retries", async () => {
    const mock = installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0005", "change-guard-five");
    const stub = guard("bounded-retry");
    interceptProjectList(mock, async () =>
      new Response(JSON.stringify({ error_summary: "invalid_arg/persistent_failure" }), { status: 400 }));

    expect((await notify(stub)).status).toBe(200);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }

    const observed = await status(stub);
    expect(observed).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      alarm_scheduled: true,
      processing_generation: null,
      failure_count: 6
    });
    expect(observed.last_error).not.toBeNull();
    expect(observed.alarm_at).not.toBeNull();
    expect((observed.alarm_at ?? 0) - Date.now()).toBeGreaterThan(240_000);
  });

  it("leaves a later notification pending for a subsequent alarm generation", async () => {
    installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0003", "change-guard-three");
    const stub = guard("generation-snapshot");

    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 1,
      processing_generation: null,
      last_error: null
    });

    // The miniflare alarm helper cannot safely drive a second stub request from
    // another DO I/O context while the manual alarm is blocked. The production
    // invariant is therefore asserted at the durable generation boundary: a
    // notification registered after the processed generation remains pending
    // and schedules another alarm instead of being retroactively consumed.
    expect((await notify(stub)).status).toBe(200);
    expect(await status(stub)).toMatchObject({
      requested_generation: 2,
      completed_generation: 1,
      alarm_scheduled: true,
      processing_generation: null,
      last_error: null
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 2,
      completed_generation: 2,
      processing_generation: null,
      last_error: null
    });
  });

  it("scheduled maintenance does not reconcile managed-document provider roots", async () => {
    const mock = installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0004", "change-guard-four");
    const projectListPaths: string[] = [];
    interceptProjectList(mock, async (path) => {
      projectListPaths.push(path);
      return null;
    });

    const ctx = createExecutionContext();
    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(projectListPaths).toEqual([]);
  });
});
