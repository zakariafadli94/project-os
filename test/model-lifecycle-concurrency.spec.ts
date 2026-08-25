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
});
