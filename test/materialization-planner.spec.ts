import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import type { ProjectState } from "../src/domain/project-state";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction, type Transaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { sha256Canonical } from "../src/materialization/hash";
import {
  planProjection,
  type ProjectionBaseline,
  type ProjectionPlan
} from "../src/materialization/planner";

const at = "2026-08-24T17:05:00+01:00";
let txSequence = 0;

function commit(
  state: ProjectState,
  operation: Transaction["operation"],
  payload: Record<string, unknown>
): CanonicalCommitRecord {
  txSequence += 1;
  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: `TXN-MATERIAL-PLANNER-${txSequence.toString().padStart(4, "0")}`,
    project_id: state.project_id,
    base_revision: state.revision,
    operation,
    created_at: at,
    payload
  });
  const result = applyTransaction(state, transaction);
  if (result.kind !== "commit") throw new Error(`fixture transition failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: state.revision,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: state.project_id,
    previous_revision: state.revision,
    new_revision: result.state.revision,
    transaction,
    state: result.state,
    event: result.event,
    receipt
  };
}

function fixture(): { record: CanonicalCommitRecord; taskId: string; decisionId: string; researchId: string; deliverableId: string } {
  txSequence = 0;
  let state = emptyProjectState("PRJ-3201", "Projection Fixture", "projection-fixture", "Test projection semantics");

  let record = commit(state, "plan.phase.create", {
    phase_id: "PHASE-PLAN3201",
    title: "Operate",
    objective: "Run the project"
  });
  state = record.state;

  record = commit(state, "constraint.add", {
    constraint_id: "CON-PLAN3201",
    title: "Keep durable truth",
    description: "Canonical commits remain authoritative"
  });
  state = record.state;

  record = commit(state, "task.create", {
    task_id: "TASK-PLAN3201",
    title: "Exercise projection",
    description: "Change only relevant views",
    phase_id: "PHASE-PLAN3201"
  });
  state = record.state;

  record = commit(state, "decision.accept", {
    decision_id: "DEC-PLAN3201",
    title: "Use incremental projection",
    decision: "Project only changed semantic outputs",
    reason: "Reduce network writes",
    impacts: ["workspace"]
  });
  state = record.state;

  record = commit(state, "research.add", {
    research_id: "RES-PLAN3201",
    title: "Projection research",
    body: "Materialized views should be reconstructible",
    source: "fixture"
  });
  state = record.state;

  record = commit(state, "deliverable.create", {
    deliverable_id: "DEL-PLAN3201",
    title: "Projection engine",
    version: "v1",
    description: "Initial projection engine",
    phase_id: "PHASE-PLAN3201",
    decision_ids: ["DEC-PLAN3201"]
  });

  return {
    record,
    taskId: "TASK-PLAN3201",
    decisionId: "DEC-PLAN3201",
    researchId: "RES-PLAN3201",
    deliverableId: "DEL-PLAN3201"
  };
}

function baselineFrom(plan: ProjectionPlan): ProjectionBaseline {
  const outputs = new Map<string, ProjectionOutputEvidence>();
  for (const [key, output] of plan.changed_outputs) {
    outputs.set(key, {
      relative_path: output.relative_path,
      input_hash: output.input_hash,
      content_hash: output.content_hash,
      source_revision: output.source_revision
    });
  }
  for (const [key, evidence] of plan.carried_forward) outputs.set(key, evidence);
  return { projection_version: plan.projection_version, outputs };
}

describe("projection hashing and incremental planning", () => {
  it("hashes canonical objects independently of object key insertion order", async () => {
    await expect(sha256Canonical({ b: 2, a: 1 })).resolves.toBe(await sha256Canonical({ a: 1, b: 2 }));
  });

  it("initial planning renders all current human-facing globals and supported entity outputs without deliverable registry cards", async () => {
    const { record, taskId, decisionId, researchId, deliverableId } = fixture();
    const plan = await planProjection(record, null, 1);

    for (const key of [
      "global:BRIEF",
      "global:DISCOVERY",
      "global:ROADMAP",
      "global:PROJECT",
      "global:PLAN",
      "global:STATE",
      "global:HANDOFF",
      `task:${taskId}`,
      `decision:${decisionId}`,
      `research:${researchId}`,
      "constraint:CON-PLAN3201"
    ]) {
      expect(plan.changed_outputs.has(key), key).toBe(true);
    }
    expect(plan.changed_outputs.has(`deliverable:${deliverableId}`)).toBe(false);
    expect(plan.changed_outputs.get("global:STATE")?.critical).toBe(true);
    expect(plan.changed_outputs.get("global:HANDOFF")?.critical).toBe(true);
    expect(plan.carried_forward.size).toBe(0);
  });

  it("task.start changes only the task and dependent aggregates while carrying BRIEF and unrelated entities forward", async () => {
    const { record, taskId, decisionId, researchId, deliverableId } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const next = commit(record.state, "task.start", { task_id: taskId });
    const plan = await planProjection(next, baselineFrom(baselinePlan), 1);

    for (const key of [`task:${taskId}`, "global:ROADMAP", "global:PLAN", "global:STATE", "global:HANDOFF"]) {
      expect(plan.changed_outputs.has(key), key).toBe(true);
    }
    for (const key of ["global:BRIEF", `decision:${decisionId}`, `research:${researchId}`]) {
      expect(plan.changed_outputs.has(key), key).toBe(false);
      expect(plan.carried_forward.has(key), key).toBe(true);
    }
    expect(plan.changed_outputs.has(`deliverable:${deliverableId}`)).toBe(false);
    expect(plan.carried_forward.has(`deliverable:${deliverableId}`)).toBe(false);
  });

  it("decision.accept changes its note and discovery, but not BRIEF", async () => {
    const { record } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const next = commit(record.state, "decision.accept", {
      decision_id: "DEC-PLAN3202",
      title: "Second decision",
      decision: "Keep discovery linked",
      reason: "Exercise accepted decisions",
      impacts: []
    });
    const plan = await planProjection(next, baselineFrom(baselinePlan), 1);

    expect(plan.changed_outputs.has("decision:DEC-PLAN3202")).toBe(true);
    expect(plan.changed_outputs.has("global:DISCOVERY")).toBe(true);
    expect(plan.changed_outputs.has("global:BRIEF")).toBe(false);
    expect(plan.carried_forward.has("global:BRIEF")).toBe(true);
  });

  it("constraint.add changes its note, BRIEF and PROJECT", async () => {
    const { record } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const next = commit(record.state, "constraint.add", {
      constraint_id: "CON-PLAN3202",
      title: "Second constraint",
      description: "Exercise aggregate dependencies"
    });
    const plan = await planProjection(next, baselineFrom(baselinePlan), 1);

    expect(plan.changed_outputs.has("constraint:CON-PLAN3202")).toBe(true);
    expect(plan.changed_outputs.has("global:BRIEF")).toBe(true);
    expect(plan.changed_outputs.has("global:PROJECT")).toBe(true);
  });

  it("unreferenced research.add changes only its entity among non-critical discovery views", async () => {
    const { record } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const next = commit(record.state, "research.add", {
      research_id: "RES-PLAN3202",
      title: "Unreferenced research",
      body: "Not yet synthesized"
    });
    const plan = await planProjection(next, baselineFrom(baselinePlan), 1);

    expect(plan.changed_outputs.has("research:RES-PLAN3202")).toBe(true);
    expect(plan.changed_outputs.has("global:DISCOVERY")).toBe(false);
    expect(plan.carried_forward.has("global:DISCOVERY")).toBe(true);
  });

  it("deliverable lifecycle changes ROADMAP without materializing a deliverable registry card", async () => {
    const { record, deliverableId } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const next = commit(record.state, "deliverable.start", { deliverable_id: deliverableId });
    const plan = await planProjection(next, baselineFrom(baselinePlan), 1);

    expect(plan.changed_outputs.has(`deliverable:${deliverableId}`)).toBe(false);
    expect(plan.carried_forward.has(`deliverable:${deliverableId}`)).toBe(false);
    expect(plan.changed_outputs.has("global:ROADMAP")).toBe(true);
    expect(plan.changed_outputs.has("global:BRIEF")).toBe(false);
    expect(plan.changed_outputs.has("global:DISCOVERY")).toBe(false);
    expect(plan.changed_outputs.has("global:PROJECT")).toBe(false);
  });

  it("projection-version change rematerializes every legacy output plus OPERATING at the same business revision", async () => {
    const { record } = fixture();
    const baselinePlan = await planProjection(record, null, 1);
    const baseline = baselineFrom(baselinePlan);
    const planV2 = await planProjection(record, baseline, 2);

    expect(planV2.target_revision).toBe(record.new_revision);
    expect(planV2.projection_version).toBe(2);
    expect(planV2.changed_outputs.size).toBe(baseline.outputs.size + 1);
    expect(planV2.changed_outputs.has("global:OPERATING")).toBe(true);
    expect(planV2.carried_forward.size).toBe(0);
    expect(planV2.source_event_id).toBe(record.event.event_id);
  });

  it("produces deterministic logical keys and relative paths regardless of map insertion order", async () => {
    const { record } = fixture();
    const reordered: CanonicalCommitRecord = {
      ...record,
      state: {
        ...record.state,
        tasks: Object.fromEntries(Object.entries(record.state.tasks).reverse()),
        decisions: Object.fromEntries(Object.entries(record.state.decisions).reverse()),
        research: Object.fromEntries(Object.entries(record.state.research).reverse()),
        deliverables: Object.fromEntries(Object.entries(record.state.deliverables).reverse()),
        constraints: Object.fromEntries(Object.entries(record.state.constraints).reverse())
      }
    };

    const one = await planProjection(record, null, 1);
    const two = await planProjection(reordered, null, 1);
    expect([...one.changed_outputs].map(([key, output]) => [key, output.relative_path]))
      .toEqual([...two.changed_outputs].map(([key, output]) => [key, output.relative_path]));
  });
});
