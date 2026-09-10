export const FALLBACK_SCHEMA_VERSION = "1.0" as const;
export const MAX_FALLBACK_CIPHERTEXT_BYTES = 128 * 1024;

export type FallbackOperation = "project_context" | "transaction";
export type FallbackDirection = "client_to_server" | "server_to_client";

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext: true;
  key_ops: [];
}

export interface P256PrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext: true;
  d: string;
  key_ops: ["deriveBits"];
}

export interface FallbackCiphertext {
  iv: string;
  ciphertext: string;
}

interface FallbackMetadata {
  key_id: string;
  operation: FallbackOperation;
  request_id: string;
  direction: FallbackDirection;
}

interface EncryptFallbackPayload extends FallbackMetadata {
  sender_private_key: CryptoKey;
  recipient_public_key: P256PublicJwk;
  plaintext: Uint8Array;
}

interface DecryptFallbackPayload extends FallbackMetadata, FallbackCiphertext {
  recipient_private_key: CryptoKey;
  sender_public_key: P256PublicJwk;
}

export type FallbackCryptoCode = "invalid_key" | "invalid_ciphertext" | "payload_too_large" | "authentication_failed";

export class FallbackCryptoError extends Error {
  constructor(readonly code: FallbackCryptoCode) {
    super(code);
    this.name = "FallbackCryptoError";
  }
}

export async function generateP256EcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as Promise<CryptoKeyPair>;
}

export async function exportP256PublicJwk(key: CryptoKey): Promise<P256PublicJwk> {
  try {
    // workerd exposes optional JsonWebKey members as enumerable undefined fields.
    // A transmitted JWK is JSON, so normalize to that exact external shape first.
    return parseP256PublicJwk(JSON.parse(JSON.stringify(await crypto.subtle.exportKey("jwk", key))));
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_key");
  }
}

export async function exportP256PrivateJwk(key: CryptoKey): Promise<P256PrivateJwk> {
  try {
    return parseP256PrivateJwk(JSON.parse(JSON.stringify(await crypto.subtle.exportKey("jwk", key))));
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_key");
  }
}

export function parseP256PublicJwk(value: unknown): P256PublicJwk {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FallbackCryptoError("invalid_key");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = ["crv", "ext", "key_ops", "kty", "x", "y"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new FallbackCryptoError("invalid_key");
  }
  if (
    candidate.kty !== "EC"
    || candidate.crv !== "P-256"
    || candidate.ext !== true
    || !Array.isArray(candidate.key_ops)
    || candidate.key_ops.length !== 0
    || typeof candidate.x !== "string"
    || typeof candidate.y !== "string"
  ) throw new FallbackCryptoError("invalid_key");

  if (decodeBase64url(candidate.x, 32).byteLength !== 32 || decodeBase64url(candidate.y, 32).byteLength !== 32) {
    throw new FallbackCryptoError("invalid_key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: candidate.x,
    y: candidate.y,
    ext: true,
    key_ops: []
  };
}

export async function importP256PrivateJwk(value: unknown): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      parseP256PrivateJwk(value),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_key");
  }
}

function parseP256PrivateJwk(value: unknown): P256PrivateJwk {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FallbackCryptoError("invalid_key");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = ["crv", "d", "ext", "key_ops", "kty", "x", "y"];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || candidate.kty !== "EC"
    || candidate.crv !== "P-256"
    || candidate.ext !== true
    || !Array.isArray(candidate.key_ops)
    || candidate.key_ops.length !== 1
    || candidate.key_ops[0] !== "deriveBits"
    || typeof candidate.d !== "string"
  ) throw new FallbackCryptoError("invalid_key");
  const publicPart = parseP256PublicJwk({
    kty: candidate.kty,
    crv: candidate.crv,
    x: candidate.x,
    y: candidate.y,
    ext: candidate.ext,
    key_ops: []
  });
  if (decodeBase64url(candidate.d, 32).byteLength !== 32) throw new FallbackCryptoError("invalid_key");
  return { ...publicPart, d: candidate.d, key_ops: ["deriveBits"] };
}

export async function encryptFallbackPayload(input: EncryptFallbackPayload): Promise<FallbackCiphertext> {
  if (input.plaintext.byteLength > MAX_FALLBACK_CIPHERTEXT_BYTES) throw new FallbackCryptoError("payload_too_large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(input.sender_private_key, input.recipient_public_key, input, ["encrypt"]);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: bytesBuffer(iv),
      additionalData: bytesBuffer(associatedData(input)),
      tagLength: 128
    }, key, bytesBuffer(input.plaintext)));
    if (ciphertext.byteLength > MAX_FALLBACK_CIPHERTEXT_BYTES) throw new FallbackCryptoError("payload_too_large");
    return { iv: base64url(iv), ciphertext: base64url(ciphertext) };
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_ciphertext");
  }
}

export async function decryptFallbackPayload(input: DecryptFallbackPayload): Promise<Uint8Array> {
  const iv = decodeBase64url(input.iv, 12);
  const ciphertext = decodeBase64url(input.ciphertext, MAX_FALLBACK_CIPHERTEXT_BYTES);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new FallbackCryptoError("invalid_ciphertext");
  const key = await deriveAesKey(input.recipient_private_key, input.sender_public_key, input, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: bytesBuffer(iv),
      additionalData: bytesBuffer(associatedData(input)),
      tagLength: 128
    }, key, bytesBuffer(ciphertext)));
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("authentication_failed");
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64url(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new FallbackCryptoError("invalid_ciphertext");
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (bytes.byteLength > maximumBytes) throw new FallbackCryptoError("payload_too_large");
    return bytes;
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_ciphertext");
  }
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicJwk: P256PublicJwk,
  metadata: FallbackMetadata,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      parseP256PublicJwk(publicJwk),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("project-os/fallback/v1/hkdf-salt"));
    return crypto.subtle.deriveKey({
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: bytesBuffer(associatedData(metadata))
    }, material, { name: "AES-GCM", length: 256 }, false, usage);
  } catch (error) {
    if (error instanceof FallbackCryptoError) throw error;
    throw new FallbackCryptoError("invalid_key");
  }
}

function associatedData(metadata: FallbackMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema_version: FALLBACK_SCHEMA_VERSION,
    key_id: metadata.key_id,
    operation: metadata.operation,
    direction: metadata.direction,
    request_id: metadata.request_id
  }));
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
