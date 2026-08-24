import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { emptyProjectState } from "../src/domain/transitions";
import { machineCommitRecordPath, machineStatePath } from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T00:20:00.000Z";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard commit-record compatibility", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats a pre-upgrade V2 snapshot with no historical records as a valid baseline", async () => {
    const projectId = "PRJ-1801";
    const mock = installDropboxMock();
    const baseline = emptyProjectState(projectId, "Pre Upgrade", "pre-upgrade", "Keep existing projects compatible");
    baseline.revision = 7;
    baseline.last_event_id = "EVT-000007";
    baseline.created_at = at;
    baseline.updated_at = at;
    mock.files.set(machineStatePath(projectId), `${JSON.stringify(baseline, null, 2)}\n`);

    const receipt = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1801-TASK-A",
      project_id: projectId,
      base_revision: 7,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-COMMIT1801A", title: "First post-upgrade commit" }
    });

    expect(receipt).toMatchObject({ status: "committed", previous_revision: 7, new_revision: 8 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 7))).toBe(false);
    expect(mock.files.has(machineCommitRecordPath(projectId, 8))).toBe(true);
  });

  it("recovers a brand-new project from revision-1 commit record when no snapshot was materialized", async () => {
    const projectId = "PRJ-1802";
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1802-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "First Record Recovery",
        slug: "first-record-recovery",
        aliases: [],
        objective: "Recover from the first immutable commit"
      }
    };

    const committed = await submit(projectId, transaction);
    expect(committed).toMatchObject({ status: "committed", previous_revision: 0, new_revision: 1, event_id: "EVT-000001" });
    expect(mock.files.has(machineCommitRecordPath(projectId, 1))).toBe(true);
    expect(mock.files.has(machineStatePath(projectId))).toBe(false);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM project_state");
      state.storage.sql.exec("DELETE FROM transactions");
    });
    await evictDurableObject(stub);

    const replay = await submit(projectId, transaction);
    expect(replay).toEqual(committed);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    expect(mock.files.has(machineStatePath(projectId))).toBe(false);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}").revision).toBe(1);
  });
});
