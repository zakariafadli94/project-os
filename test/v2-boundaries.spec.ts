import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import type { Transaction } from "../src/domain/transaction";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { machineReceiptPath, machineStatePath, machineTransactionPath } from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("already exists", "req-test");
    this.files.set(path, content);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("source missing");
    this.files.delete(from);
    this.files.set(to, value);
  }
}

const testEnv = env as unknown as Env;
const at = "2026-08-20T18:00:00.000Z";

describe("V2 persistence boundaries", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("keeps rejected terminal transactions entirely in the machine layer", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const transaction: Transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-TERMINAL-V2-0001",
      project_id: "PRJ-0001",
      base_revision: 1,
      operation: "task.start",
      created_at: at,
      payload: { task_id: "TASK-0001" }
    };
    const receipt: Receipt = {
      schema_version: "1.0",
      transaction_id: transaction.transaction_id,
      status: "rejected",
      project_id: transaction.project_id,
      previous_revision: 1,
      new_revision: 1,
      code: "TEST_REJECTION",
      message: "Test terminal artifact routing"
    };

    await repository.writeTerminalTransaction(transaction, receipt);

    expect(transport.files.has(machineTransactionPath("rejected", transaction.transaction_id))).toBe(true);
    expect(transport.files.has(machineReceiptPath(transaction.transaction_id))).toBe(true);
    expect(transport.files.has(`/PROJECT_OS/TRANSACTIONS/rejected/${transaction.transaction_id}.json`)).toBe(false);
  });

  it("materializes a V2 machine state snapshot without changing business revision", async () => {
    const projectId = "PRJ-1198";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const create = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-PROJECT-1198-0001",
        project_id: projectId,
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: { name: "Snapshot Project", slug: "snapshot-project", aliases: [], objective: "Test V2 snapshot" }
      })
    });
    const createReceipt = await create.json<Receipt>();
    expect(createReceipt.new_revision).toBe(1);

    const materialize = await stub.fetch("https://project-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });
    expect(materialize.status).toBe(200);
    await expect(materialize.json()).resolves.toEqual({ project_id: projectId, revision: 1, materialized: true });
    expect(dropbox.files.has(machineStatePath(projectId))).toBe(true);

    const task = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-PROJECT-1198-0002",
        project_id: projectId,
        base_revision: 1,
        operation: "task.create",
        created_at: at,
        payload: { task_id: "TASK-1198", title: "Revision remains one before mutation" }
      })
    });
    const taskReceipt = await task.json<Receipt>();
    expect(taskReceipt.new_revision).toBe(2);
  });
});
