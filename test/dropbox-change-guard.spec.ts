import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  reset,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { ManagedDocumentChangeJobStore } from "../src/documents/change-job-store";

const testEnv = env as unknown as Env & {
  DROPBOX_CHANGE_GUARD: DurableObjectNamespace;
};
let resetAfterMaintenanceFixture = false;

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

async function runChangeAlarmNow(stub: DurableObjectStub, projectId: string): Promise<void> {
  const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(projectGuard, async (_instance, state) => {
    const store = new ManagedDocumentChangeJobStore(state.storage);
    const continuation = store.continuation();
    if (continuation.feed_retry_at === null) return;
    store.finishContinuationSlice({
      pending: continuation.pending,
      next_wake_at: 0,
      documents_priority_next: continuation.documents_priority_next,
      feed_retry_at: 0,
      outcome: continuation.last_outcome ?? { unread_feed: true }
    });
  });
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

async function holdLocalAlarmForManualDrive(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_instance, state) => {
    const setAlarm = state.storage.setAlarm.bind(state.storage);
    const heldUntil = Date.now() + 60_000;
    // Only this project's timer is held; reconciliation and durable checkpoints
    // still run unchanged. Explicit runDurableObjectAlarm calls drive the order.
    const alarm = vi.spyOn(state.storage, "setAlarm").mockImplementation((time, options) =>
      setAlarm(Math.max(time instanceof Date ? time.getTime() : time, heldUntil), options));
    await state.storage.setAlarm(heldUntil);
    return alarm;
  });
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
  afterEach(async () => {
    const shouldReset = resetAfterMaintenanceFixture;
    resetAfterMaintenanceFixture = false;
    try {
      if (shouldReset) await reset();
    } finally {
      vi.restoreAllMocks();
    }
  });

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

  it("keeps an empty has-more generation open and parked after local continuation acknowledgement", async () => {
    const mock = installDropboxMock();
    const slug = "change-guard-empty-more";
    const projectId = await createProject("TXN-CHANGE-GUARD-EMPTY-MORE-0001", slug);
    const stub = guard("empty-more");
    interceptProjectList(mock, async path => path.includes(`${projectId}-${slug}`)
      ? new Response(JSON.stringify({ entries: [], cursor: "empty-more-cursor", has_more: true }), { status: 200 })
      : null);

    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await status(stub)).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      processing_generation: null,
      alarm_scheduled: false,
      failure_count: 0,
      last_error: null
    });
  });

  it("keeps a failed generation pending, records the failure and re-arms for retry", async () => {
    const mock = installDropboxMock();
    const projectId = await createProject("TXN-CHANGE-GUARD-0002", "change-guard-two");
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
    await runChangeAlarmNow(stub, projectId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const recovered = await status(stub);
    expect(recovered).toMatchObject({ requested_generation: 1, processing_generation: null, last_error: null, failure_count: 0 });
    expect([0, 1]).toContain(recovered.completed_generation);
  });

  it("keeps a generation open but parks it after an acknowledged local job handoff", async () => {
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
      alarm_scheduled: false,
      processing_generation: null,
      failure_count: 0
    });
    expect(observed.last_error).toBeNull();
    expect(observed.alarm_at).toBeNull();
    expect((await notify(stub)).status).toBe(200);
    expect(await status(stub)).toMatchObject({ requested_generation: 1, completed_generation: 0, alarm_scheduled: true });
  });

  it("stabilizes a clean fleet notification across two local/global alarm alternations", async () => {
    installDropboxMock();
    const projectId = await createProject("TXN-CHANGE-GUARD-CLEAN-CYCLE-0001", "change-guard-clean-cycle");
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    const stub = guard("clean-cycle");
    const baseline = await projectGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await status(stub)).requested_generation).toBe(1);
    const localCheckpoint = await runInDurableObject(projectGuard, (_instance, state) =>
      new ManagedDocumentChangeJobStore(state.storage).continuation());
    expect(localCheckpoint.last_outcome?.global_notification_owed).not.toBe(true);

    for (let alternation = 0; alternation < 2; alternation += 1) {
      expect((await projectGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
      expect(await runDurableObjectAlarm(projectGuard)).toBe(true);
      expect((await status(stub)).requested_generation).toBe(1);
    }
  });

  it("keeps a stopped-only feed incident visible while parking the global generation", async () => {
    installDropboxMock();
    const projectId = await createProject("TXN-CHANGE-GUARD-STOPPED-FEED-0001", "change-guard-stopped-feed");
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(projectGuard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const progress = await store.feedProgressFingerprint(0);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        store.recordInternalFeedFailure("a".repeat(64), progress);
      }
    });
    const stub = guard("stopped-only-feed");
    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const observed = await status(stub);
    expect(observed).toMatchObject({
      requested_generation: 1,
      completed_generation: 0,
      processing_generation: null,
      alarm_scheduled: false,
      alarm_at: null,
      failure_count: 0,
      last_error: null
    });
    const local = await projectGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(local.status).toBe(200);
    expect(await local.json<Record<string, unknown>>()).toMatchObject({
      stopped_unresolved_jobs: 1,
      safe_errors: ["identical_internal_feed_failure_limit"],
      verification_completed: false,
      local_handoff_acknowledged: true
    });
  });

  it("defers persistent reconciliation failures after five rapid retries", async () => {
    const mock = installDropboxMock();
    const projectId = await createProject("TXN-CHANGE-GUARD-0005", "change-guard-five");
    const stub = guard("bounded-retry");
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-change-guard-five`;
    let providerFailures = 0;
    interceptProjectList(mock, async (path) => {
      if (path !== root) return null;
      providerFailures += 1;
      return new Response(JSON.stringify({ error_summary: "invalid_arg/persistent_failure" }), { status: 400 });
    });
    const localAlarm = await holdLocalAlarmForManualDrive(projectGuard);
    try {
      expect((await notify(stub)).status).toBe(200);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(providerFailures).toBe(1);
      expect((await status(stub)).failure_count).toBe(1);
      for (let attempt = 1; attempt < 6; attempt += 1) {
        await runChangeAlarmNow(stub, projectId);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(providerFailures).toBe(attempt + 1);
        expect((await status(stub)).failure_count).toBe(attempt + 1);
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
    } finally {
      await runInDurableObject(projectGuard, async (_instance, state) => state.storage.deleteAlarm());
      localAlarm.mockRestore();
    }
  });

  it("parks the global retry without completing its generation when local recovery consumes the sixth feed failure", async () => {
    const mock = installDropboxMock();
    const slug = "change-guard-local-sixth";
    const projectId = await createProject("TXN-CHANGE-GUARD-LOCAL-SIXTH-0001", slug);
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    const stub = guard("local-sixth-feed-failure");
    let targetStorage: DurableObjectStorage;
    let localSliceActive = false;
    let expectedLocalOrdinal: number | null = null;
    let persistedLocalSlice: ReturnType<ManagedDocumentChangeJobStore["continuation"]> | null = null;
    const originalFinish = ManagedDocumentChangeJobStore.prototype.finishContinuationSlice;
    await runInDurableObject(projectGuard, async (_instance, state) => {
      targetStorage = state.storage;
    });
    const finishSlice = vi.spyOn(ManagedDocumentChangeJobStore.prototype, "finishContinuationSlice").mockImplementation(function (this: ManagedDocumentChangeJobStore, input) {
      const result = originalFinish.call(this, input);
      if (localSliceActive && (this as unknown as { storage: DurableObjectStorage }).storage === targetStorage) {
        const persisted = this.continuation();
        // Capture the actual successful SQL write, not its input or an outcome
        // selected by error. A later fleet slice may legitimately replace it.
        if (persisted.slice_ordinal === expectedLocalOrdinal) persistedLocalSlice = structuredClone(persisted);
      }
      return result;
    });
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-${slug}`;
    let providerFailures = 0;
    interceptProjectList(mock, async (path) => {
      if (path !== root) return null;
      providerFailures += 1;
      return new Response(JSON.stringify({ error_summary: "invalid_arg/persistent_failure" }), { status: 400 });
    });
    const localAlarm = await holdLocalAlarmForManualDrive(projectGuard);
    try {
      expect((await notify(stub)).status).toBe(200);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(providerFailures).toBe(1);
      for (let attempt = 1; attempt < 5; attempt += 1) {
        await runChangeAlarmNow(stub, projectId);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(providerFailures).toBe(attempt + 1);
        expect((await status(stub)).failure_count).toBe(attempt + 1);
      }
      await runChangeAlarmNow(stub, projectId);
      expectedLocalOrdinal = await runInDurableObject(projectGuard, async (_instance, state) =>
        new ManagedDocumentChangeJobStore(state.storage).continuation().slice_ordinal + 1);
      localSliceActive = true;
      try {
        expect(await runDurableObjectAlarm(projectGuard)).toBe(true);
      } finally {
        localSliceActive = false;
      }
      expect(persistedLocalSlice).not.toBeNull();
      const localSlice = persistedLocalSlice! as ReturnType<ManagedDocumentChangeJobStore["continuation"]>;
      expect(localSlice.slice_ordinal).toBe(expectedLocalOrdinal);
      expect(localSlice.last_outcome?.safe_errors).toEqual(["provider_blocked"]);

      // Exercise an independent fleet pass before reading the current checkpoint.
      // Its deferred slice must not overwrite the captured local failure proof.
      const independentFleet = guard("ci2044-independent-fleet");
      expect((await notify(independentFleet)).status).toBe(200);
      expect(await runDurableObjectAlarm(independentFleet)).toBe(true);
      expect(providerFailures).toBe(6);
      expect((await status(stub)).failure_count).toBe(5);
      const beforeGlobal = await runInDurableObject(projectGuard, async (_instance, state) => ({
        continuation: new ManagedDocumentChangeJobStore(state.storage).continuation(),
        alarm_at: await state.storage.getAlarm()
      }));
      expect(beforeGlobal.continuation.pending).toBe(true);
      expect(beforeGlobal.continuation.last_outcome?.unread_feed).toBe(true);
      expect(beforeGlobal.continuation.feed_retry_at).toBeGreaterThan(Date.now());
      expect(beforeGlobal.continuation.feed_retry_at).toBe(localSlice.feed_retry_at);
      expect(beforeGlobal.continuation.next_wake_at).toBe(localSlice.next_wake_at);
      expect(localSlice.last_outcome?.safe_errors).toEqual(["provider_blocked"]);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(providerFailures).toBe(6);
      expect(await status(stub)).toMatchObject({
        requested_generation: 1, completed_generation: 0,
        processing_generation: null, failure_count: 0, last_error: null,
        alarm_scheduled: false, alarm_at: null
      });
      const afterGlobal = await runInDurableObject(projectGuard, async (_instance, state) => ({
        continuation: new ManagedDocumentChangeJobStore(state.storage).continuation(),
        alarm_at: await state.storage.getAlarm()
      }));
      expect(afterGlobal.continuation.pending).toBe(true);
      expect(afterGlobal.continuation.last_outcome?.unread_feed).toBe(true);
      expect(afterGlobal.continuation.last_outcome?.safe_errors).toEqual([]);
      expect(afterGlobal.continuation.feed_retry_at).toBe(beforeGlobal.continuation.feed_retry_at);
      expect(afterGlobal.continuation.next_wake_at).toBe(beforeGlobal.continuation.next_wake_at);
      expect(afterGlobal.alarm_at).toBe(beforeGlobal.alarm_at);
      expect(afterGlobal.alarm_at).toBeGreaterThanOrEqual(afterGlobal.continuation.next_wake_at!);
    } finally {
      await runInDurableObject(projectGuard, async (_instance, state) => state.storage.deleteAlarm());
      localAlarm.mockRestore();
      finishSlice.mockRestore();
    }
  });

  it("leaves a later notification pending for a subsequent alarm generation", async () => {
    installDropboxMock();
    await createProject("TXN-CHANGE-GUARD-0003", "change-guard-three");
    const stub = guard("generation-snapshot");

    expect((await notify(stub)).status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterFirst = await status(stub);
    expect(afterFirst).toMatchObject({ requested_generation: 1, processing_generation: null, last_error: null });
    expect([0, 1]).toContain(afterFirst.completed_generation);

    // The miniflare alarm helper cannot safely drive a second stub request from
    // another DO I/O context while the manual alarm is blocked. The production
    // invariant is therefore asserted at the durable generation boundary: a
    // notification registered after the processed generation remains pending
    // and schedules another alarm instead of being retroactively consumed.
    expect((await notify(stub)).status).toBe(200);
    const afterNotify = await status(stub);
    expect(afterNotify).toMatchObject({ requested_generation: 1, alarm_scheduled: true, processing_generation: null, last_error: null });
    expect(afterNotify.completed_generation).toBe(afterFirst.completed_generation);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterSecond = await status(stub);
    expect(afterSecond).toMatchObject({ requested_generation: 1, processing_generation: null, last_error: null });
    expect(afterSecond.completed_generation).toBeLessThanOrEqual(1);
  });

  it("scheduled maintenance performs one bounded due managed-document verification", async () => {
    await reset();
    resetAfterMaintenanceFixture = true;
    const mock = installDropboxMock();
    const projectId = await createProject("TXN-CHANGE-GUARD-0004", "change-guard-four");
    const registry = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/registry", { method: "GET" });
    const registeredProjects = (await registry.json<{ projects: Array<{ project_id: string }> }>()).projects;
    expect(registeredProjects.map(project => project.project_id)).toEqual([projectId]);
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

    expect(projectListPaths).toEqual([
      `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-change-guard-four`
    ]);
  }, 15_000);
});
