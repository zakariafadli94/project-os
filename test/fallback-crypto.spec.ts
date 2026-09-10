import { describe, expect, it } from "vitest";
import {
  FallbackCryptoError,
  decryptFallbackPayload,
  encryptFallbackPayload,
  exportP256PublicJwk,
  generateP256EcdhKeyPair
} from "../src/fallback/crypto";

const metadata = {
  key_id: "fallback-key-20260909-a1b2c3d4",
  operation: "project_context" as const,
  request_id: "fallback-request-20260909-a1b2c3d4",
  direction: "client_to_server" as const
};

describe("fallback payload cryptography", () => {
  it("uses the worker runtime's exportable P-256 public JWK shape", async () => {
    const keyPair = await generateP256EcdhKeyPair();
    const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    expect(Object.keys(JSON.parse(JSON.stringify(exported))).sort()).toEqual(["crv", "ext", "key_ops", "kty", "x", "y"]);
    expect(exported).toMatchObject({ kty: "EC", crv: "P-256", ext: true, key_ops: [] });
  });

  it("round-trips a payload only for the paired P-256 keys and exact associated data", async () => {
    const caller = await generateP256EcdhKeyPair();
    const server = await generateP256EcdhKeyPair();
    const ciphertext = await encryptFallbackPayload({
      ...metadata,
      sender_private_key: caller.privateKey,
      recipient_public_key: await exportP256PublicJwk(server.publicKey),
      plaintext: new TextEncoder().encode('{"project_id":"PRJ-1234"}')
    });

    await expect(decryptFallbackPayload({
      ...metadata,
      recipient_private_key: server.privateKey,
      sender_public_key: await exportP256PublicJwk(caller.publicKey),
      ...ciphertext
    })).resolves.toEqual(new TextEncoder().encode('{"project_id":"PRJ-1234"}'));
  });

  it("rejects a ciphertext when its authenticated direction changes", async () => {
    const caller = await generateP256EcdhKeyPair();
    const server = await generateP256EcdhKeyPair();
    const ciphertext = await encryptFallbackPayload({
      ...metadata,
      sender_private_key: caller.privateKey,
      recipient_public_key: await exportP256PublicJwk(server.publicKey),
      plaintext: new TextEncoder().encode("secret")
    });

    await expect(decryptFallbackPayload({
      ...metadata,
      direction: "server_to_client",
      recipient_private_key: server.privateKey,
      sender_public_key: await exportP256PublicJwk(caller.publicKey),
      ...ciphertext
    })).rejects.toEqual(expect.objectContaining({ code: "authentication_failed" }));
  });

  it("rejects a ciphertext from a caller other than the paired public key", async () => {
    const caller = await generateP256EcdhKeyPair();
    const impostor = await generateP256EcdhKeyPair();
    const server = await generateP256EcdhKeyPair();
    const ciphertext = await encryptFallbackPayload({
      ...metadata,
      sender_private_key: caller.privateKey,
      recipient_public_key: await exportP256PublicJwk(server.publicKey),
      plaintext: new TextEncoder().encode("secret")
    });

    await expect(decryptFallbackPayload({
      ...metadata,
      recipient_private_key: server.privateKey,
      sender_public_key: await exportP256PublicJwk(impostor.publicKey),
      ...ciphertext
    })).rejects.toBeInstanceOf(FallbackCryptoError);
  });
});
