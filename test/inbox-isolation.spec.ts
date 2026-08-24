import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

describe("inbox entry isolation", () => {
  let mock: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { mock = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("continues with a healthy transaction after a poison entry cleanup conflict", async () => {
    const poisonId = "TXN-AAAA-POISON-000001";
    const poisonIncoming = `/PROJECT_OS/.project-os/transactions/incoming/${poisonId}.json`;
    const poisonRejected = `/PROJECT_OS/.project-os/transactions/rejected/${poisonId}.json`;
    mock.files.set(poisonIncoming, "{not-json");
    mock.files.set(poisonRejected, "different-existing-terminal");

    const healthy = {
      schema_version: "1.0",
      transaction_id: "TXN-ZZZZ-HEALTHY-000001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T07:40:00+01:00",
      payload: {
        name: "Healthy After Poison",
        slug: "healthy-after-poison",
        aliases: [],
        objective: "Prove one poison entry cannot block later inbox work"
      }
    };
    const healthyIncoming = `/PROJECT_OS/.project-os/transactions/incoming/${healthy.transaction_id}.json`;
    const healthyCommitted = `/PROJECT_OS/.project-os/transactions/committed/${healthy.transaction_id}.json`;
    mock.files.set(healthyIncoming, JSON.stringify(healthy));

    await expect(runScheduled()).resolves.toBeUndefined();

    expect(mock.files.has(poisonIncoming)).toBe(true);
    expect(mock.files.has(healthyCommitted)).toBe(true);
    expect(mock.files.has(healthyIncoming)).toBe(false);
  });
});
