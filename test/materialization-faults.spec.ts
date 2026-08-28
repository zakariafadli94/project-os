import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineCommitRecordPath,
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T18:00:00+01:00";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    }
  );
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

function createTx(projectId: string, slug: string, transactionId: string) {
  return {
    schema_version: "1.0",
    transaction_id: transactionId,
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: { name: `Project ${projectId}`, slug, aliases: [], objective: "Projection acceptance proof" }
  };
}

async function materialize(projectId: string): Promise<void> {
  expect(await runDurableObjectAlarm(testEnv.PROJECT_GUARD.getByName(projectId))).toBe(true);
}

describe("IMP-MATERIAL001 acceptance faults and efficiency", () => {
  let mock: ReturnType<typeof installDropboxMock>;

  beforeEach(() => {
    mock = installDropboxMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("updates task-dependent views without uploading unrelated entities or BRIEF and logs one structured attempt", async () => {
    const projectId = "PRJ-3801";
    const slug = "projection-efficiency";
    const root = workspaceProjectRoot(projectId, slug);
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    await submit(projectId, createTx(projectId, slug, "TXN-MATFAULT-3801-CREATE"));
    await materialize(projectId);
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3801-TASK", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-MAT3801", title: "Efficient task" }
    });
    await materialize(projectId);
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3801-RES", project_id: projectId,
      base_revision: 2, operation: "research.add", created_at: at,
      payload: { research_id: "RES-MAT3801", title: "Research", body: "Unrelated research" }
    });
    await materialize(projectId);
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3801-DEC", project_id: projectId,
      base_revision: 3, operation: "decision.accept", created_at: at,
      payload: { decision_id: "DEC-MAT3801", title: "Decision", decision: "Keep it", reason: "Proof", impacts: [] }
    });
    await materialize(projectId);
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3801-DEL", project_id: projectId,
      base_revision: 4, operation: "deliverable.create", created_at: at,
      payload: { deliverable_id: "DEL-MAT3801", title: "Deliverable", version: "v1", decision_ids: ["DEC-MAT3801"] }
    });
    await materialize(projectId);

    mock.uploadCalls.length = 0;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const startTx = {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3801-START", project_id: projectId,
      base_revision: 5, operation: "task.start", created_at: at,
      payload: { task_id: "TASK-MAT3801" }
    };
    const committed = await submit(projectId, startTx);
    expect(committed.status).toBe("committed");
    expect(committed.new_revision).toBe(6);
    await materialize(projectId);

    const workspaceUploads = mock.uploadCalls.filter((path) => path.startsWith(`${root}/`));
    expect(workspaceUploads).toContain(`${root}/TASKS/TASK-MAT3801.md`);
    expect(workspaceUploads).toContain(`${root}/STATE.md`);
    expect(workspaceUploads).toContain(`${root}/HANDOFF.md`);
    expect(workspaceUploads).not.toContain(`${root}/BRIEF.md`);
    expect(workspaceUploads).not.toContain(`${root}/DECISIONS/DEC-MAT3801.md`);
    expect(workspaceUploads).not.toContain(`${root}/RESEARCH/RES-MAT3801.md`);
    expect(workspaceUploads).not.toContain(`${root}/DELIVERABLES/DEL-MAT3801.md`);

    expect(info).toHaveBeenCalledWith(
      "Project OS materialization attempt",
      expect.objectContaining({
        project_id: projectId,
        target_revision: 6,
        projection_version: CURRENT_PROJECTION_VERSION,
        source_transaction_id: startTx.transaction_id,
        outputs_uploaded: expect.any(Number),
        outputs_carried_forward: expect.any(Number),
        final_state: "complete"
      })
    );

    mock.uploadCalls.length = 0;
    const replay = await submit(projectId, startTx);
    expect(replay).toEqual(committed);
    const reconcile = await stub.fetch("https://project-guard.internal/reconcile-materialization", { method: "POST" });
    expect(reconcile.status).toBe(200);
    expect(mock.uploadCalls.filter((path) => path.startsWith(`${root}/`))).toEqual([]);
    expect(mock.files.has(machineCommitRecordPath(projectId, 7))).toBe(false);
  });

  it("repairs a failed head write from immutable generation evidence with zero workspace rewrite", async () => {
    vi.restoreAllMocks();
    const faults: DropboxMockFault[] = [];
    mock = installDropboxMock({ faults });
    const projectId = "PRJ-3802";
    const slug = "head-repair";
    const root = workspaceProjectRoot(projectId, slug);
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    await submit(projectId, createTx(projectId, slug, "TXN-MATFAULT-3802-CREATE"));
    await materialize(projectId);
    faults.push({
      endpoint: "/2/files/upload",
      method: "POST",
      path: machineMaterializationHeadPath(projectId),
      occurrence: 1,
      status: 400,
      error_summary: "injected/head_failure"
    });
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3802-TASK", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-MAT3802", title: "Head repair" }
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow();
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION))).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);
    const workspaceWritesBeforeRepair = mock.uploadCalls.filter((path) => path.startsWith(`${root}/`)).length;

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(2);
    expect(mock.uploadCalls.filter((path) => path.startsWith(`${root}/`)).length).toBe(workspaceWritesBeforeRepair);
  });

  it("rebuilds lost hot materialization baseline from external completed evidence", async () => {
    const projectId = "PRJ-3803";
    const slug = "hot-state-rebuild";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    await submit(projectId, createTx(projectId, slug, "TXN-MATFAULT-3803-CREATE"));
    await materialize(projectId);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM materialization_outputs");
      state.storage.sql.exec("DELETE FROM materialization_attempt_outputs");
      state.storage.sql.exec(`
        UPDATE materialization_control
        SET head_revision = NULL,
            head_projection_version = NULL,
            requested_revision = NULL,
            requested_projection_version = NULL,
            active_revision = NULL,
            active_projection_version = NULL,
            active_coalesced_json = '[]',
            active_status = NULL,
            last_error = NULL
        WHERE singleton = 1
      `);
    });
    await evictDurableObject(stub);
    mock.uploadCalls.length = 0;

    const response = await stub.fetch("https://project-guard.internal/reconcile-materialization", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<{ materialized_head: { revision: number } | null; output_count: number }>();
    expect(body.materialized_head?.revision).toBe(1);
    expect(body.output_count).toBeGreaterThan(0);
    expect(mock.uploadCalls.filter((path) => path.includes("/WORKSPACE/PROJECTS/"))).toEqual([]);
  });

  it("coalesces four rapid canonical revisions to the newest projection while preserving every commit", async () => {
    const projectId = "PRJ-3804";
    const slug = "burst-coalescing";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    await submit(projectId, createTx(projectId, slug, "TXN-MATFAULT-3804-CREATE"));
    await materialize(projectId);

    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3804-TASK", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: at,
      payload: { task_id: "TASK-MAT3804", title: "Burst task" }
    });
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3804-RES", project_id: projectId,
      base_revision: 2, operation: "research.add", created_at: at,
      payload: { research_id: "RES-MAT3804", title: "Burst research", body: "Burst" }
    });
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3804-CON", project_id: projectId,
      base_revision: 3, operation: "constraint.add", created_at: at,
      payload: { constraint_id: "CON-MAT3804", title: "Burst constraint", description: "Bounded" }
    });
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-MATFAULT-3804-DEC", project_id: projectId,
      base_revision: 4, operation: "decision.accept", created_at: at,
      payload: { decision_id: "DEC-MAT3804", title: "Burst decision", decision: "Ship", reason: "Proof", impacts: [] }
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    for (const revision of [2, 3, 4, 5]) {
      expect(mock.files.has(machineCommitRecordPath(projectId, revision))).toBe(true);
    }
    for (const revision of [2, 3, 4]) {
      expect(mock.files.has(machineMaterializationRecordPath(projectId, revision, CURRENT_PROJECTION_VERSION))).toBe(false);
    }
    const record = JSON.parse(mock.files.get(machineMaterializationRecordPath(projectId, 5, CURRENT_PROJECTION_VERSION)) ?? "{}");
    expect(record.coalesced_revisions).toEqual([2, 3, 4]);
    expect(record.target_revision).toBe(5);
    expect(mock.maxConcurrentUploads()).toBeLessThanOrEqual(4);
  });
});
