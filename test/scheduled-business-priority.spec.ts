import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function hmac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(testEnv.DROPBOX_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createProject(transactionId: string, slug: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-28T19:50:00.000Z",
      payload: {
        name: "Priority Project",
        slug,
        aliases: [],
        objective: "Prove business ingress priority"
      }
    })
  }), testEnv, ctx);
  expect(response.status).toBe(200);
  const created = await response.json<{ project_id: string; new_revision: number }>();
  expect(created.new_revision).toBe(1);
  return created;
}

function blockFirstInboxList(mock: ReturnType<typeof installDropboxMock>) {
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

  return {
    releaseInbox,
    blocked: () => blockedInboxList
  };
}

describe("business ingress priority", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not start scheduled maintenance until inbox processing completes", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-PRIORITY-PROJECT-0001", "priority-project");
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

    const gate = blockFirstInboxList(mock);
    const scheduledCtx = createExecutionContext();
    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, testEnv, scheduledCtx);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = gate.blocked();
    const callsWhileInboxBlocked = [...mock.calls];

    gate.releaseInbox();
    await waitOnExecutionContext(scheduledCtx);

    expect(blocked).toBe(true);
    expect(callsWhileInboxBlocked).toHaveLength(0);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });

  it("does not start webhook maintenance until inbox processing completes", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-PRIORITY-PROJECT-0002", "priority-webhook-project");
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-PRIORITY-RESEARCH-0002",
      project_id: created.project_id,
      base_revision: 1,
      operation: "research.add",
      created_at: "2026-08-28T19:52:00.000Z",
      payload: {
        research_id: "RES-PRIORITY002",
        title: "Webhook business ingress priority",
        body: "Dropbox webhook maintenance must not overtake an already-started inbox scan.",
        source: "Regression test"
      }
    };
    mock.files.set(
      `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`,
      JSON.stringify(transaction)
    );

    const gate = blockFirstInboxList(mock);
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const webhookCtx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "x-dropbox-signature": await hmac(body) },
      body
    }), testEnv, webhookCtx);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = gate.blocked();
    const callsWhileInboxBlocked = [...mock.calls];

    gate.releaseInbox();
    await waitOnExecutionContext(webhookCtx);

    expect(blocked).toBe(true);
    expect(callsWhileInboxBlocked).toHaveLength(0);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });
});
