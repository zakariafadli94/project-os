import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function createProject() {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST",
    headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-DOCROUTE-PROJECT-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T23:10:00+01:00",
      payload: { name: "Document Route", slug: "document-route", aliases: [], objective: "Managed document ingress" }
    })
  }), testEnv, ctx);
  expect(response.status).toBe(200);
  return response.json<{ project_id: string }>();
}

describe("managed-document Worker ingress", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("requires authentication and routes a strict working.write request", async () => {
    const mock = installDropboxMock();
    const project = await createProject();
    const content = "# Commercial strategy\n\nRouted through Worker";
    const body = {
      operation: "working.write",
      request_id: "DOCREQ-ROUTE-00000001",
      project_id: project.project_id,
      logical_path: "strategy/commercial.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: "2026-08-24T23:11:00+01:00"
    };

    const unauthorized = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "committed",
      project_id: project.project_id,
      stage: "working",
      logical_path: "strategy/commercial.md"
    });
    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-document-route/WORKING/strategy/commercial.md`))
      .toContain(content);
  });

  it("rejects an invalid managed-document schema before routing", async () => {
    const response = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "working.write", project_id: "PRJ-0001", logical_path: "../secret" })
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_document_request" });
  });
});
