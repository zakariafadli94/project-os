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
