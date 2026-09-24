import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import { sha256Text } from "../src/documents/hash";
import { parseFallbackEncryptedResponseJson, parseFallbackPublicKeyResponse } from "../src/fallback/contract";
import { MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES } from "../src/fallback/contract";
import {
  decryptFallbackPayload,
  encryptFallbackPayload,
  exportP256PublicJwk,
  generateP256EcdhKeyPair
} from "../src/fallback/crypto";
import worker from "../src/index-mutation-gate";
import { machineCommitRecordPath } from "../src/dropbox/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";

const testEnv = env as unknown as Env;

function seed(projectId: string, through: number, mock = installDropboxMock()) {
  for (const record of commitFixture(projectId, through)) {
    mock.files.set(machineCommitRecordPath(projectId, record.new_revision), `${JSON.stringify(record, null, 2)}\n`);
  }
  return mock;
}

async function encryptedFallbackRequest(
  operation: "project_context" | "transaction",
  requestId: string,
  payload: Record<string, unknown>
) {
  const keyResponse = await worker.fetch(new Request("https://example.com/v1/fallback-ingress/key"), testEnv, createExecutionContext());
  const server = parseFallbackPublicKeyResponse(await keyResponse.json());
  const caller = await generateP256EcdhKeyPair();
  const encrypted = await encryptFallbackPayload({
    key_id: server.key_id,
    request_id: requestId,
    operation,
    direction: "client_to_server",
    sender_private_key: caller.privateKey,
    recipient_public_key: server.server_public_key,
    plaintext: new TextEncoder().encode(JSON.stringify({ operation, request_id: requestId, ...payload }))
  });
  return {
    server,
    caller,
    body: JSON.stringify({
      schema_version: "1.0",
      key_id: server.key_id,
      request_id: requestId,
      operation,
      caller_public_key: await exportP256PublicJwk(caller.publicKey),
      ...encrypted
    })
  };
}

async function encryptedContextRequest(projectId: string, requestId: string) {
  return encryptedFallbackRequest("project_context", requestId, { project_id: projectId });
}

async function submitFallbackRequest(
  operation: "project_context" | "transaction",
  requestId: string,
  payload: Record<string, unknown>
) {
  const exchange = await encryptedFallbackRequest(operation, requestId, payload);
  const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
    method: "POST",
    headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
    body: exchange.body
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  return decryptResponse(await response.text(), exchange.server, exchange.caller, requestId, operation);
}

