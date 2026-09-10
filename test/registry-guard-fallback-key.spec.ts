import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { parseFallbackEncryptedResponseJson, parseFallbackPublicKeyResponse } from "../src/fallback/contract";
import {
  decryptFallbackPayload,
  encryptFallbackPayload,
  exportP256PublicJwk,
  generateP256EcdhKeyPair
} from "../src/fallback/crypto";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("RegistryGuard fallback key exchange", () => {
  beforeEach(() => installDropboxMock());

  it("issues a non-cacheable public P-256 key without exposing private material", async () => {
    const registry = testEnv.REGISTRY_GUARD.getByName("fallback-key-public");
    const response = await registry.fetch("https://registry-guard.internal/fallback/key");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain('"d"');
    expect(parseFallbackPublicKeyResponse(JSON.parse(raw))).toMatchObject({
      schema_version: "1.0",
      server_public_key: { kty: "EC", crv: "P-256" }
    });

    await runInDurableObject(registry, async (_instance, state) => {
      const metadata = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").toArray();
      expect(JSON.stringify(metadata)).not.toContain('"d"');
    });
  });

  it("decrypts a paired caller request, encrypts its response, and retires the key exactly once", async () => {
    const registry = testEnv.REGISTRY_GUARD.getByName("fallback-key-rotation");
    const publicResponse = await registry.fetch("https://registry-guard.internal/fallback/key");
    const server = parseFallbackPublicKeyResponse(await publicResponse.json());
    const caller = await generateP256EcdhKeyPair();
    const requestId = "fallback-request-20260909-rotate01";
    const encrypted = await encryptFallbackPayload({
      key_id: server.key_id,
      request_id: requestId,
      operation: "project_context",
      direction: "client_to_server",
      sender_private_key: caller.privateKey,
      recipient_public_key: server.server_public_key,
      plaintext: new TextEncoder().encode('{"operation":"project_context","project_id":"PRJ-1234"}')
    });
    const envelope = {
      schema_version: "1.0" as const,
      key_id: server.key_id,
      request_id: requestId,
      operation: "project_context" as const,
      caller_public_key: await exportP256PublicJwk(caller.publicKey),
      ...encrypted
    };

    const decrypted = await registry.fetch("https://registry-guard.internal/fallback/decrypt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    expect(decrypted.status).toBe(200);
    await expect(decrypted.json()).resolves.toMatchObject({
      key_id: server.key_id,
      request_id: requestId,
      operation: "project_context",
      plaintext: '{"operation":"project_context","project_id":"PRJ-1234"}'
    });

    const encryptedResponse = await registry.fetch("https://registry-guard.internal/fallback/encrypt-and-rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key_id: server.key_id,
        request_id: requestId,
        operation: "project_context",
        plaintext: '{"status":"ok"}'
      })
    });
    expect(encryptedResponse.status).toBe(200);
    const responseEnvelope = parseFallbackEncryptedResponseJson(await encryptedResponse.text());
    await expect(decryptFallbackPayload({
      key_id: server.key_id,
      request_id: requestId,
      operation: "project_context",
      direction: "server_to_client",
      recipient_private_key: caller.privateKey,
      sender_public_key: server.server_public_key,
      iv: responseEnvelope.iv,
      ciphertext: responseEnvelope.ciphertext
    })).resolves.toEqual(new TextEncoder().encode('{"status":"ok"}'));

    const replay = await registry.fetch("https://registry-guard.internal/fallback/decrypt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: "fallback_key_retired" });
  });

  it("fails closed after local fallback-session loss and issues a fresh exchange without touching registry metadata", async () => {
    const registry = testEnv.REGISTRY_GUARD.getByName("fallback-key-recovery");
    const initial = parseFallbackPublicKeyResponse(await (await registry.fetch(
      "https://registry-guard.internal/fallback/key"
    )).json());
    await runInDurableObject(registry, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM fallback_key_sessions");
    });

    const caller = await generateP256EcdhKeyPair();
    const encrypted = await encryptFallbackPayload({
      key_id: initial.key_id,
      request_id: "fallback-request-20260909-recover01",
      operation: "project_context",
      direction: "client_to_server",
      sender_private_key: caller.privateKey,
      recipient_public_key: initial.server_public_key,
      plaintext: new TextEncoder().encode('{"operation":"project_context","project_id":"PRJ-1234"}')
    });
    const lost = await registry.fetch("https://registry-guard.internal/fallback/decrypt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        key_id: initial.key_id,
        request_id: "fallback-request-20260909-recover01",
        operation: "project_context",
        caller_public_key: await exportP256PublicJwk(caller.publicKey),
        ...encrypted
      })
    });
    expect(lost.status).toBe(409);
    await expect(lost.json()).resolves.toEqual({ error: "fallback_key_retired" });

    const fresh = parseFallbackPublicKeyResponse(await (await registry.fetch(
      "https://registry-guard.internal/fallback/key"
    )).json());
    expect(fresh.key_id).not.toBe(initial.key_id);
    await runInDurableObject(registry, async (_instance, state) => {
      const requests = state.storage.sql.exec("SELECT * FROM requests").toArray();
      const projects = state.storage.sql.exec("SELECT * FROM projects").toArray();
      expect(requests).toEqual([]);
      expect(projects).toEqual([]);
    });
  });

  it("bounds abandoned fallback exchanges without retaining unrelated registry state", async () => {
    const registry = testEnv.REGISTRY_GUARD.getByName("fallback-key-bounded");
    for (let index = 0; index < 33; index += 1) {
      expect((await registry.fetch("https://registry-guard.internal/fallback/key")).status).toBe(200);
    }

    await runInDurableObject(registry, async (_instance, state) => {
      const sessions = state.storage.sql.exec("SELECT key_id FROM fallback_key_sessions").toArray();
      expect(sessions).toHaveLength(32);
      expect(state.storage.sql.exec("SELECT * FROM requests").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM projects").toArray()).toEqual([]);
    });
  });
});
