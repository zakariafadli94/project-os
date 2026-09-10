import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { machineStatePath } from "../src/persistence/layout";
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

async function requestMaterialize(projectId: string): Promise<Response> {
  const stub = testEnv.PROJECT_GUARD.getByName(projectId);
  return stub.fetch("https://project-guard.internal/materialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "workspace-v2" })
  });
}

async function enableRepairMaterialization(projectId: string): Promise<void> {
  const stub = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
      [projectId]: "repair"
    });
  });
}

describe("ProjectGuard", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
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

  it("does not publish the final Dropbox receipt for project.create", async () => {
    const projectId = "PRJ-1099";
    const tx = createTx(projectId, "TXN-PROJECT-1099-0001");
    await submit(projectId, tx);

    expect(dropbox.files.has(`/PROJECT_OS/RECEIPTS/${tx.transaction_id}.json`)).toBe(false);
  });

  it("uses bounded convergence materialization without mutating business revision", async () => {
    const projectId = "PRJ-1098";
    await submit(projectId, createTx(projectId, "TXN-PROJECT-1098-0001"));
    await enableRepairMaterialization(projectId);

    const response = await requestMaterialize(projectId);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId, revision: 1, materialized: false, status: "pending"
    });

    const task = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1098-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-1098", title: "Still revision one before this" }
    });
    expect(task.new_revision).toBe(2);
  });

  it("blocks legacy direct workspace materialization until convergence activation", async () => {
    const projectId = "PRJ-1097";
    const legacyState = {
      schema_version: "1.0",
      project_id: projectId,
      name: "Legacy State",
      slug: "legacy-state",
      aliases: [],
      objective: "Prove compatibility",
      status: "active",
      revision: 7,
      current_phase_id: null,
      constraints: {},
      tasks: {},
      plan_phases: {},
      decisions: {},
      research: {},
      deliverables: {
        "DEL-1097": {
          deliverable_id: "DEL-1097",
          title: "Historical final",
          status: "completed",
          created_at: at,
          updated_at: at
        }
      },
      last_event_id: "EVT-000007",
      created_at: at,
      updated_at: at
    };

    dropbox.files.set(machineStatePath(projectId), `${JSON.stringify(legacyState, null, 2)}\n`);

    expect((await requestMaterialize(projectId)).status).toBe(409);

    const framing = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-PROJECT-1097-0008",
      project_id: projectId,
      base_revision: 7,
      operation: "project.framing.update",
      created_at: at,
      payload: { scope: ["Compatibility test"] }
    });
    expect(framing.status).toBe("committed");
    expect(framing.previous_revision).toBe(7);
    expect(framing.new_revision).toBe(8);
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

  it("enforces MODEL001 stale lifecycle conflicts and stale additive rebasing at the receipt boundary", async () => {
    const projectId = "PRJ-1010";
    await submit(projectId, createTx(projectId, "TXN-MODEL-GUARD-PROJECT-0001"));

    const task = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-MODEL-GUARD-TASK-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-1010", title: "Concurrent target" }
    });
    expect(task.new_revision).toBe(2);

    const unrelated = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-MODEL-GUARD-RESEARCH-0001",
      project_id: projectId,
      base_revision: 2,
      operation: "research.add",
      created_at: at,
      payload: { research_id: "RES-1010", title: "Unrelated", body: "Advance revision" }
    });
    expect(unrelated.new_revision).toBe(3);

    const staleCompletionTx = {
      schema_version: "1.0",
      transaction_id: "TXN-MODEL-GUARD-STALE-0001",
      project_id: projectId,
      base_revision: 2,
      operation: "task.complete",
      created_at: at,
      payload: { task_id: "TASK-1010" }
    };
    const conflict = await submit(projectId, staleCompletionTx);
    expect(conflict).toMatchObject({
      status: "conflict",
      code: "STALE_REVISION",
      previous_revision: 3,
      new_revision: 3
    });
    expect(conflict.event_id).toBeUndefined();

    const replay = await submit(projectId, staleCompletionTx);
    expect(replay).toEqual(conflict);

    const staleAdditive = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-MODEL-GUARD-RESEARCH-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "research.add",
      created_at: at,
      payload: { research_id: "RES-1011", title: "Stale additive", body: "Still independent" }
    });
    expect(staleAdditive).toMatchObject({ status: "committed", previous_revision: 3, new_revision: 4 });
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
