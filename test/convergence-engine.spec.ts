import { describe, expect, it } from "vitest";
import { minimumWake } from "../src/convergence/retry";
import { ConvergenceEngine, nextConvergenceWake } from "../src/convergence/engine";
import { createSliceBudget, providerRequestScopeFor } from "../src/convergence/budget";
import { ConvergenceJournal } from "../src/convergence/journal";
import { initialProgress } from "../src/convergence/journal";
import { ProjectRepository } from "../src/persistence/repository";
import { convergenceAttemptPath, convergenceProgressPath, machineEventPath, machineReceiptPath } from "../src/persistence/layout";
import { sha256Canonical } from "../src/materialization/hash";
import { buildAlertRecord } from "../src/convergence/observability";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { commitFixture } from "./helpers/convergence-fixture";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { afterEach, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("convergence engine scheduling", () => {
  it("does not postpone an already-due continuation", () => {
    expect(nextConvergenceWake("2026-09-08T00:00:05.000Z", ["2026-09-08T00:00:02.000Z", null])).toBe(
      minimumWake(["2026-09-08T00:00:05.000Z", "2026-09-08T00:00:02.000Z"])
    );
  });

  it("rebuilds each machine derivative from the immutable commit record", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9258", 1)[0];
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    await repository.writeReceipt(record.receipt);
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository,
      runtime,
      journal: new ConvergenceJournal(runtime, record.project_id),
      ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:00:00.000Z")
    });

    const result = await engine.runSlice(createSliceBudget(() => Date.now(), new AbortController().signal));
    expect(result.health.layers.event.state).toBe("current");
    expect(result.health.layers.receipt.state).toBe("current");
    expect(result.health.layers.state.state).toBe("current");
    expect(result.health.layers.manifest.state).toBe("current");
    expect(result.health.converged).toBe(true);
    await expect(engine.runSlice(createSliceBudget(() => Date.now(), new AbortController().signal))).resolves.toMatchObject({
      more_work: false,
      health: { converged: true }
    });
    await expect(engine.observe(createSliceBudget(() => Date.now(), new AbortController().signal))).resolves.toMatchObject({
      converged: true,
      layers: { event: { state: "current" }, receipt: { state: "current" } }
    });
  });

  it("emits a scrubbed metric snapshot when a convergence slice observes a commit", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9257", 1)[0];
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    await repository.writeReceipt(record.receipt);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const metrics: unknown[] = [];
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository,
      runtime,
      journal,
      ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:00:00.000Z"),
      deploymentSha: "d".repeat(40),
      telemetry: { emit(metric: unknown) { metrics.push(metric); } }
    });

    await engine.runSlice(createSliceBudget(() => Date.parse("2026-09-08T00:00:00.000Z"), new AbortController().signal));

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "commit_observed", kind: "counter", value: 1 }),
      expect.objectContaining({ name: "tranche_duration", kind: "histogram" }),
      expect.objectContaining({
        name: "queue_depth",
        fields: expect.objectContaining({
          project_id: "PRJ-9257", deployment_sha: "d".repeat(40), provider_calls: expect.any(Number)
        })
      })
    ]));
    expect(JSON.stringify(metrics)).not.toContain("Synthetic convergence");
    expect((await journal.load())?.progress.commit_accepted_at).toBe("2026-08-24T22:00:00Z");
  });

  it("preserves the immutable event and receipt of every discovered commit", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const records = commitFixture("PRJ-9259", 3);
    const repository = new ProjectRepository(runtime, "v2");
    for (const record of records) await repository.writeCommitRecord(record);
    await repository.writeReceipt(records[0]!.receipt);
    const engine = new ConvergenceEngine({
      projectId: "PRJ-9259",
      repository,
      runtime,
      journal: new ConvergenceJournal(runtime, "PRJ-9259"),
      ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:00:00.000Z")
    });

    await engine.runSlice(createSliceBudget(() => Date.now(), new AbortController().signal));

    for (const record of records) {
      expect(mock.files.get(machineEventPath(record.project_id, record.event.event_id))).toBe(
        repository.canonicalDerivativeText("event", record)
      );
      expect(mock.files.get(machineReceiptPath(record.receipt.transaction_id))).toBe(
        repository.canonicalDerivativeText("receipt", record)
      );
    }
  });

  it("waits for RegistryGuard to finalize a project.create receipt", async () => {
    const mock = installDropboxMock();
    const record = commitFixture("PRJ-9268", 1)[0];
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const engine = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => 0
    });

    const result = await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));

    expect(mock.files.has(machineReceiptPath(record.receipt.transaction_id))).toBe(false);
    expect(result.health.layers.receipt).toMatchObject({ state: "pending", code: "awaiting_registry_finalization" });
  });

  it("retains a persisted continuation wake when no newer commit is discovered", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const projectId = "PRJ-9260";
    const journal = new ConvergenceJournal(runtime, projectId);
    const progress = initialProgress(projectId, "2026-09-08T00:00:00.000Z", "writer-1");
    progress.next_alarm_at = "2026-09-08T00:00:02.000Z";
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId,
      repository: new ProjectRepository(runtime, "v2"),
      runtime,
      journal,
      ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:00:00.000Z")
    });

    await expect(engine.runSlice(createSliceBudget(() => 0, new AbortController().signal))).resolves.toMatchObject({
      more_work: true,
      next_alarm_at: "2026-09-08T00:00:02.000Z"
    });
  });

  it("persists an incident before returning from an exhausted human obligation", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const projectId = "PRJ-9263";
    const journal = new ConvergenceJournal(runtime, projectId);
    const progress = initialProgress(projectId, "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["e".repeat(64)] = {
      id: "e".repeat(64), layer: "human_handoff", from_revision: 257,
      target: { revision: 258, projection_version: 3 }, incident: 6,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:15:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "critical_pair_drift", lease_until: null, continuation: null
    };
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId, repository: new ProjectRepository(runtime, "v2"), runtime, journal, ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:10:40.000Z")
    });

    const result = await engine.runSlice(
      createSliceBudget(() => Date.parse("2026-09-08T00:10:40.000Z"), new AbortController().signal)
    );

    expect([...mock.files.keys()].filter((path) => path.includes("/convergence/incidents/inc-"))).toHaveLength(1);
    expect(result).toMatchObject({ more_work: true });
    expect(result.next_alarm_at).not.toBeNull();
  });

  it("records an alert delivery acknowledgement only after the immutable incident exists", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const projectId = "PRJ-9264";
    const journal = new ConvergenceJournal(runtime, projectId);
    const progress = initialProgress(projectId, "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["f".repeat(64)] = {
      id: "f".repeat(64), layer: "human_handoff", from_revision: 257,
      target: { revision: 258, projection_version: 3 }, incident: 6,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:15:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "critical_pair_drift", lease_until: null, continuation: null
    };
    await journal.save(progress, null);
    let incidentPresentAtDelivery = false;
    const engine = new ConvergenceEngine({
      projectId, repository: new ProjectRepository(runtime, "v2"), runtime, journal, ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:10:40.000Z"),
      notification: {
        async deliver(alert, deliveryId) {
          incidentPresentAtDelivery = mock.files.has(alert.diagnostic_path);
          return { acknowledged: true, delivery_id: deliveryId };
        }
      }
    });

    await engine.runSlice(createSliceBudget(() => Date.parse("2026-09-08T00:10:40.000Z"), new AbortController().signal));

    expect(incidentPresentAtDelivery).toBe(true);
    expect(Object.values((await journal.load())?.progress.alerts ?? {})).toMatchObject([{
      notification_pending: false,
      delivered_at: "2026-09-08T00:10:40.000Z"
    }]);
  });

  it("rehydrates an existing immutable incident after its progress checkpoint was lost", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const projectId = "PRJ-9266";
    const journal = new ConvergenceJournal(runtime, projectId);
    const progress = initialProgress(projectId, "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["a".repeat(64)] = {
      id: "a".repeat(64), layer: "human_handoff", from_revision: 0,
      target: { revision: 1, projection_version: 3 }, incident: 1,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:15:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "human_write_failed", lease_until: null, continuation: null
    };
    const evidence = { revision: null, identity: null, hash: null, projection_version: null, root_hash: null };
    const recorded = await buildAlertRecord({
      projectId, layer: "human_handoff", incident: 1,
      createdAt: "2026-09-08T00:10:00.000Z", code: "human_write_failed",
      relativePath: "convergence/human_handoff", expected: evidence, observed: evidence,
      lastSuccessAt: null, deploymentSha: "unknown"
    });
    await journal.recordIncident(recorded);
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId, repository: new ProjectRepository(runtime, "v2"), runtime, journal, ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:10:40.000Z")
    });

    await expect(engine.runSlice(
      createSliceBudget(() => Date.parse("2026-09-08T00:10:40.000Z"), new AbortController().signal)
    )).resolves.toMatchObject({ more_work: true });
    expect(Object.values((await journal.load())?.progress.alerts ?? {})).toMatchObject([{
      created_at: "2026-09-08T00:10:00.000Z"
    }]);
  });

  it("continues machine convergence while a human retry is waiting", async () => {
    const mock = installDropboxMock();
    const record = commitFixture("PRJ-9267", 1)[0];
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    await repository.writeReceipt(record.receipt);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const progress = initialProgress(record.project_id, "1970-01-01T00:00:00.000Z", "writer-1");
    const humanObligationId = await sha256Canonical({
      project_id: record.project_id, layer: "human_handoff", revision: record.new_revision
    });
    progress.active = { revision: record.new_revision, projection_version: 3 };
    progress.next_alarm_at = "1970-01-01T00:00:10.000Z";
    progress.obligations[humanObligationId] = {
      id: humanObligationId, layer: "human_handoff", from_revision: 0,
      target: { revision: record.new_revision, projection_version: 3 }, incident: 1,
      state: "retry_wait", first_pending_at: "1970-01-01T00:00:00.000Z",
      next_attempt_at: "1970-01-01T00:00:10.000Z", failure_count: 1,
      last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
      code: "human_write_failed", lease_until: null, continuation: null
    };
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal,
      ledger: { status: () => ({ active: null, requested: null }) } as never,
      now: () => 0, enableHuman: true
    });

    await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));

    expect(mock.files.get(machineEventPath(record.project_id, record.event.event_id))).toBe(
      repository.canonicalDerivativeText("event", record)
    );
    expect((await journal.load())?.progress.next_alarm_at).toBe("1970-01-01T00:00:10.000Z");
  });

  it("persists a retry obligation and wake when a machine derivative cannot be written", async () => {
    const record = commitFixture("PRJ-9261", 1)[0];
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: machineEventPath(record.project_id, record.event.event_id),
        occurrence: 1,
        status: 400,
        error_summary: "injected/event_write_failed"
      }]
    });
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository,
      runtime,
      journal,
      ledger: {} as never,
      now: () => 0
    });

    const result = await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    expect(result.more_work).toBe(true);
    expect(result.next_alarm_at).not.toBeNull();
    expect(Date.parse(result.next_alarm_at ?? "")).toBeGreaterThanOrEqual(2_000);
    expect(Date.parse(result.next_alarm_at ?? "")).toBeLessThanOrEqual(2_400);
    const progress = await journal.load();
    const obligation = Object.values(progress?.progress.obligations ?? {}).find((candidate) => candidate.layer === "event");
    expect(obligation).toMatchObject({ failure_count: 1, state: "retry_wait", next_attempt_at: result.next_alarm_at });

    await expect(engine.runSlice(createSliceBudget(() => 0, new AbortController().signal))).resolves.toMatchObject({
      more_work: true,
      next_alarm_at: result.next_alarm_at
    });
    expect(mock.files.has(machineEventPath(record.project_id, record.event.event_id))).toBe(false);
  });

  it("reconstructs a retry wait when a crash loses the failed-attempt checkpoint", async () => {
    const record = commitFixture("PRJ-9270", 1)[0];
    const eventPath = machineEventPath(record.project_id, record.event.event_id);
    const mock = installDropboxMock({
      faults: [
        {
          endpoint: "/2/files/upload",
          path: eventPath,
          occurrence: 1,
          status: 400,
          error_summary: "injected/event_write_failed"
        },
        {
          endpoint: "/2/files/upload",
          path: convergenceProgressPath(record.project_id),
          occurrence: 3,
          status: 400,
          error_summary: "injected/checkpoint_lost_after_attempt"
        }
      ]
    });
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const crashed = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => 0
    });

    await expect(crashed.runSlice(createSliceBudget(() => 0, new AbortController().signal))).rejects.toThrow(
      "Dropbox conditional upload failed"
    );

    const restarted = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => 0
    });
    const result = await restarted.runSlice(createSliceBudget(() => 0, new AbortController().signal));

    expect(mock.files.has(eventPath)).toBe(false);
    expect(result.health.layers.event).toMatchObject({ state: "retry_wait", failure_count: 1 });
    expect(Date.parse(result.next_alarm_at ?? "")).toBeGreaterThanOrEqual(2_000);
  });

  it("does not advance the canonical cursor before the first repair reservation is durable", async () => {
    const record = commitFixture("PRJ-9265", 1)[0];
    const obligationId = await sha256Canonical({
      project_id: record.project_id,
      layer: "event",
      revision: record.new_revision
    });
    installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: convergenceAttemptPath(record.project_id, obligationId, 1),
        occurrence: 1,
        status: 400,
        error_summary: "injected/attempt_reservation_failed"
      }]
    });
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const engine = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => 0
    });

    await expect(engine.runSlice(createSliceBudget(() => 0, new AbortController().signal))).rejects.toThrow(
      "Dropbox upload failed"
    );

    expect((await journal.load())?.progress.canonical_observed_revision).toBe(0);
  });

  it("retries a due machine obligation after a cold restart and marks it verified", async () => {
    const record = commitFixture("PRJ-9262", 1)[0];
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: machineEventPath(record.project_id, record.event.event_id),
        occurrence: 1,
        status: 400,
        error_summary: "injected/event_write_failed"
      }]
    });
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    await repository.writeReceipt(record.receipt);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const first = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => 0
    });
    const failed = await first.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const dueAt = Date.parse(failed.next_alarm_at ?? "");
    expect(dueAt).toBeGreaterThan(0);

    const restarted = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => dueAt
    });
    const recovered = await restarted.runSlice(createSliceBudget(() => dueAt, new AbortController().signal));

    expect(mock.files.get(machineEventPath(record.project_id, record.event.event_id))).toBe(
      repository.canonicalDerivativeText("event", record)
    );
    expect(recovered).toMatchObject({ more_work: true });
    const verificationAt = Date.parse(recovered.next_alarm_at ?? "");
    const reverified = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: {} as never, now: () => verificationAt
    });
    await expect(reverified.runSlice(createSliceBudget(() => verificationAt, new AbortController().signal))).resolves.toMatchObject({
      more_work: false, next_alarm_at: null
    });
    expect((await journal.load())?.progress.canonical_observed_revision).toBe(record.new_revision);
    const obligation = Object.values((await journal.load())?.progress.obligations ?? {}).find((candidate) => candidate.layer === "event");
    expect(obligation).toMatchObject({ state: "verified", failure_count: 1, last_attempt_number: 2 });
  });

  it("checkpoints a bounded continuation before scoped provider capacity is exhausted", async () => {
    installDropboxMock();
    const record = commitFixture("PRJ-9269", 1)[0];
    const seedRuntime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const seedRepository = new ProjectRepository(seedRuntime, "v2");
    await seedRepository.writeCommitRecord(record);
    await seedRepository.writeReceipt(record.receipt);

    const budget = createSliceBudget(() => 0, new AbortController().signal);
    const runtime = persistenceFromDropbox(new DropboxClient(
      { appKey: "key", appSecret: "secret", refreshToken: "refresh" },
      { requestScope: providerRequestScopeFor(budget) }
    ));
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository: new ProjectRepository(runtime, "v2"),
      runtime,
      journal: new ConvergenceJournal(runtime, record.project_id),
      ledger: {} as never,
      now: () => 0
    });

    const result = await engine.runSlice(budget);

    expect(result.provider_calls).toBeLessThanOrEqual(28);
    expect(result.more_work).toBe(true);
    expect(result.next_alarm_at).toBe("1970-01-01T00:00:00.000Z");
  });
});
