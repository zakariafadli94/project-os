import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import type { MutationContext } from "../src/admission/mutation-context";
import { createControlTowerServer } from "../src/control-tower/mcp";
import type { Transaction } from "../src/domain/transaction";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import worker from "../src/index";
import fallbackWorker from "../src/index-mutation-gate";
import { exportP256PublicJwk, encryptFallbackPayload, generateP256EcdhKeyPair, decryptFallbackPayload } from "../src/fallback/crypto";
import { parseFallbackEncryptedResponseJson, parseFallbackPublicKeyResponse } from "../src/fallback/contract";
import { machineTransactionPath } from "../src/persistence/layout";
import { requestDigest } from "../src/persistence/observation";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const auth = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };

async function contextFor(projectId: string): Promise<MutationContext> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/mutation-context?include_state=false",
    { headers: auth }
  );
  expect(response.status).toBe(200);
  return (await response.json<{ context: MutationContext }>()).context;
}

async function fallbackSubmit(transaction: Transaction, mutationContext: MutationContext, exchangeId = "fallback-exchange-entry-parity-0001") {
  const keyResponse = await fallbackWorker.fetch(new Request("https://example.com/v1/fallback-ingress/key"), testEnv, createExecutionContext());
  const server = parseFallbackPublicKeyResponse(await keyResponse.json());
  const caller = await generateP256EcdhKeyPair();
  const envelope = encodeAdmission(transaction, mutationContext);
  const encrypted = await encryptFallbackPayload({
    key_id: server.key_id,
    request_id: exchangeId,
    operation: "transaction",
    direction: "client_to_server",
    sender_private_key: caller.privateKey,
    recipient_public_key: server.server_public_key,
    plaintext: new TextEncoder().encode(JSON.stringify({ operation: "transaction", request_id: exchangeId, admission_json: JSON.stringify(envelope) }))
  });
  const response = await fallbackWorker.fetch(new Request("https://example.com/v1/fallback-ingress", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ schema_version: "1.0", key_id: server.key_id, request_id: exchangeId, operation: "transaction", caller_public_key: await exportP256PublicJwk(caller.publicKey), ...encrypted })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const encryptedResponse = parseFallbackEncryptedResponseJson(await response.text());
  const plaintext = await decryptFallbackPayload({
    key_id: server.key_id, request_id: exchangeId, operation: "transaction", direction: "server_to_client",
    recipient_private_key: caller.privateKey, sender_public_key: server.server_public_key,
    iv: encryptedResponse.iv, ciphertext: encryptedResponse.ciphertext
  });
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

it("keeps one canonical transaction identity and receipt across API, inbox, Control Tower and fallback", async () => {
  const mock = installDropboxMock();
  const create: Transaction = {
    schema_version: "1.0", transaction_id: "TXN-ENTRY-PARITY-CREATE-01", project_id: "PRJ-AUTO", base_revision: 0,
    operation: "project.create", created_at: "2026-09-24T10:00:00.000Z",
    payload: { name: "Entry parity", slug: "entry-parity", aliases: [], objective: "Exercise all transaction entry points" }
  };
  const createdResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(create)
  }), testEnv, createExecutionContext());
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json<{ project_id: string; status: string }>();
  expect(created.status).toBe("committed");

  const transaction: Transaction = {
    schema_version: "1.0", transaction_id: "TXN-ENTRY-PARITY-RESEARCH-01", project_id: created.project_id, base_revision: 1,
    operation: "research.add", created_at: "2026-09-24T10:01:00.000Z",
    payload: { research_id: "RES-ENTRYPARITY0001", title: "One business request", body: "Same canonical payload through four entry points." }
  };
  const businessDigest = await requestDigest(transaction);
  const context1 = await contextFor(created.project_id);
  expect(await requestDigest(encodeAdmission(transaction, context1).request)).toBe(businessDigest);
  const apiResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(transaction, context1))
  }), testEnv, createExecutionContext());
  expect(apiResponse.status).toBe(200);
  const apiReceipt = await apiResponse.json<Record<string, unknown>>();
  expect(apiReceipt).toMatchObject({ transaction_id: transaction.transaction_id, status: "committed" });

  // The incoming copy changes object key order and has no stale admission envelope.
  const reordered: Transaction = {
    payload: { body: transaction.payload.body, research_id: (transaction.payload as any).research_id, title: transaction.payload.title },
    operation: transaction.operation,
    created_at: transaction.created_at,
    base_revision: transaction.base_revision,
    project_id: transaction.project_id,
    transaction_id: transaction.transaction_id,
    schema_version: transaction.schema_version
  };
  expect(await requestDigest(reordered)).toBe(businessDigest);
  mock.files.set(machineTransactionPath("incoming", transaction.transaction_id), JSON.stringify({
    ...reordered,
    payload: { body: transaction.payload.body, title: transaction.payload.title, research_id: (transaction.payload as any).research_id }
  }));
  const inboxResponse = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", { method: "POST", headers: auth }), testEnv, createExecutionContext());
  expect(inboxResponse.status).toBe(200);
  expect(await inboxResponse.json()).toMatchObject({ processed: 1, failed: 0 });
  expect(mock.files.has(machineTransactionPath("committed", transaction.transaction_id))).toBe(true);
  const inboxReceiptResponse = await testEnv.PROJECT_GUARD.getByName(created.project_id).fetch(
    `https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`,
    { headers: auth }
  );
  const inboxReceipt = await inboxReceiptResponse.json<Record<string, unknown>>();

  // Control Tower obtains its own fresh context; client cannot select one.
  const tower = createControlTowerServer(testEnv as unknown as Parameters<typeof createControlTowerServer>[0], { read: true, mutate: true }) as any;
  const towerResult = await tower._registeredTools.project_os_submit_transaction.handler({ project_id: created.project_id, request: { ...transaction, payload: { ...transaction.payload } } });
  expect(towerResult.isError).not.toBe(true);
  const towerReceipt = JSON.parse(towerResult.content[0].text);

  // Fallback encrypts a newly-issued admission envelope, but exchange identity is transport-only.
  const context2 = await contextFor(created.project_id);
  expect(context2.token).not.toBe(context1.token);
  expect(await requestDigest(encodeAdmission(transaction, context2).request)).toBe(businessDigest);
  const fallbackReceipt = await fallbackSubmit(transaction, context2);
  expect(fallbackReceipt).toMatchObject({
    status: "ok", operation: "transaction", response_status: 200,
    receipt: { status: "committed", transaction_id: transaction.transaction_id }
  });

  const receiptKeys = (value: Record<string, unknown>) => ({ status: value.status, transaction_id: value.transaction_id, project_id: value.project_id, new_revision: value.new_revision });
  expect(receiptKeys(inboxReceipt)).toEqual(receiptKeys(apiReceipt));
  expect(receiptKeys(towerReceipt)).toEqual(receiptKeys(apiReceipt));
  expect(receiptKeys(fallbackReceipt.receipt as Record<string, unknown>)).toEqual(receiptKeys(apiReceipt));
  expect(mock.files.has(machineTransactionPath("committed", transaction.transaction_id))).toBe(true);

  const changed = { ...transaction, payload: { ...transaction.payload, title: "Different business request, same identity" } };
  const collision = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(changed, await contextFor(created.project_id)))
  }), testEnv, createExecutionContext());
  expect(collision.status).toBe(409);
  expect(await collision.json()).toMatchObject({ error: "idempotency_payload_mismatch" });
});

