import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env & {
  DROPBOX_CHANGE_GUARD: DurableObjectNamespace;
};

interface ChangeGuardStatus {
  requested_generation: number;
  completed_generation: number;
  alarm_scheduled: boolean;
  processing_generation: number | null;
  last_error: string | null;
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

function guard() {
  return testEnv.DROPBOX_CHANGE_GUARD.getByName("global");
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

  it("durably coalesces duplicate notifications and completes the requested generation", async () => {
    installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0001", "change-guard-one");
    const stub = guard();

    expect((await notify(stub)).status).toBe(200);
    expect((await notify(stub)).status).toBe(200);
    expect(await status(stub)).toMatchObject({
      requested_generation: 2,
      completed_generation: 0,
      alarm_scheduled: true,
      processing_generation: null
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 2,
      completed_generation: 2,
      processing_generation: null,
      last_error: null
    });
  });

  it("keeps a failed generation pending, records the failure and re-arms for retry", async () => {
    const mock = installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0002", "change-guard-two");
    const stub = guard();
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
      processing_generation: null
    });
    expect((await status(stub)).last_error).not.toBeNull();

    fail = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 1,
      processing_generation: null,
      last_error: null
    });
  });

  it("does not let an older processing generation consume a notification queued during its run", async () => {
    const mock = installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0003", "change-guard-three");
    const stub = guard();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    let blocked = false;
    interceptProjectList(mock, async () => {
      if (blocked) return null;
      blocked = true;
      entered();
      await gate;
      return null;
    });

    expect((await notify(stub)).status).toBe(200);
    const firstAlarm = runDurableObjectAlarm(stub);
    await enteredGate;

    const secondNotify = notify(stub);
    release();
    expect(await firstAlarm).toBe(true);
    expect((await secondNotify).status).toBe(200);
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
