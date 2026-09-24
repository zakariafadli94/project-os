import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { createSliceBudget } from "../src/convergence/budget";
import { initialProgress } from "../src/convergence/journal";
import { MaterializationCoordinator } from "../src/materialization/coordinator";
import { MaterializationLedger } from "../src/materialization/ledger";
import { WorkspaceProjectionWriter } from "../src/materialization/writer";
import {
  convergenceProgressPath,
  machineCommitRecordPath,
  machineEventPath,
  machineManifestPath,
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  machineReceiptPath,
  machineStatePath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("rebuilds a real rich PV5 baseline at PV6 after a typed research.add using alarms only", async () => {
  const environment = env as unknown as Env;
  const projectId = "PRJ-8920";
  const mock = installDropboxMock();
  vi.setSystemTime(new Date(Date.now() + 86_400_000));
  const guard = environment.MATERIALIZATION_GUARD.getByName(projectId);
  const modes = JSON.stringify({ [projectId]: "repair" });
  await runInDurableObject(guard, instance => {
    (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
  });

  // Model the already-published v5 generation from the previous release.
  // This is a one-shot migration fixture, not steady-state commit throughput.
  const records = commitFixture(projectId, 193); // Eight globals + 192 research outputs.
  for (const record of records) {
    mock.files.set(machineCommitRecordPath(projectId, record.new_revision), `${JSON.stringify(record, null, 2)}\n`);
    mock.files.set(machineEventPath(projectId, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`);
    mock.files.set(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`);
  }
  const baseline = records.at(-1)!;
  const basePersistence = createProductionPersistence(environment, projectId);
  const baseRepository = new ProjectRepository(basePersistence, "v2");
  mock.files.set(machineStatePath(projectId), baseRepository.canonicalDerivativeText("state", baseline));
  mock.files.set(machineManifestPath(projectId), baseRepository.canonicalDerivativeText("manifest", baseline));
  const progress = initialProgress(projectId, new Date().toISOString(), `migration-${projectId}`);
  progress.canonical_observed_revision = baseline.new_revision;
  progress.receipt_verified_through = baseline.new_revision;
  progress.event_verified_through = baseline.new_revision;
  mock.files.set(convergenceProgressPath(projectId), JSON.stringify(progress));

  let baselineCalls = 0;
  await runInDurableObject(guard, async (_instance, state) => {
    const ledger = new MaterializationLedger(state.storage);
    ledger.requestTarget({ revision: baseline.new_revision, projection_version: 5 });
    for (let slice = 0; slice < 64; slice += 1) {
      const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
      const runtime = createProductionPersistence(environment, projectId);
      const repository = new ProjectRepository(runtime, "v2");
      const coordinator = new MaterializationCoordinator({
        projectId,
        repository,
        ledger,
        writer: new WorkspaceProjectionWriter(runtime, 4),
        projectionVersion: 5,
        sliceBudget: budget
      });
      const before = mock.providerCalls.length;
      const result = await coordinator.runNext();
      const used = 32 - budget.calls_left;
      expect(used).toBeLessThanOrEqual(32);
      baselineCalls += mock.providerCalls.length - before;
      if (result.completed || !result.more_work) return;
    }
    throw new Error("pv5_baseline_did_not_complete");
  });
  expect(baselineCalls).toBeGreaterThan(0);

  const baselineHead = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "null") as {
    target_revision: number; projection_version: number
  } | null;
  expect(baselineHead).toMatchObject({ target_revision: 193, projection_version: 5 });
  const oldGeneration = JSON.parse(mock.files.get(machineMaterializationRecordPath(projectId, 193, 5)) ?? "null") as {
    total_output_count: number; outputs: Record<string, unknown>
  } | null;
  expect(oldGeneration?.total_output_count).toBe(200);
  expect(Object.keys(oldGeneration?.outputs ?? {})).toHaveLength(200);

  // Construct the next canonical revision with the real typed parser and
  // transition; only the fixture persistence boundary is seeded directly.
  const nextRecord = commitFixture(projectId, 194).at(-1)!;
  expect(nextRecord.transaction.operation).toBe("research.add");
  expect(nextRecord.previous_revision).toBe(193);
  expect(nextRecord.new_revision).toBe(194);
  mock.files.set(machineCommitRecordPath(projectId, 194), `${JSON.stringify(nextRecord, null, 2)}\n`);
  mock.files.set(machineEventPath(projectId, nextRecord.event.event_id), `${JSON.stringify(nextRecord.event, null, 2)}\n`);
  mock.files.set(machineReceiptPath(nextRecord.transaction.transaction_id), `${JSON.stringify(nextRecord.receipt, null, 2)}\n`);
  const nextRepository = new ProjectRepository(createProductionPersistence(environment, projectId), "v2");
  mock.files.set(machineStatePath(projectId), nextRepository.canonicalDerivativeText("state", nextRecord));
  mock.files.set(machineManifestPath(projectId), nextRepository.canonicalDerivativeText("manifest", nextRecord));

  let maximumSliceUse = 0;
  const tracked = new WeakMap<MaterializationGuard, Array<{ calls_left: number }>>();
  for (const methodName of ["coordinatorForSlice", "convergenceEngineForSlice"] as const) {
    const original = (MaterializationGuard.prototype as any)[methodName];
    vi.spyOn(MaterializationGuard.prototype as any, methodName).mockImplementation(function(
      this: MaterializationGuard, ...args: unknown[]
    ) {
      const value = original.apply(this, args);
      tracked.get(this)?.push(value.budget);
      return value;
    });
  }
  const originalAlarm = MaterializationGuard.prototype.alarm;
  const originalFetch = MaterializationGuard.prototype.fetch;
  vi.spyOn(MaterializationGuard.prototype, "fetch").mockImplementation(async function(
    this: MaterializationGuard, ...args: Parameters<typeof originalFetch>
  ) {
    const budgets: Array<{ calls_left: number }> = [];
    tracked.set(this, budgets);
    try {
      return await originalFetch.apply(this, args);
    } finally {
      for (const budget of budgets) maximumSliceUse = Math.max(maximumSliceUse, 32 - budget.calls_left);
      tracked.delete(this);
    }
  });
  vi.spyOn(MaterializationGuard.prototype, "alarm").mockImplementation(async function(
    this: MaterializationGuard, ...args: Parameters<typeof originalAlarm>
  ) {
    const budgets: Array<{ calls_left: number }> = [];
    tracked.set(this, budgets);
    try {
      await originalAlarm.apply(this, args);
    } finally {
      for (const budget of budgets) maximumSliceUse = Math.max(maximumSliceUse, 32 - budget.calls_left);
      tracked.delete(this);
    }
  });

  // One request opens the work. From this point forward only durable alarms
  // may advance the reconstruction or publish the new head.
  const accepted = await guard.fetch("https://materialization.internal/request-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, revision: 194, projection_version: CURRENT_PROJECTION_VERSION })
  });
  expect(accepted.status).toBe(200);

  let reached = false;
  for (let wake = 0; wake < 128; wake += 1) {
    const currentHead = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "null") as {
      target_revision: number; projection_version: number
    } | null;
    if (currentHead?.target_revision === 194 && currentHead.projection_version === CURRENT_PROJECTION_VERSION) {
      reached = true;
      break;
    }
    const dueAt = await runInDurableObject(guard, (_instance, state) => state.storage.getAlarm());
    expect(dueAt, "migration lost its durable alarm continuation").not.toBeNull();
    if (dueAt !== null) vi.setSystemTime(Math.max(Date.now(), dueAt));
    await runDurableObjectAlarm(guard);
  }
  expect(reached).toBe(true);
  expect(maximumSliceUse).toBeLessThanOrEqual(32);

  const latest = JSON.parse(mock.files.get(machineMaterializationRecordPath(
    projectId, 194, CURRENT_PROJECTION_VERSION
  )) ?? "null") as {
    target_revision: number;
    projection_version: number;
    total_output_count: number;
    outputs: Record<string, { relative_path: string }>;
    removed_outputs: string[];
  } | null;
  expect(latest).toMatchObject({ target_revision: 194, projection_version: CURRENT_PROJECTION_VERSION });
  expect(Object.keys(latest?.outputs ?? {}).length).toBeGreaterThanOrEqual(20);
  expect(latest?.total_output_count).toBe(201);

  const outputPaths = new Set<string>();
  const current = new Map<string, { relative_path: string }>();
  for (const [key, evidence] of Object.entries(oldGeneration?.outputs ?? {})) {
    current.set(key, evidence as { relative_path: string });
  }
  for (const removed of latest?.removed_outputs ?? []) current.delete(removed);
  for (const [key, evidence] of Object.entries(latest?.outputs ?? {})) current.set(key, evidence);
  for (const evidence of current.values()) outputPaths.add(evidence.relative_path);
  expect(current.size).toBe(201);
  expect(outputPaths.size).toBe(201);
  const slug = baseline.state.slug;
  const projectedPaths = [...mock.files.keys()].filter(path => path.startsWith(`${workspaceProjectRoot(projectId, slug)}/`));
  expect(new Set(projectedPaths).size).toBe(projectedPaths.length);
}, 120_000);
