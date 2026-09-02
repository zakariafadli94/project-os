import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWithRollback } from "../src/continuity/rollback";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import type { Transaction } from "../src/domain/transaction";
import { machineCommitRecordPath, machineReceiptPath, machineStatePath } from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T03:00:00+01:00";

async function submit(projectId: string, transaction: Transaction): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
  return response.json<Receipt>();
}

async function createProject(projectId: string): Promise<Receipt> {
  return submit(projectId, {
    schema_version: "1.0",
    transaction_id: `TXN-ROLLBACK-${projectId.slice(4)}-CREATE`,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: `Rollback ${projectId}`,
      slug: `rollback-${projectId.slice(4)}`,
      aliases: [],
      objective: "Rollback proof"
    }
  });
}

function taskTx(projectId: string, id: string): Transaction {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-ROLLBACK-${projectId.slice(4)}-${id}`,
    project_id: projectId,
    base_revision: 1,
    operation: "task.create",
    created_at: at,
    payload: { task_id: id, title: id }
  };
}

function projectionStub(projectId: string) {
  return testEnv.MATERIALIZATION_GUARD.getByName(projectId);
}

describe("ProjectGuard data-preserving rollback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back before commit and applies the business effect exactly once", async () => {
    const projectId = "PRJ-2020";
    const mock = installDropboxMock();
    await createProject(projectId);
    expect(await runDurableObjectAlarm(projectionStub(projectId))).toBe(true);
    const tx = taskTx(projectId, "TASK-ROLLBACK2020");

    const execution = await executeWithRollback({
      selectedPath: "candidate",
      transaction: tx,
      candidate: async () => { throw new Error("candidate failed before commit"); },
      stable: (transaction) => submit(projectId, transaction)
    });

    expect(execution).toMatchObject({
      selected_path: "candidate",
      final_path: "stable",
      fallback_occurred: true,
      candidate_failure: "technical",
      receipt: { status: "committed", previous_revision: 1, new_revision: 2 }
    });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);

    const replay = await submit(projectId, tx);
    expect(replay).toEqual(execution.receipt);
    expect(await runDurableObjectAlarm(projectionStub(projectId))).toBe(true);
    const state = JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}");
    expect(state.revision).toBe(2);
    expect(state.tasks).toHaveProperty("TASK-ROLLBACK2020");
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("treats a post-commit projection failure as a committed candidate result, not a rollback trigger", async () => {
    const projectId = "PRJ-2021";
    const eventPath = `/PROJECT_OS/.project-os/projects/${projectId}/events/EVT-000002.json`;
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: eventPath,
        occurrence: 1,
        status: 400,
        error_summary: "injected/post_commit_projection_failure"
      }]
    });
    await createProject(projectId);
    expect(await runDurableObjectAlarm(projectionStub(projectId))).toBe(true);
    const tx = taskTx(projectId, "TASK-ROLLBACK2021");
    const stable = vi.fn((transaction: Transaction) => submit(projectId, transaction));

    const execution = await executeWithRollback({
      selectedPath: "candidate",
      transaction: tx,
      candidate: (transaction) => submit(projectId, transaction),
      stable
    });

    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(execution).toMatchObject({
      selected_path: "candidate",
      final_path: "candidate",
      fallback_occurred: false,
      receipt: { status: "committed", previous_revision: 1, new_revision: 2 }
    });
    expect(stable).not.toHaveBeenCalled();
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    expect(mock.files.has(machineReceiptPath(tx.transaction_id))).toBe(false);

    const replay = await submit(projectId, tx);
    expect(replay).toEqual(execution.receipt);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("keeps rollback isolated to the transaction's project", async () => {
    const mock = installDropboxMock();
    const projectA = "PRJ-2022";
    const projectB = "PRJ-2023";
    await createProject(projectA);
    await createProject(projectB);

    const txA = taskTx(projectA, "TASK-ROLLBACK2022");
    const txB = taskTx(projectB, "TASK-ROLLBACK2023");

    const [resultA, resultB] = await Promise.all([
      executeWithRollback({
        selectedPath: "candidate",
        transaction: txA,
        candidate: async () => { throw new Error("candidate A failed"); },
        stable: (transaction) => submit(projectA, transaction)
      }),
      executeWithRollback({
        selectedPath: "candidate",
        transaction: txB,
        candidate: (transaction) => submit(projectB, transaction),
        stable: (transaction) => submit(projectB, transaction)
      })
    ]);

    expect(resultA).toMatchObject({ final_path: "stable", fallback_occurred: true });
    expect(resultB).toMatchObject({ final_path: "candidate", fallback_occurred: false });
    expect(mock.files.has(machineCommitRecordPath(projectA, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectB, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectA, 3))).toBe(false);
    expect(mock.files.has(machineCommitRecordPath(projectB, 3))).toBe(false);

    expect(await runDurableObjectAlarm(projectionStub(projectA))).toBe(true);
    expect(await runDurableObjectAlarm(projectionStub(projectB))).toBe(true);
    const stateA = JSON.parse(mock.files.get(machineStatePath(projectA)) ?? "{}");
    const stateB = JSON.parse(mock.files.get(machineStatePath(projectB)) ?? "{}");
    expect(stateA.revision).toBe(2);
    expect(stateB.revision).toBe(2);
    expect(stateA.tasks).toHaveProperty("TASK-ROLLBACK2022");
    expect(stateB.tasks).toHaveProperty("TASK-ROLLBACK2023");
  });
});