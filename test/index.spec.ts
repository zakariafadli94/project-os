import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { artifactInboxPath, inboxPath } from "../src/index";
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Worker routing", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("selects inbox path from layout mode", () => {
    expect(inboxPath("legacy")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("shadow")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("v2")).toBe("/PROJECT_OS/.project-os/transactions/incoming");
    expect(artifactInboxPath("legacy")).toBe("/PROJECT_OS/ARTIFACTS/incoming");
    expect(artifactInboxPath("shadow")).toBe("/PROJECT_OS/ARTIFACTS/incoming");
    expect(artifactInboxPath("v2")).toBe("/PROJECT_OS/.project-os/artifacts/incoming");
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
    mock.files.set(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`, JSON.stringify(transaction));
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "x-dropbox-signature": await hmac(body) },
      body
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`)).toBe(false);
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
    mock.files.set(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`, JSON.stringify(transaction));

    const ctx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`)).toBe(false);
  });

  it("processes an artifact inbox request through ProjectGuard and publishes a receipt", async () => {
    const mock = installDropboxMock();
    const ctx = createExecutionContext();
    const create = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ARTIFACT-INBOX-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-23T00:30:00.000Z",
        payload: { name: "Artifact Inbox", slug: "artifact-inbox", aliases: [], objective: "Test artifact inbox" }
      })
    }), testEnv, ctx);
    const project = await create.json<{ project_id: string }>();
    const content = "# Inbox artifact";
    const requestId = "ART-INBOX-000001";
    const artifact = {
      request_id: requestId,
      project_id: project.project_id,
      relative_path: "playbooks/inbox.md",
      content,
      content_sha256: await sha256(content),
      mode: "create"
    };
    mock.files.set(`/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`, JSON.stringify(artifact));

    const scheduledCtx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, scheduledCtx);
    await waitOnExecutionContext(scheduledCtx);

    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-artifact-inbox/ARTIFACTS/playbooks/inbox.md`)).toBe(content);
    expect(mock.files.has(`/PROJECT_OS/.project-os/artifacts/receipts/${requestId}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/artifacts/committed/${requestId}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`)).toBe(false);
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

  it("requires authentication on direct artifact ingress", async () => {
    const mock = installDropboxMock();
    const ctx = createExecutionContext();
    const create = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ARTIFACT-DIRECT-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-23T00:30:00.000Z",
        payload: { name: "Artifact Direct", slug: "artifact-direct", aliases: [], objective: "Test direct artifacts" }
      })
    }), testEnv, ctx);
    const project = await create.json<{ project_id: string }>();
    const content = "direct artifact";
    const artifact = {
      request_id: "ART-DIRECT-000001",
      project_id: project.project_id,
      relative_path: "direct/a.md",
      content,
      content_sha256: await sha256(content),
      mode: "create"
    };

    const unauthorized = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(artifact)
    }), testEnv, ctx);
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(artifact)
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "committed", request_id: artifact.request_id });
    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-artifact-direct/ARTIFACTS/direct/a.md`)).toBe(content);
  });

  it("requires auth and materializes existing projects without changing their revision", async () => {
    const mock = installDropboxMock();
    const ctx = createExecutionContext();

    const create = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ADMIN-MATERIALIZE-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-20T18:00:00.000Z",
        payload: { name: "Admin Project", slug: "admin-project", aliases: [], objective: "Test migration" }
      })
    }), testEnv, ctx);
    expect(create.status).toBe(200);
    const receipt = await create.json<{ project_id: string; new_revision: number }>();
    expect(receipt.new_revision).toBe(1);

    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/workspace-v2/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [receipt.project_id] })
    }), testEnv, ctx);
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/workspace-v2/materialize", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [receipt.project_id] })
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ project_id: receipt.project_id, status: "materialized", revision: 1 }]
    });
    expect(mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${receipt.project_id}-admin-project/PROJECT.md`)).toBe(true);
  });

  it("rejects staged artifacts before Durable Object routing while binary ingress is disabled", async () => {
    const ctx = createExecutionContext();
    const artifact = {
      request_id: "ART-BINARY-DISABLED-0001",
      project_id: "PRJ-0003",
      relative_path: "example.pdf",
      content_sha256: "a".repeat(64),
      source: {
        kind: "staged_provider_object",
        path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-DISABLED-0001/example.pdf",
        object_id: "id:source",
        revision_token: "rev-1",
        size: 100,
        integrity: { algorithm: "dropbox-content-hash", value: "hash" }
      },
      mode: "create"
    };
    const response = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(artifact)
    }), testEnv, ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "BINARY_ARTIFACT_INGRESS_DISABLED" });
  });
});
