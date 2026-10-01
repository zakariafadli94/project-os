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

  it("refuses project completion while a task remains unfinished", () => {
    const initial = emptyProjectState("PRJ-0001", "Agency", "agency");
    const created = applyTransaction(initial, tx({
      operation: "task.create",
      payload: { task_id: "TASK-OPEN001", title: "Finish handoff" }
    }));
    expect(created.kind).toBe("commit");
    if (created.kind !== "commit") return;

    const refused = applyTransaction(created.state, tx({
      base_revision: created.state.revision,
      operation: "project.complete",
      payload: { summary: "Done" }
    }));
    expect(refused).toMatchObject({ kind: "rejected", code: "PROJECT_HAS_UNFINISHED_TASKS" });
    expect(created.state.status).toBe("active");
    expect(created.state.revision).toBe(1);

    const finished = applyTransaction(created.state, tx({
      base_revision: created.state.revision,
      operation: "task.complete",
      payload: { task_id: "TASK-OPEN001", result: "Handoff verified" }
    }));
    expect(finished.kind).toBe("commit");
    if (finished.kind !== "commit") return;
    expect(applyTransaction(finished.state, tx({
      base_revision: finished.state.revision,
      operation: "project.complete",
      payload: { summary: "Done" }
    }))).toMatchObject({ kind: "commit", state: { status: "completed" } });
  });

  it("refuses project completion while a plan phase remains open", () => {
    const initial = emptyProjectState("PRJ-0001", "Agency", "agency");
    const created = applyTransaction(initial, tx({
      operation: "plan.phase.create",
      payload: { phase_id: "PHASE-OPEN001", title: "Launch" }
    }));
    expect(created.kind).toBe("commit");
    if (created.kind !== "commit") return;

    expect(applyTransaction(created.state, tx({
      base_revision: created.state.revision,
      operation: "project.complete",
      payload: { summary: "Done" }
    }))).toMatchObject({ kind: "rejected", code: "PROJECT_HAS_OPEN_PHASES" });
  });

  it("preserves the explicit active-to-archived lifecycle path", () => {
    const initial = emptyProjectState("PRJ-0001", "Agency", "agency");
    expect(applyTransaction(initial, tx({
      operation: "project.archive",
      payload: { reason: "Initiative discontinued" }
    }))).toMatchObject({ kind: "commit", state: { status: "archived" } });
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
});
