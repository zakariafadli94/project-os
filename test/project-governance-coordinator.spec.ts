import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import { CURRENT_PROJECTION_VERSION, type CompletedMaterializationRecord, type MaterializationHead, type ProjectionOutputEvidence } from "../src/domain/materialization";
import type { ProjectGovernanceProfile } from "../src/domain/project-governance";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction } from "../src/domain/transitions";
import {
  MaterializationCoordinator,
  type MaterializationLedgerPort,
  type MaterializationRepositoryPort,
  type ProjectionWriterPort
} from "../src/materialization/coordinator";
import type { ProjectionPlan } from "../src/materialization/planner";

const at = "2026-08-30T08:10:00+01:00";

function record(): CanonicalCommitRecord {
  const tx = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-GOV-COORD-9301-CREATE",
    project_id: "PRJ-9301",
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: { name: "Coordinator Probe", slug: "coordinator-probe", aliases: [], objective: "Render governance" }
  });
  const result = applyTransaction(null, tx);
  if (result.kind !== "commit") throw new Error(`fixture failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: tx.transaction_id,
    status: "committed",
    project_id: tx.project_id,
    previous_revision: 0,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return { schema_version: "1.0", project_id: tx.project_id, previous_revision: 0, new_revision: 1, transaction: tx, state: result.state, event: result.event, receipt };
}

const profile: ProjectGovernanceProfile = {
  schema_version: "1.0",
  project_id: "PRJ-9301",
  project_kind: "synthetic_probe",
  authorization_id: "PCAUTH-DDDDDDDDDDDDDDDDDDDDDDDD",
  improvement_package_id: "IMP-GOV001",
  created_at: at
};

class Repo implements MaterializationRepositoryPort {
  readonly commit = record();
  async readCommitRecord(_projectId: string, revision: number) { return revision === 1 ? this.commit : null; }
  async readProjectGovernanceProfile(_projectId: string) { return profile; }
  async readMaterializationHead() { return null; }
  async readMaterializationRecord() { return null; }
  async listMaterializationRecordRefs() { return []; }
  async writeCompletedMaterializationRecord(_record: CompletedMaterializationRecord) {}
  async writeMaterializationHead(_head: MaterializationHead) {}
  async materializeCanonicalDerivatives() {}
}

class Ledger implements MaterializationLedgerPort {
  requested: { revision: number; projection_version: number } | null = null;
  active: { revision: number; projection_version: number; coalesced_revisions: number[] } | null = null;
  head: { revision: number; projection_version: number } | null = null;
  outputs = new Map<string, ProjectionOutputEvidence>();
  requestTarget(target: { revision: number; projection_version: number }) { this.requested = target; }
  beginNextTarget() {
    if (this.active) return this.active;
    if (!this.requested) return null;
    this.active = { ...this.requested, coalesced_revisions: [] };
    return this.active;
  }
  recordVerifiedOutput(key: string, evidence: ProjectionOutputEvidence) { this.outputs.set(key, evidence); }
  attemptOutputs() { return new Map<string, ProjectionOutputEvidence>(); }
  baselineOutputs() { return new Map<string, ProjectionOutputEvidence>(); }
  failActive(_message: string) {}
  completeTarget(input: { revision: number; projection_version: number }) {
    this.head = { revision: input.revision, projection_version: input.projection_version };
    this.requested = null;
    this.active = null;
  }
  restoreExternalBaseline(head: { revision: number; projection_version: number }, outputs: ReadonlyMap<string, ProjectionOutputEvidence>) {
    this.head = head;
    this.outputs = new Map(outputs);
  }
  status() {
    return {
      head: this.head,
      requested: this.requested,
      active: this.active,
      active_status: this.active ? "running" : null,
      last_error: null,
      output_count: this.outputs.size,
      attempt_output_count: 0
    };
  }
}

class Writer implements ProjectionWriterPort {
  projectContent = "";
  async materialize(plan: ProjectionPlan, options: { onOutputVerified?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void> }) {
    this.projectContent = plan.changed_outputs.get("global:PROJECT")?.content ?? "";
    const result = new Map<string, ProjectionOutputEvidence>();
    for (const [key, output] of plan.changed_outputs) {
      const evidence: ProjectionOutputEvidence = {
        relative_path: output.relative_path,
        input_hash: output.input_hash,
        content_hash: output.content_hash,
        source_revision: output.source_revision
      };
      result.set(key, evidence);
      await options.onOutputVerified?.(key, evidence);
    }
    return result;
  }
}

describe("project governance materialization coordinator", () => {
  it("loads the separate governance profile before planning PROJECT.md", async () => {
    const ledger = new Ledger();
    const writer = new Writer();
    const coordinator = new MaterializationCoordinator({
      projectId: "PRJ-9301",
      repository: new Repo(),
      ledger,
      writer,
      projectionVersion: CURRENT_PROJECTION_VERSION,
      now: () => at
    });

    coordinator.requestTarget(1);
    await coordinator.runNext();

    expect(writer.projectContent).toContain("Project kind: synthetic_probe");
    expect(writer.projectContent).toContain("Synthetic project — fictitious / non-business");
  });
});
