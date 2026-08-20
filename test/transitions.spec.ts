import { describe, expect, it } from "vitest";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import type { Transaction } from "../src/domain/transaction";

const at = "2026-08-20T18:00:00.000Z";

function tx(overrides: Partial<Transaction> & Pick<Transaction, "operation" | "payload">): Transaction {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-${Math.random().toString(36).slice(2).toUpperCase()}0000000000`,
    project_id: "PRJ-0001",
    base_revision: 0,
    created_at: at,
    ...overrides
  } as Transaction;
}

describe("applyTransaction", () => {
  it("creates a project at revision 1", () => {
    const result = applyTransaction(null, tx({
      operation: "project.create",
      payload: { name: "Agency", slug: "agency", aliases: ["agence"], objective: "Launch agency" }
    }));
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") {
      expect(result.state.revision).toBe(1);
      expect(result.event.revision).toBe(1);
    }
  });

  it("rejects completing an unknown task", () => {
    const state = emptyProjectState("PRJ-0001", "Agency", "agency");
    const result = applyTransaction(state, tx({
      base_revision: state.revision,
      operation: "task.complete",
      payload: { task_id: "TASK-4040" }
    }));
    expect(result.kind).toBe("rejected");
  });

  it("allows stale additive research when the research id is new", () => {
    const state = { ...emptyProjectState("PRJ-0001", "Agency", "agency"), revision: 7 };
    const result = applyTransaction(state, tx({
      base_revision: 3,
      operation: "research.add",
      payload: { research_id: "RES-0001", title: "Finding", body: "Evidence" }
    }));
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect(result.state.revision).toBe(8);
  });

  it("returns conflict for a stale accepted decision", () => {
    const state = { ...emptyProjectState("PRJ-0001", "Agency", "agency"), revision: 7 };
    const result = applyTransaction(state, tx({
      base_revision: 6,
      operation: "decision.accept",
      payload: { decision_id: "DEC-0001", title: "ICP", decision: "Industrial distributors", reason: "Fit", impacts: [] }
    }));
    expect(result.kind).toBe("conflict");
  });

  it("allows a stale independent task completion only while the target transition is still valid", () => {
    let state = emptyProjectState("PRJ-0001", "Agency", "agency");
    const created = applyTransaction(state, tx({
      operation: "task.create",
      payload: { task_id: "TASK-0001", title: "Launch" }
    }));
    if (created.kind !== "commit") throw new Error("setup failed");
    state = created.state;

    const concurrent = { ...state, revision: state.revision + 2 };
    const completed = applyTransaction(concurrent, tx({
      base_revision: state.revision,
      operation: "task.complete",
      payload: { task_id: "TASK-0001" }
    }));
    expect(completed.kind).toBe("commit");

    if (completed.kind !== "commit") throw new Error("completion failed");
    const replayFromStale = applyTransaction(completed.state, tx({
      base_revision: state.revision,
      operation: "task.complete",
      payload: { task_id: "TASK-0001" }
    }));
    expect(replayFromStale.kind).toBe("rejected");
  });
});
