import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { machineMaterializationRecordPath, workspaceProjectRoot } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-02T07:20:00+01:00";

function materializationNamespace(): DurableObjectNamespace {
  const namespace = (testEnv as unknown as {
    MATERIALIZATION_GUARD?: DurableObjectNamespace;
  }).MATERIALIZATION_GUARD;
  if (!namespace) throw new Error("MATERIALIZATION_GUARD binding is missing");
  return namespace;
}

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
          project_id: "PRJ-9999",
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "project_binding_mismatch" });
  });

  it("rejects invalid materialization targets", async () => {
    const response = await materializationNamespace().getByName("PRJ-3903").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3903",
          revision: -1,
          projection_version: 0
        })
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_materialization_target" });
  });

  it("accepts a target without synchronously writing human workspace output", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3904";
    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          revision: 7,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_id: projectId,
      requested: { revision: 7, projection_version: CURRENT_PROJECTION_VERSION }
    });
    const workspaceRoot = workspaceProjectRoot(projectId, "unused");
    expect(mock.uploadCalls.some((path) => path.startsWith(`${workspaceRoot}/`))).toBe(false);
  });

  it("does not let ProjectGuard own projection alarms", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3901";

    const receipt = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-MATISO-3901-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Materialization Isolation",
        slug: "materialization-isolation",
        aliases: [],
        objective: "Separate canonical and projection Durable Object I/O contexts"
      }
    });
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    expect(await runDurableObjectAlarm(testEnv.PROJECT_GUARD.getByName(projectId))).toBe(true);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(false);
  });
});
