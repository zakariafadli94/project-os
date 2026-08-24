import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWithRollback } from "../src/continuity/rollback";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import type { Transaction } from "../src/domain/transaction";
import { machineCommitRecordPath, machineStatePath } from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T02:20:00+01:00";

async function routeProjectGuard(projectId: string, transaction: Transaction): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
  return response.json<Receipt>();
}

function createTransaction(projectId: string): Extract<Transaction, { operation: "project.create" }> {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-ROLLBACK-${projectId.slice(4)}-CREATE`,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: `Rollback ${projectId.slice(4)}`,
      slug: `rollback-${projectId.slice(4)}`,
      aliases: [],
      objective: "Prove automatic safe rollback"
    }
  };
}

function taskTransaction(projectId: string, suffix: string, taskId: string): Extract<Transaction, { operation: "task.create" }> {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-ROLLBACK-${projectId.slice(4)}-${suffix}`,
    project_id: projectId,
    base_revision: 1,
    operation: "task.create",
    created_at: at,
    payload: { task_id: taskId, title: `Rollback proof ${suffix}` }
  };
}

describe("ProjectGuard data-preserving rollback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back before commit and applies the business effect exactly once", async () => {
    const projectId = "PRJ-2020";
    const mock = installDropboxMock();
    await routeProjectGuard(projectId, createTransaction(projectId));
    const transaction = taskTransaction(projectId, "TASK", "TASK-ROLLBACK2020");

    const execution = await executeWithRollback({
      selectedPath: "candidate",
      transaction,
      candidate: async () => {
        throw new Error("injected/pre_commit_candidate_failure");
      },
      stable: (tx) => routeProjectGuard(projectId, tx)
    });

    expect(execution).toMatchObject({
      selected_path: "candidate",
      final_path: "stable",
      fallback_occurred: true,
      candidate_failure: "technical",
      receipt: { status: "committed", previous_revision: 1, new_revision: 2, event_id: "EVT-000002" }
    });

    const replay = await routeProjectGuard(projectId, transaction);
    expect(replay).toEqual(execution.receipt);
    const state = JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}");
    expect(state.revision).toBe(2);
    expect(state.tasks).toHaveProperty("TASK-ROLLBACK2020");
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("falls back after canonical commit and reconciles the same transaction without a second revision", async () => {
    const projectId = "PRJ-2021";
    const eventPath = `/PROJECT_OS/.project-os/projects/${projectId}/events/EVT-000002.json`;
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: eventPath,
        occurrence: 1,
        status: 400,
        error_summary: "injected/post_commit_candidate_failure"
      }]
    });
    await routeProjectGuard(projectId, createTransaction(projectId));
    const transaction = taskTransaction(projectId, "TASK", "TASK-ROLLBACK2021");

    const execution = await executeWithRollback({
      selectedPath: "candidate",
      transaction,
      candidate: (tx) => routeProjectGuard(projectId, tx),
      stable: (tx) => routeProjectGuard(projectId, tx)
    });

    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(execution).toMatchObject({
      selected_path: "candidate",
      final_path: "stable",
      fallback_occurred: true,
      candidate_failure: "technical",
      receipt: { status: "committed", previous_revision: 1, new_revision: 2, event_id: "EVT-000002" }
    });

    const replay = await routeProjectGuard(projectId, transaction);
    expect(replay).toEqual(execution.receipt);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    const state = JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}");
    expect(state.revision).toBe(2);
    expect(state.tasks).toHaveProperty("TASK-ROLLBACK2021");
  });

  it("keeps rollback isolated to the transaction's project", async () => {
    const projectA = "PRJ-2022";
    const projectB = "PRJ-2023";
    const mock = installDropboxMock();
    await routeProjectGuard(projectA, createTransaction(projectA));
    await routeProjectGuard(projectB, createTransaction(projectB));

    const transactionA = taskTransaction(projectA, "TASK", "TASK-ROLLBACK2022");
    const transactionB = taskTransaction(projectB, "TASK", "TASK-ISOLATE2023");

    const rollbackA = await executeWithRollback({
      selectedPath: "candidate",
      transaction: transactionA,
      candidate: async () => {
        throw new Error("injected/project_a_candidate_failure");
      },
      stable: (tx) => routeProjectGuard(projectA, tx)
    });
    const committedB = await routeProjectGuard(projectB, transactionB);

    expect(rollbackA.receipt).toMatchObject({ project_id: projectA, status: "committed", new_revision: 2 });
    expect(committedB).toMatchObject({ project_id: projectB, status: "committed", new_revision: 2 });

    const stateA = JSON.parse(mock.files.get(machineStatePath(projectA)) ?? "{}");
    const stateB = JSON.parse(mock.files.get(machineStatePath(projectB)) ?? "{}");
    expect(stateA.revision).toBe(2);
    expect(stateB.revision).toBe(2);
    expect(stateA.tasks).toHaveProperty("TASK-ROLLBACK2022");
    expect(stateA.tasks).not.toHaveProperty("TASK-ISOLATE2023");
    expect(stateB.tasks).toHaveProperty("TASK-ISOLATE2023");
    expect(stateB.tasks).not.toHaveProperty("TASK-ROLLBACK2022");
  });
});
