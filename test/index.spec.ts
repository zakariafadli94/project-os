import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { inboxPath } from "../src/index";
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

describe("Worker routing", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("selects inbox path from layout mode", () => {
    expect(inboxPath("legacy")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("shadow")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("v2")).toBe("/PROJECT_OS/.project-os/transactions/incoming");
  });

  it("returns health status", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/health"), testEnv, ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns the exact Dropbox webhook challenge", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook?challenge=abc123"), testEnv, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects invalid Dropbox webhook signatures", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "x-dropbox-signature": "bad" },
      body: "{}"
    }), testEnv, ctx);
    expect(response.status).toBe(401);
  });

  it("accepts a valid Dropbox webhook and processes the inbox asynchronously", async () => {
    const mock = installDropboxMock();
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-WEBHOOK-00000001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { name: "Webhook Project", slug: "webhook-project", aliases: [], objective: "Verify ingress" }
    };
    mock.files.set(`/PROJECT_OS/TRANSACTIONS/incoming/${transaction.transaction_id}.json`, JSON.stringify(transaction));
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "x-dropbox-signature": await hmac(body) },
      body
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(mock.files.has(`/PROJECT_OS/TRANSACTIONS/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/TRANSACTIONS/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });

  it("recovers an unprocessed incoming transaction from the scheduled handler", async () => {
    const mock = installDropboxMock();
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-CRON-00000000001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { name: "Cron Project", slug: "cron-project", aliases: [], objective: "Recover missed webhook" }
    };
    mock.files.set(`/PROJECT_OS/TRANSACTIONS/incoming/${transaction.transaction_id}.json`, JSON.stringify(transaction));

    const ctx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(mock.files.has(`/PROJECT_OS/TRANSACTIONS/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/TRANSACTIONS/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });

  it("requires authentication and strict schema on direct transaction ingress", async () => {
    const ctx = createExecutionContext();
    const unauthorized = await worker.fetch(new Request("https://example.com/v1/transactions", { method: "POST", body: "{}" }), testEnv, ctx);
    expect(unauthorized.status).toBe(401);

    const malformed = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "edit_file", path: "../../secret" })
    }), testEnv, ctx);
    expect(malformed.status).toBe(400);
  });
});
