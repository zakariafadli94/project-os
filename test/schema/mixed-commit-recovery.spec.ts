import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalCommitRecord } from "../../src/domain/commit-record";
import type { Env } from "../../src/env";
import { parseTransaction } from "../../src/domain/transaction";
import { applyTransaction } from "../../src/domain/transitions";
import { machineCommitRecordPath, machineStatePath } from "../../src/persistence/layout";
import { installDropboxMock } from "../helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-28T17:00:00.000Z";

async function submit(projectId: string, transaction: unknown): Promise<Response> {
  return testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    }
  );
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

  it("fails closed with structured diagnostics when v1_only encounters durable ProjectState V2 history", async () => {
    const projectId = "PRJ-9005";
    const mock = installDropboxMock();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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

    await expect(submit(projectId, task)).rejects.toThrow(
      /writer stage regression.*core_v2.*v1_only|durable frontier core_v2/i
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "Project OS schema compatibility failure",
      expect.objectContaining({
        project_id: projectId,
        family: "ProjectState",
        encountered_version: "2.0",
        semantic_version: "2.0",
        canonical_revision: 1,
        deployment_identity: expect.any(String),
        failure_class: "writer_stage_regression",
        active_writer_stage: "v1_only",
        frontier: "core_v2"
      })
    );

    // The old binary must not down-encode, append a new commit, or materialize
    // a V1 snapshot after observing the core_v2 rollback frontier.
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    expect(mock.files.has(machineStatePath(projectId))).toBe(false);
  });
});
