import { describe, expect, it } from "vitest";
import { parseCanonicalCommitRecord, type CanonicalCommitRecord } from "../../src/domain/commit-record";
import { CURRENT_PROJECTION_VERSION, type ProjectionOutputEvidence } from "../../src/domain/materialization";
import type { ProjectState } from "../../src/domain/project-state";
import type { Receipt } from "../../src/domain/receipt";
import { parseTransaction, type Transaction } from "../../src/domain/transaction";
import { applyTransaction } from "../../src/domain/transitions";
import {
  planProjection,
  type ProjectionBaseline,
  type ProjectionPlan
} from "../../src/materialization/planner";
import { encodeProjectState } from "../../src/schema/project-state";
import type { SchemaWriterStage } from "../../src/schema/writer-stage";

const projectId = "PRJ-9011";
const at = "2026-08-29T01:30:00+01:00";
let sequence = 0;

function nextTransaction(
  state: ProjectState | null,
  operation: Transaction["operation"],
  payload: Record<string, unknown>
): Transaction {
  sequence += 1;
  return parseTransaction({
    schema_version: "1.0",
    transaction_id: `TXN-SCHEMA-MATCOMPAT-${sequence.toString().padStart(4, "0")}`,
    project_id: projectId,
    base_revision: state?.revision ?? 0,
    operation,
    created_at: at,
    payload
  });
}

function commit(
  previous: CanonicalCommitRecord | null,
  operation: Transaction["operation"],
  payload: Record<string, unknown>,
  writerStage: SchemaWriterStage
): CanonicalCommitRecord {
  const transaction = nextTransaction(previous?.state ?? null, operation, payload);
  const applied = applyTransaction(previous?.state ?? null, transaction);
  if (applied.kind !== "commit") throw new Error(`fixture transition failed: ${applied.kind}`);

  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: previous?.new_revision ?? 0,
    new_revision: applied.state.revision,
    event_id: applied.event.event_id,
    committed_at: at
  };

  return parseCanonicalCommitRecord({
    schema_version: "1.0",
    project_id: projectId,
    previous_revision: previous?.new_revision ?? 0,
    new_revision: applied.state.revision,
    transaction,
    state: encodeProjectState(applied.state, writerStage),
    event: applied.event,
    receipt
  });
}

function envelopeWithStateStage(record: CanonicalCommitRecord, writerStage: SchemaWriterStage): CanonicalCommitRecord {
  return parseCanonicalCommitRecord({
    ...record,
    state: encodeProjectState(record.state, writerStage)
  });
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
  for (const [key, output] of plan.carried_forward) outputs.set(key, output);
  return { projection_version: plan.projection_version, outputs };
}

function comparableOutputs(plan: ProjectionPlan) {
  return [...plan.changed_outputs]
    .map(([key, value]) => [key, {
      relative_path: value.relative_path,
      input_hash: value.input_hash,
      content_hash: value.content_hash,
      source_revision: value.source_revision
    }] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

describe("ProjectState schema evolution vs materialization", () => {
  it("keeps the current projection at v3 and produces identical projection semantics from V1 or V2 nested state", async () => {
    sequence = 0;
    const created = commit(null, "project.create", {
      name: "Schema Materialization",
      slug: "schema-materialization",
      aliases: [],
      objective: "Keep durable schema independent from projection semantics"
    }, "v1_only");

    const fromV1 = envelopeWithStateStage(created, "v1_only");
    const fromV2 = envelopeWithStateStage(created, "core_v2");
    const planV1 = await planProjection(fromV1, null, CURRENT_PROJECTION_VERSION);
    const planV2 = await planProjection(fromV2, null, CURRENT_PROJECTION_VERSION);

    expect(CURRENT_PROJECTION_VERSION).toBe(3);
    expect(planV1.projection_version).toBe(3);
    expect(planV2.projection_version).toBe(3);
    expect(planV2.changed_outputs.has("global:OPERATING")).toBe(true);
    expect(planV2.changed_outputs.get("global:HANDOFF")?.content).toMatch(/Operating contract/i);
    expect(comparableOutputs(planV2)).toEqual(comparableOutputs(planV1));
  });

  it("carries unaffected outputs forward with their older source revision when the next commit carries ProjectState V2", async () => {
    sequence = 0;
    const created = commit(null, "project.create", {
      name: "Schema Materialization",
      slug: "schema-materialization",
      aliases: [],
      objective: "Keep durable schema independent from projection semantics"
    }, "v1_only");
    const baselinePlan = await planProjection(created, null, CURRENT_PROJECTION_VERSION);

    const research = commit(created, "research.add", {
      research_id: "RES-MATCOMPAT9011",
      title: "Unreferenced schema research",
      body: "This research is not synthesized into Discovery yet."
    }, "core_v2");
    const nextPlan = await planProjection(research, baselineFrom(baselinePlan), CURRENT_PROJECTION_VERSION);

    expect(nextPlan.target_revision).toBe(2);
    expect(nextPlan.projection_version).toBe(3);
    expect(nextPlan.changed_outputs.has("research:RES-MATCOMPAT9011")).toBe(true);
    for (const key of ["global:BRIEF", "global:DISCOVERY", "global:PROJECT", "global:PLAN", "global:ROADMAP"]) {
      expect(nextPlan.changed_outputs.has(key), key).toBe(false);
      expect(nextPlan.carried_forward.get(key)?.source_revision, key).toBe(1);
    }
    for (const key of ["global:STATE", "global:HANDOFF", "global:OPERATING"]) {
      expect(nextPlan.changed_outputs.has(key), key).toBe(true);
      expect(nextPlan.changed_outputs.get(key)?.source_revision, key).toBe(2);
    }
  });

  it("does not change projection semantics merely because the canonical state encoder advances", async () => {
    sequence = 0;
    const created = commit(null, "project.create", {
      name: "Schema Materialization",
      slug: "schema-materialization",
      aliases: [],
      objective: "Keep durable schema independent from projection semantics"
    }, "core_v2");
    const plan = await planProjection(created, null, CURRENT_PROJECTION_VERSION);

    expect(plan.projection_version).toBe(3);
    expect(plan.expected_output_keys).toContain("global:OPERATING");
    expect(plan.expected_output_keys).toContain("global:HANDOFF");
    expect(plan.expected_output_keys).not.toContain("global:PROJECTION_V4");
  });
});
