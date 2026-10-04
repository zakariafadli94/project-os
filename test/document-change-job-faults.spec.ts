import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  initializeManagedDocumentChangeJobSchema,
  ManagedDocumentChangeJobStore,
  type ManagedDocumentChangeJobInput,
  type ManagedDocumentDriftFinding,
  type ManagedDocumentChangeQuarantine
} from "../src/documents/change-job-store";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { emptyProjectState } from "../src/domain/transitions";
import { packageRuntime } from "./helpers/package-runtime";
import { InternalExecutionFailure } from "../src/execution/coordinator";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { RuleAdmissionError } from "../src/admission/rule-admission";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { normalizeSystemAdmission } from "../src/admission/operation-context";
import { sha256Canonical } from "../src/materialization/hash";

const testEnv = env as unknown as Env;
const at = "2026-08-31T14:20:00+01:00";
let restoreTestEnvBindings: (() => Promise<void>) | null = null;
let resetAfterRetryFaultFixture = false;

function restoreOptionalEnvBinding(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Change jobs ${slug}`, slug, aliases: [], objective: "Durable change jobs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

function injectRetryAfterForCursor(mock: ReturnType<typeof installDropboxMock>, targetCursor: string) {
  const delegateFetch = mock.spy.getMockImplementation();
  if (!delegateFetch) throw new Error("Dropbox mock implementation unavailable");
  const continuedCursors: string[] = [];
  let retryAfterInjected = false;
  mock.spy.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
      const body = await request.clone().json() as { cursor?: unknown };
      if (typeof body.cursor === "string") continuedCursors.push(body.cursor);
      if (body.cursor === targetCursor && !retryAfterInjected) {
        retryAfterInjected = true;
        return new Response(JSON.stringify({ error_summary: "too_many_requests/" }), {
          status: 429,
          headers: { "Retry-After": "60" }
        });
      }
    }
    return delegateFetch(input, init);
  });
  return { continuedCursors, didInject: () => retryAfterInjected };
}

describe("durable managed-document change jobs", () => {
  afterEach(async () => {
    try { await restoreTestEnvBindings?.(); }
    finally {
      restoreTestEnvBindings = null;
      const shouldReset = resetAfterRetryFaultFixture;
      resetAfterRetryFaultFixture = false;
      try {
        vi.useRealTimers();
      } finally {
        try {
          if (shouldReset) await reset();
        } finally {
          vi.restoreAllMocks();
        }
      }
    }
  });

  it("reports a bounded checkpoint without advancing verification or changing durable jobs", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CHECKPOINT-READ-0001", "checkpoint-read");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const snapshot = async () => runInDurableObject(guard, async (_instance, state) =>
      ["managed_document_change_control", "managed_document_drift_control", "managed_document_change_jobs", "managed_document_change_quarantine", "managed_document_drift_findings"]
        .map(table => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()));
    await runInDurableObject(guard, async (_instance, state) => {
      const jobs = new ManagedDocumentChangeJobStore(state.storage);
      jobs.registerPage({ expected_cursor: null, next_cursor: "private-provider-cursor", jobs: [] });
      jobs.completeScheduledVerification("2026-10-01T12:00:00.000Z");
      for (let index = 0; index < 8; index += 1) {
        const job = { job_id: `CHGJOB-${index.toString(16).toUpperCase().padStart(24, "0")}`,
          change: { kind: "file" as const, path: `/private/target-${index}`, name: `target-${index}` }, detection_source: "incremental" as const, priority: 10 };
        jobs.registerPage({ expected_cursor: jobs.cursor(), next_cursor: "private-provider-cursor", jobs: [job] });
        jobs.markQuarantined({ ...job, ordinal: index, attempts: 0, last_error: null }, "file_target_missing", "2026-10-02T12:00:00.000Z");
        jobs.recordDriftFinding({ finding_id: `DRIFT-${index.toString(16).toUpperCase().padStart(24, "0")}`,
          job_id: job.job_id, path: job.change.path, change_kind: "file", status: "unexpected_conflict", code: "file_target_missing",
          resource: { resource_type: "document", resource_id: "PRIVATE-RESOURCE", version: "private-version", zone: "WORKING" }, observed_at: "2026-10-02T12:00:00.000Z" });
      }
      const pending = { job_id: `CHGJOB-${"F".repeat(24)}`, change: { kind: "file" as const, path: "/private/pending", name: "pending" }, detection_source: "incremental" as const, priority: 10 };
      jobs.registerPage({ expected_cursor: jobs.cursor(), next_cursor: "private-provider-cursor", jobs: [pending] });
      jobs.markFailed(pending.job_id, "private-error-payload");
    });
    const before = await snapshot();
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    expect(response.status).toBe(200);
    const value = await response.json<any>();
    expect(value.document_change_checkpoint).toMatchObject({ read_only: true, project_id: created.project_id,
      schedule: { last_verified_at: "2026-10-01T12:00:00.000Z", next_verification_at: "2026-10-02T12:00:00.000Z", late_since: null, due: true },
      cursor: { present: true }, counts: { pending_jobs: 1, pending_jobs_with_error: 1, quarantines: 8, findings_by_status: { unexpected_conflict: 8 } } });
    expect(value.document_change_checkpoint.schedule.overdue_by_ms).toBeGreaterThan(0);
    expect(value.document_change_checkpoint.cursor.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.document_change_checkpoint.recent_quarantines).toHaveLength(5);
    expect(value.document_change_checkpoint.recent_findings).toHaveLength(5);
    expect(JSON.stringify(value)).not.toMatch(/private-|PRIVATE-RESOURCE|\/private\//);
    expect(await snapshot()).toEqual(before);
  });

  it("omits the checkpoint when quarantine counters contain malformed stored values", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CHECKPOINT-COUNTERS-0001", "checkpoint-counters");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const rows = async () => runInDurableObject(guard, async (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM managed_document_change_quarantine ORDER BY job_id").toArray());
    await runInDurableObject(guard, async (_instance, state) => {
      for (const [id, attempts] of [["A", "private-row-secret"], ["B", -1], ["C", 1.5], ["D", 1]] as const) {
        state.storage.sql.exec("INSERT INTO managed_document_change_quarantine (job_id, path, code, attempts, quarantined_at) VALUES (?, ?, ?, ?, ?)",
          `CHGJOB-${id.repeat(24)}`, "/private/target", "file_target_missing", attempts, "2026-10-02T12:00:00.000Z");
      }
    });
    const before = await rows();
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    const body = await response.json<any>();
    expect(response.status).toBe(200);
    expect(body.document_change_checkpoint).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private-row-secret");
    expect(await rows()).toEqual(before);
  });

  it("bounds a scheduled document slice and leaves durable work for the next cron", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-document-budget";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-SCHEDULED-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    for (let index = 0; index < 6; index += 1) {
      await mock.writeExternal(`${root}/INPUTS/scheduled-${index}.pdf`, `%PDF scheduled ${index}`);
    }

    const response = await guard.fetch(
      "https://project-guard.internal/reconcile-documents?scheduled=1",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduled: true,
      jobs_registered: 6,
      jobs_completed: 1,
      jobs_pending: 5
    });
  });

  it("records provider budget exhaustion as a durable yield without failing or completing verification", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-BUDGET-YIELD-RED-0001", "scheduled-budget-yield-red");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed.listChanges = async () => { throw new Error("slice_budget_exhausted"); };
    const state = emptyProjectState(created.project_id, "Budget yield", "scheduled-budget-yield-red");
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined,
        () => Date.parse("2026-10-03T15:00:00.000Z"));
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-03T15:00:00.000Z" });
    });
    const verification = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).scheduledVerification("2026-10-03T15:00:00.000Z"));

    expect(summary).toMatchObject({ budget_yield: true, semantic_progress: 0, jobs_pending: 0, job_failures: 0, verification_completed: false });
    expect(verification.last_verified_at).toBeNull();
  });

  it("continues an eligible sibling while a has-more feed is parked behind its observed Retry-After", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-RETRY-0001", "feed-retry-sibling");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const now = Date.parse("2026-10-03T15:00:00.000Z");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      return { entries: [], cursor: "must-not-be-read-yet", has_more: true };
    };
    const state = emptyProjectState(created.project_id, "Feed retry", "feed-retry-sibling");
    const job = { job_id: "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC", change: { kind: "deleted" as const, name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental" as const, priority: 10 };
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.beginContinuationSlice(false);
      store.registerPage({ expected_cursor: null, next_cursor: "feed-cursor", jobs: [job] });
      store.finishContinuationSlice({ pending: true, next_wake_at: now + 60_000, documents_priority_next: false,
        feed_retry_at: now + 60_000, outcome: { unread_feed: true } });
      store.completeScheduledVerification("2026-10-01T15:00:00.000Z");
    });
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      (coordinator as any).processJob = async () => true;
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });

    expect(feedCalls).toBe(0);
    expect(summary).toMatchObject({ jobs_completed: 1, jobs_pending: 0, unread_feed: true, feed_retry_at: now + 60_000, verification_completed: false });
  });

  it("keeps an empty has-more page open without claiming semantic progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-EMPTY-HAS-MORE-0001", "empty-has-more");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed.listChanges = async () => ({ entries: [], cursor: "empty-page-next", has_more: true });
    const state = emptyProjectState(created.project_id, "Empty has more", "empty-has-more");
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined,
        () => Date.parse("2026-10-03T15:00:00.000Z"));
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-03T15:00:00.000Z" });
    });

    expect(summary).toMatchObject({ cursor_advanced: true, unread_feed: true, semantic_progress: 0, verification_completed: false });
  });

  it("advances a scheduled continuation through local alarms without another reconcile POST", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-local-continuation";
    const created = await createProject("TXN-CHANGEJOB-LOCAL-CONTINUATION-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const changeGuard = testEnv.DROPBOX_CHANGE_GUARD.getByName("global");
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    for (let index = 0; index < 12; index += 1) mock.writeExternalFolder(`${root}/INPUTS/local-${index}`);
    const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ jobs_pending: 11, jobs_completed: 1 });

    for (let index = 0; index < 2; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_050));
      await runInDurableObject(guard, instance => instance.alarm());
      if (index === 0) {
        const afterFirstAlarm = await runInDurableObject(guard, async (_instance, durableState) =>
          new ManagedDocumentChangeJobStore(durableState.storage).pendingCount());
        expect(afterFirstAlarm).toBe(3);
      }
    }
    const state = await runInDurableObject(guard, async (_instance, durableState) => ({
      pending: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
      checkpoint: new ManagedDocumentChangeJobStore(durableState.storage).continuation()
    }));
    expect(state.pending).toBe(0);
    expect(state.checkpoint.pending).toBe(false);
    expect(mock.folders.has(`${root}/INPUTS/local-11`)).toBe(true);
    const acknowledgement = await changeGuard.fetch("https://dropbox-change-guard.internal/status", { method: "GET" });
    expect(acknowledgement.status).toBe(200);
    expect(await acknowledgement.json<Record<string, unknown>>()).toMatchObject({ requested_generation: 1 });
  }, 15_000);

  it("keeps the initial document continuation wakeable when admission fails before the first scan", async () => {
    const mock = installDropboxMock();
    const slug = "initial-admission-retry";
    const created = await createProject("TXN-CHANGEJOB-INITIAL-ADMISSION-RETRY-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const cursorBefore = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    await mock.writeExternal(`${root}/INPUTS/retry-after-admission.pdf`, "%PDF retry after admission");
    let admissionCalls = 0;
    vi.useFakeTimers();
    try {
      const requestAt = Date.now();
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as { ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean> };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          if (admissionCalls === 1) throw new RuleAdmissionError("rule_admission_invalid");
          return false;
        });
      });

      const failed = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
      expect(failed.status).toBe(503);
      const initial = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        alarm: await durableState.storage.getAlarm()
      }));
      expect(initial.continuation).toMatchObject({ pending: true, next_wake_at: expect.any(Number) });
      expect(initial.alarm).not.toBeNull();

      vi.setSystemTime(requestAt + 2_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const resumed = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        cursor: new ManagedDocumentChangeJobStore(durableState.storage).cursor(),
        pending_jobs: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
        job_statuses: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs").toArray()
      }));
      expect(admissionCalls).toBe(2);
      expect(resumed.cursor).not.toBe(cursorBefore);
      expect(resumed.pending_jobs).toBe(0);
      expect(resumed.job_statuses.length).toBeGreaterThan(0);
      expect(resumed.continuation).toMatchObject({ pending: false, scheduled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries unavailable prelude admission across alarms and resumes without another reconcile POST", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-UNAVAILABLE-0001", "prelude-unavailable");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let admissionCalls = 0;
      let coordinatorCalls = 0;
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as {
          ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
          enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void>;
          notifyDropboxChangeCoordinator: (...args: unknown[]) => Promise<boolean>;
        };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          if (admissionCalls <= 2) throw new RuleAdmissionError("rule_admission_invalid");
          return false;
        });
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation(() => ({
          reconcile: async () => {
            coordinatorCalls += 1;
            return {
              scanned: 0, ignored: 0, captured: 0, ingested: 0, duplicates: 0, restored: 0, conflicts: 0,
              intake_completed: 0, duplicate_cleaned: 0, withdrawn: 0, intake_resumed: 0, changed_document_ids: [],
              candidates: 0, mutation_gate_mode: "observe", policy_violations: 0,
              bootstrapped: 0, cursor_reset: false, baseline: false, cursor_advanced: false, archived: false,
              jobs_registered: 0, jobs_completed: 0, jobs_pending: 0, job_failures: 0, jobs_quarantined: 0,
              drift_findings: 0, expected_changes: 0, scheduled: false, scheduled_due: false,
              late_since: null, last_scheduled_verified_at: null, budget_yield: false, semantic_progress: 0,
              unread_feed: false, executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0,
              verification_completed: false, earliest_eligible_at: null, feed_retry_at: null, safe_errors: []
            } satisfies Awaited<ReturnType<ManagedDocumentChangeCoordinator["reconcile"]>>;
          }
        } as unknown as ManagedDocumentChangeCoordinator));
        vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockResolvedValue();
        vi.spyOn(target, "notifyDropboxChangeCoordinator").mockResolvedValue(true);
      });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const checkpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm()
        }));
        expect(checkpoint.continuation.pending).toBe(true);
        expect(checkpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
        expect(checkpoint.continuation.next_wake_at).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(checkpoint.alarm).not.toBeNull();
        expect(coordinatorCalls).toBe(0);
      }

      vi.setSystemTime(startedAt + 93_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const resumed = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(admissionCalls).toBe(3);
      expect(coordinatorCalls).toBe(1);
      expect(resumed.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks six identical typed prelude INTERNAL failures without a seventh alarm attempt", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-INTERNAL-0001", "prelude-internal-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let stateReads = 0;
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as { readManagedDocumentState: (...args: unknown[]) => Promise<unknown> };
        vi.spyOn(target, "readManagedDocumentState").mockImplementation(async () => {
          stateReads += 1;
          throw new InternalExecutionFailure("canonical_state_decode_failed", "read_state");
        });
      });

      let finalCheckpoint!: { continuation: ReturnType<ManagedDocumentChangeJobStore["continuation"]>; alarm: number | null; rawFailure: string | null };
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        finalCheckpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm(),
          rawFailure: durableState.storage.sql.exec<{ prelude_failure_state_json: string | null }>(
            "SELECT prelude_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
          ).one().prelude_failure_state_json
        }));
        if (attempt < 6) {
          expect(finalCheckpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
          expect(finalCheckpoint.alarm).not.toBeNull();
        }
      }
      expect(stateReads).toBe(6);
      expect(finalCheckpoint.continuation).toMatchObject({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
        last_outcome: { stopped_unresolved_jobs: 1, verification_completed: false,
          safe_errors: ["identical_internal_document_prelude_failure_limit"] } });
      expect(JSON.parse(finalCheckpoint.rawFailure!)).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });
      // The remaining alarm is only for the durable global OPEN/PARK notice;
      // the parked document prelude itself must not be attempted again.
      expect(finalCheckpoint.alarm).not.toBeNull();
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      expect(stateReads).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps repeated UNKNOWN prelude failures bounded and retryable without the typed stop", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-UNKNOWN-0001", "prelude-unknown-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let admissionCalls = 0;
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as { ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean> };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          throw new Error("temporary governance read failure");
        });
      });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const checkpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          prelude: durableState.storage.sql.exec<{ prelude_failure_state_json: string | null }>(
            "SELECT prelude_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
          ).one().prelude_failure_state_json
        }));
        expect(checkpoint.continuation.pending).toBe(true);
        expect(checkpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
        expect(checkpoint.continuation.next_wake_at).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(checkpoint.continuation.last_outcome?.stopped_unresolved_jobs ?? 0).toBe(0);
        expect(checkpoint.prelude).toBeNull();
      }
      expect(admissionCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves provider prelude Retry-After deadlines across old runnable work and unsafe values", async () => {
    installDropboxMock();
    vi.useFakeTimers();
    try {
      const cases = [
        { label: "over-24-hours", retryAfterMs: 25 * 60 * 60 * 1_000, sentinel: false },
        { label: "finite-unsafe", retryAfterMs: 1e16, sentinel: true },
        { label: "explicit-sentinel", retryAfterMs: Number.MAX_SAFE_INTEGER, sentinel: true }
      ] as const;
      for (const [index, scenario] of cases.entries()) {
        const created = await createProject(`TXN-CHANGEJOB-PRELUDE-RETRY-${index.toString().padStart(4, "0")}`, `prelude-retry-${scenario.label}`);
        const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
        const startedAt = Date.now();
        await runInDurableObject(guard, async (_instance, durableState) => {
          const store = new ManagedDocumentChangeJobStore(durableState.storage);
          store.beginContinuationSlice(true, startedAt);
          store.finishContinuationSlice({ pending: true, next_wake_at: startedAt,
            documents_priority_next: true, feed_retry_at: startedAt - 1,
            outcome: { semantic_progress: 0, executable_jobs: 1, unread_feed: true, safe_errors: [] } });
          await durableState.storage.setAlarm(startedAt);
        });
        await runInDurableObject(guard, instance => {
          const target = instance as unknown as { readManagedDocumentState: (...args: unknown[]) => Promise<unknown> };
          vi.spyOn(target, "readManagedDocumentState").mockRejectedValue(new ProviderOperationError("prelude limited", true, {
            providerId: "dropbox", status: 429, code: "too_many_requests", retryAfterMs: scenario.retryAfterMs
          }));
        });
        vi.setSystemTime(startedAt + 1_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const observed = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm(),
          preludeFailure: new ManagedDocumentChangeJobStore(durableState.storage).preludeFailureCheckpoint()
        }));
        if (scenario.sentinel) {
          expect(observed.continuation).toMatchObject({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
            feed_retry_at: Number.MAX_SAFE_INTEGER });
          expect(observed.alarm).toBeNull();
        } else {
          const deadline = startedAt + 1_000 + scenario.retryAfterMs;
          expect(observed.continuation).toMatchObject({ pending: true, next_wake_at: deadline, feed_retry_at: deadline });
          expect(observed.alarm).toBe(deadline);
        }
        expect(observed.continuation.last_outcome?.safe_errors).toContain("document_slice_failed");
        expect(observed.preludeFailure).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat the saturated feed deadline as immediately eligible", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-SATURATED-0001", "feed-saturated-deadline");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      return { entries: [], cursor: "must-remain-unread", has_more: true };
    };
    const state = emptyProjectState(created.project_id, "Saturated deadline", "feed-saturated-deadline");
    const now = Date.parse("2026-10-03T21:00:00.000Z");
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "seed-cursor", jobs: [] });
      store.finishContinuationSlice({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
        documents_priority_next: false, feed_retry_at: Number.MAX_SAFE_INTEGER, outcome: { unread_feed: true } });
    });
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now + 24 * 60 * 60 * 1_000).toISOString() });
    });

    expect(feedCalls).toBe(0);
    expect(summary).toMatchObject({ unread_feed: true, feed_retry_at: Number.MAX_SAFE_INTEGER, verification_completed: false });
  });

  it("allows a complete initial and distinct-drift governance sequence inside one bounded slice", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-GOVERNANCE-SCOPE-0001", "governance-scope");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const accepted = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        scopedGovernanceRequest(scope: { deadlineMs: number; signal: AbortSignal; now?: () => number }, request: () => Promise<Response>): Promise<Response>;
      };
      const scope = { deadlineMs: Date.now() + 10_000, signal: new AbortController().signal };
      for (let index = 0; index < 8; index += 1) {
        const response = await target.scopedGovernanceRequest(scope, async () => Response.json({ index }));
        expect(response.status).toBe(200);
      }
      return true;
    });

    expect(accepted).toBe(true);
  });

  it("admits initial work and a separately bound package drift with one live slice scope", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-GOVERNED-DRIFT-0001", "governed-drift");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const originalGuardBindings = await runInDurableObject(guard, instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      return { signingKey: bindings.RULE_ADMISSION_SIGNING_KEY, projectModes: bindings.PROJECT_OS_ADMISSION_PROJECT_MODES };
    });
    const originalRegistryBindings = await runInDurableObject(registry, instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      return { signingKey: bindings.RULE_ADMISSION_SIGNING_KEY, governanceToken: bindings.RULE_GOVERNANCE_TOKEN };
    });
    const originalRegistryRows = await runInDurableObject(registry, (_instance, durableState) => ({
      governanceMeta: durableState.storage.sql.exec<{ key: string; value: string }>(
        "SELECT key, value FROM meta WHERE key = 'rule_governance'").toArray(),
      globalRequests: durableState.storage.sql.exec<{ transaction_id: string; transaction_json: string; project_id: string | null; status: string; receipt_json: string | null }>(
        "SELECT transaction_id, transaction_json, project_id, status, receipt_json FROM requests WHERE project_id = 'GLOBAL'").toArray(),
      governanceEvents: durableState.storage.sql.exec<{ revision: number; event_json: string }>(
        "SELECT revision, event_json FROM governance_events").toArray()
    }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(registry, (_instance, durableState) => durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'");
        durableState.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'");
        durableState.storage.sql.exec("DELETE FROM governance_events");
        for (const row of originalRegistryRows.governanceMeta) {
          durableState.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", row.key, row.value);
        }
        for (const row of originalRegistryRows.globalRequests) {
          durableState.storage.sql.exec(
            "INSERT INTO requests (transaction_id, transaction_json, project_id, status, receipt_json) VALUES (?, ?, ?, ?, ?)",
            row.transaction_id, row.transaction_json, row.project_id, row.status, row.receipt_json
          );
        }
        for (const row of originalRegistryRows.governanceEvents) {
          durableState.storage.sql.exec("INSERT INTO governance_events (revision, event_json) VALUES (?, ?)", row.revision, row.event_json);
        }
      }));
      await runInDurableObject(guard, instance => {
        const bindings = (instance as unknown as { env: Env }).env as unknown as Record<string, unknown>;
        restoreOptionalEnvBinding(bindings, "RULE_ADMISSION_SIGNING_KEY", originalGuardBindings.signingKey);
        restoreOptionalEnvBinding(bindings, "PROJECT_OS_ADMISSION_PROJECT_MODES", originalGuardBindings.projectModes);
      });
      await runInDurableObject(registry, instance => {
        const bindings = (instance as unknown as { env: Env }).env as unknown as Record<string, unknown>;
        restoreOptionalEnvBinding(bindings, "RULE_ADMISSION_SIGNING_KEY", originalRegistryBindings.signingKey);
        restoreOptionalEnvBinding(bindings, "RULE_GOVERNANCE_TOKEN", originalRegistryBindings.governanceToken);
      });
    };
    const signingKey = "change-job-governance-test-key";
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, created.project_id);
    await runInDurableObject(guard, instance => Object.assign((instance as unknown as { env: Env }).env, {
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));

    const admissions = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        createManagedDocumentSlice(startedAt: number): { scope: { deadlineMs: number; signal: AbortSignal }; runtime: import("../src/persistence/provider/capabilities").ProjectOsPersistenceRuntime; abortTimer: ReturnType<typeof setTimeout> };
        loadOrRecoverState(): Promise<import("../src/domain/project-state").ProjectState | null>;
        ruleAdmissionRequired(state: import("../src/domain/project-state").ProjectState, operation: import("../src/admission/operation-context").NormalizedAdmissionOperation, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        admitRules(state: import("../src/domain/project-state").ProjectState, operation: import("../src/admission/operation-context").NormalizedAdmissionOperation, actor: undefined, scope: { deadlineMs: number; signal: AbortSignal }): Promise<{ operation: string; request_hash: string }>;
        persistAdmissionProof(kind: string, requestId: string, proof: never, runtime: import("../src/persistence/provider/capabilities").ProjectOsPersistenceRuntime): Promise<unknown>;
        executionPlanResolver: (admission: unknown) => Promise<unknown>;
      };
      const slice = target.createManagedDocumentSlice(Date.now());
      try {
        const state = await target.loadOrRecoverState();
        if (!state) throw new Error("expected initialized project state");
        const initial = await normalizeSystemAdmission(state.project_id, "project.materialize", "DOCUMENTS", `document-reconcile@${state.revision}`, String(state.revision));
        expect(await target.ruleAdmissionRequired(state, initial, slice.scope)).toBe(true);
        const initialProof = await target.admitRules(state, initial, undefined, slice.scope);

        const resource = { resource_id: `PKG-${"A".repeat(64)}`, resource_type: "package", zone: "WORKING", version: `1:${"b".repeat(64)}` };
        const drift = { project_id: state.project_id, operation: "package.drift.observe", resources: [resource], request_hash: await sha256Canonical({ finding_id: "DRIFT-GOVERNED-0001", resource }) };
        slice.scope.deadlineMs = Date.now();
        expect(await target.ruleAdmissionRequired(state, drift, slice.scope)).toBe(true);
        await expect(target.admitRules(state, drift, undefined, slice.scope)).rejects.toThrow("slice_budget_exhausted");

        const resumed = target.createManagedDocumentSlice(Date.now());
        try {
          expect(await target.ruleAdmissionRequired(state, drift, resumed.scope)).toBe(true);
          const driftProof = await target.admitRules(state, drift, undefined, resumed.scope);
          const originalPlanResolver = target.executionPlanResolver;
          target.executionPlanResolver = async () => { throw new Error("slice_budget_exhausted"); };
          await expect(target.persistAdmissionProof("document-drift", "DRIFT-GOVERNED-YIELD-0001", driftProof as never, resumed.runtime))
            .rejects.toThrow("slice_budget_exhausted");
          target.executionPlanResolver = originalPlanResolver;
          await target.persistAdmissionProof("document-drift", "DRIFT-GOVERNED-0001-slice-1", driftProof as never, resumed.runtime);
          return { initial: initialProof.operation, drift: driftProof.operation, driftHash: driftProof.request_hash, requestHash: drift.request_hash };
        } finally {
          clearTimeout(resumed.abortTimer);
        }
      } finally {
        clearTimeout(slice.abortTimer);
      }
    });

    expect(admissions).toMatchObject({ initial: "project.materialize", drift: "package.drift.observe" });
    expect(admissions.driftHash).toBe(admissions.requestHash);
  });

  it("persists and retries a bounded global notification owed after local completion", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-LOCAL-NOTIFY-0001", "local-notify-owed");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const originalDropboxChangeGuard = await runInDurableObject(guard, instance =>
      (instance as unknown as { env: Record<string, unknown> }).env.DROPBOX_CHANGE_GUARD);
    restoreTestEnvBindings = async () => runInDurableObject(guard, instance => {
      restoreOptionalEnvBinding((instance as unknown as { env: Record<string, unknown> }).env,
        "DROPBOX_CHANGE_GUARD", originalDropboxChangeGuard);
    });
    let releaseResponse!: (response: Response) => void;
    let fetchCount = 0;
    let stall = true;
    const fetchNotification = vi.fn(async () => {
      fetchCount += 1;
      if (!stall) return Response.json({ status: "registered", requested_generation: 1, completed_generation: 0 });
      return new Promise<Response>(resolve => { releaseResponse = resolve; });
    });
    vi.useFakeTimers();
    try {
      await runInDurableObject(guard, async (instance, durableState) => {
        const target = instance as unknown as {
          env: Env;
          createManagedDocumentSlice(startedAt: number): { scope: { deadlineMs: number; signal: AbortSignal }; abortTimer: ReturnType<typeof setTimeout> };
          notifyDropboxChangeCoordinator(store: ManagedDocumentChangeJobStore, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        };
        Object.assign(target.env, { DROPBOX_CHANGE_GUARD: { getByName: () => ({ fetch: fetchNotification }) } });
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.finishContinuationSlice({ pending: false, next_wake_at: null, documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 1, executable_jobs: 0, unread_feed: false } });
        const first = target.createManagedDocumentSlice(Date.now());
        try {
          const pending = target.notifyDropboxChangeCoordinator(store, first.scope);
          await vi.waitFor(() => expect(fetchCount).toBe(1));
          expect(store.continuation().last_outcome).toMatchObject({ global_notification_owed: true });
          expect(await durableState.storage.getAlarm()).not.toBeNull();
          await vi.advanceTimersByTimeAsync(18_001);
          await expect(pending).resolves.toBe(false);
          expect(store.continuation().last_outcome).toMatchObject({ global_notification_owed: true });
        } finally {
          releaseResponse?.(Response.json({ status: "registered", requested_generation: 1, completed_generation: 0 }));
          clearTimeout(first.abortTimer);
        }

      });
      stall = false;
      await runDurableObjectAlarm(guard);
      const replayed = await runInDurableObject(guard, (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(replayed.last_outcome).not.toHaveProperty("global_notification_owed");
    } finally {
      vi.useRealTimers();
    }
    expect(fetchCount).toBe(2);
  }, 10_000);

  it("preserves fresh feed and job progress when route and alarm dirty scans yield", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-yield-vector";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-VECTOR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    const jobIds = ["CHGJOB-111111111111111111111111", "CHGJOB-222222222222222222222222", "CHGJOB-333333333333333333333333"];
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "durable-sibling-cursor", jobs: jobIds.map((job_id, index) => ({
        job_id,
        change: { kind: "deleted" as const, name: `sibling-${index}.md`, path: `/inputs/sibling-${index}.md` },
        detection_source: "incremental" as const,
        priority: 10
      })) });
    });
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    let dirtyScanCalls = 0;
    const checkpointsSeenBeforeDirtyScan: Array<{ outcome: Record<string, unknown> | null; next_wake_at: number | null }> = [];
    vi.useFakeTimers();
    try {
      const requestAt = Date.now();
      await runInDurableObject(guard, (instance, durableState) => {
        const continuationStore = new ManagedDocumentChangeJobStore(durableState.storage);
        const target = instance as unknown as {
          enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
        };
        const createCoordinator = target.createManagedDocumentChangeCoordinator.bind(instance);
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation((...args) => {
          const coordinator = createCoordinator(...args);
          vi.spyOn(coordinator as any, "processJob").mockResolvedValue(true);
          return coordinator;
        });
        vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockImplementation(async () => {
          dirtyScanCalls += 1;
          const checkpoint = continuationStore.continuation();
          checkpointsSeenBeforeDirtyScan.push({ outcome: checkpoint.last_outcome, next_wake_at: checkpoint.next_wake_at });
          if (dirtyScanCalls === 1 || dirtyScanCalls === 3) throw new Error("slice_budget_exhausted");
        });
      });

      const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
      expect(first.status).toBe(200);
      const firstBody = await first.json<any>();
      expect(retryAfter.didInject()).toBe(true);
      expect(retryAfter.continuedCursors).toContain(targetCursor);
      expect(firstBody).toMatchObject({ jobs_completed: 1, jobs_pending: 2, unread_feed: true, budget_yield: true });
      expect(firstBody.feed_retry_at).toBeGreaterThan(requestAt + 50_000);
      expect(checkpointsSeenBeforeDirtyScan[0].outcome).toMatchObject({
        semantic_progress: 1, jobs_completed: 1, unread_feed: true, executable_jobs: 2,
        safe_errors: ["provider_retryable"]
      });
      expect(checkpointsSeenBeforeDirtyScan[0].next_wake_at).toBeGreaterThan(requestAt);
      expect(checkpointsSeenBeforeDirtyScan[0].next_wake_at).toBeLessThan(requestAt + 5_000);
      const afterRoute = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(afterRoute.last_outcome).toMatchObject({ semantic_progress: 1, unread_feed: true, executable_jobs: 2, budget_yield: true });

      vi.setSystemTime(requestAt + 2_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const afterAlarm = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        pending: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
        statuses: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray()
      }));
      expect(dirtyScanCalls).toBe(3);
      expect(checkpointsSeenBeforeDirtyScan[2].outcome).toMatchObject({
        semantic_progress: 2, jobs_completed: 2, unread_feed: true, executable_jobs: 0,
        safe_errors: [], feed_retry_at: firstBody.feed_retry_at
      });
      expect(checkpointsSeenBeforeDirtyScan[2].next_wake_at).toBeGreaterThan(requestAt + 50_000);
      expect(mock.providerCalls.filter(call => call.endpoint === "POST /2/files/list_folder/continue")).toHaveLength(1);
      expect(afterAlarm.pending).toBe(0);
      expect(afterAlarm.statuses).toEqual([{ status: "completed" }, { status: "completed" }, { status: "completed" }]);
      expect(afterAlarm.continuation.feed_retry_at).toBe(firstBody.feed_retry_at);
      expect(afterAlarm.continuation.last_outcome).toMatchObject({
        semantic_progress: 2,
        jobs_registered: 0,
        jobs_completed: 2,
        unread_feed: true,
        executable_jobs: 0,
        future_eligible_jobs: 0,
        budget_yield: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives due document and navigation recovery a turn before repeated slow owed acknowledgements", async () => {
    installDropboxMock();
    const slug = "notify-fair-recovery";
    const created = await createProject("TXN-CHANGEJOB-NOTIFY-FAIR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    let acknowledgementCalls = 0;
    const acknowledgementProgress: Array<{ jobs: Array<{ status: string }>; scanPending: number }> = [];
    const seedDueWork = async (startedAt: number, suffix: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const currentCursor = store.cursor();
      const jobs: ManagedDocumentChangeJobInput[] = Array.from({ length: 9 }, (_, index) => {
        const jobSuffix = `${suffix}${index.toString(16).padStart(2, "0")}`;
        return { job_id: `CHGJOB-${jobSuffix.repeat(8)}`,
          change: { kind: "deleted", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/INPUTS/gone-${jobSuffix}.md`, name: `gone-${jobSuffix}.md` },
          detection_source: "incremental", priority: 10 };
      });
      store.registerPage({ expected_cursor: currentCursor, next_cursor: `notify-cursor-${suffix}`, jobs });
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt,
        documents_priority_next: true, feed_retry_at: null,
        outcome: { semantic_progress: 0, jobs_registered: 1, jobs_completed: 0, jobs_pending: 1, unread_feed: true,
          executable_jobs: 1, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [], global_notification_owed: true } });
      durableState.storage.sql.exec(
        "INSERT INTO navigation_refresh_scan (singleton, requested_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
        new Date(startedAt).toISOString()
      );
      await durableState.storage.setAlarm(startedAt);
    });
    try {
      const firstStartedAt = Date.now();
      await seedDueWork(firstStartedAt, "C");
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as {
          notifyDropboxChangeCoordinator(store: ManagedDocumentChangeJobStore, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        };
        vi.spyOn(target, "notifyDropboxChangeCoordinator").mockImplementation(async store => {
          acknowledgementCalls += 1;
          const storage = (store as unknown as { storage: { sql: { exec<T>(query: string): { toArray(): T[] } } } }).storage;
          acknowledgementProgress.push({
            jobs: storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray(),
            scanPending: storage.sql.exec("SELECT singleton FROM navigation_refresh_scan WHERE singleton = 1").toArray().length
          });
          const continuation = store.continuation();
          store.finishContinuationSlice({ pending: continuation.pending, next_wake_at: continuation.next_wake_at,
            documents_priority_next: continuation.documents_priority_next, feed_retry_at: continuation.feed_retry_at,
            outcome: { ...(continuation.last_outcome ?? {}), global_notification_owed: true } });
          vi.setSystemTime(Date.now() + 19_000);
          return false;
        });
      });

      const firstAlarm = runDurableObjectAlarm(guard);
      await firstAlarm;
      const firstAfter = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        jobs: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray()
      }));
      expect(firstAfter.continuation.last_outcome?.global_notification_owed).toBe(true);
      expect(acknowledgementProgress[0]?.jobs).toHaveLength(9);
      expect(acknowledgementProgress[0]?.jobs.some(job => job.status === "completed")).toBe(true);
      expect(acknowledgementProgress[0]?.jobs.some(job => job.status === "pending")).toBe(true);
      expect(acknowledgementProgress[0]?.scanPending).toBe(0);

      const secondStartedAt = Date.now() + 1_000;
      vi.setSystemTime(secondStartedAt);
      await seedDueWork(secondStartedAt, "D");
      const secondAlarm = runDurableObjectAlarm(guard);
      await secondAlarm;
      expect(acknowledgementProgress[1]?.jobs).toHaveLength(18);
      expect(acknowledgementProgress[1]?.jobs.some(job => job.status === "completed")).toBe(true);
      expect(acknowledgementProgress[1]?.jobs.some(job => job.status === "pending")).toBe(true);
      expect(acknowledgementProgress[1]?.scanPending).toBe(0);
      expect(acknowledgementCalls).toBe(2);
      const owed = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation().last_outcome?.global_notification_owed);
      expect(owed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the fresh Retry-After vector when a route dirty scan fails non-budget", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-error-vector";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-ERROR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    await runInDurableObject(guard, instance => {
      const target = instance as unknown as { enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void> };
      vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockRejectedValue(new InternalExecutionFailure("navigation_scan_invariant", "dirty_zone_scan"));
    });
    await runInDurableObject(guard, (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const current = store.continuation();
      store.finishContinuationSlice({ pending: current.pending, next_wake_at: current.next_wake_at,
        documents_priority_next: current.documents_priority_next, feed_retry_at: current.feed_retry_at,
        outcome: { ...(current.last_outcome ?? {}), global_notification_owed: true } });
    });

    const requestedAt = Date.now();
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const continuation = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).continuation());
    expect(retryAfter.didInject()).toBe(true);
    expect(retryAfter.continuedCursors).toContain(targetCursor);
    console.log("g4-scan-failure-outcome", JSON.stringify(continuation.last_outcome));

    expect(body).toMatchObject({ unread_feed: true, jobs_registered: 0, jobs_completed: 0,
      budget_yield: false, safe_errors: ["provider_retryable", "navigation_refresh_scan_failed"] });
    expect(body.feed_retry_at).toBeGreaterThan(requestedAt + 50_000);
    expect(continuation.last_outcome).toMatchObject({ unread_feed: true, jobs_registered: 0, jobs_completed: 0,
      safe_errors: ["provider_retryable", "navigation_refresh_scan_failed"], global_notification_owed: true });
    expect(continuation.next_wake_at).toBeGreaterThan(requestedAt + 50_000);
    expect(await runInDurableObject(guard, (_instance, durableState) => durableState.storage.sql.exec("SELECT singleton FROM navigation_refresh_scan").toArray())).toHaveLength(1);
  });

  it("keeps a future feed Retry-After instead of forcing a route one-second wake after dirty-scan yield", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-feed-backoff";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-BACKOFF-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    await runInDurableObject(guard, instance => {
      const target = instance as unknown as { enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void> };
      vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockRejectedValue(new Error("slice_budget_exhausted"));
    });

    const requestedAt = Date.now();
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const continuation = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).continuation());
    expect(retryAfter.didInject()).toBe(true);
    expect(retryAfter.continuedCursors).toContain(targetCursor);
    expect(body).toMatchObject({ unread_feed: true, budget_yield: true, jobs_pending: 0, executable_jobs: 0 });
    expect(body.feed_retry_at).toBeGreaterThan(requestedAt + 50_000);
    expect(continuation.next_wake_at).toBeGreaterThan(requestedAt + 50_000);
  });

  it("keeps dirty-zone navigation probes inside the remaining shared document deadline", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-NAV-SCOPE-0001", "scheduled-nav-scope");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    const startedAt = Date.now() - 17_900;
    let apiStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { apiStarted = resolve; });
    const sourceStatePath = `/PROJECT_OS/.project-os/projects/${created.project_id}/documents/navigation-sources/state.json`;
    let scopedApiCalls = 0;
    let scopedSignalPresent = false;
    let scopedSignalType = "missing";
    let scopedSignalAborted = false;
    const delegateFetch = mock.spy.getMockImplementation();
    if (!delegateFetch) throw new Error("Dropbox mock implementation unavailable");
    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      let requestedPath: string | undefined;
      const apiArg = request.headers.get("Dropbox-API-Arg");
      if (apiArg) {
        try { requestedPath = (JSON.parse(apiArg) as { path?: string }).path; }
        catch { /* The delegated mock handles malformed test requests. */ }
      }
      if (!requestedPath && url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/get_metadata") {
        try { requestedPath = (JSON.parse(await request.clone().text()) as { path?: string }).path; }
        catch { /* The delegated mock handles malformed test requests. */ }
      }
      const readsNavigationState = requestedPath === sourceStatePath
        && (url.pathname === "/2/files/get_metadata" || url.pathname === "/2/files/download");
      if (!readsNavigationState) return delegateFetch(input, init);

      scopedApiCalls += 1;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      scopedSignalPresent = signal !== undefined && signal !== null;
      scopedSignalType = signal instanceof AbortSignal ? "AbortSignal" : typeof signal;
      apiStarted();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          scopedSignalAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    });

    await runInDurableObject(guard, async (instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.beginContinuationSlice(true);
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 20_000,
        documents_priority_next: false, feed_retry_at: null, outcome: { unread_feed: true } });
      state.storage.sql.exec(
        "INSERT INTO navigation_refresh_scan (singleton, requested_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
        new Date(startedAt).toISOString()
      );
      await state.storage.setAlarm(startedAt + 20_000);
      const slice = (instance as unknown as {
        createManagedDocumentSlice(at: number): { runtime: ReturnType<typeof packageRuntime>["runtime"]; scope: { deadlineMs: number }; abortTimer: ReturnType<typeof setTimeout> };
        enqueueNavigationRefreshForDirtyZones(projectId: string, runtime: ReturnType<typeof packageRuntime>["runtime"]): Promise<void>;
      }).createManagedDocumentSlice(startedAt);
      try {
        const scan = (instance as unknown as {
          enqueueNavigationRefreshForDirtyZones(projectId: string, runtime: typeof slice.runtime): Promise<void>;
        }).enqueueNavigationRefreshForDirtyZones(created.project_id, slice.runtime);
        const rejected = expect(scan).rejects.toThrow("slice_budget_exhausted");
        await requestStarted;
        await vi.advanceTimersByTimeAsync(101);
        await rejected;
      } finally {
        clearTimeout(slice.abortTimer);
      }
    });
    expect(scopedApiCalls).toBe(1);
    expect(scopedSignalPresent).toBe(true);
    expect(scopedSignalType).toBe("AbortSignal");
    expect(scopedSignalAborted).toBe(true);
    const checkpoint = await runInDurableObject(guard, async (_instance, state) => ({
      continuation: new ManagedDocumentChangeJobStore(state.storage).continuation(),
      scanPending: state.storage.sql.exec("SELECT singleton FROM navigation_refresh_scan WHERE singleton = 1").toArray().length === 1,
      alarmAt: await state.storage.getAlarm()
    }));
    expect(checkpoint.continuation.pending).toBe(true);
    expect(checkpoint.scanPending).toBe(true);
    expect(checkpoint.alarmAt).not.toBeNull();
    vi.useRealTimers();
  }, 15_000);

  it("gives a healthy sibling a scheduled turn after a failed head across coordinator restart", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAIRNESS-RED-0001", "scheduled-fairness-red");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Scheduled fairness", "scheduled-fairness-red");
    const firstId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingId = "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({
        expected_cursor: null,
        next_cursor: "fairness-seed",
        jobs: [
          { job_id: firstId, change: { kind: "deleted", name: "first.md", path: "/inputs/first.md" }, detection_source: "incremental", priority: 10 },
          { job_id: siblingId, change: { kind: "deleted", name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental", priority: 10 }
        ]
      });
    });

    const runScheduledSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        if (job.job_id === firstId) throw new Error("repeatable internal failure");
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });

    const first = await runScheduledSlice("2026-10-03T15:00:00.000Z");
    const second = await runScheduledSlice("2026-10-03T15:00:01.000Z");
    const third = await runScheduledSlice("2026-10-03T15:00:02.000Z");
    const pending = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).pending().map(job => job.job_id));

    expect(first).toMatchObject({ jobs_pending: 2, jobs_completed: 0, job_failures: 1 });
    expect(second).toMatchObject({ jobs_pending: 1, jobs_completed: 1, job_failures: 0 });
    expect(third).toMatchObject({ jobs_pending: 1, jobs_completed: 0, job_failures: 1 });
    expect(visited).toEqual([firstId, siblingId, firstId]);
    expect(pending).toEqual([firstId]);
  });

  it("lets a deferred job yield within its fixed cohort despite higher-priority arrivals", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAIRNESS-DEFERRED-0001", "scheduled-fairness-deferred");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Deferred fairness", "scheduled-fairness-deferred");
    const firstId = "CHGJOB-111111111111111111111111";
    const siblingId = "CHGJOB-222222222222222222222222";
    const firstArrivalId = "CHGJOB-333333333333333333333333";
    const secondArrivalId = "CHGJOB-444444444444444444444444";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "deferred-seed",
        jobs: [
          { job_id: firstId, change: { kind: "deleted", name: "deferred.md", path: "/inputs/deferred.md" }, detection_source: "incremental", priority: 10 },
          { job_id: siblingId, change: { kind: "deleted", name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental", priority: 10 }
        ]
      });
    });
    const runSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage);
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        return job.job_id !== firstId;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const addArrival = (jobId: string, name: string, priority: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({
        expected_cursor: store.cursor(),
        next_cursor: store.cursor() ?? "deferred-seed",
        jobs: [{ job_id: jobId, change: { kind: "deleted", name, path: `/inputs/${name}` }, detection_source: "baseline", priority }]
      });
    });

    const first = await runSlice("2026-10-03T16:00:00.000Z");
    await addArrival(firstArrivalId, "arrival-one.md", 0);
    const second = await runSlice("2026-10-03T16:00:01.000Z");
    await addArrival(secondArrivalId, "arrival-two.md", 10);
    const third = await runSlice("2026-10-03T16:00:02.000Z");

    expect(first).toMatchObject({ jobs_pending: 2, jobs_completed: 0, job_failures: 0 });
    expect(second).toMatchObject({ jobs_completed: 1, job_failures: 0 });
    expect(third).toMatchObject({ jobs_completed: 1, job_failures: 0 });
    expect(visited).toEqual([firstId, siblingId, firstArrivalId]);
  });

  it("starts a fresh cohort for page siblings only after the prior cohort is exhausted", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-COHORT-PAGE-0001", "scheduled-cohort-page");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed = { listChanges: async () => ({
      entries: [
        { kind: "deleted", name: "page-one.md", path: "/inputs/page-one.md" },
        { kind: "deleted", name: "page-two.md", path: "/inputs/page-two.md" }
      ],
      cursor: "cohort-page-2"
    }) };
    const state = emptyProjectState(created.project_id, "Cohort page", "scheduled-cohort-page");
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "cohort-page-1",
        jobs: [{ job_id: "CHGJOB-AAAAAAAAAAAAAAAABBBBBBBB", change: { kind: "deleted", name: "prior.md", path: "/inputs/prior.md" }, detection_source: "incremental", priority: 10 }]
      });
    });
    const result = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage);
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.change.name);
        return true;
      };
      return coordinator.reconcile(state, { now: "2026-10-03T17:30:00.000Z" });
    });

    expect(result).toMatchObject({ jobs_registered: 2, jobs_completed: 3, jobs_pending: 0, job_failures: 0 });
    expect(visited).toEqual(["prior.md", "page-one.md", "page-two.md"]);
  });

  it("stops only six identical classified internal failures while leaving the obligation pending", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-INTERNAL-STOP-0001", "scheduled-internal-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Internal failure stop", "scheduled-internal-stop");
    const jobId = "CHGJOB-555555555555555555555555";
    const siblingId = "CHGJOB-666666666666666666666666";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "internal-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "internal.md", path: "/inputs/internal.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 2473 WHERE job_id = ?", jobId);
    });

    const runFailureSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async () => { throw new InternalExecutionFailure("repeatable_internal_error", "process"); };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const base = Date.parse("2026-10-03T16:30:00.000Z");
    const failureSlices = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      failureSlices.push(await runFailureSlice(new Date(base + attempt * 86_400_000).toISOString()));
    }

    const stoppedState = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: store.cursor() ?? "internal-seed", jobs: [
        { job_id: siblingId, change: { kind: "deleted", name: "healthy.md", path: "/inputs/healthy.md" }, detection_source: "baseline", priority: 0 }
      ] });
      return {
        pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })),
        quarantines: store.quarantines(),
        findings: store.driftFindingsForJob(jobId),
        checkpoint: await store.readCheckpoint("2026-10-10T16:30:00.000Z")
      };
    });

    const visited: string[] = [];
    const afterStop = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse("2026-10-11T16:30:00.000Z"));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-11T16:30:00.000Z" });
    });
    const final = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => job.job_id), checkpoint: await store.readCheckpoint("2026-10-11T16:30:00.000Z") };
    });

    expect(failureSlices.slice(0, 5).every(summary => summary.jobs_pending === 1 && summary.jobs_quarantined === 0)).toBe(true);
    expect(failureSlices[5]).toMatchObject({ jobs_pending: 1, jobs_quarantined: 0, job_failures: 1 });
    expect(stoppedState.pending).toEqual([
      { job_id: siblingId, attempts: 0 },
      { job_id: jobId, attempts: 2479 }
    ]);
    expect(stoppedState.quarantines).toEqual([]);
    expect(stoppedState.findings).toEqual([expect.objectContaining({ status: "unexpected_conflict", code: "identical_internal_failure_limit" })]);
    expect(stoppedState.checkpoint.schedule.last_verified_at).toBeNull();
    expect(stoppedState.checkpoint.recent_findings).toEqual([expect.objectContaining({ code: "identical_internal_failure_limit" })]);
    expect(afterStop).toMatchObject({ jobs_pending: 1, jobs_completed: 1, job_failures: 0 });
    expect(visited).toEqual([siblingId]);
    expect(final.pending).toEqual([jobId]);
    expect(final.checkpoint.schedule.last_verified_at).toBeNull();
  });

  it("keeps repeated unknown errors retryable and unresolved without internal-stop quarantine", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-UNKNOWN-RETRY-0001", "scheduled-unknown-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Unknown retry", "scheduled-unknown-retry");
    const jobId = "CHGJOB-777777777777777777777777";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "unknown-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "unknown.md", path: "/inputs/unknown.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 2473 WHERE job_id = ?", jobId);
    });

    const base = Date.parse("2026-10-03T18:00:00.000Z");
    const runFailureSlice = (nowMs: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => nowMs);
      (coordinator as any).processJob = async () => { throw new Error("unclassified persistent failure"); };
      return coordinator.reconcile(state, { scheduled: true, now: new Date(nowMs).toISOString() });
    });
    const first = await runFailureSlice(base);
    const beforeEligible = await runFailureSlice(base);
    const summaries = [first];
    for (let attempt = 1; attempt < 6; attempt += 1) {
      const summary = await runInDurableObject(guard, async (_instance, durableState) => {
        const nowMs = base + attempt * 86_400_000;
        const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => nowMs);
        (coordinator as any).processJob = async () => { throw new Error("unclassified persistent failure"); };
        return coordinator.reconcile(state, { scheduled: true, now: new Date(nowMs).toISOString() });
      });
      summaries.push(summary);
    }
    const remaining = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })), quarantines: store.quarantines(), findings: store.driftFindingsForJob(jobId) };
    });

    expect(first).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(beforeEligible).toMatchObject({ jobs_pending: 1, job_failures: 0 });
    expect(summaries.every(summary => summary.jobs_pending === 1 && summary.job_failures === 1)).toBe(true);
    expect(remaining.pending).toEqual([{ job_id: jobId, attempts: 2479 }]);
    expect(remaining.quarantines).toEqual([]);
    expect(remaining.findings).toEqual([]);
  });

  it("parks six identical typed internal feed failures without a seventh feed attempt", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-INTERNAL-FEED-STOP-0001", "internal-feed-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Internal feed stop", "internal-feed-stop");
    const now = Date.parse("2026-10-03T19:00:00.000Z");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      throw new InternalExecutionFailure("provider_scope_invalid", "feed_page_read");
    };
    const summaries = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const summary = await runInDurableObject(guard, async (_instance, durableState) => {
        const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
        return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
      });
      summaries.push(summary);
    }
    const seventh = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const checkpoint = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).feedFailureCheckpoint());

    expect(feedCalls).toBe(6);
    expect(summaries.slice(0, 5).every(summary => summary.stopped_unresolved_jobs === 0 && summary.verification_completed === false)).toBe(true);
    expect(summaries[5]).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 1, job_failures: 0,
      safe_errors: ["identical_internal_feed_failure_limit"], feed_retry_at: Number.MAX_SAFE_INTEGER, verification_completed: false });
    expect(seventh).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 1, job_failures: 0,
      safe_errors: ["identical_internal_feed_failure_limit"], verification_completed: false });
    expect(checkpoint).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });

    await runInDurableObject(guard, (_instance, durableState) => new ManagedDocumentChangeJobStore(durableState.storage)
      .registerPage({ expected_cursor: null, next_cursor: "feed-progress-after-stop", jobs: [
        { job_id: `CHGJOB-${"F".repeat(24)}`, change: { kind: "deleted", path: "/PROJECT_OS/WORKSPACE/PROJECTS/feed-progress/deleted.md", name: "deleted.md" },
          detection_source: "incremental", priority: 10 }
      ] }));
    const afterProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const resetCheckpoint = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).feedFailureCheckpoint());
    expect(feedCalls).toBe(7);
    expect(afterProgress).toMatchObject({ stopped_unresolved_jobs: 0, safe_errors: ["internal_feed_failure"], verification_completed: false });
    expect(resetCheckpoint).toMatchObject({ consecutive_failures: 1, total_attempts: 7, stopped: false });
  });

  it("tracks feed failure streaks only from durable job progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-STABLE-PROGRESS-0001", "feed-stable-progress");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const failureFingerprint = "a".repeat(64);
    const firstProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "stable-feed-cursor", jobs: [] });
      return store.feedProgressFingerprint(1);
    });
    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).recordInternalFeedFailure(failureFingerprint, firstProgress);
    });
    const cursorOnlyProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: "stable-feed-cursor", next_cursor: "empty-page-cursor", jobs: [] });
      return store.feedProgressFingerprint(0);
    });
    expect(cursorOnlyProgress).toBe(firstProgress);

    const repeatedFailure = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      let checkpoint = store.feedFailureCheckpoint();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        checkpoint = store.recordInternalFeedFailure(failureFingerprint, cursorOnlyProgress);
      }
      return checkpoint;
    });
    expect(repeatedFailure).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });

    const progressed = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: "empty-page-cursor", next_cursor: "job-registration-cursor", jobs: [
        { job_id: "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB", change: { kind: "file", path: "/inputs/real-progress.md", name: "real-progress.md" },
          detection_source: "incremental", priority: 10 }
      ] });
      const progress = await store.feedProgressFingerprint(0);
      const checkpoint = store.recordInternalFeedFailure(failureFingerprint, progress);
      return { progress, checkpoint };
    });
    expect(progressed.progress).not.toBe(firstProgress);
    expect(progressed.checkpoint).toMatchObject({ consecutive_failures: 1, total_attempts: 7, stopped: false });
  });

  it("keeps unknown feed errors retryable without the typed internal stop", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-UNKNOWN-FEED-0001", "unknown-feed-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Unknown feed retry", "unknown-feed-retry");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => { feedCalls += 1; throw new Error("unknown feed failure"); };
    const now = Date.parse("2026-10-03T20:00:00.000Z");
    const run = () => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const first = await run();
    const second = await run();
    expect(feedCalls).toBe(2);
    expect(first).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 0, safe_errors: ["feed_error"], verification_completed: false });
    expect(second).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 0, safe_errors: ["feed_error"], verification_completed: false });
  });

  it("honors provider retry-after while allowing eligible siblings through", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROVIDER-WAIT-0001", "scheduled-provider-wait");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Provider wait", "scheduled-provider-wait");
    const blockedId = "CHGJOB-888888888888888888888888";
    const siblingId = "CHGJOB-999999999999999999999999";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({ expected_cursor: null, next_cursor: "provider-seed", jobs: [
        { job_id: blockedId, change: { kind: "deleted", name: "rate-limited.md", path: "/inputs/rate-limited.md" }, detection_source: "incremental", priority: 10 },
        { job_id: siblingId, change: { kind: "deleted", name: "healthy.md", path: "/inputs/healthy.md" }, detection_source: "incremental", priority: 10 }
      ] });
    });
    const runSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        if (job.job_id === blockedId) {
          throw new ProviderOperationError("provider retry detail", true, {
            providerId: "dropbox", status: 429, code: "too_many_requests", requestId: "volatile-request-id", retryAfterMs: 60_000
          });
        }
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const start = Date.parse("2026-10-03T19:00:00.000Z");
    const first = await runSlice(new Date(start).toISOString());
    const second = await runSlice(new Date(start).toISOString());
    const tooEarly = await runSlice(new Date(start + 59_000).toISOString());
    const eligible = await runSlice(new Date(start + 60_000).toISOString());
    const later = [];
    for (let minute = 2; minute <= 6; minute += 1) {
      later.push(await runSlice(new Date(start + minute * 60_000).toISOString()));
    }
    const stateAfter = await runInDurableObject(guard, async (_instance, durableState) => {
      const rows = durableState.storage.sql.exec("SELECT * FROM managed_document_change_job_failure_state ORDER BY job_id").toArray();
      return { rows, pending: new ManagedDocumentChangeJobStore(durableState.storage).pending().map(job => job.job_id) };
    });

    expect(first).toMatchObject({ job_failures: 1, jobs_pending: 2 });
    expect(second).toMatchObject({ jobs_completed: 1, jobs_pending: 1 });
    expect(tooEarly).toMatchObject({ job_failures: 0, jobs_completed: 0, jobs_pending: 1 });
    expect(eligible).toMatchObject({ job_failures: 1, jobs_pending: 1 });
    expect(later.every(summary => summary.job_failures === 1 && summary.jobs_pending === 1)).toBe(true);
    expect(visited.filter(jobId => jobId === blockedId)).toHaveLength(7);
    expect(visited[1]).toBe(siblingId);
    expect(stateAfter.pending).toEqual([blockedId]);
    expect(stateAfter.rows).toHaveLength(1);
    expect(stateAfter.rows[0]).toMatchObject({ classification: "provider_retryable", stopped: 0 });
    expect(JSON.stringify(stateAfter.rows)).not.toMatch(/provider retry detail|volatile-request-id/);
  });

  it("bases retry-after on the provider failure observation time, not slice entry", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-RETRY-OBSERVED-0001", "scheduled-retry-observed");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Retry observation", "scheduled-retry-observed");
    const jobId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAC";
    const startedAt = Date.parse("2026-10-03T20:00:00.000Z");
    let clockMs = startedAt;

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "retry-observation-seed",
        jobs: [{ job_id: jobId, change: { kind: "deleted", name: "delayed.md", path: "/inputs/delayed.md" }, detection_source: "incremental", priority: 10 }]
      });
    });

    await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => clockMs);
      (coordinator as any).processJob = async () => {
        // Model a provider response arriving 15 seconds after the scheduled slice began.
        clockMs = startedAt + 15_000;
        throw new ProviderOperationError("delayed provider response", true, {
          providerId: "dropbox", status: 429, code: "too_many_requests", retryAfterMs: 60_000
        });
      };
      await coordinator.reconcile(state, { scheduled: true, now: new Date(startedAt).toISOString() });
    });

    const stored = await runInDurableObject(guard, async (_instance, durableState) =>
      durableState.storage.sql.exec("SELECT next_attempt_at FROM managed_document_change_job_failure_state WHERE job_id = ?", jobId).one());
    expect(stored.next_attempt_at).toBe(startedAt + 75_000);
    const beforeDeadline = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const nowMs = startedAt + 74_999;
      return store.selectNextPending(store.beginSelectionCohort(nowMs), nowMs);
    });
    expect(beforeDeadline).toBeNull();
    const atDeadline = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const nowMs = startedAt + 75_000;
      return store.selectNextPending(store.beginSelectionCohort(nowMs), nowMs);
    });
    expect(atDeadline?.job_id).toBe(jobId);
  });

  it("parks a finite Retry-After whose deadline cannot be represented safely", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-RETRY-BOUNDARY-0001", "scheduled-retry-boundary");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const jobId = "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBC";
    const base = Date.parse("2026-10-03T21:00:00.000Z");
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "retry-boundary-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "boundary.md", path: "/inputs/boundary.md" }, detection_source: "incremental", priority: 10 }
      ] });
      const job = store.pending()[0];
      store.recordFailure(job, "bounded diagnostic", {
        failure_fingerprint: "0".repeat(64), progress_fingerprint: "1".repeat(64),
        classification: "provider_retryable", now_ms: base, retry_after_ms: 1e16
      });
      const cohort = store.beginSelectionCohort(base + 86_400_000);
      expect(cohort).toBeGreaterThan(0);
      expect(store.selectNextPending(cohort, base + 86_400_000)).toBeNull();
      const maximumTimeCohort = store.beginSelectionCohort(Number.MAX_SAFE_INTEGER);
      expect(store.selectNextPending(maximumTimeCohort, Number.MAX_SAFE_INTEGER)).toBeNull();
      const row = durableState.storage.sql.exec("SELECT next_attempt_at FROM managed_document_change_job_failure_state WHERE job_id = ?", jobId).one();
      expect(row.next_attempt_at).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it("resets the internal failure streak after a changed error or durable finding progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAILURE-RESET-0001", "scheduled-failure-reset");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Failure reset", "scheduled-failure-reset");
    const jobId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAB";
    let failureCode = "first_internal_error";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "failure-reset-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "reset.md", path: "/inputs/reset.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 100 WHERE job_id = ?", jobId);
    });
    const runSlice = (day: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage);
      (coordinator as any).processJob = async () => { throw new InternalExecutionFailure(failureCode, "process"); };
      return coordinator.reconcile(state, {
        scheduled: true,
        now: new Date(Date.parse("2026-10-03T20:00:00.000Z") + day * 86_400_000).toISOString()
      });
    });

    for (let day = 0; day < 5; day += 1) await runSlice(day);
    failureCode = "different_internal_error";
    const changedError = await runSlice(5);
    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).recordDriftFinding({
        finding_id: "DRIFT-0123456789ABCDEF01234567",
        job_id: jobId,
        path: "/inputs/reset.md",
        change_kind: "deleted",
        status: "expected_reconciled",
        code: "PACKAGE_EXPECTED_DELETE",
        request_id: "DOCREQ-STABLE-FINDING-0001",
        observed_at: "2026-10-09T20:00:00.000Z"
      });
    });
    const changedProgress = await runSlice(6);
    const beforeSixthAfterProgress = [];
    for (let day = 7; day < 11; day += 1) beforeSixthAfterProgress.push(await runSlice(day));
    const sixthAfterProgress = await runSlice(11);
    const final = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })), findings: store.driftFindingsForJob(jobId) };
    });

    expect(changedError).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(changedProgress).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(beforeSixthAfterProgress.every(summary => summary.jobs_pending === 1 && summary.job_failures === 1)).toBe(true);
    expect(sixthAfterProgress).toMatchObject({ jobs_pending: 1, job_failures: 1, jobs_quarantined: 0 });
    expect(final.pending).toEqual([{ job_id: jobId, attempts: 112 }]);
    expect(final.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PACKAGE_EXPECTED_DELETE" }),
      expect.objectContaining({ code: "identical_internal_failure_limit" })
    ]));
  });

  it("resumes a frozen CURRENT-index resource fanout across bounded scheduled slices", async () => {
    const projectId = "PRJ-9327";
    const state = emptyProjectState(projectId, "Fanout", "package-fanout");
    const runtime = packageRuntime().runtime;
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-package-fanout/WORKING/CURRENT.md`;
    await runtime.objects.createText(path, "externally changed index");
    runtime.objects.listChildren = async (parent) => parent === path.slice(0, path.lastIndexOf("/"))
      ? [{ kind: "file", name: "CURRENT.md", path }]
      : [];
    runtime.changeFeed = { listChanges: async () => ({ entries: [], cursor: "fanout-pending" }) };
    const resources = Array.from({ length: 10 }, (_, index) => ({
      resource_id: `PKG-${index.toString(16).toUpperCase().padStart(64, "0")}`,
      resource_type: "package",
      zone: "WORKING",
      version: `1:${index.toString(16).padStart(64, "0")}`
    }));
    const callbackResources: string[] = [];
    const callbackSnapshotIds: (string | undefined)[] = [];
    let normalReconcileCalls = 0;
    let snapshotUnavailable = false;
    let snapshotRestored = false;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);

    const results = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "fanout-seed", jobs: [] });
      const job: ManagedDocumentChangeJobInput = {
        job_id: `CHGJOB-${"A".repeat(24)}`,
        change: { kind: "file", name: "CURRENT.md", path },
        detection_source: "incremental",
        priority: 10
      };
      store.registerPage({ expected_cursor: "fanout-seed", next_cursor: "fanout-pending", jobs: [job] });
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe",
        async (_state, operation) => { callbackResources.push(operation.resources[0].resource_id); },
        async () => undefined);
      (coordinator as any).mutationGate.processChanges = async () => ({ candidates: 0, policy_violations: 0 });
      (coordinator as any).stableWorkProducts.reconcile = async () => ({ handled: false, captured: 0, restored: 0, conflicts: 0 });
      (coordinator as any).reconciler.reconcileChanges = async () => { normalReconcileCalls += 1; return ({ scanned: 0, ignored: 0, captured: 0, ingested: 0, duplicates: 0, restored: 0, conflicts: 0, intake_completed: 0, duplicate_cleaned: 0, withdrawn: 0, intake_resumed: 0, changed_document_ids: [] }); };
      (coordinator as any).packageDrift = {
        observe: async (_state: unknown, _change: unknown, snapshotRequestId?: string) => {
          callbackSnapshotIds.push(snapshotRequestId);
          if (snapshotRestored) return { handled: true, status: "expected_reconciled", code: "PACKAGE_EXPECTED_WRITE", request_id: "DOCREQ-SNAPSHOT-PROOF-0001", resource: resources[0] };
          if (snapshotUnavailable) return { handled: true, status: "unexpected_conflict", code: "PACKAGE_NAVIGATION_UNAVAILABLE", snapshot_request_id: snapshotRequestId };
          return { handled: true, status: "unexpected_conflict", code: "PACKAGE_UNEXPECTED_MUTATION", resources, snapshot_request_id: "DOCREQ-SNAPSHOT-PROOF-0001" };
        }
      };
      const first = await coordinator.reconcile(state);
      const firstFindings = store.driftFindingsForJob(job.job_id);
      snapshotRestored = true;
      const restored = await coordinator.reconcile(state);
      const restoredFindings = store.driftFindingsForJob(job.job_id);
      snapshotRestored = false;
      snapshotUnavailable = true;
      const unavailable = await coordinator.reconcile(state);
      const unavailableFindings = store.driftFindingsForJob(job.job_id);
      snapshotUnavailable = false;
      const second = await coordinator.reconcile(state);
      return { first, second, restored, unavailable, firstFindings, restoredFindings, unavailableFindings, findings: store.driftFindingsForJob(job.job_id) };
    });

    expect(results.first).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0, restored: 0 });
    expect(results.firstFindings).toHaveLength(9); // frozen-snapshot sentinel plus eight resources
    expect(results.restored).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0 });
    expect(results.restoredFindings).toHaveLength(9);
    expect(results.unavailable).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0 });
    expect(results.unavailableFindings).toHaveLength(9);
    expect(results.second).toMatchObject({ jobs_completed: 1, jobs_pending: 0, job_failures: 0, restored: 0 });
    expect(results.findings).toHaveLength(11);
    expect(callbackResources).toHaveLength(10);
    expect(new Set(callbackResources).size).toBe(10);
    expect(callbackSnapshotIds).toEqual([undefined, "DOCREQ-SNAPSHOT-PROOF-0001", "DOCREQ-SNAPSHOT-PROOF-0001", "DOCREQ-SNAPSHOT-PROOF-0001"]);
    expect(normalReconcileCalls).toBe(0);
  });

  it("advances the provider cursor after durable registration while isolating a failed job from a healthy sibling", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-isolation";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    // Establish the initial provider cursor before introducing the page under test.
    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const badInput = `${root}/INPUTS/bad.pdf`;
    const goodInput = `${root}/INPUTS/good.pdf`;
    faults.push({
      endpoint: "/2/files/copy_v2",
      occurrence: 1,
      status: 409,
      error_summary: "to/conflict/file/...",
      path: badInput
    });

    await mock.writeExternal(badInput, "%PDF poison job");
    await mock.writeExternal(goodInput, "%PDF healthy job");

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      cursor_advanced: true,
      jobs_registered: 2,
      jobs_completed: 0,
      jobs_pending: 2,
      job_failures: 1,
      budget_yield: true,
      ignored: 0
    });

    expect(mock.files.has(badInput)).toBe(true);

    // The first failure now carries a durable bounded retry time. Mature that
    // specific local fixture job so this test continues to cover recovery
    // after its injected provider fault has been consumed.
    await runInDurableObject(guard, async (_instance, durableState) => {
      const pendingBadJob = new ManagedDocumentChangeJobStore(durableState.storage).pending()
        .find(job => job.change.path === badInput);
      expect(pendingBadJob).toBeDefined();
      durableState.storage.sql.exec(
        "UPDATE managed_document_change_job_failure_state SET next_attempt_at = 0 WHERE job_id = ?",
        pendingBadJob!.job_id
      );
    });

    for (let slice = 0; slice < 8 && mock.files.has(badInput); slice += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_050));
      await runInDurableObject(guard, instance => instance.alarm());
    }
    expect(mock.files.has(badInput)).toBe(false);
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/bad.pdf`)).toBe("%PDF poison job");
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/good.pdf`)).toBe("%PDF healthy job");
  });

  it("routes a folder change without requesting file metadata", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-routing";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobs_registered: 1,
      jobs_completed: 1,
      jobs_pending: 0,
      job_failures: 0
    });
    expect(mock.providerCalls).not.toContainEqual({ endpoint: "POST /2/files/get_metadata", paths: [folder] });
  });

  it("terminally quarantines a legacy file job whose target is now a folder", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-quarantine";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(),
        next_cursor: "legacy-folder-cursor",
        jobs: [{
          job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
          change: { kind: "file", name: "REVENUE-OS", path: folder },
          detection_source: "incremental",
          priority: 10
        }]
      });
    });

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 1, job_failures: 0 });

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
      path: folder,
      code: "directory_used_as_file_target",
      attempts: 1
    })]);
  });

  it("quarantines a proven-absent file target once and admits a new observation after it reappears", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-missing-metadata";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-MISSINGMETA-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/vanished.pdf`;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(), next_cursor: "missing-metadata-retry-cursor",
        jobs: [{ job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", change: { kind: "file", name: "vanished.pdf", path: absentPath }, detection_source: "incremental", priority: 10 }]
      });
    });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_completed: 0, job_failures: 0, jobs_quarantined: 1 });
    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", path: absentPath, code: "file_target_missing", attempts: 1
    })]);

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(second.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 0, job_failures: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines[0]?.attempts).toBe(1);

    await mock.writeExternal(absentPath, "%PDF target reappeared with a new provider revision");
    const reappeared = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(reappeared.json()).resolves.toMatchObject({ jobs_registered: 1, jobs_completed: 1, jobs_pending: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      const jobs = state.storage.sql.exec<{ job_id: string; status: string; attempts: number }>(
        "SELECT job_id, status, attempts FROM managed_document_change_jobs ORDER BY ordinal"
      ).toArray();
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.job_id)).size).toBe(2);
      expect(jobs.map((job) => job.status)).toEqual(["completed", "completed"]);
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toHaveLength(1);
  });

  it("keeps a file-kind change retryable when the provider listing fails", async () => {
    const faults: DropboxMockFault[] = [];
    installDropboxMock({ faults });
    const slug = "change-job-list-failure";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-LISTFAIL-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/unknown.pdf`;
    const parent = absentPath.slice(0, absentPath.lastIndexOf("/"));
    await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "list-failure-cursor", jobs: [{
        job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
        change: { kind: "file", name: "unknown.pdf", path: absentPath }, detection_source: "incremental", priority: 10
      }] });
    });
    for (let occurrence = 1; occurrence <= 10; occurrence += 1) {
      faults.push({ endpoint: "/2/files/list_folder", occurrence: 1, status: 503, error_summary: "temporarily_unavailable", path: parent });
    }

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 1, jobs_completed: 0, job_failures: expect.any(Number), jobs_quarantined: 0 });
    let pending: unknown[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      pending = new ManagedDocumentChangeJobStore(state.storage).pending();
    });
    expect(pending).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE", attempts: expect.any(Number), last_error: expect.stringContaining("Dropbox list_folder failed")
    })]);
  }, 15_000);

  it("terminally quarantines an external move that conflicts with immutable candidate evidence", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-candidate-evidence-conflict";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-CANDIDATE-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const original = `${root}/DELIVERABLES/external.md`;
    const moved = `${root}/DELIVERABLES/external-moved.md`;
    await mock.writeExternal(original, "# externally moved");
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);

    const move = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_path: original, to_path: moved })
    });
    expect(move.ok).toBe(true);

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      jobs_quarantined: 1,
      jobs_pending: 0,
      job_failures: 0
    });

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual(expect.arrayContaining([expect.objectContaining({
      path: moved,
      code: "mutation_candidate_evidence_conflict",
      attempts: 1
    })]));
  });

  it("keeps the old durable cursor when its reset baseline fails despite a foreign project continuation", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-reset-atomic";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    let cursorBefore: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorBefore = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(cursorBefore).not.toBeNull();

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    await mock.writeExternal(`${root}/ARTIFACTS/reset-proof.md`, "# reset proof");

    const foreign = await createProject("TXN-CHANGEJOB-PROJECT-FOREIGN-CURSOR-0001", "foreign-cursor-consumer");
    const foreignGuard = testEnv.PROJECT_GUARD.getByName(foreign.project_id);
    const foreignBaseline = await foreignGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(foreignBaseline.status).toBe(200);
    const foreignCursor = await runInDurableObject(foreignGuard, (_instance, state) =>
      state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor);
    expect(foreignCursor).not.toBeNull();
    expect(foreignCursor).not.toBe(cursorBefore);

    // Both reset responses are bound to the saved target cursor. This preserves
    // one for its retry even if another project's real continuation runs first.
    faults.push(
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/...",
        cursor: cursorBefore!
      },
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/...",
        cursor: cursorBefore!
      },
      {
        endpoint: "/2/files/list_folder",
        occurrence: 1,
        status: 400,
        error_summary: "invalid_arg/...",
        path: root
      }
    );

    const unrelatedListing = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/PROJECT_OS/WORKSPACE/UNRELATED-PROJECT" })
    });
    expect(unrelatedListing.status).toBe(200);

    const providerCallOffset = mock.providerCalls.length;
    const firstReset = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(firstReset.status).toBe(200);
    await expect(firstReset.json()).resolves.toMatchObject({ safe_errors: ["provider_blocked"], unread_feed: true });

    const firstResetProviderCalls = mock.providerCalls.slice(providerCallOffset);
    expect(firstResetProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder/continue", paths: [] });
    expect(firstResetProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder", paths: [root] });

    let cursorAfterFailure: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorAfterFailure = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
      expect(cursorAfterFailure).toBe(cursorBefore);
      // This test owns a manual retry; alarm-only recovery is exercised separately.
      await state.storage.deleteAlarm();
    });
    expect(cursorAfterFailure).toBe(cursorBefore);

    const foreignRetry = await foreignGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(foreignRetry.status).toBe(200);
    await expect(foreignRetry.json()).resolves.toMatchObject({ cursor_reset: false, baseline: false });

    // Advance the durable Retry-After eligibility rather than retrying the
    // failed feed immediately. This test is about atomic cursor preservation.
    await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      expect(store.cursor()).toBe(cursorBefore);
      const continuation = store.continuation();
      store.finishContinuationSlice({
        pending: continuation.pending,
        next_wake_at: Date.now(),
        documents_priority_next: continuation.documents_priority_next,
        feed_retry_at: Date.now(),
        outcome: continuation.last_outcome ?? { unread_feed: true }
      });
    });

    const retryProviderCallOffset = mock.providerCalls.length;
    const retry = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      cursor_reset: true,
      baseline: true,
      cursor_advanced: true
    });
    const retryProviderCalls = mock.providerCalls.slice(retryProviderCallOffset);
    expect(retryProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder/continue", paths: [] });
    expect(retryProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder", paths: [root] });
  });

  it("deduplicates a replayed page and preserves global pending order across later pages", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0003", "change-job-store-order");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-store-order/INPUTS`;
      const firstPage: ManagedDocumentChangeJobInput[] = [
        {
          job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
          change: { kind: "deleted", name: "first.md", path: `${root}/first.md` },
          detection_source: "incremental",
          priority: 10
        },
        {
          job_id: "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB",
          change: { kind: "deleted", name: "second.md", path: `${root}/second.md` },
          detection_source: "incremental",
          priority: 10
        }
      ];

      const initialCursor = store.cursor();
      expect(store.registerPage({
        expected_cursor: initialCursor,
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 0, cursor_advanced: false });
      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB"
      ]);

      store.markFailed("CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA", "retry me");
      store.markCompleted("CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB");
      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-2",
        jobs: [
          {
            job_id: "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
            change: { kind: "deleted", name: "third.md", path: `${root}/third.md` },
            detection_source: "incremental",
            priority: 10
          },
          {
            job_id: "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD",
            change: { kind: "deleted", name: "fourth.md", path: `${root}/fourth.md` },
            detection_source: "incremental",
            priority: 10
          }
        ]
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
        "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD"
      ]);
    });
  });

  it("persists an external drift conflict without replacing its first observation", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0004", "change-job-drift-finding");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let findings: ManagedDocumentDriftFinding[] = [];

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const finding = {
        finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
        job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-drift-finding/WORKING/PACKAGES/PKG-${"A".repeat(64)}/1/a.md`,
        change_kind: "deleted" as const,
        status: "unexpected_conflict" as const,
        code: "PACKAGE_UNEXPECTED_DISAPPEARANCE",
        request_id: "DOCREQ-DRIFT-0001",
        resource: { resource_id: `PKG-${"A".repeat(64)}`, resource_type: "package", zone: "WORKING", version: `1:${"b".repeat(64)}` },
        observed_at: "2026-09-12T00:00:00.000Z"
      };
      store.recordDriftFinding(finding);
      store.recordDriftFinding({ ...finding, observed_at: "2026-09-12T01:00:00.000Z", code: "PACKAGE_EXPECTED_EFFECT_DIVERGED" });
      findings = store.driftFindings();
    });

    expect(findings).toEqual([expect.objectContaining({
      finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
      status: "unexpected_conflict",
      code: "PACKAGE_EXPECTED_EFFECT_DIVERGED",
      opened_at: "2026-09-12T00:00:00.000Z",
      observed_at: "2026-09-12T01:00:00.000Z"
    })]);
  });

  it("persists daily verification lateness until a later successful verification", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0005", "change-job-lateness");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let first: unknown;
    let early: unknown;
    let late: unknown;
    let cleared: unknown;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      first = store.scheduledVerification("2026-09-12T00:00:00.000Z");
      store.completeScheduledVerification("2026-09-12T00:00:00.000Z");
      early = store.scheduledVerification("2026-09-12T23:59:59.000Z");
      late = store.scheduledVerification("2026-09-13T00:00:01.000Z");
      store.completeScheduledVerification("2026-09-13T00:00:01.000Z");
      cleared = store.scheduledVerification("2026-09-13T00:00:02.000Z");
    });

    expect(first).toMatchObject({ due: true, late_since: null });
    expect(early).toMatchObject({ due: false, late_since: null });
    expect(late).toMatchObject({ due: true, late_since: "2026-09-13T00:00:00.000Z" });
    expect(cleared).toMatchObject({ due: false, late_since: null, last_verified_at: "2026-09-13T00:00:01.000Z" });
  });

  it("keeps daily verification due until the final provider change page is consumed", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-PAGED-0001", "change-job-paged-daily");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const previousFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let page = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
        page += 1;
        return Promise.resolve(Response.json({ entries: [], cursor: `daily-page-${page}`, has_more: page === 1 }));
      }
      return previousFetch(input, init);
    });

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ scheduled_due: true, last_scheduled_verified_at: null });
    let intermediateCursor: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      intermediateCursor = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(intermediateCursor).toBe("daily-page-1");

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(second.status).toBe(200);
    const result = await second.json<{ scheduled_due: boolean; last_scheduled_verified_at: string | null }>();
    expect(result.scheduled_due).toBe(true);
    expect(result.last_scheduled_verified_at).not.toBeNull();
    let finalCursor: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      finalCursor = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(finalCursor).toBe("daily-page-2");
    const third = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(await third.json()).toMatchObject({ scheduled_due: false });
  });
});