async function decryptResponse(
  raw: string,
  server: Awaited<ReturnType<typeof parseFallbackPublicKeyResponse>>,
  caller: CryptoKeyPair,
  requestId: string,
  operation: "project_context" | "transaction" = "project_context"
) {
  const response = parseFallbackEncryptedResponseJson(raw);
  const plaintext = await decryptFallbackPayload({
    key_id: server.key_id,
    request_id: requestId,
    operation,
    direction: "server_to_client",
    recipient_private_key: caller.privateKey,
    sender_public_key: server.server_public_key,
    iv: response.iv,
    ciphertext: response.ciphertext
  });
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

describe("encrypted fallback ingress", () => {
  beforeEach(() => installDropboxMock());

  it("publishes only a non-cacheable bootstrap key and no project state", async () => {
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress/key"), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain("canonical_state");
    expect(parseFallbackPublicKeyResponse(JSON.parse(raw))).toMatchObject({ server_public_key: { crv: "P-256" } });
  });

  it("returns compact canonical context and the true signed mutation context only inside the encrypted response", async () => {
    const projectId = "PRJ-9940";
    seed(projectId, 2);
    const requestId = "fallback-request-20260909-context01";
    const exchange = await encryptedContextRequest(projectId, requestId);

    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: exchange.body
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain(projectId);

    const body = await decryptResponse(raw, exchange.server, exchange.caller, requestId);
    expect(body).toMatchObject({
      status: "ok",
      operation: "project_context",
      request_id: requestId,
      project: { identity: { project_id: projectId }, revision: 2 },
      mutation_context: { project_id: projectId, canonical_revision: 2 }
    });
  });

  it("keeps canonical unavailability opaque to the public route and encrypted to the caller", async () => {
    const projectId = "PRJ-9941";
    const requestId = "fallback-request-20260909-unavailable";
    const exchange = await encryptedContextRequest(projectId, requestId);
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: exchange.body
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("canonical_unavailable");
    await expect(decryptResponse(raw, exchange.server, exchange.caller, requestId)).resolves.toEqual({
      status: "unavailable",
      operation: "project_context",
      request_id: requestId,
      code: "canonical_unavailable"
    });
  });

  it("encrypts canonical-record inconsistency as unavailable instead of exposing a relay parsing error", async () => {
    const requestId = "fallback-request-20260909-inconsistent";
    const exchange = await encryptedContextRequest("PRJ-9947", requestId);
    const inconsistentProjectGuard = {
      getByName: () => ({ fetch: async () => Response.json({ context: null, canonical_state: null }) })
    };
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: exchange.body
    }), {
      ...testEnv,
      PROJECT_GUARD: inconsistentProjectGuard
    } as unknown as Env, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(decryptResponse(await response.text(), exchange.server, exchange.caller, requestId)).resolves.toEqual({
      status: "unavailable",
      operation: "project_context",
      request_id: requestId,
      code: "canonical_unavailable"
    });
  });

  it("rejects unauthenticated relay input before issuing a fallback result", async () => {
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "fallback_ingress_unavailable" });
  });

  it("rejects declared and measured oversized relay input without an encrypted business result", async () => {
    const oversized = "A".repeat(MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES + 1);
    const headerSets: HeadersInit[] = [
      { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json", "content-length": String(MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES + 1) },
      { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" }
    ];
    for (const headers of headerSets) {
      const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
        method: "POST",
        headers,
        body: oversized
      }), testEnv, createExecutionContext());
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "fallback_ingress_unavailable" });
    }
  });

  it("returns only the opaque public error if response encryption becomes unavailable", async () => {
    const projectId = "PRJ-9946";
    seed(projectId, 1);
    const unavailableRegistry = {
      getByName: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (path === "/fallback/decrypt") {
            return Response.json({
              key_id: "fkey_response_failure_20260909",
              request_id: "fallback-request-20260909-response-failure",
              operation: "project_context",
              plaintext: JSON.stringify({
                operation: "project_context",
                request_id: "fallback-request-20260909-response-failure",
                project_id: projectId
              })
            });
          }
          return Response.json({ error: "fallback_response_unavailable" }, { status: 503 });
        }
      })
    };
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: "{}"
    }), {
      ...testEnv,
      REGISTRY_GUARD: unavailableRegistry
    } as unknown as Env, createExecutionContext());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain(projectId);
    expect(JSON.parse(raw)).toEqual({ error: "fallback_ingress_unavailable" });
  });

  it("recovers a committed fallback exchange after its POST response is lost and the key rotates", async () => {
    const projectId = "PRJ-9942";
    const mock = seed(projectId, 1);
    await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: "synthetic-context-secret-for-vitest-only",
        RULE_ADMISSION_SIGNING_KEY: "synthetic-context-secret-for-vitest-only"
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-context-secret-for-vitest-only", projectId);
    const contextRequestId = "fallback-request-20260909-transaction-context";
    const contextExchange = await encryptedContextRequest(projectId, contextRequestId);
    const contextResponse = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: contextExchange.body
    }), testEnv, createExecutionContext());
    const contextBody = await decryptResponse(
      await contextResponse.text(), contextExchange.server, contextExchange.caller, contextRequestId
    );
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-FALLBACK-20260909-9942-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-FALLBACK9942A", title: "Encrypted fallback transaction" }
    };
    const admissionJson = JSON.stringify(encodeAdmission(
      transaction,
      contextBody.mutation_context as Parameters<typeof encodeAdmission>[1]
    ));
    const transactionRequestId = "fallback-request-20260909-transaction-submit";
    const keyResponse = await worker.fetch(new Request("https://example.com/v1/fallback-ingress/key"), testEnv, createExecutionContext());
    const server = parseFallbackPublicKeyResponse(await keyResponse.json());
    const caller = await generateP256EcdhKeyPair();
    const encrypted = await encryptFallbackPayload({
      key_id: server.key_id,
      request_id: transactionRequestId,
      operation: "transaction",
      direction: "client_to_server",
      sender_private_key: caller.privateKey,
      recipient_public_key: server.server_public_key,
      plaintext: new TextEncoder().encode(JSON.stringify({
        operation: "transaction",
        request_id: transactionRequestId,
        admission_json: admissionJson
      }))
    });
    const response = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        key_id: server.key_id,
        request_id: transactionRequestId,
        operation: "transaction",
        caller_public_key: await exportP256PublicJwk(caller.publicKey),
        ...encrypted
      })
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    // Simulate a lost client response: leave the encrypted body unread and do not retry POST.
    expect(response.bodyUsed).toBe(false);
    const rotatedKeyResponse = await worker.fetch(new Request(
      "https://example.com/v1/fallback-ingress/key"
    ), testEnv, createExecutionContext());
    const rotatedKey = parseFallbackPublicKeyResponse(await rotatedKeyResponse.json());
    expect(rotatedKey.key_id).not.toBe(server.key_id);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);

    const recoveredStatus = await worker.fetch(new Request(
      `https://example.com/v1/fallback-ingress/status?exchange_id=${transactionRequestId}`,
      { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
    ), testEnv, createExecutionContext());
    expect(recoveredStatus.status).toBe(200);
    expect(recoveredStatus.headers.get("cache-control")).toBe("no-store");
    expect(await recoveredStatus.json()).toEqual({
      exchange_id: transactionRequestId,
      transaction_id: transaction.transaction_id,
      status: "finalizing",
      recovery: {
        durable_intent: true,
        state: "none",
        next_attempt_at: null,
        action: "check_status",
        owner: "client",
        requires_new_approval: false
      }
    });
    expect(await (await worker.fetch(new Request(
      `https://example.com/v1/fallback-ingress/status?exchange_id=${transactionRequestId}`,
      { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
    ), testEnv, createExecutionContext())).text()).not.toContain("receipt");

    await runInDurableObject(testEnv.REGISTRY_GUARD.getByName("global"), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests WHERE transaction_id = ?", transaction.transaction_id);
    });
    const afterLocalCacheLoss = await worker.fetch(new Request(
      `https://example.com/v1/fallback-ingress/status?exchange_id=${transactionRequestId}`,
      { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
    ), testEnv, createExecutionContext());
    expect(await afterLocalCacheLoss.json()).toMatchObject({ status: "finalizing", transaction_id: transaction.transaction_id });

    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const timedOut = await runInDurableObject(registry, async (instance) => {
      const mutable = instance as unknown as { env: Env; fetch(request: Request): Promise<Response> };
      const projectGuard = mutable.env.PROJECT_GUARD;
      Object.assign(mutable.env, {
        PROJECT_GUARD: { getByName: () => ({ fetch: () => new Promise<Response>(() => {}) }) }
      });
      try {
        return await mutable.fetch(new Request(
          `https://registry-guard.internal/fallback/status?exchange_id=${transactionRequestId}`,
          { headers: { "x-authority-sha256": await sha256Text(`Bearer ${testEnv.INGRESS_TOKEN}`) } }
        ));
      } finally {
        Object.assign(mutable.env, { PROJECT_GUARD: projectGuard });
      }
    });
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toMatchObject({ status: "unknown", code: "request_status_unavailable" });

    const differentAuthority = `${Date.now()}.${"a".repeat(64)}`;
    const foreignStatus = await worker.fetch(new Request(
      `https://example.com/v1/fallback-ingress/status?exchange_id=${transactionRequestId}`,
      { headers: { authorization: `Bearer ${differentAuthority}` } }
    ), { ...testEnv, CONTROL_TOWER_OPERATOR_TOKEN: differentAuthority } as Env, createExecutionContext());
    expect(foreignStatus.status).toBe(403);

    const foreignReplay = await encryptedFallbackRequest("transaction", "fallback-request-20260924-foreign-owner", {
      admission_json: admissionJson
    });
    const foreignReplayResponse = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${differentAuthority}`, "content-type": "application/json" },
      body: foreignReplay.body
    }), { ...testEnv, CONTROL_TOWER_OPERATOR_TOKEN: differentAuthority } as Env, createExecutionContext());
    expect(foreignReplayResponse.status).toBe(409);

    const changedExchange = await encryptedFallbackRequest("transaction", transactionRequestId, {
      admission_json: JSON.stringify(encodeAdmission({
        ...transaction,
        payload: { ...transaction.payload, title: "Changed under the same exchange ID" }
      }, contextBody.mutation_context as Parameters<typeof encodeAdmission>[1]))
    });
    const collision = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: changedExchange.body
    }), testEnv, createExecutionContext());
    expect(collision.status).toBe(409);

    const refreshedContext = await encryptedFallbackRequest("transaction", transactionRequestId, {
      admission_json: JSON.stringify(encodeAdmission(transaction, {
        ...(contextBody.mutation_context as NonNullable<Parameters<typeof encodeAdmission>[1]>),
        observed_at: "2026-09-24T09:00:01.000Z",
        expiry: "2026-09-24T09:05:01.000Z"
      }))
    });
    const refreshedResponse = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: refreshedContext.body
    }), testEnv, createExecutionContext());
    expect(refreshedResponse.status).toBe(200);

    const unknownStatus = await worker.fetch(new Request(
      "https://example.com/v1/fallback-ingress/status?exchange_id=fallback-request-20260924-not-found",
      { headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` } }
    ), testEnv, createExecutionContext());
    expect(await unknownStatus.json()).toMatchObject({ status: "unknown" });
  });

  it("returns the ordinary fail-closed admission result without a business mutation", async () => {
    const projectId = "PRJ-9943";
    const wrongProjectId = "PRJ-9944";
    const mock = seed(projectId, 1);
    seed(wrongProjectId, 1, mock);
    for (const id of [projectId, wrongProjectId]) {
      await runInDurableObject(testEnv.PROJECT_GUARD.getByName(id), (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, {
          PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [id]: "strict" }),
          MUTATION_CONTEXT_SIGNING_KEY: "synthetic-context-secret-for-vitest-only",
          RULE_ADMISSION_SIGNING_KEY: "synthetic-context-secret-for-vitest-only"
        });
      });
    }
    const context = await submitFallbackRequest(
      "project_context",
      "fallback-request-20260909-reject-context",
      { project_id: projectId }
    );
    const signedContext = context.mutation_context as Parameters<typeof encodeAdmission>[1];
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-FALLBACK-20260909-9943-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-FALLBACK9943A", title: "Must not mutate" }
    };
    const cases = [
      {
        name: "missing",
        requestId: "fallback-request-20260909-reject-missing",
        admission: encodeAdmission(transaction, null),
        expectedStatus: 428,
        expectedError: "mutation_context_missing"
      },
      {
        name: "forged",
        requestId: "fallback-request-20260909-reject-forged",
        admission: encodeAdmission(transaction, { ...signedContext!, token: "forged.invalid" }),
        expectedStatus: 428,
        expectedError: "mutation_context_invalid"
      },
      {
        name: "stale-base",
        requestId: "fallback-request-20260909-reject-stale",
        admission: encodeAdmission({ ...transaction, transaction_id: "TXN-FALLBACK-20260909-9943-0002", base_revision: 0 }, signedContext),
        expectedStatus: 409,
        expectedError: "mutation_context_stale"
      },
      {
        name: "wrong-project",
        requestId: "fallback-request-20260909-reject-project",
        admission: encodeAdmission({
          ...transaction,
          transaction_id: "TXN-FALLBACK-20260909-9944-0001",
          project_id: wrongProjectId,
          payload: { task_id: "TASK-FALLBACK9944A", title: "Wrong context project" }
        }, signedContext),
        expectedStatus: 409,
        expectedError: "mutation_context_stale"
      }
    ];

    for (const scenario of cases) {
      const response = await submitFallbackRequest("transaction", scenario.requestId, {
        admission_json: JSON.stringify(scenario.admission)
      });
      expect(response).toMatchObject({
        status: "ok",
        response_status: scenario.expectedStatus,
        receipt: { error: scenario.expectedError }
      });
    }
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    expect(mock.files.has(machineCommitRecordPath(wrongProjectId, 2))).toBe(false);
  });

  it("returns the original committed receipt for an exact fallback replay and rejects a changed transaction payload", async () => {
    const projectId = "PRJ-9945";
    seed(projectId, 1);
    await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: "synthetic-context-secret-for-vitest-only",
        RULE_ADMISSION_SIGNING_KEY: "synthetic-context-secret-for-vitest-only"
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-context-secret-for-vitest-only", projectId);
    const context = await submitFallbackRequest(
      "project_context",
      "fallback-request-20260909-replay-context",
      { project_id: projectId }
    );
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-FALLBACK-20260909-9945-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-FALLBACK9945A", title: "Replay once" }
    };
    const admission = JSON.stringify(encodeAdmission(
      transaction,
      context.mutation_context as Parameters<typeof encodeAdmission>[1]
    ));
    const committed = await submitFallbackRequest("transaction", "fallback-request-20260909-replay-first", { admission_json: admission });
    const replay = await submitFallbackRequest("transaction", "fallback-request-20260909-replay-second", { admission_json: admission });
    expect(committed).toMatchObject({ receipt: { status: "committed", new_revision: 2 } });
    expect(replay).toMatchObject({ receipt: { status: "committed", new_revision: 2 } });
    expect(replay.receipt).toEqual(committed.receipt);

    const changedExchange = await encryptedFallbackRequest("transaction", "fallback-request-20260909-replay-changed", {
      admission_json: JSON.stringify(encodeAdmission({
        ...transaction,
        payload: { ...transaction.payload, title: "Changed under same transaction id" }
      }, context.mutation_context as Parameters<typeof encodeAdmission>[1]))
    });
    const changed = await worker.fetch(new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: changedExchange.body
    }), testEnv, createExecutionContext());
    expect(changed.status).toBe(409);
  });
});
