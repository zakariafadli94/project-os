import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker, { inboxPath } from "../src/index";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("Dropbox read/list resilience", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recovers an inbox scan when the first Dropbox folder listing fails transiently", async () => {
    const inbox = inboxPath("v2");
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/list_folder",
        path: inbox,
        occurrence: 1,
        status: 503,
        error_summary: "internal_error/transient_list_failure"
      }]
    });
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-DROPRES-LIST-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T06:50:00+01:00",
      payload: {
        name: "Dropbox List Recovery",
        slug: "dropbox-list-recovery",
        aliases: [],
        objective: "Prove transient list_folder recovery"
      }
    };
    mock.files.set(`${inbox}/${transaction.transaction_id}.json`, JSON.stringify(transaction));

    const ctx = createExecutionContext();
    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`${inbox}/${transaction.transaction_id}.json`)).toBe(false);
    expect(mock.calls.filter((call) => call === "POST /2/files/list_folder").length).toBeGreaterThanOrEqual(3);
  });
});
