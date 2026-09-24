import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { convergenceProgressPath, machineEventPath, machineManifestPath, machineMaterializationHeadPath, machineReceiptPath, machineStatePath, workspaceProjectRoot } from "../src/persistence/layout";
import { initialProgress } from "../src/convergence/journal";
import { commitFixture, seedCommits } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import { ProjectGuard } from "../src/durable/project-guard-neutral";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("advances five active projects in a thirty-project fixture by durable alarms only", async () => {
  const environment = env as unknown as Env;
  const mock = installDropboxMock();
  vi.setSystemTime(new Date(Date.now() + 86_400_000));
  const projectIds = Array.from({ length: 30 }, (_, index) => `PRJ-${8500 + index}`);
  const modes = JSON.stringify(Object.fromEntries(projectIds.map(id => [id, "repair"])));
  const guards = projectIds.map(id => environment.MATERIALIZATION_GUARD.getByName(id));
  const alarmInvocations = new Map<string, number>();
  let maxProviderCallsPerAlarm = 0;
  let maxSliceBudgetUsage = 0;
  let maxProjectGuardFinalizationBudgetUsage = 0;
  const activeSliceBudgets = new WeakMap<MaterializationGuard, Array<{ calls_left: number }>>();
  const coordinatorForSlice = (MaterializationGuard.prototype as any).coordinatorForSlice;
  vi.spyOn(MaterializationGuard.prototype as any, "coordinatorForSlice").mockImplementation(function(
    this: MaterializationGuard,
    ...args: unknown[]
  ) {
    const value = coordinatorForSlice.apply(this, args);
    activeSliceBudgets.get(this)?.push(value.budget);
    return value;
  });
  const convergenceEngineForSlice = (MaterializationGuard.prototype as any).convergenceEngineForSlice;
  vi.spyOn(MaterializationGuard.prototype as any, "convergenceEngineForSlice").mockImplementation(function(
    this: MaterializationGuard,
    ...args: unknown[]
  ) {
    const value = convergenceEngineForSlice.apply(this, args);
    activeSliceBudgets.get(this)?.push(value.budget);
    return value;
  });
  const finalizeCurrentMaterializationSlice = (ProjectGuard.prototype as any).finalizeCurrentMaterializationSlice;
  vi.spyOn(ProjectGuard.prototype as any, "finalizeCurrentMaterializationSlice").mockImplementation(async function(
    this: ProjectGuard,
    ...args: unknown[]
  ) {
    const budget = args[4] as { calls: number };
    try {
      return await finalizeCurrentMaterializationSlice.apply(this, args);
    } finally {
      maxProjectGuardFinalizationBudgetUsage = Math.max(maxProjectGuardFinalizationBudgetUsage, budget.calls);
    }
  });
  const alarm = MaterializationGuard.prototype.alarm;
  vi.spyOn(MaterializationGuard.prototype, "alarm").mockImplementation(async function(
    this: MaterializationGuard,
    ...args: Parameters<typeof alarm>
  ) {
    const before = mock.providerCalls.length;
    const projectId = (this as unknown as { projectId: string }).projectId;
    const budgets: Array<{ calls_left: number }> = [];
    activeSliceBudgets.set(this, budgets);
    alarmInvocations.set(projectId, (alarmInvocations.get(projectId) ?? 0) + 1);
    try {
      await alarm.apply(this, args);
    } finally {
      maxProviderCallsPerAlarm = Math.max(maxProviderCallsPerAlarm, mock.providerCalls.length - before);
      for (const budget of budgets) maxSliceBudgetUsage = Math.max(maxSliceBudgetUsage, 32 - budget.calls_left);
      activeSliceBudgets.delete(this);
    }
  });
  const targetRevision = 193; // Eight global outputs plus 192 research outputs.
  for (let index = 0; index < projectIds.length; index += 1) {
    const id = projectIds[index]!;
    const records = commitFixture(id, targetRevision);
    seedCommits(mock, records);
    const repository = new ProjectRepository(createProductionPersistence(environment, id), "v2");
    for (const record of records) {
      mock.files.set(machineEventPath(id, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`);
      mock.files.set(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`);
    }
    const latest = records.at(-1)!;
    mock.files.set(machineStatePath(id), repository.canonicalDerivativeText("state", latest));
    mock.files.set(machineManifestPath(id), repository.canonicalDerivativeText("manifest", latest));
    // This workload starts after historical machine convergence, measuring a
    // 200-output projection, not 193 previously unprocessed business commits.
    const progress = initialProgress(id, new Date().toISOString(), `fixture-${id}`);
    progress.canonical_observed_revision = targetRevision;
    progress.receipt_verified_through = targetRevision;
    progress.event_verified_through = targetRevision;
    mock.files.set(convergenceProgressPath(id), JSON.stringify(progress));
    await runInDurableObject(guards[index]!, instance => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
  }
  for (let index = 0; index < 5; index += 1) {
    expect((await guards[index]!.fetch("https://materialization.internal/request-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectIds[index], revision: targetRevision, projection_version: CURRENT_PROJECTION_VERSION })
    })).status).toBe(200);
  }
  const completed = new Set<number>();
  const wakes = Array(5).fill(0) as number[];
  const firstProjectSlices: Array<{ round: number; ledger: unknown; calls: Array<{ endpoint: string; paths: string[] }> }> = [];
  const finalProjectSlices: Array<{ round: number; ledger: unknown; calls: Array<{ endpoint: string; paths: string[] }> }> = [];
  for (let round = 0; round < 128 && completed.size < 5; round += 1) {
    for (let index = 0; index < 5; index += 1) {
      if (completed.has(index)) continue;
      const dueAt = await runInDurableObject(guards[index]!, (_instance, state) => state.storage.getAlarm());
      const id = projectIds[index]!;
      const priorInvocations = alarmInvocations.get(id) ?? 0;
      const before = mock.providerCalls.length;
      if (dueAt !== null) vi.setSystemTime(Math.max(Date.now(), dueAt));
      const ran = await runDurableObjectAlarm(guards[index]!);
      const invocations = alarmInvocations.get(id) ?? 0;
      expect(ran || invocations > priorInvocations,
        `project ${id} had no observed alarm invocation at round ${round}; dueAt=${dueAt}`).toBe(true);
      wakes[index] = invocations;
      if (index === 0) {
        const ledger = await runInDurableObject(guards[index]!, instance => {
          const value = instance as unknown as { ledger: { status(): unknown; finalVerificationPending(): unknown[] } };
          return { status: value.ledger.status(), pending: value.ledger.finalVerificationPending().length };
        });
        const observation = { round, ledger, calls: mock.providerCalls.slice(before).map(call => ({
          endpoint: call.endpoint,
          paths: call.paths.slice(0, 3)
        })) };
        if (firstProjectSlices.length < 3) firstProjectSlices.push(observation);
        if ((ledger as { pending: number; status: { active_status?: string; attempt_output_count?: number } }).pending > 0
          || (ledger as { status: { active_status?: string } }).status.active_status === "verifying"
          || ((ledger as { status: { attempt_output_count?: number } }).status.attempt_output_count ?? 0) >= 195) {
          finalProjectSlices.push(observation);
          if (finalProjectSlices.length > 8) finalProjectSlices.shift();
        }
      }
      const raw = mock.files.get(machineMaterializationHeadPath(projectIds[index]!));
      if (raw && JSON.parse(raw).target_revision === targetRevision) completed.add(index);
    }
  }
  const progress = [...mock.files].filter(([path]) => path.includes(projectIds[0]!) && path.endsWith("progress.json"))
    .map(([path, raw]) => { const value = JSON.parse(raw); return { path, observed: value.canonical_observed_revision,
      active: value.active, requested: value.requested, pending: Object.values(value.obligations)
        .filter((item: any) => item.state !== "verified").map((item: any) => ({ layer: item.layer, code: item.code, target: item.target })) }; });
  const status = await (await guards[0]!.fetch("https://materialization.internal/diagnostic-status")).json();
  expect(maxSliceBudgetUsage, `a Durable Object slice consumed more than 32 calls: max=${maxSliceBudgetUsage}`).toBeLessThanOrEqual(32);
  expect(maxProjectGuardFinalizationBudgetUsage, `a ProjectGuard finalization slice consumed more than 32 calls: max=${maxProjectGuardFinalizationBudgetUsage}`).toBeLessThanOrEqual(32);
  expect(completed.size, `completed=${[...completed]}, wakes=${wakes}, max aggregate calls/alarm=${maxProviderCallsPerAlarm}, max slice budget usage=${maxSliceBudgetUsage}, progress=${JSON.stringify(progress)}, ledger=${JSON.stringify(status)}, first_slices=${JSON.stringify(firstProjectSlices)}, final_slices=${JSON.stringify(finalProjectSlices)}`).toBe(5);
  for (let index = 5; index < 30; index += 1) {
    expect(await runInDurableObject(guards[index]!, (_instance, state) => state.storage.getAlarm())).toBeNull();
  }
  console.info("persistence_workload_fixture", JSON.stringify({ projects: 30, active: 5, outputs: 200, wakes, maxAggregateProviderCallsPerAlarm: maxProviderCallsPerAlarm, maxMaterializationGuardSliceBudgetUsage: maxSliceBudgetUsage, maxProjectGuardFinalizationBudgetUsage }));
}, 120_000);

it("recovers five 20-output projects after a single 30-second provider outage under simulated 100ms latency", async () => {
  const environment = env as unknown as Env;
  const projectIds = Array.from({ length: 5 }, (_, index) => `PRJ-${8600 + index}`);
  const delayedProject = projectIds[0]!;
  const delayedHeadRecord = commitFixture(delayedProject, 13).at(-1)!;
  const delayedHandoffPath = `${workspaceProjectRoot(delayedProject, delayedHeadRecord.state.slug)}/HANDOFF.md`;
  const mock = installDropboxMock({ faults: [{
    endpoint: "/2/files/upload",
    path: delayedHandoffPath,
    occurrence: 1,
    status: 503,
    error_summary: "injected/thirty_second_project_outage",
    responseHeaders: { "Retry-After": "30" }
  }] });
  const fixtureStart = Date.now() + 86_400_000;
  vi.setSystemTime(fixtureStart);
  const modes = JSON.stringify(Object.fromEntries(projectIds.map(id => [id, "repair"])));
  const guards = projectIds.map(id => environment.MATERIALIZATION_GUARD.getByName(id));
  for (let index = 0; index < projectIds.length; index += 1) {
    const id = projectIds[index]!;
    const records = commitFixture(id, 13); // 8 global outputs plus 12 research outputs.
    seedCommits(mock, records);
    const repository = new ProjectRepository(createProductionPersistence(environment, id), "v2");
    for (const record of records) {
      mock.files.set(machineEventPath(id, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`);
      mock.files.set(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`);
    }
    const latest = records.at(-1)!;
    mock.files.set(machineStatePath(id), repository.canonicalDerivativeText("state", latest));
    mock.files.set(machineManifestPath(id), repository.canonicalDerivativeText("manifest", latest));
    const progress = initialProgress(id, new Date().toISOString(), `fixture-${id}`);
    progress.canonical_observed_revision = 13;
    progress.receipt_verified_through = 13;
    progress.event_verified_through = 13;
    mock.files.set(convergenceProgressPath(id), JSON.stringify(progress));
    await runInDurableObject(guards[index]!, instance => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
  }
  for (let index = 0; index < projectIds.length; index += 1) {
    expect((await guards[index]!.fetch("https://materialization.internal/request-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectIds[index], revision: 13, projection_version: CURRENT_PROJECTION_VERSION })
    })).status).toBe(200);
  }

  let outageResponses = 0;
  let simulatedProviderCalls = 0;
  const providerFetch = mock.spy.getMockImplementation();
  expect(providerFetch).toBeDefined();
  mock.spy.mockImplementation(async (input, init) => {
    simulatedProviderCalls += 1;
    vi.setSystemTime(Date.now() + 100); // deterministic 100ms/provider-call virtual latency
    const response = await providerFetch!(input, init);
    if (response.status === 503) outageResponses += 1;
    return response;
  });
  const completed = new Set<number>();
  let outageRetryDelayMs = 0;
  let firstOutageSnapshot: unknown = null;
  for (let round = 0; round < 128 && completed.size < projectIds.length; round += 1) {
    for (let index = 0; index < projectIds.length; index += 1) {
      if (completed.has(index)) continue;
      const guard = guards[index]!;
      const dueAt = await runInDurableObject(guard, (_instance, state) => state.storage.getAlarm());
      if (dueAt !== null) vi.setSystemTime(Math.max(Date.now(), dueAt));
      const priorOutageResponses = outageResponses;
      await runDurableObjectAlarm(guard);
      if (firstOutageSnapshot === null && outageResponses > priorOutageResponses) {
        const retryAt = await runInDurableObject(guard, (_instance, state) => state.storage.getAlarm());
        if (retryAt !== null) outageRetryDelayMs = retryAt - Date.now();
        firstOutageSnapshot = {
          project_id: projectIds[index],
          round,
          dueAt,
          retryAt,
          now: Date.now(),
          progress: mock.files.get(convergenceProgressPath(delayedProject))
        };
      }
      const raw = mock.files.get(machineMaterializationHeadPath(projectIds[index]!));
      if (raw && JSON.parse(raw).target_revision === 13) completed.add(index);
    }
  }
  const virtualElapsedMs = Date.now() - fixtureStart;
  expect(outageResponses).toBe(1);
  expect(outageRetryDelayMs, JSON.stringify(firstOutageSnapshot)).toBeGreaterThanOrEqual(29_000);
  expect(completed.size).toBe(5);
  expect(virtualElapsedMs).toBeGreaterThanOrEqual(30_000);
  console.info("persistence_fault_profile", JSON.stringify({ projects: 5, projectionOutputsPerProject: 20, seededCommitsPerProject: 13, providerLatencyMs: 100, simulatedProviderCalls, outageMs: 30_000, outageResponses, outageRetryDelayMs, completed: completed.size, virtualElapsedMs }));
}, 120_000);
