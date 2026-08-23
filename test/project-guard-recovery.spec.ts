import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-23T21:45:00.000Z";

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

describe("ProjectGuard canonical recovery", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("recovers current project state from canonical Dropbox after local SQLite state is lost", async () => {
    const projectId = "PRJ-1201";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-RECOVERY-1201-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: "Recovery 1201", slug: "recovery-1201", aliases: [], objective: "Recover from canonical Dropbox" }
    });
    expect(created.status).toBe("committed");
    expect(created.new_revision).toBe(1);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM transactions");
      state.storage.sql.exec("DELETE FROM project_state");
    });

    const recovered = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-RECOVERY-1201-TASK",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-RECOVERY1201", title: "Continue after local loss" }
    });

    expect(recovered.status).toBe("committed");
    expect(recovered.previous_revision).toBe(1);
    expect(recovered.new_revision).toBe(2);
  });

  it("replays the canonical committed receipt after local receipt and state caches are lost", async () => {
    const projectId = "PRJ-1202";
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-RECOVERY-1202-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: "Recovery 1202", slug: "recovery-1202", aliases: [], objective: "Recover committed receipt" }
    });

    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-RECOVERY-1202-TASK",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-RECOVERY1202", title: "Commit exactly once" }
    };
    const committed = await submit(projectId, transaction);
    expect(committed.status).toBe("committed");
    expect(committed.new_revision).toBe(2);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM transactions");
      state.storage.sql.exec("DELETE FROM project_state");
    });

    const replay = await submit(projectId, transaction);
    expect(replay).toEqual(committed);
  });
});
