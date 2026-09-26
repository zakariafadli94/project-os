import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineCommitRecordPath,
  machineEventPath,
  machineMaterializationHeadPath,
  machineReceiptPath,
  machineStatePath
} from "../src/dropbox/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
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

async function materializeThroughContinuations(projectId: string): Promise<void> {
  const stub = projectionStub(projectId);
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
      [projectId]: "repair"
    });
  });
  for (let slice = 0; slice < 64; slice += 1) if (!await runDurableObjectAlarm(stub)) return;
}

async function finalizeSyntheticProjectCreate(projectId: string, receipt: Receipt): Promise<void> {
  await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(receipt);
}

describe("ProjectGuard crash-safe canonical commits", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("advances past failed transaction recoveries to later pending requests", async () => {
    const projectId = "PRJ-1712";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let index = 1; index <= 5; index += 1) {
        state.storage.sql.exec(
          "INSERT INTO request_recovery (kind, request_id) VALUES ('transaction', ?)",
          `TXN-FAIRNESS-1712-${index}`
        );
      }
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    let wakeDuringProviderFailure: number | null = null;
    const attempted: string[] = [];
    await runInDurableObject(stub, (instance, state) => {
      const ledger = (instance as unknown as { transactionRequests: {
        readRecoverableTransaction(projectId: string, requestId: string): Promise<unknown>
      } }).transactionRequests;
      const original = ledger.readRecoverableTransaction.bind(ledger);
      let first = true;
      vi.spyOn(ledger, "readRecoverableTransaction").mockImplementation(async (project, requestId) => {
        attempted.push(requestId);
        if (first) {
          first = false;
          wakeDuringProviderFailure = await state.storage.getAlarm();
          throw new Error("transient_provider_failure");
        }
        return original(project, requestId);
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(attempted).toEqual([
      "TXN-FAIRNESS-1712-1", "TXN-FAIRNESS-1712-2", "TXN-FAIRNESS-1712-3", "TXN-FAIRNESS-1712-4"
    ]);
    expect(wakeDuringProviderFailure).not.toBeNull();
    expect(await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())).not.toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(attempted.slice(4)).toEqual(["TXN-FAIRNESS-1712-5"]);
    // A forced early alarm must not retry failed work before its recorded
    // next_attempt_at, and must not starve the healthy fifth request.
    await runDurableObjectAlarm(stub);
    expect(attempted).toHaveLength(5);
    const attempts = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{
      request_id: string; count: number
    }>("SELECT request_id, count FROM request_recovery_failures WHERE kind = 'transaction' ORDER BY request_id").toArray());
    expect(attempts).toHaveLength(5);
    expect(attempts.at(-1)).toMatchObject({ request_id: "TXN-FAIRNESS-1712-5", count: 1 });
  });

  it("resumes the exact transaction after a failed commit write without caller replay", async () => {
    const projectId = "PRJ-1703";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);

    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1703-TASK-A",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-COMMIT1703A", title: "Recover without a chat replay" }
    };
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "writeCommitRecord").mockRejectedValueOnce(new Error("transient_commit_write_failure"));
      restore = () => spy.mockRestore();
    });

    await expect(stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction)
    })).rejects.toThrow("transient_commit_write_failure");
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    restore();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("recovers a transaction staged before its immutable request write", async () => {
    const projectId = "PRJ-1706";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1706-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-COMMIT1706A", title: "Staged before immutable write" }
    };
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const requests = (instance as any).transactionRequests;
      const spy = vi.spyOn(requests, "ensureTransactionRequest").mockRejectedValueOnce(new Error("intent_write_unavailable"));
      restore = () => spy.mockRestore();
    });
    await expect(stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(transaction)
    })).rejects.toThrow("intent_write_unavailable");
    restore();
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    await runDurableObjectAlarm(stub);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("returns the exact committed receipt before an opted-in projection wait", async () => {
    const projectId = "PRJ-1717";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1717-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-COMMIT1717A", title: "Return receipt without waiting for projection" }
    };
    let release!: () => void;
    const projection = new Promise<void>((resolve) => { release = resolve; });
    let responseSettled = false;
    let completedResponse!: Response;
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const spy = vi.spyOn(instance as any, "requestMaterializationSafely").mockImplementationOnce(async () => projection);
      restore = () => spy.mockRestore();
    });
    const submission = stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify(transaction)
    }).then((received) => { responseSettled = true; return received; });
    try {
      await vi.waitFor(() => expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true));
      await vi.waitFor(() => expect(responseSettled).toBe(true), { timeout: 250 });
    } finally {
      release();
      completedResponse = await submission;
      restore();
    }
    expect(completedResponse.status).toBe(200);
    expect(await completedResponse.json()).toMatchObject({ transaction_id: transaction.transaction_id, project_id: projectId, status: "committed", new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    const replay = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify(transaction)
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ transaction_id: transaction.transaction_id, project_id: projectId, status: "committed", new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    let restoreFailedHandoff!: () => void;
    await runInDurableObject(stub, (instance) => {
      const spy = vi.spyOn(instance as any, "requestMaterializationSafely").mockResolvedValueOnce(false);
      restoreFailedHandoff = () => spy.mockRestore();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    restoreFailedHandoff();
    const retained = await runInDurableObject(stub, async (_instance, state) => ({
      rows: state.storage.sql.exec<{ request_id: string }>(
        "SELECT request_id FROM request_recovery WHERE kind = 'transaction' AND request_id = ?", transaction.transaction_id
      ).toArray(), alarm: await state.storage.getAlarm()
    }));
    expect(retained.rows).toEqual([{ request_id: transaction.transaction_id }]);
    expect(retained.alarm).not.toBeNull();
    const retryAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(retryAt + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    vi.useRealTimers();
    const recoveryRows = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ request_id: string }>(
      "SELECT request_id FROM request_recovery WHERE kind = 'transaction' AND request_id = ?", transaction.transaction_id
    ).toArray());
    expect(recoveryRows).toEqual([]);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("rejects different bytes under a staged transaction identifier", async () => {
    const projectId = "PRJ-1704";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
    const original = {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1704-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-COMMIT1704A", title: "Original task" }
    };
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "writeCommitRecord").mockRejectedValueOnce(new Error("transient_commit_write_failure"));
      restore = () => spy.mockRestore();
    });
    await expect(stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(original)
    })).rejects.toThrow("transient_commit_write_failure");
    restore();
    const changed = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify({ ...original, payload: { ...original.payload, title: "Changed task" } })
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "idempotency_payload_mismatch" });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    await runDurableObjectAlarm(stub);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("recovers a recorded commit after the response path fails without a second revision", async () => {
    const projectId = "PRJ-1705";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1705-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-COMMIT1705A", title: "Commit before response failure" }
    };
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const spy = vi.spyOn(instance as any, "requestMaterializationSafely").mockRejectedValueOnce(new Error("post_commit_failure"));
      restore = () => spy.mockRestore();
    });
    await expect(stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(transaction)
    })).rejects.toThrow("post_commit_failure");
    restore();
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    await runDurableObjectAlarm(stub);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    const replay = await submit(projectId, transaction);
    expect(replay).toMatchObject({ status: "committed", new_revision: 2 });
  });

  it("does not silently rebase a pending request after another canonical commit wins", async () => {
    const projectId = "PRJ-1707";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
    const seeded = await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1707-SEED", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-COMMIT1707A", title: "Task to complete" }
    });
    expect(seeded).toMatchObject({ status: "committed", new_revision: 2 });
    const pending = {
      schema_version: "1.0", transaction_id: "TXN-COMMIT-1707-TASK-A", project_id: projectId,
      base_revision: 2, operation: "task.complete", created_at: at,
      payload: { task_id: "TASK-COMMIT1707A" }
    };
    let restore!: () => void;
    await runInDurableObject(stub, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "writeCommitRecord").mockRejectedValueOnce(new Error("transient_commit_write_failure"));
      restore = () => spy.mockRestore();
    });
    await expect(stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(pending)
    })).rejects.toThrow("transient_commit_write_failure");
    restore();
    const winner = await submit(projectId, {
      ...pending, transaction_id: "TXN-COMMIT-1707-TASK-B",
    });
    expect(winner).toMatchObject({ status: "committed", new_revision: 3 });
    await runDurableObjectAlarm(stub);
    expect(mock.files.has(machineCommitRecordPath(projectId, 4))).toBe(false);
    const replay = await submit(projectId, pending);
    expect(replay).toMatchObject({ status: "conflict" });
  });

  it("keeps an immutable committed record authoritative while derived materialization is pending", async () => {
    const projectId = "PRJ-1701";
    const mock = installDropboxMock();
    const stub = projectionStub(projectId);

    const created = await submit(projectId, createTransaction(projectId));
    expect(created.new_revision).toBe(1);
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);
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

    await materializeThroughContinuations(projectId);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(2);
    expect(mock.files.has(machineReceiptPath(transaction.transaction_id))).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(2);
  });

  it("accepts later canonical work before projection catches up and converges to the newest revision", async () => {
    const projectId = "PRJ-1702";
    const mock = installDropboxMock();
    const stub = projectionStub(projectId);

    const created = await submit(projectId, createTransaction(projectId));
    await finalizeSyntheticProjectCreate(projectId, created);
    await materializeThroughContinuations(projectId);

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

    await materializeThroughContinuations(projectId);
    const state = JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}");
    expect(state.revision).toBe(3);
    expect(state.tasks).toHaveProperty("TASK-COMMIT1702A");
    expect(state.tasks).toHaveProperty("TASK-COMMIT1702B");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(3);
    expect(first.event_id).toBeDefined();
    expect(mock.files.has(machineEventPath(projectId, first.event_id!))).toBe(true);
    expect(first.transaction_id).toBeDefined();
    expect(mock.files.has(machineReceiptPath(first.transaction_id!))).toBe(true);
    expect(next.event_id).toBeDefined();
    expect(mock.files.has(machineEventPath(projectId, next.event_id!))).toBe(true);
    expect(next.transaction_id).toBeDefined();
    expect(mock.files.has(machineReceiptPath(next.transaction_id!))).toBe(true);
  });
});
