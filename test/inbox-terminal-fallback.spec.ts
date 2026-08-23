import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("inbox terminal archival fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes terminal then removes source when inbox move conflicts before destination exists", async () => {
    const mock = installDropboxMock({ moveConflicts: 1 });
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-ARCHIVE-FALLBACK-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-23T02:02:00.000Z",
      payload: { name: "Archive Fallback", slug: "archive-fallback", aliases: [], objective: "Verify inbox archival fallback" }
    };
    const raw = JSON.stringify(transaction);
    const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
    const committed = `/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`;
    mock.files.set(incoming, raw);

    const ctx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(mock.files.get(committed)).toBe(raw);
    expect(mock.files.has(incoming)).toBe(false);
  });
});
