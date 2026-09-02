import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineCommitRecordPath,
  machineMaterializationHeadPath,
  machineReceiptPath,
  machineStatePath
} from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T00:10:00.000Z";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

function createTransaction(projectId: string) {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-COMMIT-${projectId.slice(4)}-CREATE`,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: `Commit ${projectId.slice(4)}`,
      slug: `commit-${projectId.slice(4)}`,
      aliases: [],
      objective: "Recover interrupted canonical commits"
    }
  };
}

function projectionStub(projectId: string) {
  return testEnv.MATERIALIZATION_GUARD.getByName(projectId);
}

describe("ProjectGuard crash-safe canonical commits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps an immutable committed record authoritative while derived materialization is pending", async () => {
    const projectId = "PRJ-1701";
    const mock = installDropboxMock();
    const stub = projectionStub(projectId);

    const created = await submit(projectId, createTransaction(projectId));
    expect(created.new_revision).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(1);

    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1701-TASK-A",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-COMMIT1701A", title: "Commit once across a crash" }
    };

    const committed = await submit(projectId, transaction);
    expect(committed).toMatchObject({
      status: "committed",
      previous_revision: 1,
      new_revision: 2,
      event_id: "EVT-000002"
    });

    const recordPath = machineCommitRecordPath(projectId, 2);
    expect(mock.files.has(recordPath)).toBe(true);
    expect(mock.files.has(machineReceiptPath(transaction.transaction_id))).toBe(false);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(1);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    const replayBeforeProjection = await submit(projectId, transaction);
    expect(replayBeforeProjection).toEqual(committed);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(2);
    expect(mock.files.has(machineReceiptPath(transaction.transaction_id))).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(2);
  });

  it("accepts later canonical work before projection catches up and converges to the newest revision", async () => {
    const projectId = "PRJ-1702";
    const mock = installDropboxMock();
    const stub = projectionStub(projectId);

    await submit(projectId, createTransaction(projectId));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const first = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1702-TASK-A",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-COMMIT1702A", title: "Pending projection task" }
    });
    expect(first).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);

    const next = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1702-TASK-B",
      project_id: projectId,
      base_revision: 2,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-COMMIT1702B", title: "Continue before projection" }
    });

    expect(next).toMatchObject({
      status: "committed",
      previous_revision: 2,
      new_revision: 3,
      event_id: "EVT-000003"
    });
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(true);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(1);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}");
    expect(state.revision).toBe(3);
    expect(state.tasks).toHaveProperty("TASK-COMMIT1702A");
    expect(state.tasks).toHaveProperty("TASK-COMMIT1702B");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(3);
  });
});