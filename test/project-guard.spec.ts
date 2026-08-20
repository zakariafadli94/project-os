import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-20T18:00:00.000Z";

function createTx(projectId: string, transactionId: string) {
  return {
    schema_version: "1.0",
    transaction_id: transactionId,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: { name: `Project ${projectId}`, slug: projectId.toLowerCase().replace("prj-", "project-"), aliases: [], objective: "Test" }
  };
}

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const stub = testEnv.PROJECT_GUARD.getByName(projectId);
  const response = await stub.fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("commits project creation at revision 1 and replays idempotently", async () => {
    const projectId = "PRJ-1001";
    const tx = createTx(projectId, "TXN-PROJECT-1001-0001");
    const first = await submit(projectId, tx);
    const replay = await submit(projectId, tx);

    expect(first.status).toBe("committed");
    expect(first.new_revision).toBe(1);
    expect(replay).toEqual(first);
  });

  it("increments revisions monotonically across valid task mutations", async () => {
    const projectId = "PRJ-1002";
    await submit(projectId, createTx(projectId, "TXN-PROJECT-1002-0001"));

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1002-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-1002", title: "Ship" }
    });
    const completed = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1002-0003",
      project_id: projectId,
      base_revision: 2,
      operation: "task.complete",
      created_at: at,
      payload: { task_id: "TASK-1002" }
    });

    expect(created.new_revision).toBe(2);
    expect(completed.new_revision).toBe(3);
  });

  it("returns a conflict receipt for stale L2 mutations", async () => {
    const projectId = "PRJ-1003";
    await submit(projectId, createTx(projectId, "TXN-PROJECT-1003-0001"));
    await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1003-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "research.add",
      created_at: at,
      payload: { research_id: "RES-1003", title: "Finding", body: "Evidence" }
    });

    const receipt = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1003-0003",
      project_id: projectId,
      base_revision: 1,
      operation: "decision.accept",
      created_at: at,
      payload: { decision_id: "DEC-1003", title: "Market", decision: "Morocco", reason: "Focus", impacts: [] }
    });

    expect(receipt.status).toBe("conflict");
    expect(receipt.new_revision).toBe(2);
  });

  it("preserves revision and idempotency state across Durable Object eviction", async () => {
    const projectId = "PRJ-1004";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const tx = createTx(projectId, "TXN-PROJECT-1004-0001");
    await submit(projectId, tx);

    await evictDurableObject(stub);

    const replay = await submit(projectId, tx);
    const task = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1004-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-1004", title: "Persist" }
    });

    expect(replay.new_revision).toBe(1);
    expect(task.new_revision).toBe(2);
  });

  it("rejects the unallocated project sentinel at the per-project guard", async () => {
    const receipt = await submit("PRJ-AUTO", {
      schema_version: "1.0",
      transaction_id: "TXN-AUTO-PROJECT-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: "Auto", slug: "auto", aliases: [], objective: "Allocate first" }
    });
    expect(receipt.status).toBe("rejected");
    expect(receipt.code).toBe("UNALLOCATED_PROJECT_ID");
  });
});
