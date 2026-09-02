import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Receipt } from "../src/domain/receipt";
import type { Env } from "../src/env";
import { machineMaterializationRecordPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const projectId = "PRJ-0005";
const at = "2026-09-01T17:30:00+01:00";

async function submit(transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard legacy alarm boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drains a legacy alarm without any Dropbox projection I/O", async () => {
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    const created = await submit({
      schema_version: "1.0",
      transaction_id: "TXN-ALARMSERIAL-CREATE-0001",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Alarm Serialization",
        slug: "alarm-serialization",
        aliases: [],
        objective: "Keep projection I/O outside ProjectGuard"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });

    const callsBeforeAlarm = mock.calls.length;
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(mock.calls).toHaveLength(callsBeforeAlarm);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(false);
  });
});