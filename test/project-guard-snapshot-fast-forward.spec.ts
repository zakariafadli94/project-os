import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { Receipt } from "../src/domain/receipt";
import { normalizeProjectState } from "../src/domain/project-state-normalizer";
import { applyTransaction } from "../src/domain/transitions";
import type { Transaction } from "../src/domain/transaction";
import type { Env } from "../src/env";
import {
  machineCommitRecordPath,
  machineMaterializationHeadPath,
  machineStatePath
} from "../src/persistence/layout";
import { encodeProjectState } from "../src/schema/project-state";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T13:30:00+01:00";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard canonical snapshot catch-up", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fast-forwards a stale local cache from the verified machine snapshot instead of replaying every commit", async () => {
    // PRJ-0005 is intentionally part of the configured core-v2 floor in the
    // test environment. The scenario exercises V2 snapshot recovery and must
    // not weaken the fail-closed writer-stage regression guard.
    const projectId = "PRJ-0005";
    const mock = installDropboxMock();
    const projectionStub = testEnv.MATERIALIZATION_GUARD.getByName(projectId);

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-FASTFORWARD-1799-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Fast Forward",
        slug: "fast-forward",
        aliases: [],
        objective: "Bound canonical recovery reads"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });
    expect(await runDurableObjectAlarm(projectionStub)).toBe(true);

    let state = normalizeProjectState(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}"));
    expect(state.revision).toBe(1);

    for (let revision = 2; revision <= 12; revision += 1) {
      const transaction: Transaction = {
        schema_version: "1.0",
        transaction_id: `TXN-FASTFORWARD-1799-TASK-${String(revision).padStart(2, "0")}`,
        project_id: projectId,
        base_revision: state.revision,
        operation: "task.create",
        created_at: at,
        payload: {
          task_id: `TASK-FASTFORWARD${String(revision).padStart(3, "0")}`,
          title: `Synthetic canonical task ${revision}`
        }
      };
      const result = applyTransaction(state, transaction);
      if (result.kind !== "commit") throw new Error(`Unexpected synthetic transition: ${result.kind}`);
      const receipt: CanonicalCommitRecord["receipt"] = {
        schema_version: "1.0",
        transaction_id: transaction.transaction_id,
        status: "committed",
        project_id: projectId,
        previous_revision: state.revision,
        new_revision: result.state.revision,
        event_id: result.event.event_id,
        committed_at: transaction.created_at
      };
      const record = {
        schema_version: "1.0",
        project_id: projectId,
        previous_revision: state.revision,
        new_revision: result.state.revision,
        transaction,
        state: encodeProjectState(result.state, "provider_v2"),
        event: result.event,
        receipt
      };
      await mock.writeExternal(
        machineCommitRecordPath(projectId, result.state.revision),
        `${JSON.stringify(record, null, 2)}\n`
      );
      state = result.state;
    }

    await mock.writeExternal(
      machineStatePath(projectId),
      `${JSON.stringify(encodeProjectState(state, "provider_v2"), null, 2)}\n`
    );

    mock.downloadCalls.length = 0;
    const committed = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-FASTFORWARD-1799-AFTER-SNAPSHOT",
      project_id: projectId,
      base_revision: 12,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-FASTFORWARDAFTER", title: "Continue from verified snapshot" }
    });

    expect(committed).toMatchObject({ status: "committed", previous_revision: 12, new_revision: 13 });
    const commitReads = mock.downloadCalls.filter((path) => path.includes(`/projects/${projectId}/commits/`));
    const allowedCommitReads = new Set([
      machineCommitRecordPath(projectId, 12),
      machineCommitRecordPath(projectId, 13)
    ]);
    expect(commitReads).toContain(machineCommitRecordPath(projectId, 12));
    expect(commitReads).not.toContain(machineCommitRecordPath(projectId, 2));
    expect(commitReads.every((path) => allowedCommitReads.has(path))).toBe(true);
    expect(new Set(commitReads).size).toBeLessThanOrEqual(2);
    expect(commitReads.length).toBeLessThanOrEqual(3);
  });

  it("bounds search reconciliation and drain recovery from a verified materialization head", async () => {
    const projectId = "PRJ-0002";
    const mock = installDropboxMock();
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);
    const projectionStub = testEnv.MATERIALIZATION_GUARD.getByName(projectId);

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-SEARCH-FASTFORWARD-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Search Fast Forward",
        slug: "search-fast-forward",
        aliases: [],
        objective: "Bound search recovery reads"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });
    expect(await runDurableObjectAlarm(projectionStub)).toBe(true);

    let state = normalizeProjectState(JSON.parse(mock.files.get(machineStatePath(projectId)) ?? "{}"));
    const staleSnapshot = state;
    for (let revision = 2; revision <= 12; revision += 1) {
      const transaction: Transaction = {
        schema_version: "1.0",
        transaction_id: `TXN-SEARCH-FASTFORWARD-${String(revision).padStart(2, "0")}`,
        project_id: projectId,
        base_revision: state.revision,
        operation: "task.create",
        created_at: at,
        payload: {
          task_id: `TASK-SEARCHFAST${String(revision).padStart(3, "0")}`,
          title: `Search fast-forward task ${revision}`
        }
      };
      const result = applyTransaction(state, transaction);
      if (result.kind !== "commit") throw new Error(`Unexpected synthetic transition: ${result.kind}`);
      const receipt: CanonicalCommitRecord["receipt"] = {
        schema_version: "1.0",
        transaction_id: transaction.transaction_id,
        status: "committed",
        project_id: projectId,
        previous_revision: state.revision,
        new_revision: result.state.revision,
        event_id: result.event.event_id,
        committed_at: transaction.created_at
      };
      await mock.writeExternal(
        machineCommitRecordPath(projectId, result.state.revision),
        `${JSON.stringify({
          schema_version: "1.0",
          project_id: projectId,
          previous_revision: state.revision,
          new_revision: result.state.revision,
          transaction,
          state: encodeProjectState(result.state, "provider_v2"),
          event: result.event,
          receipt
        }, null, 2)}\n`
      );
      state = result.state;
    }
    const reconcileMaterialization = await projectionStub.fetch(
      "https://materialization-guard.internal/reconcile",
      { method: "POST" }
    );
    expect(reconcileMaterialization.status).toBe(200);
    expect(await runDurableObjectAlarm(projectionStub)).toBe(true);
    await mock.writeExternal(
      machineStatePath(projectId),
      `${JSON.stringify(encodeProjectState(staleSnapshot, "provider_v2"), null, 2)}\n`
    );
    await runInDurableObject(projectGuard, async (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM project_state");
    });
    mock.downloadCalls.length = 0;

    const response = await projectGuard.fetch("https://project-guard.internal/reconcile-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force_full: true })
    });
    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({ canonical_revision: 12 });
    const commitReads = mock.downloadCalls.filter((path) => path.includes(`/projects/${projectId}/commits/`));
    expect(commitReads).toContain(machineCommitRecordPath(projectId, 12));
    expect(commitReads).not.toContain(machineCommitRecordPath(projectId, 2));
    expect(new Set(commitReads).size).toBeLessThanOrEqual(3);
    expect(commitReads.length).toBeLessThanOrEqual(4);

    await runInDurableObject(projectGuard, async (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM project_state");
    });
    mock.downloadCalls.length = 0;
    const drain = await projectGuard.fetch("https://project-guard.internal/drain-search", { method: "POST" });
    expect(drain.status).toBe(200);
    await expect(drain.clone().json()).resolves.toMatchObject({ canonical_revision: 12 });
    const drainCommitReads = mock.downloadCalls.filter((path) => path.includes(`/projects/${projectId}/commits/`));
    expect(drainCommitReads).not.toContain(machineCommitRecordPath(projectId, 2));
    expect(drainCommitReads.length).toBeLessThanOrEqual(4);

    const headPath = machineMaterializationHeadPath(projectId);
    const head = JSON.parse(mock.files.get(headPath) ?? "{}");
    const materialization = JSON.parse(mock.files.get(head.record_path) ?? "{}");
    materialization.result_root_hash = "0".repeat(64);
    await mock.writeExternal(head.record_path, `${JSON.stringify(materialization, null, 2)}\n`);
    await runInDurableObject(projectGuard, async (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM project_state");
    });
    await expect(projectGuard.fetch(
      "https://project-guard.internal/reconcile-search",
      { method: "POST" }
    )).rejects.toThrow("Verified materialization head binding mismatch");
  });

  it("keeps a current-revision real commit minimal and preserves stale conflicts", async () => {
    const projectId = "PRJ-0006";
    const mock = installDropboxMock();
    const projectionStub = testEnv.MATERIALIZATION_GUARD.getByName(projectId);

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-HOTPATH-0001-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Commit Hot Path",
        slug: "commit-hot-path",
        aliases: [],
        objective: "Bound provider I/O for current-revision commits"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });
    expect(await runDurableObjectAlarm(projectionStub)).toBe(true);

    mock.calls.length = 0;
    mock.downloadCalls.length = 0;
    mock.uploadCalls.length = 0;

    const committed = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-HOTPATH-0002-COMMIT",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: {
        task_id: "TASK-HOTPATH001",
        title: "Current revision commit"
      }
    });

    expect(committed).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
    expect(mock.downloadCalls).not.toContain(machineStatePath(projectId));

    const nextCommitPath = machineCommitRecordPath(projectId, 2);
    expect(mock.downloadCalls.filter((path) => path === nextCommitPath)).toHaveLength(1);

    const providerCalls = mock.calls.filter((call) => call.startsWith("POST /2/files/"));
    expect(providerCalls).toHaveLength(3);

    mock.uploadCalls.length = 0;
    const stale = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-HOTPATH-0003-STALE",
      project_id: projectId,
      base_revision: 1,
      operation: "task.complete",
      created_at: at,
      payload: {
        task_id: "TASK-HOTPATH001"
      }
    });

    expect(stale).toMatchObject({
      status: "conflict",
      code: "STALE_REVISION",
      previous_revision: 2,
      new_revision: 2
    });
    expect(mock.uploadCalls).not.toContain(machineCommitRecordPath(projectId, 3));
  });
});
