import { describe, expect, it } from "vitest";
import {
  FallbackContractError,
  MAX_FALLBACK_CIPHERTEXT_BYTES,
  parseFallbackDecryptedRequest,
  parseFallbackEncryptedRequestJson,
  parseFallbackPublicKeyResponse
} from "../src/fallback/contract";
import { exportP256PublicJwk, generateP256EcdhKeyPair } from "../src/fallback/crypto";

const keyId = "fallback-key-20260909-a1b2c3d4";
const requestId = "fallback-request-20260909-a1b2c3d4";

describe("fallback ingress contract", () => {
  it("accepts only a strict P-256 public key response", async () => {
    const server = await generateP256EcdhKeyPair();
    const parsed = parseFallbackPublicKeyResponse({
      schema_version: "1.0",
      key_id: keyId,
      server_public_key: await exportP256PublicJwk(server.publicKey)
    });

    expect(parsed.key_id).toBe(keyId);
    expect(parsed.server_public_key).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("rejects malformed, extended, duplicate and oversized encrypted request envelopes before decrypting", async () => {
    const caller = await generateP256EcdhKeyPair();
    const envelope = {
      schema_version: "1.0",
      key_id: keyId,
      request_id: requestId,
      operation: "project_context",
      caller_public_key: await exportP256PublicJwk(caller.publicKey),
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA"
    };

    expect(parseFallbackEncryptedRequestJson(JSON.stringify(envelope))).toMatchObject({ operation: "project_context" });
    expect(() => parseFallbackEncryptedRequestJson(JSON.stringify({ ...envelope, ciphertext: "not+base64" })))
      .toThrow(FallbackContractError);
    expect(() => parseFallbackEncryptedRequestJson(JSON.stringify({ ...envelope, unexpected: true })))
      .toThrow(FallbackContractError);
    expect(() => parseFallbackEncryptedRequestJson(JSON.stringify({
      ...envelope,
      caller_public_key: { ...envelope.caller_public_key, crv: "P-384" }
    }))).toThrow(FallbackContractError);
    expect(() => parseFallbackEncryptedRequestJson(`{"schema_version":"1.0","schema_version":"1.0",${JSON.stringify(envelope).slice(1)}`))
      .toThrow(FallbackContractError);
    expect(() => parseFallbackEncryptedRequestJson(JSON.stringify({
      ...envelope,
      ciphertext: "A".repeat(Math.ceil((MAX_FALLBACK_CIPHERTEXT_BYTES + 1) * 4 / 3))
    }))).toThrow(FallbackContractError);
  });

  it("accepts only an encrypted project context request or a strict admission envelope transaction", () => {
    expect(parseFallbackDecryptedRequest(JSON.stringify({
      operation: "project_context",
      request_id: requestId,
      project_id: "PRJ-1234"
    }))).toEqual({
      operation: "project_context",
      request_id: requestId,
      project_id: "PRJ-1234"
    });

    const admissionJson = JSON.stringify({
      admission_version: "1.0",
      mutation_context: null,
      request: {
        schema_version: "1.0",
        transaction_id: "TXN-FALLBACK-20260909-0001",
        project_id: "PRJ-1234",
        base_revision: 1,
        operation: "task.create",
        created_at: "2026-09-09T10:00:00.000Z",
        payload: { task_id: "TASK-FALLBACK2026A", title: "Fallback transaction" }
      }
    });
    const transaction = parseFallbackDecryptedRequest(JSON.stringify({
      operation: "transaction",
      request_id: requestId,
      admission_json: admissionJson
    }));
    expect(transaction).toMatchObject({ operation: "transaction", admission_json: admissionJson });

    expect(() => parseFallbackDecryptedRequest(JSON.stringify({
      operation: "transaction",
      request_id: requestId,
      admission_json: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-FALLBACK-20260909-0001",
        project_id: "PRJ-1234",
        base_revision: 1,
        operation: "task.create",
        created_at: "2026-09-09T10:00:00.000Z",
        payload: { task_id: "TASK-FALLBACK2026A", title: "Naked transaction" }
      })
    }))).toThrow(FallbackContractError);
  });
});
