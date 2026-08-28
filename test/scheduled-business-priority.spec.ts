import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
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

async function createProject() {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
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
  }), testEnv, ctx);
  expect(response.status).toBe(200);
  const created = await response.json<{ project_id: string; new_revision: number }>();
  expect(created.new_revision).toBe(1);
  return created;
}

function blockNextInboxList(mock: ReturnType<typeof installDropboxMock>) {
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

function researchTransaction(
  projectId: string,
  transactionId: string,
  researchId: string,
  baseRevision: number,
  createdAt: string,
  title: string
) {
  return {
    schema_version: "1.0",
    transaction_id: transactionId,
    project_id: projectId,
    base_revision: baseRevision,
    operation: "research.add",
    created_at: createdAt,
    payload: {
      research_id: researchId,
      title,
      body: "Maintenance must never overtake an already-started business inbox scan.",
      source: "Regression test"
    }
  };
}

describe("business ingress priority", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps scheduled and webhook maintenance behind inbox processing", async () => {
    const mock = installDropboxMock();
    const created = await createProject();

    const scheduledTransaction = researchTransaction(
      created.project_id,
      "TXN-PRIORITY-RESEARCH-0001",
      "RES-PRIORITY001",
      1,
      "2026-08-28T19:51:00.000Z",
      "Scheduled business ingress priority"
    );
    mock.files.set(
      `/PROJECT_OS/.project-os/transactions/incoming/${scheduledTransaction.transaction_id}.json`,
      JSON.stringify(scheduledTransaction)
    );

    const scheduledGate = blockNextInboxList(mock);
    const scheduledCtx = createExecutionContext();
    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, testEnv, scheduledCtx);

    const scheduledBaseline = mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const scheduledBlocked = scheduledGate.blocked();
    const scheduledCallsWhileBlocked = mock.calls.slice(scheduledBaseline);

    scheduledGate.releaseInbox();
    await waitOnExecutionContext(scheduledCtx);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${scheduledTransaction.transaction_id}.json`)).toBe(true);

    const webhookTransaction = researchTransaction(
      created.project_id,
      "TXN-PRIORITY-RESEARCH-0002",
      "RES-PRIORITY002",
      2,
      "2026-08-28T19:52:00.000Z",
      "Webhook business ingress priority"
    );
    mock.files.set(
      `/PROJECT_OS/.project-os/transactions/incoming/${webhookTransaction.transaction_id}.json`,
      JSON.stringify(webhookTransaction)
    );

    const webhookGate = blockNextInboxList(mock);
    const webhookBaseline = mock.calls.length;
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const webhookCtx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "x-dropbox-signature": await hmac(body) },
      body
    }), testEnv, webhookCtx);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const webhookBlocked = webhookGate.blocked();
    const webhookCallsWhileBlocked = mock.calls.slice(webhookBaseline);

    webhookGate.releaseInbox();
    await waitOnExecutionContext(webhookCtx);

    expect.soft(scheduledBlocked, "scheduled inbox scan should block").toBe(true);
    expect.soft(scheduledCallsWhileBlocked, "scheduled maintenance overtook inbox processing").toHaveLength(0);
    expect.soft(webhookBlocked, "webhook inbox scan should block").toBe(true);
    expect.soft(webhookCallsWhileBlocked, "webhook maintenance overtook inbox processing").toHaveLength(0);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${webhookTransaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${webhookTransaction.transaction_id}.json`)).toBe(false);
  });
});
