import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { machineReceiptPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
let dropbox: ReturnType<typeof installDropboxMock>;

beforeEach(() => { dropbox = installDropboxMock(); });

it("looks up an AUTO project creation by its original transaction ID", async () => {
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const transaction = {
    schema_version: "1.0",
    transaction_id: "TXN-CREATE-STATUS-0001",
    project_id: "PRJ-AUTO",
    base_revision: 0,
    operation: "project.create",
    created_at: "2026-09-24T09:00:00.000Z",
    payload: { name: "Status lookup", slug: "status-lookup", aliases: [], objective: "Recover a lost create response" }
  };

  const created = await registry.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(created.status).toBe(200);
  const originalReceipt = await created.json<Record<string, unknown>>();

  const status = await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.json()).toEqual({
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: originalReceipt.project_id,
    receipt: originalReceipt
  });

  await runInDurableObject(registry, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM requests WHERE transaction_id = ?", transaction.transaction_id);
  });
  const recovered = await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: originalReceipt.project_id,
    receipt: originalReceipt
  });

  const receiptPath = machineReceiptPath(transaction.transaction_id);
  const corruptedReceipt = JSON.parse(dropbox.files.get(receiptPath)!) as Record<string, unknown>;
  corruptedReceipt.transaction_id = "TXN-CREATE-STATUS-OTHER";
  dropbox.files.set(receiptPath, JSON.stringify(corruptedReceipt));
  const mismatched = await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(mismatched.status).toBe(503);
  expect(await mismatched.json()).toMatchObject({ status: "unknown", code: "create_status_unavailable" });

  dropbox.files.delete(receiptPath);
  const lostReceipt = await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(lostReceipt.status).toBe(200);
  expect(await lostReceipt.json()).toMatchObject({ status: "unknown", code: "canonical_evidence_not_found" });
});

it("returns unknown, never absence, when canonical provider reads fail", async () => {
  dropbox = installDropboxMock({ faults: Array.from({ length: 5 }, () => ({
    endpoint: "/2/files/download", path: machineReceiptPath("TXN-CREATE-STATUS-PROVIDER"),
    occurrence: 1, status: 503, error_summary: "temporary_unavailable/"
  })) });
  const status = await worker.fetch(new Request(
    "https://example.com/v1/project-creates/TXN-CREATE-STATUS-PROVIDER/request-status",
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(status.status).toBe(503);
  expect(await status.json()).toMatchObject({ status: "unknown", code: "create_status_unavailable" });
});

it("recovers an allocated create with the same ID without allocating a second project", async () => {
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const beforeAllocation = await runInDurableObject(registry, (_instance, state) => ({
    projectCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects").one().count,
    next: Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'next_project_number'").one().value)
  }));
  const transaction = {
    schema_version: "1.0",
    transaction_id: "TXN-CREATE-STATUS-ALLOCATED-0001",
    project_id: "PRJ-AUTO",
    base_revision: 0,
    operation: "project.create",
    created_at: "2026-09-24T09:10:00.000Z",
    payload: { name: "Allocated status", slug: "allocated-status", aliases: [], objective: "Retry same ID" }
  };
  let allocatedProjectId: string | null = null;
  const failedGuard = { getByName: (projectId: string) => ({ fetch: async () => {
    allocatedProjectId = projectId;
    return Response.json({ error: "temporary_guard_unavailable" }, { status: 503 });
  } }) };
  const initial = await runInDurableObject(registry, async (instance) => {
    const mutable = instance as unknown as { env: Env; fetch(request: Request): Promise<Response> };
    const projectGuard = mutable.env.PROJECT_GUARD;
    Object.assign(mutable.env, { PROJECT_GUARD: failedGuard });
    try {
      return await mutable.fetch(new Request("https://registry-guard.internal/create", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction)
      }));
    } finally {
      Object.assign(mutable.env, { PROJECT_GUARD: projectGuard });
    }
  });
  expect(initial.status).toBe(502);
  expect(allocatedProjectId).toMatch(/^PRJ-[0-9]{4,}$/);

  const pending = await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(await pending.json()).toMatchObject({ status: "pending", project_id: allocatedProjectId });

  const replay = await registry.fetch("https://registry-guard.internal/create", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction)
  });
  expect(replay.status).toBe(200);
  const receipt = await replay.json<Record<string, unknown>>();
  expect(receipt).toMatchObject({ status: "committed", project_id: allocatedProjectId });
  expect(await worker.fetch(new Request(
    `https://example.com/v1/project-creates/${transaction.transaction_id}/request-status`,
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext()).then(response => response.json())).toMatchObject({
    status: "committed", project_id: allocatedProjectId, receipt
  });
  const allocation = await runInDurableObject(registry, (_instance, state) => ({
    projectCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects").one().count,
    next: state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'next_project_number'").one().value
  }));
  expect(allocation).toEqual({ projectCount: beforeAllocation.projectCount + 1, next: String(beforeAllocation.next + 1) });
});

it("does not report absence when the Registry-local admission record is missing", async () => {
  const status = await worker.fetch(new Request(
    "https://example.com/v1/project-creates/TXN-CREATE-STATUS-UNKNOWN/request-status",
    { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
  ), testEnv, createExecutionContext());
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ status: "unknown", code: "canonical_evidence_not_found" });
});

it("requires an authorized reader for create status", async () => {
  const status = await worker.fetch(new Request(
    "https://example.com/v1/project-creates/TXN-CREATE-STATUS-UNKNOWN/request-status"
  ), testEnv, createExecutionContext());
  expect(status.status).toBe(401);
});
