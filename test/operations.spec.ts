import { describe, expect, it } from "vitest";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import type { Transaction } from "../src/domain/transaction";

const at = "2026-08-20T18:00:00.000Z";
let serial = 0;

function tx<T extends Transaction["operation"]>(projectId: string, baseRevision: number, operation: T, payload: Extract<Transaction, { operation: T }>["payload"]): Transaction {
  serial += 1;
  return {
    schema_version: "1.0",
    transaction_id: `TXN-OPERATIONS-${serial.toString().padStart(8, "0")}`,
    project_id: projectId,
    base_revision: baseRevision,
    operation,
    created_at: at,
    payload
  } as Transaction;
}

function commit(state: ReturnType<typeof emptyProjectState>, transaction: Transaction) {
  const result = applyTransaction(state, transaction);
  expect(result.kind).toBe("commit");
  if (result.kind !== "commit") throw new Error(`Expected commit, got ${result.kind}`);
  return result.state;
}

describe("complete V1 operation surface", () => {
  it("enforces project lifecycle transitions", () => {
    let state = emptyProjectState("PRJ-2001", "Lifecycle", "lifecycle");
    state = commit(state, tx(state.project_id, 0, "project.pause", { reason: "wait" }));
    expect(state.status).toBe("paused");
    state = commit(state, tx(state.project_id, 1, "project.resume", {}));
    expect(state.status).toBe("active");
    state = commit(state, tx(state.project_id, 2, "project.complete", { summary: "done" }));
    expect(state.status).toBe("completed");
    state = commit(state, tx(state.project_id, 3, "project.archive", { reason: "closed" }));
    expect(state.status).toBe("archived");
    expect(applyTransaction(state, tx(state.project_id, 4, "project.resume", {})).kind).toBe("rejected");
  });

  it("preserves superseded decisions rather than deleting history", () => {
    let state = emptyProjectState("PRJ-2002", "Decisions", "decisions");
    state = commit(state, tx(state.project_id, 0, "decision.accept", {
      decision_id: "DEC-2001", title: "Pricing", decision: "5000", reason: "Initial", impacts: []
    }));
    state = commit(state, tx(state.project_id, 1, "decision.accept", {
      decision_id: "DEC-2002", title: "Pricing v2", decision: "7500", reason: "Validated", impacts: []
    }));
    state = commit(state, tx(state.project_id, 2, "decision.supersede", {
      decision_id: "DEC-2001", replacement_decision_id: "DEC-2002", reason: "Replaced"
    }));
    expect(state.decisions["DEC-2001"].status).toBe("superseded");
    expect(state.decisions["DEC-2001"].superseded_by).toBe("DEC-2002");
    expect(state.decisions["DEC-2002"].status).toBe("accepted");
  });

  it("creates, updates and completes plan phases deterministically", () => {
    let state = emptyProjectState("PRJ-2003", "Plan", "plan");
    state = commit(state, tx(state.project_id, 0, "plan.phase.create", { phase_id: "PHASE-2001", title: "Research" }));
    state = commit(state, tx(state.project_id, 1, "plan.phase.create", { phase_id: "PHASE-2002", title: "Launch" }));
    state = commit(state, tx(state.project_id, 2, "plan.phase.update", { phase_id: "PHASE-2001", next_actions: ["Interview users"] }));
    state = commit(state, tx(state.project_id, 3, "plan.phase.complete", { phase_id: "PHASE-2001" }));
    expect(state.plan_phases["PHASE-2001"].status).toBe("completed");
    expect(state.plan_phases["PHASE-2002"].status).toBe("active");
    expect(state.current_phase_id).toBe("PHASE-2002");
    expect(applyTransaction(state, tx(state.project_id, 4, "plan.phase.update", { phase_id: "PHASE-2001", title: "Changed" })).kind).toBe("rejected");
  });

  it("rejects duplicate constraints and deliverables and terminal re-completion", () => {
    let state = emptyProjectState("PRJ-2004", "Outputs", "outputs");
    state = commit(state, tx(state.project_id, 0, "constraint.add", { constraint_id: "CON-2001", title: "Budget", description: "Low" }));
    expect(applyTransaction(state, tx(state.project_id, 1, "constraint.add", { constraint_id: "CON-2001", title: "Budget", description: "Again" })).kind).toBe("rejected");
    state = commit(state, tx(state.project_id, 1, "deliverable.add", { deliverable_id: "DEL-2001", title: "Report" }));
    state = commit(state, tx(state.project_id, 2, "deliverable.complete", { deliverable_id: "DEL-2001", outcome: "Delivered" }));
    expect(state.deliverables["DEL-2001"].status).toBe("completed");
    expect(applyTransaction(state, tx(state.project_id, 3, "deliverable.complete", { deliverable_id: "DEL-2001" })).kind).toBe("rejected");
  });
});
