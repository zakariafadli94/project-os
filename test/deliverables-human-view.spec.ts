import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import type { ProjectState } from "../src/domain/project-state";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction, type Transaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/materialization/hash";
import { planProjection, type ProjectionPlan } from "../src/materialization/planner";
import { MaterializationOutputConflictError, WorkspaceProjectionWriter } from "../src/materialization/writer";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { MANAGED_NOTICE } from "../src/render/shared";

const at = "2026-08-29T17:30:00+01:00";
let sequence = 0;

function commit(
  state: ProjectState,
  operation: Transaction["operation"],
  payload: Record<string, unknown>
): CanonicalCommitRecord {
  sequence += 1;
  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: `TXN-DELIVVIEW-${sequence.toString().padStart(6, "0")}`,
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

function deliverableFixture(): CanonicalCommitRecord {
  sequence = 0;
  let state = emptyProjectState("PRJ-3901", "Human Deliverables", "human-deliverables", "Keep published content readable");
  let record = commit(state, "plan.phase.create", {
    phase_id: "PHASE-DELIV3901",
    title: "Operate",
    objective: "Exercise deliverable publication"
  });
  state = record.state;
  record = commit(state, "deliverable.create", {
    deliverable_id: "DEL-HUMAN3901",
    title: "Published business corpus",
    version: "1.0",
    description: "Registry metadata for a real published document",
    phase_id: "PHASE-DELIV3901",
    decision_ids: []
  });
  return record;
}

class MemoryObjects implements ObjectPersistence {
  files = new Map<string, string>();
  deleted: string[] = [];

  async readText(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async createText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async upsertText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async getMetadata(path: string): Promise<ProviderObjectMetadata | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, size: new TextEncoder().encode(content).byteLength };
  }
  async listChildren(_path: string): Promise<ProviderEntry[]> { return []; }
  async move(): Promise<void> { throw new Error("not used"); }
  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.files.delete(path);
  }
}

describe("human deliverables view", () => {
  it("does not materialize canonical deliverable registry cards into DELIVERABLES and ROADMAP does not link to them", async () => {
    const record = deliverableFixture();
    const plan = await planProjection(record, null, 2);

    expect(plan.changed_outputs.has("deliverable:DEL-HUMAN3901")).toBe(false);
    const roadmap = plan.changed_outputs.get("global:ROADMAP")?.content ?? "";
    expect(roadmap).not.toContain("[[DELIVERABLES/DEL-HUMAN3901");
    expect(roadmap).toContain("Published business corpus");
  });

  it("marks a legacy deliverable projection for safe physical removal", async () => {
    const record = deliverableFixture();
    const legacyContent = `${MANAGED_NOTICE}\n# old registry card\n`;
    const legacyEvidence: ProjectionOutputEvidence = {
      relative_path: "DELIVERABLES/DEL-HUMAN3901.md",
      input_hash: await sha256Text("legacy-input"),
      content_hash: await sha256Text(legacyContent),
      source_revision: record.new_revision
    };
    const baseline = {
      projection_version: 2,
      outputs: new Map<string, ProjectionOutputEvidence>([["deliverable:DEL-HUMAN3901", legacyEvidence]])
    };

    const plan = await planProjection(record, baseline, 2);
    expect(plan.removed_outputs).toContain("deliverable:DEL-HUMAN3901");
    expect(plan.removed_output_evidence?.get("deliverable:DEL-HUMAN3901")).toEqual(legacyEvidence);
  });

  it("deletes a removed projection only when current bytes still match completed evidence", async () => {
    const objects = new MemoryObjects();
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const legacyContent = `${MANAGED_NOTICE}\n# old registry card\n`;
    const legacyEvidence: ProjectionOutputEvidence = {
      relative_path: "DELIVERABLES/DEL-HUMAN3901.md",
      input_hash: await sha256Text("legacy-input"),
      content_hash: await sha256Text(legacyContent),
      source_revision: 3
    };
    objects.files.set("/workspace/DELIVERABLES/DEL-HUMAN3901.md", legacyContent);
    const plan: ProjectionPlan = {
      project_id: "PRJ-3901",
      target_revision: 4,
      projection_version: 2,
      source_transaction_id: "TXN-DELIVVIEW-REMOVE",
      source_event_id: "EVT-000004",
      changed_outputs: new Map(),
      carried_forward: new Map(),
      removed_outputs: ["deliverable:DEL-HUMAN3901"],
      removed_output_evidence: new Map([["deliverable:DEL-HUMAN3901", legacyEvidence]]),
      expected_output_keys: []
    };

    await writer.materialize(plan, { workspaceRoot: "/workspace" });

    expect(objects.deleted).toEqual(["/workspace/DELIVERABLES/DEL-HUMAN3901.md"]);
    expect(objects.files.has("/workspace/DELIVERABLES/DEL-HUMAN3901.md")).toBe(false);
  });

  it("preserves and fails closed when an obsolete projection changed since completed evidence", async () => {
    const objects = new MemoryObjects();
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const baselineContent = `${MANAGED_NOTICE}\n# old registry card\n`;
    const divergentContent = `${MANAGED_NOTICE}\n# manually changed registry card\n`;
    const legacyEvidence: ProjectionOutputEvidence = {
      relative_path: "DELIVERABLES/DEL-HUMAN3901.md",
      input_hash: await sha256Text("legacy-input"),
      content_hash: await sha256Text(baselineContent),
      source_revision: 3
    };
    const path = "/workspace/DELIVERABLES/DEL-HUMAN3901.md";
    objects.files.set(path, divergentContent);
    const preserved: string[] = [];
    const plan: ProjectionPlan = {
      project_id: "PRJ-3901",
      target_revision: 4,
      projection_version: 2,
      source_transaction_id: "TXN-DELIVVIEW-DIVERGED",
      source_event_id: "EVT-000004",
      changed_outputs: new Map(),
      carried_forward: new Map(),
      removed_outputs: ["deliverable:DEL-HUMAN3901"],
      removed_output_evidence: new Map([["deliverable:DEL-HUMAN3901", legacyEvidence]]),
      expected_output_keys: []
    };

    await expect(writer.materialize(plan, {
      workspaceRoot: "/workspace",
      onUnexpectedContent: (entry) => {
        preserved.push(entry.currentContent);
      }
    })).rejects.toBeInstanceOf(MaterializationOutputConflictError);

    expect(objects.deleted).toEqual([]);
    expect(objects.files.get(path)).toBe(divergentContent);
    expect(preserved).toEqual([divergentContent]);
  });
});
