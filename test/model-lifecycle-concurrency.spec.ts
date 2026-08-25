import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import type { Transaction } from "../src/domain/transaction";

const at = "2026-08-25T18:00:00.000Z";
let serial = 0;

function tx<T extends Transaction["operation"]>(
  projectId: string,
  baseRevision: number,
  operation: T,
  payload: Extract<Transaction, { operation: T }>["payload"]
): Transaction {
  serial += 1;
  return {
    schema_version: "1.0",
    transaction_id: `TXN-MODEL-${serial.toString().padStart(10, "0")}`,
    project_id: projectId,
    base_revision: baseRevision,
    operation,
    created_at: at,
    payload
  } as Transaction;
}

function commit(state: ProjectState, transaction: Transaction): ProjectState {
  const result = applyTransaction(state, transaction);
  expect(result.kind).toBe("commit");
  if (result.kind !== "commit") throw new Error(`Expected commit, got ${result.kind}`);
  return result.state;
}

describe("MODEL001 concurrency", () => {
  it("conflicts stale task start", () => {
    let state = emptyProjectState("PRJ-4001", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4001", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4001"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale task block", () => {
    let state = emptyProjectState("PRJ-4002", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4002", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4002", reason: "Blocked"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale task completion", () => {
    let state = emptyProjectState("PRJ-4003", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4003", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4003"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale legacy deliverable completion", () => {
    let state = emptyProjectState("PRJ-4004", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "deliverable.add", {
      deliverable_id: "DEL-4001", title: "Legacy"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "deliverable.complete", {
      deliverable_id: "DEL-4001", outcome: "Done"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("rebases only the approved additive operations when current-state invariants still hold", () => {
    const state = { ...emptyProjectState("PRJ-4005", "Model", "model"), revision: 5 };

    expect(applyTransaction(state, tx(state.project_id, 2, "research.add", {
      research_id: "RES-4001", title: "Research", body: "Evidence"
    })).kind).toBe("commit");

    expect(applyTransaction(state, tx(state.project_id, 2, "constraint.add", {
      constraint_id: "CON-4001", title: "Constraint", description: "Rule"
    })).kind).toBe("commit");

    expect(applyTransaction(state, tx(state.project_id, 2, "task.create", {
      task_id: "TASK-4005", title: "Independent task"
    })).kind).toBe("commit");

    expect(applyTransaction(state, tx(state.project_id, 2, "deliverable.add", {
      deliverable_id: "DEL-4002", title: "Legacy additive"
    })).kind).toBe("commit");
  });
});

describe("MODEL001 task lifecycle", () => {
  it("allows pending to complete without mandatory start", () => {
    let state = emptyProjectState("PRJ-4101", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4101", title: "Direct completion"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4101", result: "Done naturally"
    }));
    expect(state.tasks["TASK-4101"]).toMatchObject({ status: "completed", result: "Done naturally" });
  });

  it("supports blocked reason refresh, resume, active block and blocked completion", () => {
    let state = emptyProjectState("PRJ-4102", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4102", title: "Recoverable"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "First blocker"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "Updated blocker"
    }));
    expect(state.tasks["TASK-4102"].blocked_reason).toBe("Updated blocker");

    state = commit(state, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4102"
    }));
    expect(state.tasks["TASK-4102"]).toMatchObject({ status: "active" });
    expect(state.tasks["TASK-4102"].blocked_reason).toBeUndefined();

    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "Second blocker"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4102"
    }));
    expect(state.tasks["TASK-4102"].status).toBe("completed");
    expect(state.tasks["TASK-4102"].blocked_reason).toBeUndefined();
  });

  it("keeps completed tasks terminal", () => {
    let state = emptyProjectState("PRJ-4103", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4103", title: "Terminal"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4103"
    }));

    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4103"
    })).kind).toBe("rejected");
    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4103", reason: "No"
    })).kind).toBe("rejected");
    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4103"
    })).kind).toBe("rejected");
  });
});

describe("MODEL001 phase lifecycle", () => {
  it("rejects completion of a pending non-current phase", () => {
    let state = emptyProjectState("PRJ-4201", "Phases", "phases");
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4201", title: "Current"
    }));
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4202", title: "Later"
    }));
    const result = applyTransaction(state, tx(state.project_id, state.revision, "plan.phase.complete", {
      phase_id: "PHASE-4202"
    }));
    expect(result).toMatchObject({ kind: "rejected", code: "PHASE_NOT_CURRENT" });
  });

  it("fails closed when a historical state contains another active phase", () => {
    let state = emptyProjectState("PRJ-4202", "Phases", "phases");
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4203", title: "Current"
    }));
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4204", title: "Later"
    }));
    state.plan_phases["PHASE-4204"].status = "active";

    const result = applyTransaction(state, tx(state.project_id, state.revision, "plan.phase.complete", {
      phase_id: "PHASE-4203"
    }));
    expect(result).toMatchObject({ kind: "rejected", code: "PHASE_STATE_INCONSISTENT" });
  });
});
