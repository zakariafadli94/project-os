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

  it("exposes layout-aware transaction and artifact inbox paths", () => {
    expect(inboxPath("legacy")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("shadow")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
    expect(inboxPath("v2")).toBe("/PROJECT_OS/.project-os/transactions/incoming");
    expect(artifactInboxPath("legacy")).toBe("/PROJECT_OS/ARTIFACTS/incoming");
    expect(artifactInboxPath("shadow")).toBe("/PROJECT_OS/ARTIFACTS/incoming");
    expect(artifactInboxPath("v2")).toBe("/PROJECT_OS/.project-os/artifacts/incoming");
  });

  it("returns health status", async () => {
    const response = await worker.fetch(new Request("https://example.com/health"), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("verifies Dropbox GET webhook challenge", async () => {
    const response = await worker.fetch(new Request("https://example.com/dropbox/webhook?challenge=abc123"), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });

  it("rejects invalid Dropbox webhook signatures and accepts valid wake-ups", async () => {
    const body = JSON.stringify({ list_folder: { accounts: ["dbid:test"] } });
    const invalid = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "X-Dropbox-Signature": "bad" },
      body
    }), testEnv, createExecutionContext());
    expect(invalid.status).toBe(403);

    const valid = await worker.fetch(new Request("https://example.com/dropbox/webhook", {
      method: "POST",
      headers: { "X-Dropbox-Signature": await hmac(body) },
      body
    }), testEnv, createExecutionContext());
    expect(valid.status).toBe(200);
  });

  it("routes project.create through RegistryGuard", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ROUTE-CREATE-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-20T18:00:00.000Z",
        payload: { name: "Route Create", slug: "route-create", aliases: [], objective: "Test route" }
      })
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "committed" });
  });

  it("routes normal transactions through ProjectGuard", async () => {
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const create = await registry.fetch("https://registry-guard.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ROUTE-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-20T18:00:00.000Z",
        payload: { name: "Route Project", slug: "route-project", aliases: [], objective: "Test route" }
      })
    });
    const created = await create.json<{ project_id: string }>();
    const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ROUTE-TASK-0001",
        project_id: created.project_id,
        base_revision: 1,
        operation: "task.create",
        created_at: "2026-08-20T18:01:00.000Z",
        payload: { task_id: "TASK-ROUTE0001", title: "Route task" }
      })
    }), testEnv, createExecutionContext());
    expect(await response.json()).toMatchObject({ status: "committed" });
  });

  it("recovers an unprocessed incoming transaction from the scheduled handler and clears exact replay", async () => {
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
    const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
    const committed = `/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`;
    const raw = JSON.stringify(transaction);
    mock.files.set(incoming, raw);

    const ctx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);

    mock.files.set(incoming, raw);
    const replayCtx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, replayCtx);
    await waitOnExecutionContext(replayCtx);

    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);
  });

  it("processes an artifact inbox request through ProjectGuard, publishes a receipt, and clears exact replay", async () => {
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
    const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`;
    const committed = `/PROJECT_OS/.project-os/artifacts/committed/${requestId}.json`;
    const raw = JSON.stringify(artifact);
    mock.files.set(incoming, raw);

    const scheduledCtx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, scheduledCtx);
    await waitOnExecutionContext(scheduledCtx);

    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-artifact-inbox/ARTIFACTS/playbooks/inbox.md`)).toBe(content);
    expect(mock.files.has(`/PROJECT_OS/.project-os/artifacts/receipts/${requestId}.json`)).toBe(true);
    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);

    mock.files.set(incoming, raw);
    const replayCtx = createExecutionContext();
    await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, replayCtx);
    await waitOnExecutionContext(replayCtx);

    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);
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
        transaction_id: "TXN-MAT-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-20T18:00:00.000Z",
        payload: { name: "Materialize", slug: "materialize", aliases: [], objective: "Test materialize" }
      })
    }), testEnv, ctx);
    const project = await create.json<{ project_id: string }>();
    const response = await worker.fetch(new Request("https://example.com/v1/admin/workspace-v2/materialize", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [project.project_id] })
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-materialize/STATE.md`)).toBe(true);
  });
});
