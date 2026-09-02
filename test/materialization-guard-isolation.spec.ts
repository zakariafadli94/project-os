import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { machineMaterializationRecordPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-02T07:20:00+01:00";

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
    const materializationNamespace = (testEnv as unknown as {
      MATERIALIZATION_GUARD?: DurableObjectNamespace;
    }).MATERIALIZATION_GUARD;

    expect(materializationNamespace).toBeDefined();
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
