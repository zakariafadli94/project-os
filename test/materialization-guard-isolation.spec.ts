import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-02T07:20:00+01:00";

function materializationNamespace(): DurableObjectNamespace {
  const namespace = (testEnv as unknown as {
    MATERIALIZATION_GUARD?: DurableObjectNamespace;
  }).MATERIALIZATION_GUARD;
  if (!namespace) throw new Error("MATERIALIZATION_GUARD binding missing");
  return namespace;
}

async function createProject(projectId: string, slug: string, transactionId: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: slug,
        slug,
        aliases: [],
        objective: "Verify isolated materialization ownership"
      }
    })
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("MaterializationGuard isolation boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes a separate MATERIALIZATION_GUARD Durable Object binding", () => {
    expect(materializationNamespace()).toBeDefined();
  });

  it("rejects cross-project target requests", async () => {
    const response = await materializationNamespace().getByName("PRJ-3902").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3903",
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(409);
  });

  it("rejects invalid materialization targets", async () => {
    const response = await materializationNamespace().getByName("PRJ-3904").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3904",
          revision: -1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(400);
  });

  it("accepts a target without synchronously writing human workspace output", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3906";
    const receipt = await createProject(projectId, "target-handoff", "TXN-MATISO-3906-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const workspaceRoot = workspaceProjectRoot(projectId, "target-handoff");
    const filesBefore = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));

    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(200);

    const filesAfter = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));
    expect(filesAfter).toEqual(filesBefore);
  });

  it("owns projection execution in the separate MaterializationGuard alarm", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3905";
    const receipt = await createProject(projectId, "materialization-alarm", "TXN-MATISO-3905-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    const response = await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        revision: 1,
        projection_version: CURRENT_PROJECTION_VERSION
      })
    });
    expect(response.status).toBe(200);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(true);
  });

  it("reconciles and reports projection status from canonical machine state", async () => {
    installDropboxMock();
    const projectId = "PRJ-3907";
    const receipt = await createProject(projectId, "materialization-status", "TXN-MATISO-3907-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    const status = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("hands a committed canonical revision to MaterializationGuard automatically", async () => {
    installDropboxMock();
    const projectId = "PRJ-3909";
    const receipt = await createProject(projectId, "automatic-handoff", "TXN-MATISO-3909-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const status = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/status",
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("keeps projection hot state out of ProjectGuard", async () => {
    installDropboxMock();
    const projectId = "PRJ-3908";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "project-guard-canonical-only", "TXN-MATISO-3908-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const materializationTables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_%' ORDER BY name"
      ).toArray();
      expect(materializationTables).toEqual([]);
    });
  });

  it("does not let ProjectGuard own projection alarms", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3901";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "materialization-isolation", "TXN-MATISO-3901-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(projectGuard)).toBe(true);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(false);
  });
});
