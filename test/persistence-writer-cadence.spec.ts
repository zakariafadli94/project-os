import { describe, expect, it } from "vitest";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { createSliceBudget } from "../src/convergence/budget";
import type { SliceBudget } from "../src/convergence/contract";
import { sha256Text } from "../src/materialization/hash";
import type { PlannedProjectionOutput, ProjectionPlan } from "../src/materialization/planner";
import { WorkspaceProjectionWriter } from "../src/materialization/writer";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { MANAGED_NOTICE } from "../src/render/shared";

const PROJECT_COUNT = 30;
const ACTIVE_PROJECT_COUNT = 5;
const OUTPUTS_PER_PROJECT = 200;
const CHANGED_PER_PLAN = 20;
const PLANS_PER_PROJECT = 5;
const PLAN_INTERVAL_MS = 12_000;
const PROVIDER_LATENCY_MS = 100;
const MAX_SLICE_PROVIDER_CALLS = 32;

type StressOutput = PlannedProjectionOutput & { expected_revision: number };

class TimedObjects implements ObjectPersistence {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  calls = 0;
  now: number;
  budget: SliceBudget | null = null;

  constructor(now: number) {
    this.now = now;
  }

  private beforeHttp(): void {
    this.budget?.beforeHttp();
    this.calls += 1;
    this.now += PROVIDER_LATENCY_MS;
  }

  async readText(path: string): Promise<string | null> {
    this.beforeHttp();
    return this.files.get(path) ?? null;
  }

  async createText(path: string, content: string): Promise<void> {
    this.beforeHttp();
    if (this.files.has(path)) throw new Error(`unexpected create collision: ${path}`);
    this.files.set(path, content);
    this.writes.push(path);
  }

  async upsertText(path: string, content: string): Promise<void> {
    this.beforeHttp();
    this.files.set(path, content);
    this.writes.push(path);
  }

  async getMetadata(path: string): Promise<ProviderObjectMetadata | null> {
    const content = this.files.get(path);
    return content === undefined ? null : {
      path,
      size: new TextEncoder().encode(content).byteLength,
      objectId: `stress:${path}`,
      revisionToken: await sha256Text(content)
    };
  }

  async listChildren(_path: string): Promise<ProviderEntry[]> { return []; }
  async move(_from: string, _to: string): Promise<void> { throw new Error("unexpected move"); }
  async delete(path: string): Promise<void> { this.files.delete(path); }
}

async function baselineOutput(index: number): Promise<StressOutput> {
  const key = `research:RES-WRITER-STRESS-${index.toString().padStart(3, "0")}`;
  const relative_path = `RESEARCH/RES-WRITER-STRESS-${index.toString().padStart(3, "0")}.md`;
  const content = `${MANAGED_NOTICE}\nsynthetic baseline output ${index}\n`;
  return {
    key,
    relative_path,
    input_hash: await sha256Text(`synthetic-input:${key}:0`),
    content_hash: await sha256Text(content),
    source_revision: 0,
    content,
    critical: false,
    expected_revision: 0
  };
}

function evidence(output: StressOutput): ProjectionOutputEvidence {
  return {
    relative_path: output.relative_path,
    input_hash: output.input_hash,
    content_hash: output.content_hash,
    source_revision: output.source_revision
  };
}

async function stressPlan(
  projectId: string,
  revision: number,
  outputs: readonly StressOutput[]
): Promise<{ plan: ProjectionPlan; changed: StressOutput[] }> {
  const start = (revision - 1) * CHANGED_PER_PLAN;
  const changed = await Promise.all(outputs.slice(start, start + CHANGED_PER_PLAN).map(async (prior) => {
    const content = `${MANAGED_NOTICE}\nsynthetic writer stress output ${prior.key} revision ${revision}\n`;
    return {
      ...prior,
      baseline: evidence(prior),
      input_hash: await sha256Text(`synthetic-input:${prior.key}:${revision}`),
      content_hash: await sha256Text(content),
      source_revision: revision,
      content,
      expected_revision: revision
    };
  }));
  const changedKeys = new Set(changed.map((output) => output.key));
  const carried = outputs.filter((output) => !changedKeys.has(output.key));
  return {
    changed,
    plan: {
      project_id: projectId,
      target_revision: revision,
      projection_version: CURRENT_PROJECTION_VERSION,
      source_transaction_id: `SYNTHETIC-WRITER-STRESS-${projectId}-${revision}`,
      source_event_id: `SYNTHETIC-WRITER-STRESS-EVENT-${projectId}-${revision}`,
      changed_outputs: new Map(changed.map((output) => [output.key, output])),
      carried_forward: new Map(carried.map((output) => [output.key, evidence(output)])),
      removed_outputs: [],
      expected_output_keys: outputs.map((output) => output.key)
    }
  };
}

