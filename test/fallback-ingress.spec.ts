import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FallbackKeyResponse {
  schema_version: "1.0";
  algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM";
  key_id: string;
  public_key: JsonWebKey;
}

interface FallbackEnvelope {
  schema_version: "1.0";
  key_id: string;
  client_public_key: JsonWebKey;
  iv: string;
  ciphertext: string;
}

interface FallbackEncryptedResponse {
  schema_version: "1.0";
  key_id: string;
  iv: string;
  ciphertext: string;
}

interface ClientExchange {
  envelope: FallbackEnvelope;
  shared_secret: ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveAesKey(sharedSecret: ArrayBuffer, keyId: string, direction: "request" | "response"): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(keyId),
      info: encoder.encode(`project-os-fallback-${direction}-v1`)
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    direction === "request" ? ["encrypt"] : ["decrypt"]
  );
}

function additionalData(keyId: string, direction: "request" | "response"): Uint8Array {
  return encoder.encode(`project-os-fallback-v1:${keyId}:${direction}`);
}

async function fetchFallbackKey(): Promise<FallbackKeyResponse> {
  const response = await worker.fetch(
    new Request("https://example.com/v1/fallback-ingress/key"),
    testEnv,
    createExecutionContext()
  );
  expect(response.status).toBe(200);
  return response.json<FallbackKeyResponse>();
}

async function encryptFallbackRequest(key: FallbackKeyResponse, plaintext: unknown): Promise<ClientExchange> {
  const clientPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  const serverPublic = await crypto.subtle.importKey(
    "jwk",
    key.public_key,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPublic },
    clientPair.privateKey,
    256
  );
  const requestKey = await deriveAesKey(sharedSecret, key.key_id, "request");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(key.key_id, "request") },
    requestKey,
    encoder.encode(JSON.stringify(plaintext))
  );
  return {
    shared_secret: sharedSecret,
    envelope: {
      schema_version: "1.0",
      key_id: key.key_id,
      client_public_key: await crypto.subtle.exportKey("jwk", clientPair.publicKey),
      iv: base64UrlEncode(iv),
      ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
    }
  };
}

async function decryptFallbackResponse(
  keyId: string,
  sharedSecret: ArrayBuffer,
  response: FallbackEncryptedResponse
): Promise<any> {
  expect(response.schema_version).toBe("1.0");
  expect(response.key_id).toBe(keyId);
  expect(Object.keys(response).sort()).toEqual(["ciphertext", "iv", "key_id", "schema_version"]);
  const responseKey = await deriveAesKey(sharedSecret, keyId, "response");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(response.iv),
      additionalData: additionalData(keyId, "response")
    },
    responseKey,
    base64UrlDecode(response.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

async function exchange(plaintext: unknown, token = testEnv.INGRESS_TOKEN): Promise<{ status: number; body: FallbackEncryptedResponse; decrypted: any }> {
  const key = await fetchFallbackKey();
  const client = await encryptFallbackRequest(key, plaintext);
  const response = await worker.fetch(
    new Request("https://example.com/v1/fallback-ingress", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(client.envelope)
    }),
    testEnv,
    createExecutionContext()
  );
  const body = await response.json<FallbackEncryptedResponse>();
  const decrypted = response.status === 200
    ? await decryptFallbackResponse(key.key_id, client.shared_secret, body)
    : null;
  return { status: response.status, body, decrypted };
}

async function createProject(transactionId: string, slug: string): Promise<{ project_id: string; new_revision: number }> {
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-06T22:10:00+01:00",
      payload: {
        name: `Fallback ingress ${slug}`,
        slug,
        aliases: [],
        objective: "Encrypted connector outage fallback test"
      }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string; new_revision: number }>();
  expect(receipt.status).toBe("committed");
  return { project_id: receipt.project_id, new_revision: receipt.new_revision };
}

describe("encrypted Project OS fallback ingress", () => {
  it("exposes only a public encryption key without requiring ingress authorization", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/fallback-ingress/key"),
      testEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(testEnv.INGRESS_TOKEN);
    const body = JSON.parse(raw) as FallbackKeyResponse;
    expect(body).toMatchObject({
      schema_version: "1.0",
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM"
    });
    expect(body.key_id).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(body.public_key).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("fails closed when the encrypted exchange is not ingress-authorized", async () => {
    const key = await fetchFallbackKey();
    const client = await encryptFallbackRequest(key, {
      schema_version: "1.0",
      request_id: "FBK-AUTH-0001",
      operation: "project_context",
      project_id: "PRJ-0002"
    });
    const response = await worker.fetch(
      new Request("https://example.com/v1/fallback-ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(client.envelope)
      }),
      testEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns canonical project context encrypted end-to-end", async () => {
    const created = await createProject("TXN-FALLBACK-CONTEXT-0001", "fallback-context");
    const result = await exchange({
      schema_version: "1.0",
      request_id: "FBK-CONTEXT-0001",
      operation: "project_context",
      project_id: created.project_id
    });
    expect(result.status).toBe(200);
    expect(result.decrypted).toMatchObject({
      schema_version: "1.0",
      request_id: "FBK-CONTEXT-0001",
      operation: "project_context",
      result: {
        project_id: created.project_id,
        revision: created.new_revision
      }
    });
    expect(JSON.stringify(result.body)).not.toContain(created.project_id);
  });

  it("commits a typed transaction through the encrypted transport and replays it idempotently", async () => {
    const created = await createProject("TXN-FALLBACK-RELAY-0001", "fallback-relay");
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-FALLBACK-RESEARCH-0001",
      project_id: created.project_id,
      base_revision: created.new_revision,
      operation: "research.add",
      created_at: "2026-09-06T22:11:00+01:00",
      payload: {
        research_id: "RES-FALLBACK-0001",
        title: "Fallback ingress evidence",
        content: "Connector-independent encrypted ingress committed through the normal ProjectGuard transaction path."
      }
    };

    const first = await exchange({
      schema_version: "1.0",
      request_id: "FBK-TRANSACTION-0001",
      operation: "transaction",
      transaction
    });
    expect(first.status).toBe(200);
    expect(first.decrypted).toMatchObject({
      schema_version: "1.0",
      request_id: "FBK-TRANSACTION-0001",
      operation: "transaction",
      result: {
        transaction_id: transaction.transaction_id,
        project_id: created.project_id,
        status: "committed",
        previous_revision: created.new_revision,
        new_revision: created.new_revision + 1
      }
    });
    expect(JSON.stringify(first.body)).not.toContain(transaction.transaction_id);

    const replay = await exchange({
      schema_version: "1.0",
      request_id: "FBK-TRANSACTION-0002",
      operation: "transaction",
      transaction
    });
    expect(replay.status).toBe(200);
    expect(replay.decrypted.result).toEqual(first.decrypted.result);

    const context = await exchange({
      schema_version: "1.0",
      request_id: "FBK-CONTEXT-0002",
      operation: "project_context",
      project_id: created.project_id
    });
    expect(context.decrypted.result.revision).toBe(created.new_revision + 1);
  });
});
