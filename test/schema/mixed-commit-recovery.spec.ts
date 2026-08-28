import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalCommitRecord } from "../../src/domain/commit-record";
import type { Env } from "../../src/env";
import type { Receipt } from "../../src/domain/receipt";
import { parseTransaction } from "../../src/domain/transaction";
import { applyTransaction } from "../../src/domain/transitions";
import { machineCommitRecordPath, machineStatePath } from "../../src/persistence/layout";
import { installDropboxMock } from "../helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-28T17:00:00.000Z";

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

function committedRecord(
  previous: CanonicalCommitRecord | null,
  transactionInput: unknown,
  stateVersion: "1.0" | "2.0"
): CanonicalCommitRecord {
  const tx = parseTransaction(transactionInput);
  const applied = applyTransaction(previous?.state ?? null, tx);
  if (applied.kind !== "commit") throw new Error(`fixture transition failed: ${applied.kind}`);
  const state = { ...applied.state, schema_version: stateVersion };
  const receipt: CanonicalCommitRecord["receipt"] = {
    schema_version: "1.0",
    transaction_id: tx.transaction_id,
    status: "committed",
    project_id: tx.project_id,
    previous_revision: previous?.new_revision ?? 0,
    new_revision: state.revision,
    event_id: applied.event.event_id,
    committed_at: tx.created_at
  };
  return {
    schema_version: "1.0",
    project_id: tx.project_id,
    previous_revision: previous?.new_revision ?? 0,
    new_revision: state.revision,
    transaction: tx,
    state,
    event: applied.event,
    receipt
  };
}

describe("mixed canonical commit recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reconstructs identical business state from envelope 1.0 records crossing ProjectState V1 to V2", async () => {
    const projectId = "PRJ-9005";
    const mock = installDropboxMock();
    const create = {
      schema_version: "1.0",
      transaction_id: "TXN-SCHEMA-MIXED-9005-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Mixed Recovery",
        slug: "mixed-recovery",
        aliases: [],
        objective: "Recover mixed schema generations"
      }
    };
    const task = {
      schema_version: "1.0",
      transaction_id: "TXN-SCHEMA-MIXED-9005-TASK",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-SCHEMA9005", title: "Cross V1 to V2" }
    };

    const rev1 = committedRecord(null, create, "1.0");
    const rev2 = committedRecord(rev1, task, "2.0");
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(rev1, null, 2)}\n`);
    mock.files.set(machineCommitRecordPath(projectId, 2), `${JSON.stringify(rev2, null, 2)}\n`);
    expect(mock.files.has(machineStatePath(projectId))).toBe(false);

    const replay = await submit(projectId, task);

    expect(replay).toEqual(rev2.receipt);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    expect(mock.files.has(machineStatePath(projectId))).toBe(false);
  });
});
