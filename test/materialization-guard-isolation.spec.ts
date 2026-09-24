import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { ConvergenceJournal } from "../src/convergence/journal";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { commitFixture } from "./helpers/convergence-fixture";
import type { SliceBudget } from "../src/convergence/contract";

const testEnv = env as unknown as Env;
const at = "2026-09-02T07:20:00+01:00";

function materializationNamespace(): DurableObjectNamespace {
  const namespace = (testEnv as unknown as {
    MATERIALIZATION_GUARD?: DurableObjectNamespace;
  }).MATERIALIZATION_GUARD;
  if (!namespace) throw new Error("MATERIALIZATION_GUARD binding missing");
  return namespace;
}

async function createProject(projectId: string, slug: string, transactionId: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: slug,
        slug,
        aliases: [],
        objective: "Verify isolated materialization ownership"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  // This fixture addresses MaterializationGuard in isolation.  Production
  // finalizes the receipt through RegistryGuard before repair convergence can
  // consume the commit; reproduce that canonical precondition here.
  await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(receipt);
  return receipt;
}

describe("MaterializationGuard isolation boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checkpoints canonical commit reconstruction and never returns a partial state as current", async () => {
    const projectId = "PRJ-3910";
    const commits = commitFixture(projectId, 8);
    let reads: number[] = [];
    const repository = {
      readProjectState: async () => null,
      readCommitRecord: async (_project: string, revision: number) => {
        reads.push(revision);
        return commits[revision - 1] ?? null;
      }
    };
    let startChecks = 0;
    const partialBudget: SliceBudget = {
      deadline_ms: Date.now() + 25_000,
      calls_left: 32,
      now: () => Date.now(),
      signal: new AbortController().signal,
      beforeHttp: () => undefined,
      canStartEffect: () => ++startChecks <= 2
    };
    const guard = materializationNamespace().getByName(projectId);
    const partial = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { canonicalState(repo: unknown, budget: SliceBudget): Promise<unknown> })
        .canonicalState(repository, partialBudget)
    );

    expect(partial).toMatchObject({ complete: false, state: null });
    expect(reads).toEqual([1, 2]);

    reads = [];
    const resumed = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { canonicalState(repo: unknown): Promise<unknown> })
        .canonicalState(repository)
    );
    expect(resumed).toMatchObject({ complete: true, state: { project_id: projectId, revision: 8 } });
    expect(reads).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps bounded canonical diagnostics read-only when reconstruction is incomplete", async () => {
    const projectId = "PRJ-3911";
    const writes: string[] = [];
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId,
      ctx: { storage: {
        get: async () => undefined,
        put: async () => { writes.push("put"); },
        delete: async () => { writes.push("delete"); },
        setAlarm: async () => { writes.push("alarm"); }
      } }
    }) as MaterializationGuard;
    const commits = commitFixture(projectId, 4);
    let reads = 0;
    const repository = {
      readProjectState: async () => null,
      readCommitRecord: async (_project: string, revision: number) => {
        reads += 1;
        return commits[revision - 1] ?? null;
      }
    };
    let checks = 0;
    const budget: SliceBudget = {
      deadline_ms: Date.now() + 25_000, calls_left: 32, now: () => Date.now(),
      signal: new AbortController().signal, beforeHttp: () => undefined,
      canStartEffect: () => ++checks <= 2
    };
    const result = await (guard as unknown as {
      canonicalState(repo: unknown, budget: SliceBudget, persist: boolean): Promise<unknown>;
      canonicalStatePendingResponse(schedule: boolean): Promise<Response>;
    }).canonicalState(repository, budget, false) as { complete: boolean; state: unknown };
    const response = await (guard as unknown as {
      canonicalStatePendingResponse(schedule: boolean): Promise<Response>;
    }).canonicalStatePendingResponse(false);

    expect(result).toEqual({ complete: false, state: null });
    expect(reads).toBe(2);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ reason: "canonical_state_reconstruction_pending" });
    expect(writes).toEqual([]);
  });

  it("exposes a separate MATERIALIZATION_GUARD Durable Object binding", () => {
    expect(materializationNamespace()).toBeDefined();
  });

  it("rejects cross-project target requests", async () => {
    const response = await materializationNamespace().getByName("PRJ-3902").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3903",
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(409);
  });

  it("rejects invalid materialization targets", async () => {
    const response = await materializationNamespace().getByName("PRJ-3904").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3904",
          revision: -1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(400);
  });

  it("accepts a target without synchronously writing human workspace output", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3906";
    const receipt = await createProject(projectId, "target-handoff", "TXN-MATISO-3906-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const workspaceRoot = workspaceProjectRoot(projectId, "target-handoff");
    const filesBefore = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));

    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(200);

    const filesAfter = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));
    expect(filesAfter).toEqual(filesBefore);
  });

  it("owns projection execution in the separate MaterializationGuard alarm", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3905";
    const receipt = await createProject(projectId, "materialization-alarm", "TXN-MATISO-3905-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    const response = await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        revision: 1,
        projection_version: CURRENT_PROJECTION_VERSION
      })
    });
    expect(response.status).toBe(200);
    for (let slice = 0; slice < 32; slice += 1) {
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      if (mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))) break;
    }
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(true);
  });

  it("reports a verified repair canary as current after its writer becomes idle", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3912";
    await createProject(projectId, "repair-current", "TXN-MATISO-3912-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        revision: 1,
        projection_version: CURRENT_PROJECTION_VERSION
      })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId,
      revision: 1,
      materialized: true,
      status: "current"
    });
  });

  it("keeps a retry wake when a verified head cannot notify ProjectGuard", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3917";
    await createProject(projectId, "finalization-retry", "TXN-MATISO-3917-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [projectId]: "repair" });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);
    await runInDurableObject(guard, async (instance, state) => {
      await state.storage.deleteAlarm();
      vi.spyOn(instance as any, "notifyProjectGuardOfCurrentHead").mockRejectedValue(new Error("temporary_project_guard_unavailable"));
    });

    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("notifies ProjectGuard from a legacy alarm even when the synchronous materialization left no queued target", async () => {
    const guard = materializationNamespace().getByName("PRJ-3918");
    let notify!: ReturnType<typeof vi.fn>;
    await runInDurableObject(guard, async (instance, state) => {
      (instance as any).layoutMode = "legacy";
      (instance as any).coordinatorForSlice = () => ({
        coordinator: { runNext: async () => ({ completed: false, more_work: false }) }
      });
      notify = vi.spyOn(instance as any, "notifyProjectGuardOfCurrentHead").mockResolvedValue(true);
      await state.storage.setAlarm(Date.now() + 1_000);
    });

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("notifies ProjectGuard from an idle V2 alarm so a published head finalizes its covered receipts", async () => {
    const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId: "PRJ-3919",
      layoutMode: "v2",
      env: {},
      ctx: { storage: { get: async () => undefined } },
      queue: Promise.resolve()
    }) as MaterializationGuard;
    const notify = vi.spyOn(materialization as any, "notifyProjectGuardOfCurrentHead").mockResolvedValue(true);

    await materialization.alarm();

    expect(notify).toHaveBeenCalledOnce();
  });

  it("keeps an idle verified canary current when bounded verification reads are slow", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3913";
    await createProject(projectId, "repair-slow-current", "TXN-MATISO-3913-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 200));
    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ materialized: true, status: "current" });
  });

  it("closes stale human work after the current durable head is verified", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3914";
    await createProject(projectId, "repair-stale-human", "TXN-MATISO-3914-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "retry_wait",
      next_attempt_at: at,
      code: "human_internal_failure"
    };
    saved.progress.requested = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);

    const reconciled = await guard.fetch("https://materialization-guard.internal/reconcile", {
      method: "POST"
    });
    expect(reconciled.status).toBe(200);
    const acknowledged = await journal.load();
    expect(acknowledged?.progress).toMatchObject({ requested: null, active: null, next_alarm_at: null });

    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ materialized: true, status: "current" });
    const repaired = await journal.load();
    expect(repaired?.progress).toMatchObject({ requested: null, active: null, next_alarm_at: null });
    expect(Object.values(repaired?.progress.obligations ?? {}).every((obligation) => obligation.state === "verified")).toBe(true);

    mock.files.delete(machineMaterializationHeadPath(projectId));
    const withoutProviderHead = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });
    expect([200, 202]).toContain(withoutProviderHead.status);
    const withoutProviderHeadBody = await withoutProviderHead.json<{ materialized: boolean; status: string }>();
    if (withoutProviderHeadBody.materialized) {
      expect(mock.files.has(machineMaterializationHeadPath(projectId))).toBe(true);
      expect(withoutProviderHeadBody.status).toBe("current");
    }
  });

  it("does not acknowledge a warm head when a current view has drifted at the provider", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3920";
    const slug = "repair-warm-drift";
    await createProject(projectId, slug, "TXN-MATISO-3920-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1], state: "retry_wait", next_attempt_at: at, code: "human_internal_failure"
    };
    saved.progress.requested = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);
    await mock.writeExternal(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`, "external drift after proof");

    let failedClosed = false;
    try {
      await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    } catch (error) {
      failedClosed = error instanceof Error && /current-view verification failed/i.test(error.message);
    }
    expect(failedClosed).toBe(true);

    const after = await journal.load();
    expect(after?.progress.obligations[human[0]]).toMatchObject({
      state: "retry_wait", code: "human_internal_failure", next_attempt_at: at
    });
    expect(after?.progress).toMatchObject({
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION },
      active: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
    expect(mock.files.get(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe("external drift after proof");
  });

  it("retires a covered blocked human obligation before rearming a newer canonical target", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3916";
    await createProject(projectId, "repair-covered-human", "TXN-MATISO-3916-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const persistence = createProductionPersistence(testEnv, projectId);
    const repository = new ProjectRepository(persistence, "v2");
    await repository.writeCommitRecord(commitFixture(projectId, 2)[1]!);
    const journal = new ConvergenceJournal(persistence, projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff" && obligation.target.revision === 1);
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "blocked",
      next_attempt_at: null,
      code: "identical_internal_failure_limit",
      failure_count: 6
    };
    const futureProjectionId = "c".repeat(64);
    saved.progress.obligations[futureProjectionId] = {
      ...human[1],
      id: futureProjectionId,
      target: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION + 1 },
      state: "blocked",
      next_attempt_at: null,
      code: "future_projection_not_materialized"
    };
    const olderFutureProjectionId = "d".repeat(64);
    saved.progress.obligations[olderFutureProjectionId] = {
      ...human[1],
      id: olderFutureProjectionId,
      target: { revision: 0, projection_version: CURRENT_PROJECTION_VERSION + 1 },
      state: "blocked",
      next_attempt_at: null,
      code: "older_future_projection_not_materialized"
    };
    saved.progress.canonical_observed_revision = 2;
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.requested = { revision: 2, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = null;
    await journal.save(saved.progress, saved.token);

    const recordPath = machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION);
    const originalRecord = mock.files.get(recordPath);
    expect(originalRecord).toBeDefined();
    if (!originalRecord) throw new Error("missing materialization record");
    const corruptRecord = JSON.parse(originalRecord) as Record<string, unknown>;
    corruptRecord.source_event_id = "EVT-999999";
    mock.files.set(recordPath, JSON.stringify(corruptRecord));
    await expect(guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" }))
      .rejects.toThrow("Materialization resume point canonical binding mismatch");
    expect((await journal.load())?.progress.obligations[human[0]].state).toBe("blocked");

    mock.files.set(recordPath, originalRecord);
    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const repaired = await journal.load();
    expect(repaired?.progress.obligations[human[0]]).toMatchObject({
      state: "verified",
      code: null,
      next_attempt_at: null,
      continuation: null
    });
    expect(repaired?.progress.obligations[futureProjectionId]).toMatchObject({
      state: "blocked",
      code: "future_projection_not_materialized"
    });
    expect(repaired?.progress.obligations[olderFutureProjectionId]).toMatchObject({
      state: "blocked",
      code: "older_future_projection_not_materialized"
    });
    expect(repaired?.progress.requested).toEqual({
      revision: 2,
      projection_version: CURRENT_PROJECTION_VERSION
    });
    expect(repaired?.progress.active?.revision).not.toBe(1);
  });

  it("requeues the current projection version even when an older obligation is still pending", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3915";
    await createProject(projectId, "repair-stale-generation", "TXN-MATISO-3915-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "retry_wait",
      next_attempt_at: at,
      code: "generation_or_head_not_current"
    };
    saved.progress.requested = null;
    saved.progress.active = null;
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);
    mock.files.delete(machineMaterializationHeadPath(projectId));

    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const repaired = await journal.load();
    expect(repaired?.progress.requested).toEqual({
      revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION
    });
  });

  it("reconciles and reports projection status from canonical machine state", async () => {
    installDropboxMock();
    const projectId = "PRJ-3907";
    const receipt = await createProject(projectId, "materialization-status", "TXN-MATISO-3907-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    const status = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("reports unverified convergence health instead of inferring it from the head", async () => {
    installDropboxMock();
    const projectId = "PRJ-3910";
    await createProject(projectId, "convergence-health", "TXN-MATISO-3910-CREATE");

    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/status",
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      convergence: {
        schema_version: "1.0",
        project_id: projectId,
        converged: false,
        layers: { human_handoff: { state: "unknown" } }
      }
    });
  });

  it("inspects a pending projection without scheduling or reconciling it", async () => {
    installDropboxMock();
    const projectId = "PRJ-3911";
    await createProject(projectId, "diagnostic-read-only", "TXN-MATISO-3911-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    const response = await guard.fetch(
      "https://materialization-guard.internal/diagnostic-status",
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      diagnostic: {
        read_only: true,
        final_verification_pending_count: 0,
        managed_zones_ready: false
      }
    });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("hands a committed canonical revision to MaterializationGuard automatically", async () => {
    installDropboxMock();
    const projectId = "PRJ-3909";
    const receipt = await createProject(projectId, "automatic-handoff", "TXN-MATISO-3909-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const status = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/status",
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("keeps projection hot state out of ProjectGuard", async () => {
    installDropboxMock();
    const projectId = "PRJ-3908";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "project-guard-canonical-only", "TXN-MATISO-3908-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const materializationTables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_%' ORDER BY name"
      ).toArray();
      expect(materializationTables).toEqual([]);
    });
  });

  it("does not let ProjectGuard own projection alarms", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3901";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "materialization-isolation", "TXN-MATISO-3901-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(projectGuard)).toBe(true);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(false);
  });
});
