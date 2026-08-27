import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineCommitRecordPath,
  machineMaterializationHeadPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T17:40:00+01:00";

function createTx(projectId: string, slug: string, transactionId: string) {
  return {
    schema_version: "1.0",
    transaction_id: transactionId,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: { name: `Project ${projectId}`, slug, aliases: [], objective: "Test async materialization" }
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

async function status(projectId: string) {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/materialization-status",
    { method: "GET" }
  );
  expect(response.status).toBe(200);
  return response.json<{
    project_id: string;
    canonical_revision: number;
    projection_version: number;
    materialized_head: { revision: number; projection_version: number } | null;
    requested: { revision: number; projection_version: number } | null;
    active: { revision: number; projection_version: number } | null;
    blocked_error: string | null;
    output_count: number;
  }>();
}

describe("ProjectGuard asynchronous materialization", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    dropbox = installDropboxMock();
  });

  it("returns a committed business receipt before human materialization and resumes it through an alarm after eviction", async () => {
    vi.restoreAllMocks();
    const projectId = "PRJ-3601";
    const slug = "materialization-project";
    const workspaceRoot = workspaceProjectRoot(projectId, slug);
    const taskPath = `${workspaceRoot}/TASKS/TASK-MAT3601.md`;
    dropbox = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        occurrence: 1,
        status: 503,
        error_summary: "internal_error/transient_projection",
        method: "POST",
        path: taskPath
      }]
    });
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    const create = await submit(projectId, createTx(projectId, slug, "TXN-MATERIAL-PG-3601-CREATE"));
    expect(create.status).toBe("committed");
    expect(create.new_revision).toBe(1);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 1))).toBe(true);
    expect(dropbox.files.has(machineMaterializationHeadPath(projectId))).toBe(false);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    const taskTx = {
      schema_version: "1.0",
      transaction_id: "TXN-MATERIAL-PG-3601-TASK",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-MAT3601", title: "Async task" }
    };
    const task = await submit(projectId, taskTx);

    expect(task.status).toBe("committed");
    expect(task.new_revision).toBe(2);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(dropbox.files.has(taskPath)).toBe(false);
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{ state_json: string }>(
        "SELECT state_json FROM project_state WHERE singleton = 1"
      ).one();
      expect(JSON.parse(row.state_json).revision).toBe(2);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(dropbox.files.has(taskPath)).toBe(true);
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(2);

    const replay = await submit(projectId, taskTx);
    expect(replay).toEqual(task);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("keeps canonical revision committed when a permanent workspace conflict blocks projection", async () => {
    const projectId = "PRJ-3602";
    const slug = "blocked-projection";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const root = workspaceProjectRoot(projectId, slug);

    await submit(projectId, createTx(projectId, slug, "TXN-MATERIAL-PG-3602-CREATE"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    dropbox.files.set(`${root}/BRIEF.md`, "human edit outside Project OS");
    const receipt = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-MATERIAL-PG-3602-CONSTRAINT",
      project_id: projectId,
      base_revision: 1,
      operation: "constraint.add",
      created_at: at,
      payload: { constraint_id: "CON-MAT3602", title: "Conflict proof", description: "Changes BRIEF" }
    });
    expect(receipt.status).toBe("committed");
    expect(receipt.new_revision).toBe(2);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);

    const materialization = await status(projectId);
    expect(materialization.canonical_revision).toBe(2);
    expect(materialization.materialized_head?.revision).toBe(1);
    expect(materialization.blocked_error).toMatch(/overwrite|changed unexpectedly|untracked/i);
  });

  it("exposes compact materialization status without file contents", async () => {
    const projectId = "PRJ-3603";
    const slug = "materialization-status";
    await submit(projectId, createTx(projectId, slug, "TXN-MATERIAL-PG-3603-CREATE"));

    const before = await status(projectId);
    expect(before).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      projection_version: 1,
      materialized_head: null
    });
    expect(JSON.stringify(before)).not.toContain("# Brief");

    expect(await runDurableObjectAlarm(testEnv.PROJECT_GUARD.getByName(projectId))).toBe(true);
    const after = await status(projectId);
    expect(after.materialized_head).toEqual({ revision: 1, projection_version: 1 });
    expect(after.output_count).toBeGreaterThan(0);
  });

  it("keeps the existing synchronous /materialize admin compatibility route", async () => {
    const projectId = "PRJ-3604";
    const slug = "sync-materialize";
    await submit(projectId, createTx(projectId, slug, "TXN-MATERIAL-PG-3604-CREATE"));

    const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
      "https://project-guard.internal/materialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "workspace-v2" })
      }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ project_id: projectId, revision: 1, materialized: true });
    expect(JSON.parse(dropbox.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);
  });

  it("reconcile-materialization requeues current canonical state without changing the business revision", async () => {
    const projectId = "PRJ-3605";
    const slug = "reconcile-materialization";
    await submit(projectId, createTx(projectId, slug, "TXN-MATERIAL-PG-3605-CREATE"));

    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const response = await stub.fetch("https://project-guard.internal/reconcile-materialization", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<{ canonical_revision: number; requested: { revision: number } | null }>();
    expect(body.canonical_revision).toBe(1);
    expect(body.requested?.revision).toBe(1);
    expect(dropbox.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});