describe("synthetic writer cadence capacity (not a business transaction qualification)", () => {
  it("processes five 20-output plans per minute for five of thirty projects without duplicate writes", async () => {
    const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `PRJ-${8900 + index}`);
    const activeProjects = projectIds.slice(0, ACTIVE_PROJECT_COUNT);
    const fixtureStart = 1_800_000_000_000;
    const outputIndices = Array.from({ length: OUTPUTS_PER_PROJECT }, (_, index) => index);
    const baseline = await Promise.all(outputIndices.map(baselineOutput));
    const adapters = new Map(activeProjects.map((projectId) => [projectId, new TimedObjects(fixtureStart)]));
    const writers = new Map(activeProjects.map((projectId) => [projectId, new WorkspaceProjectionWriter(adapters.get(projectId)!, 1)]));
    const latestByProject = new Map(activeProjects.map((projectId) => [projectId, [...baseline]]));
    const completedWritesByProject = new Map(activeProjects.map((projectId) => [projectId, [] as string[]]));
    let wakes = 0;
    let maximumSliceCalls = 0;

    for (const projectId of activeProjects) {
      const objects = adapters.get(projectId)!;
      for (const output of baseline) objects.files.set(`/stress/${output.relative_path}`, output.content);
      expect(objects.files.size).toBe(OUTPUTS_PER_PROJECT);
    }

    for (let revision = 1; revision <= PLANS_PER_PROJECT; revision += 1) {
      for (const projectId of activeProjects) {
        const objects = adapters.get(projectId)!;
        const writer = writers.get(projectId)!;
        const priorOutputs = latestByProject.get(projectId)!;
        const { plan, changed } = await stressPlan(projectId, revision, priorOutputs);
        expect(plan.changed_outputs.size).toBe(20);
        expect(plan.carried_forward.size).toBe(180);
        const arrivalAt = fixtureStart + (revision - 1) * PLAN_INTERVAL_MS;
        objects.now = Math.max(objects.now, arrivalAt);
        const checkpoint = new Map<string, ProjectionOutputEvidence>();
        let nextKey: string | null = "start";
        const planStartCalls = objects.calls;
        const planStartWakes = wakes;

        while (nextKey !== null) {
          const budget = createSliceBudget(() => objects.now, new AbortController().signal);
          const callsBeforeWake = objects.calls;
          objects.budget = budget;
          let result: Awaited<ReturnType<typeof writer.materializeSlice>>;
          try {
            result = await writer.materializeSlice(plan, {
              workspaceRoot: "/stress",
              alreadyVerified: checkpoint,
              onOutputVerified: (key, outputEvidence) => { checkpoint.set(key, outputEvidence); }
            }, budget);
          } finally {
            objects.budget = null;
          }
          const sliceCalls = objects.calls - callsBeforeWake;
          const budgetCalls = MAX_SLICE_PROVIDER_CALLS - budget.calls_left;
          expect(sliceCalls).toBe(budgetCalls);
          expect(budgetCalls).toBeLessThanOrEqual(MAX_SLICE_PROVIDER_CALLS);
          expect(budget.calls_left).toBeGreaterThanOrEqual(4);
          maximumSliceCalls = Math.max(maximumSliceCalls, budgetCalls);
          nextKey = result.nextKey;
          wakes += 1;
        }

        expect(wakes - planStartWakes).toBe(2);
        expect(objects.calls - planStartCalls).toBe(40);
        expect(objects.now - arrivalAt).toBe(4_000);
        expect(objects.now - arrivalAt).toBeLessThanOrEqual(PLAN_INTERVAL_MS);
        expect(checkpoint.size).toBe(CHANGED_PER_PLAN);

        const updated = new Map(priorOutputs.map((output) => [output.key, output]));
        for (const output of changed) {
          expect(checkpoint.get(output.key)).toEqual(evidence(output));
          updated.set(output.key, output);
          completedWritesByProject.get(projectId)!.push(output.relative_path);
        }
        latestByProject.set(projectId, [...updated.values()]);
        expect(updated.size).toBe(OUTPUTS_PER_PROJECT);
        expect(plan.expected_output_keys).toHaveLength(OUTPUTS_PER_PROJECT);
      }
    }

    expect(maximumSliceCalls).toBeLessThanOrEqual(MAX_SLICE_PROVIDER_CALLS);
    expect(wakes).toBe(50);
    for (const projectId of activeProjects) {
      const objects = adapters.get(projectId)!;
      const writes = completedWritesByProject.get(projectId)!;
      expect(writes).toHaveLength(100);
      expect(new Set(writes).size).toBe(100);
      expect(objects.writes).toEqual(writes.map((path) => `/stress/${path}`));
      expect(objects.files.size).toBe(OUTPUTS_PER_PROJECT);
      expect(latestByProject.get(projectId)).toHaveLength(OUTPUTS_PER_PROJECT);
    }
    expect(adapters.size).toBe(5);
    expect(projectIds.slice(ACTIVE_PROJECT_COUNT)).toHaveLength(25);
  });
});
