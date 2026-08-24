import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T19:35:00+01:00";

async function createProject(transactionId: string): Promise<Receipt> {
  const suffix = transactionId.slice(-4).toLowerCase();
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Document ${suffix}`, slug: `document-${suffix}`, aliases: [], objective: "Managed docs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("ProjectGuard managed documents", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("writes a working document and exposes compact logical status", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Commercial strategy";
    const write = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36010001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content,
        content_sha256: await sha256Text(content),
        created_at: at
      })
    });
    expect(write.status).toBe(200);
    const receipt = await write.json<{ status: string; document_id: string; version_id: string; stage: string }>();
    expect(receipt).toMatchObject({ status: "committed", stage: "working" });

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(receipt.document_id)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    const body = await status.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      project_id: created.project_id,
      document_id: receipt.document_id,
      kind: "work_product",
      logical_path: "strategy/commercial.md",
      working_version_id: receipt.version_id,
      reconciliation_status: "clean"
    });
    expect(JSON.stringify(body)).not.toContain(content);
    expect(body).not.toHaveProperty("provider");
  });

  it("rejects request-id reuse with a different document payload", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0002");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const base = {
      operation: "working.write",
      request_id: "DOCREQ-WORK-36020001",
      project_id: created.project_id,
      logical_path: "strategy/commercial.md",
      content: "one",
      content_sha256: await sha256Text("one"),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    expect((await first.json<{ status: string }>()).status).toBe("committed");

    const changed = { ...base, content: "two", content_sha256: await sha256Text("two") };
    const second = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });
    expect(await second.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("fails closed when the Durable Object project binding differs", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0003");
    const guard = testEnv.PROJECT_GUARD.getByName("PRJ-9999");
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36030001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content: "x",
        content_sha256: await sha256Text("x"),
        created_at: at
      })
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "PROJECT_BINDING_MISMATCH" });
  });
});