it("adjudicates new strict admissions and one existing domain refusal consistently across all four transaction entries", async () => {
  const mock = installDropboxMock();
  const create: Transaction = {
    schema_version: "1.0", transaction_id: "TXN-ENTRY-STRICT-CREATE-01", project_id: "PRJ-AUTO", base_revision: 0,
    operation: "project.create", created_at: "2026-09-24T11:00:00.000Z",
    payload: { name: "Strict entry parity", slug: "strict-entry-parity", aliases: [], objective: "Exercise newly admitted transaction paths" }
  };
  const createdResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(create)
  }), testEnv, createExecutionContext());
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json<{ project_id: string; status: string }>();
  expect(created.status).toBe("committed");
  const projectId = created.project_id;
  const signingKey = "strict-entry-parity-signing-key";
  const strictEnv = {
    ...testEnv,
    RULE_ADMISSION_SIGNING_KEY: signingKey,
    PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
  } as Env;
  await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, strictEnv);
  });
  await bootstrapRuleAdmissionGovernance(strictEnv, signingKey, projectId);

  const committedTransaction: Transaction = {
    schema_version: "1.0", transaction_id: "TXN-ENTRY-STRICT-SEED-01", project_id: projectId, base_revision: 1,
    operation: "research.add", created_at: "2026-09-24T11:01:00.000Z",
    payload: { research_id: "RES-STRICTENTRY0001", title: "Seed existing research", body: "The next requests collide with this typed invariant." }
  };
  const seedResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(committedTransaction, await contextFor(projectId)))
  }), strictEnv, createExecutionContext());
  expect(seedResponse.status).toBe(200);
  expect(await seedResponse.json()).toMatchObject({ status: "committed", new_revision: 2 });

  const newRequest = (transactionId: string, researchId: string, baseRevision: number): Transaction => ({
    schema_version: "1.0", transaction_id: transactionId, project_id: projectId, base_revision: baseRevision,
    operation: "research.add", created_at: "2026-09-24T11:01:30.000Z",
    payload: { research_id: researchId, title: "New strict admission", body: "One fresh identity per entry." }
  });
  const newInbox = newRequest("TXN-ENTRY-STRICT-INBOX-NEW", "RES-STRICTINBOX0001", 2);
  mock.files.set(machineTransactionPath("incoming", newInbox.transaction_id), JSON.stringify(newInbox));
  const newInboxResponse = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", { method: "POST", headers: auth }), strictEnv, createExecutionContext());
  expect(newInboxResponse.status).toBe(200);
  expect(await newInboxResponse.json()).toMatchObject({ processed: 1, failed: 0 });
  const newInboxReceiptResponse = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    `https://project-guard.internal/receipt?kind=transaction&request_id=${newInbox.transaction_id}`,
    { headers: auth }
  );
  const newInboxReceipt = await newInboxReceiptResponse.json<Record<string, unknown>>();
  expect(newInboxReceipt).toMatchObject({ status: "committed", new_revision: 3 });

  const newMcp = newRequest("TXN-ENTRY-STRICT-MCP-NEW", "RES-STRICTMCP00001", 3);
  const newTowerResult = await (createControlTowerServer(strictEnv as unknown as Parameters<typeof createControlTowerServer>[0], { read: true, mutate: true }) as any)
    ._registeredTools.project_os_submit_transaction.handler({ project_id: projectId, request: newMcp });
  expect(newTowerResult.isError).not.toBe(true);
  expect(JSON.parse(newTowerResult.content[0].text)).toMatchObject({ status: "committed", new_revision: 4 });

  const newFallback = newRequest("TXN-ENTRY-STRICT-FALLBACK-NEW", "RES-STRICTFALLB0001", 4);
  const newFallbackReceipt = await fallbackSubmit(newFallback, await contextFor(projectId), "fallback-exchange-entry-strict-new-0001");
  expect(newFallbackReceipt.receipt).toMatchObject({ status: "committed", new_revision: 5 });

  const requestFor = (transactionId: string): Transaction => ({
    schema_version: "1.0", transaction_id: transactionId, project_id: projectId, base_revision: 5,
    operation: "research.add", created_at: "2026-09-24T11:02:00.000Z",
    payload: { research_id: "RES-STRICTENTRY0001", title: "Duplicate canonical research", body: "Must be refused consistently." }
  });
  const requests = {
    api: requestFor("TXN-ENTRY-STRICT-API-01"),
    inbox: requestFor("TXN-ENTRY-STRICT-INBOX-01"),
    mcp: requestFor("TXN-ENTRY-STRICT-MCP-01"),
    fallback: requestFor("TXN-ENTRY-STRICT-FALLBACK-01")
  };

  const apiResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(requests.api, await contextFor(projectId)))
  }), strictEnv, createExecutionContext());
  expect(apiResponse.status).toBe(200);
  const apiReceipt = await apiResponse.json<Record<string, unknown>>();

  mock.files.set(machineTransactionPath("incoming", requests.inbox.transaction_id), JSON.stringify(requests.inbox));
  const inboxResponse = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", { method: "POST", headers: auth }), strictEnv, createExecutionContext());
  expect(inboxResponse.status).toBe(200);
  expect(await inboxResponse.json()).toMatchObject({ processed: 1, failed: 0 });
  expect([...mock.files.keys()].filter((path) => path.includes(requests.inbox.transaction_id))).toEqual(expect.arrayContaining([machineTransactionPath("rejected", requests.inbox.transaction_id)]));
  const inboxTerminal = JSON.parse(mock.files.get(machineTransactionPath("rejected", requests.inbox.transaction_id)) ?? "{}");
  const inboxReceipt = inboxTerminal.receipt as Record<string, unknown>;

  const tower = createControlTowerServer(strictEnv as unknown as Parameters<typeof createControlTowerServer>[0], { read: true, mutate: true }) as any;
  const towerResult = await tower._registeredTools.project_os_submit_transaction.handler({ project_id: projectId, request: requests.mcp });
  expect(towerResult.isError).toBe(true);
  const towerReceipt = JSON.parse(towerResult.content[0].text);

  const fallbackReceipt = await fallbackSubmit(requests.fallback, await contextFor(projectId), "fallback-exchange-entry-strict-0001");
  const result = (receipt: Record<string, unknown>) => ({ status: receipt.status, code: receipt.code });
  expect(result(apiReceipt)).toEqual({ status: "rejected", code: "RESEARCH_EXISTS" });
  expect(result(inboxReceipt)).toEqual(result(apiReceipt));
  expect(result(towerReceipt)).toEqual(result(apiReceipt));
  expect(result(fallbackReceipt.receipt as Record<string, unknown>)).toEqual(result(apiReceipt));

  // A separate, explicit collision scenario: same committed identity, changed payload.
  const changedSeed = { ...committedTransaction, payload: { ...committedTransaction.payload, title: "Changed under committed identity" } };
  const collisionApi = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(changedSeed, await contextFor(projectId)))
  }), strictEnv, createExecutionContext());
  expect(collisionApi.status).toBe(409);
  expect(await collisionApi.json()).toMatchObject({ error: "idempotency_payload_mismatch" });

  mock.files.set(machineTransactionPath("incoming", committedTransaction.transaction_id), JSON.stringify(changedSeed));
  const collisionInbox = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", { method: "POST", headers: auth }), strictEnv, createExecutionContext());
  expect(collisionInbox.status).toBe(200);
  expect(await collisionInbox.json()).toMatchObject({ processed: 1, failed: 0 });
  expect(JSON.parse(mock.files.get(machineTransactionPath("rejected", committedTransaction.transaction_id)) ?? "{}"))
    .toMatchObject({ status: "rejected", code: "idempotency_payload_mismatch" });

  const collisionTower = await (createControlTowerServer(strictEnv as unknown as Parameters<typeof createControlTowerServer>[0], { read: true, mutate: true }) as any)
    ._registeredTools.project_os_submit_transaction.handler({ project_id: projectId, request: changedSeed });
  expect(collisionTower.isError).toBe(true);
  expect(JSON.parse(collisionTower.content[0].text)).toMatchObject({ status: "rejected", code: "idempotency_payload_mismatch" });

  const collisionFallback = await fallbackSubmit(changedSeed, await contextFor(projectId), "fallback-exchange-entry-strict-collision-01");
  expect(collisionFallback).toMatchObject({ status: "ok", response_status: 409 });
  expect(collisionFallback.receipt).toMatchObject({ error: "idempotency_payload_mismatch" });
});
