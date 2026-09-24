import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import {
  machineCommitRecordPath, machineEventPath, machineManifestPath,
  machineMaterializationHeadPath, machineMaterializationRecordPath,
  machineReceiptPath, machineStatePath, workspaceProjectRoot, convergenceProgressPath
} from "../src/persistence/layout";
import { initialProgress } from "../src/convergence/journal";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { MaterializationGuard } from "../src/durable/materialization-guard";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("converges five active 200-output projects through alarm-only cadence commits without touching dormant projects", async () => {
  const environment = env as unknown as Env;
  const mock = installDropboxMock();
  const projectIds = Array.from({ length: 30 }, (_, index) => `PRJ-${8800 + index}`);
  const active = projectIds.slice(0, 5);
  const modes = JSON.stringify(Object.fromEntries(projectIds.map(id => [id, "repair"])));
  const guards = projectIds.map(id => environment.MATERIALIZATION_GUARD.getByName(id));
  const fixtureStart = Date.now() + 86_400_000;
  vi.setSystemTime(fixtureStart);

  let maximumSliceUse = 0;
  const trackedBudgets = new WeakMap<MaterializationGuard, Array<{ calls_left: number }>>();
  for (const methodName of ["coordinatorForSlice", "convergenceEngineForSlice"] as const) {
    const original = (MaterializationGuard.prototype as any)[methodName];
    vi.spyOn(MaterializationGuard.prototype as any, methodName).mockImplementation(function(
      this: MaterializationGuard, ...args: unknown[]
    ) {
      const value = original.apply(this, args);
      trackedBudgets.get(this)?.push(value.budget);
      return value;
    });
  }
  let alarmOnly = true;
  const originalAlarm = MaterializationGuard.prototype.alarm;
  vi.spyOn(MaterializationGuard.prototype, "alarm").mockImplementation(async function(
    this: MaterializationGuard, ...args: Parameters<typeof originalAlarm>
  ) {
    const budgets: Array<{ calls_left: number }> = [];
    trackedBudgets.set(this, budgets);
    try {
      await originalAlarm.apply(this, args);
    } finally {
      for (const budget of budgets) maximumSliceUse = Math.max(maximumSliceUse, 32 - budget.calls_left);
      trackedBudgets.delete(this);
    }
  });

  const latestInitialByProject = new Map<string, ReturnType<typeof commitFixture>[number]>();
  for (const projectId of projectIds) {
    const records = commitFixture(projectId, 193); // 8 global + 192 research outputs.
    for (const record of records) {
      mock.files.set(machineCommitRecordPath(projectId, record.new_revision), `${JSON.stringify(record, null, 2)}\n`);
      mock.files.set(machineEventPath(projectId, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`);
      mock.files.set(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`);
    }
    const latest = records.at(-1)!;
    latestInitialByProject.set(projectId, latest);
    const repository = new ProjectRepository(createProductionPersistence(environment, projectId), "v2");
    mock.files.set(machineStatePath(projectId), repository.canonicalDerivativeText("state", latest));
    mock.files.set(machineManifestPath(projectId), repository.canonicalDerivativeText("manifest", latest));
    const progress = initialProgress(projectId, new Date().toISOString(), `cadence-${projectId}`);
    progress.canonical_observed_revision = 193;
    progress.receipt_verified_through = 193;
    progress.event_verified_through = 193;
    mock.files.set(convergenceProgressPath(projectId), JSON.stringify(progress));
    await runInDurableObject(guards[projectIds.indexOf(projectId)]!, instance => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
  }

  const request = async (projectId: string, revision: number) => {
    const response = await guards[projectIds.indexOf(projectId)]!.fetch("https://materialization.internal/request-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(response.status).toBe(200);
  };
  const runUntilHeads = async (revision: number, maxRounds: number) => {
    for (let round = 0; round < maxRounds; round += 1) {
      let allCurrent = true;
      for (const projectId of active) {
        const raw = mock.files.get(machineMaterializationHeadPath(projectId));
        if (raw && JSON.parse(raw).target_revision === revision) continue;
        allCurrent = false;
        const guard = guards[projectIds.indexOf(projectId)]!;
        const dueAt = await runInDurableObject(guard, (_instance, state) => state.storage.getAlarm());
        expect(dueAt, `active project ${projectId} lost its durable continuation`).not.toBeNull();
        if (dueAt !== null) vi.setSystemTime(Math.max(Date.now(), dueAt));
        await runDurableObjectAlarm(guard);
      }
      if (allCurrent) return;
    }
    throw new Error(`alarm-only convergence did not reach revision ${revision}`);
  };

  for (const projectId of active) await request(projectId, 193);
  await runUntilHeads(193, 128);
  const baselineHeads = new Map(active.map(projectId => [
    projectId, JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId))!) as { target_revision: number }
  ]));

  // Each active project receives one committed output per virtual minute:
  // 1/minute/project is comfortably below the required 5/minute ceiling.
  // Existing typed operations affect one research entity per research.add;
  // this fixture therefore qualifies cadence and cumulative 20-output growth,
  // not a synthetic bulk-edit operation that the domain does not define.
  const finalRevision = 213;
  const commitTimes = new Map(active.map(projectId => [projectId, [] as number[]]));
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    vi.setSystemTime(fixtureStart + ordinal * 60_000);
    for (const projectId of active) {
      commitTimes.get(projectId)!.push(Date.now());
      const nextRevision = 193 + ordinal;
      const record = commitFixture(projectId, nextRevision).at(-1)!;
      mock.files.set(machineCommitRecordPath(projectId, nextRevision), `${JSON.stringify(record, null, 2)}\n`);
      mock.files.set(machineEventPath(projectId, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`);
      mock.files.set(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`);
      const repository = new ProjectRepository(createProductionPersistence(environment, projectId), "v2");
      mock.files.set(machineStatePath(projectId), repository.canonicalDerivativeText("state", record));
      mock.files.set(machineManifestPath(projectId), repository.canonicalDerivativeText("manifest", record));
      await request(projectId, nextRevision);
    }
    await runUntilHeads(193 + ordinal, 24);
  }

  // A request may start/restart a target, but actual projection progress above
  // was driven only by Durable Object alarms (never /materialize or direct run).
  alarmOnly &&= mock.calls.every(call => !call.includes("/materialize"));
  expect(baselineHeads.size).toBe(5);
  expect(alarmOnly).toBe(true);
  expect(maximumSliceUse).toBeLessThanOrEqual(32);
  for (const projectId of active) {
    const times = commitTimes.get(projectId)!;
    expect(times).toHaveLength(20);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(12_000);
    }
    const head = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId))!) as {
      target_revision: number; projection_version: number
    };
    expect(head).toMatchObject({ target_revision: finalRevision, projection_version: CURRENT_PROJECTION_VERSION });
    const chain: Array<{ parent: { target_revision: number; projection_version: number } | null;
      total_output_count: number; outputs: Record<string, { relative_path: string }>; removed_outputs: string[] }> = [];
    let generation: { target_revision: number; projection_version: number } | null = {
      target_revision: finalRevision, projection_version: CURRENT_PROJECTION_VERSION
    };
    while (generation !== null) {
      const record = JSON.parse(mock.files.get(machineMaterializationRecordPath(
        projectId, generation.target_revision, generation.projection_version
      ))!) as typeof chain[number];
      chain.push(record);
      generation = record.parent;
      expect(chain.length).toBeLessThanOrEqual(32);
    }
    const latest = chain[0]!;
    const outputs = new Map<string, { relative_path: string }>();
    for (const record of chain.reverse()) {
      for (const removed of record.removed_outputs) outputs.delete(removed);
      for (const [key, evidence] of Object.entries(record.outputs)) outputs.set(key, evidence);
    }
    expect(latest.total_output_count).toBe(220);
    expect(outputs.size).toBe(220);
    expect(new Set([...outputs.values()].map(evidence => evidence.relative_path)).size).toBe(220);
    const slug = latestInitialByProject.get(projectId)!.state.slug;
    const projectedPaths = [...mock.files.keys()].filter(path => path.startsWith(`${workspaceProjectRoot(projectId, slug)}/`));
    expect(new Set(projectedPaths).size).toBe(projectedPaths.length);
  }
  for (const projectId of projectIds.slice(5)) {
    expect(mock.files.has(machineMaterializationHeadPath(projectId))).toBe(false);
    expect(await runInDurableObject(guards[projectIds.indexOf(projectId)]!, (_instance, state) => state.storage.getAlarm())).toBeNull();
  }
}, 120_000);
