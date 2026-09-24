import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

beforeEach(() => installDropboxMock());

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
