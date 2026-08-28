import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("scheduled business priority", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not start maintenance until inbox processing completes", async () => {
    const mock = installDropboxMock();
    const createCtx = createExecutionContext();
    const createResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-PRIORITY-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-28T19:50:00.000Z",
        payload: {
          name: "Priority Project",
          slug: "priority-project",
          aliases: [],
          objective: "Prove business ingress priority"
        }
      })
    }), testEnv, createCtx);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json<{ project_id: string; new_revision: number }>();
    expect(created.new_revision).toBe(1);

    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-PRIORITY-RESEARCH-0001",
      project_id: created.project_id,
      base_revision: 1,
      operation: "research.add",
      created_at: "2026-08-28T19:51:00.000Z",
      payload: {
        research_id: "RES-PRIORITY001",
        title: "Business ingress priority",
        body: "Scheduled maintenance must never overtake an already-started inbox scan.",
        source: "Regression test"
      }
    };
    mock.files.set(
      `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`,
      JSON.stringify(transaction)
    );

    const delegate = mock.spy.getMockImplementation();
    if (!delegate) throw new Error("Dropbox mock implementation unavailable");

    let releaseInbox!: () => void;
    const inboxGate = new Promise<void>((resolve) => { releaseInbox = resolve; });
    let blockedInboxList = false;
    mock.spy.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!blockedInboxList && url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder") {
        blockedInboxList = true;
        await inboxGate;
      }
      return delegate(input, init);
    });

    const scheduledCtx = createExecutionContext();
    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, testEnv, scheduledCtx);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(blockedInboxList).toBe(true);
    expect(mock.calls).toHaveLength(0);

    releaseInbox();
    await waitOnExecutionContext(scheduledCtx);

    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });
});
