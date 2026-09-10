import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

const SCHEMA_VERSION = "1.0" as const;
const ALGORITHM = "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const;
const KEY_STORAGE_KEY = "fallback-ingress-keypair-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Direction = "request" | "response";

interface StoredKeyPair {
  key_id: string;
  public_key: JsonWebKey;
  private_key: JsonWebKey;
}

interface EncryptedEnvelope {
  schema_version: "1.0";
  key_id: string;
  client_public_key: JsonWebKey;
  iv: string;
  ciphertext: string;
}

interface EncryptRequest {
  key_id: string;
  client_public_key: JsonWebKey;
  plaintext: string;
}

export class FallbackIngressGuard extends DurableObject<Env> {
  private keyPair: Promise<StoredKeyPair>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.keyPair = this.initializeKeyPair();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/key") {
      const key = await this.keyPair;
      return Response.json({
        schema_version: SCHEMA_VERSION,
        algorithm: ALGORITHM,
        key_id: key.key_id,
        public_key: key.public_key
      }, {
        headers: { "cache-control": "no-store" }
      });
    }

    if (request.method === "POST" && url.pathname === "/decrypt") {
      try {
        const envelope = parseEnvelope(await request.json());
        const key = await this.keyPair;
        if (!secureStringEqual(envelope.key_id, key.key_id)) {
          return Response.json({ error: "invalid_fallback_key" }, { status: 400 });
        }
        const plaintext = await decryptEnvelope(key, envelope);
        return Response.json({
          key_id: key.key_id,
          client_public_key: envelope.client_public_key,
          plaintext
        });
      } catch {
        return Response.json({ error: "invalid_fallback_envelope" }, { status: 400 });
      }
    }

    if (request.method === "POST" && url.pathname === "/encrypt") {
      try {
        const body = parseEncryptRequest(await request.json());
        const key = await this.keyPair;
        if (!secureStringEqual(body.key_id, key.key_id)) {
          return Response.json({ error: "invalid_fallback_key" }, { status: 400 });
        }
        const encrypted = await encryptResponse(key, body.client_public_key, body.plaintext);
        await this.rotateKeyPair(key.key_id);
        return Response.json(encrypted);
      } catch {
        return Response.json({ error: "invalid_fallback_response" }, { status: 400 });
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async initializeKeyPair(): Promise<StoredKeyPair> {
    const existing = await this.ctx.storage.get<StoredKeyPair>(KEY_STORAGE_KEY);
    if (existing) return existing;

    const key = await generateStoredKeyPair();
    await this.ctx.storage.put(KEY_STORAGE_KEY, key);
    return key;
  }

  private async rotateKeyPair(expectedKeyId: string): Promise<void> {
    const current = await this.keyPair;
    if (!secureStringEqual(current.key_id, expectedKeyId)) return;

    const next = await generateStoredKeyPair();
    await this.ctx.storage.put(KEY_STORAGE_KEY, next);
    this.keyPair = Promise.resolve(next);
  }
}

async function generateStoredKeyPair(): Promise<StoredKeyPair> {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  return {
    key_id: base64UrlEncode(crypto.getRandomValues(new Uint8Array(18))),
    public_key: await crypto.subtle.exportKey("jwk", generated.publicKey),
    private_key: await crypto.subtle.exportKey("jwk", generated.privateKey)
  };
}

function parseEnvelope(value: unknown): EncryptedEnvelope {
  if (!isRecord(value)) throw new Error("invalid envelope");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "ciphertext,client_public_key,iv,key_id,schema_version") {
    throw new Error("unexpected envelope fields");
  }
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("invalid schema version");
  if (typeof value.key_id !== "string" || value.key_id.length < 16) throw new Error("invalid key id");
  if (typeof value.iv !== "string" || value.iv.length < 16) throw new Error("invalid iv");
  if (typeof value.ciphertext !== "string" || value.ciphertext.length < 16) throw new Error("invalid ciphertext");
  if (!validPublicJwk(value.client_public_key)) throw new Error("invalid public key");
  return value as unknown as EncryptedEnvelope;
}

function parseEncryptRequest(value: unknown): EncryptRequest {
  if (!isRecord(value)) throw new Error("invalid encrypt request");
  if (typeof value.key_id !== "string" || value.key_id.length < 16) throw new Error("invalid key id");
  if (typeof value.plaintext !== "string") throw new Error("invalid plaintext");
  if (!validPublicJwk(value.client_public_key)) throw new Error("invalid public key");
  return value as unknown as EncryptRequest;
}

function validPublicJwk(value: unknown): value is JsonWebKey {
  return isRecord(value)
    && value.kty === "EC"
    && value.crv === "P-256"
    && typeof value.x === "string"
    && value.x.length > 0
    && typeof value.y === "string"
    && value.y.length > 0
    && value.d === undefined;
}

async function decryptEnvelope(key: StoredKeyPair, envelope: EncryptedEnvelope): Promise<string> {
  const sharedSecret = await deriveSharedSecret(key.private_key, envelope.client_public_key);
  const aesKey = await deriveAesKey(sharedSecret, key.key_id, "request", ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(envelope.iv),
      additionalData: additionalData(key.key_id, "request")
    },
    aesKey,
    base64UrlDecode(envelope.ciphertext)
  );
  return decoder.decode(plaintext);
}

async function encryptResponse(
  key: StoredKeyPair,
  clientPublicKey: JsonWebKey,
  plaintext: string
): Promise<{ schema_version: "1.0"; key_id: string; iv: string; ciphertext: string }> {
  const sharedSecret = await deriveSharedSecret(key.private_key, clientPublicKey);
  const aesKey = await deriveAesKey(sharedSecret, key.key_id, "response", ["encrypt"]);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(ivBytes),
      additionalData: additionalData(key.key_id, "response")
    },
    aesKey,
    toArrayBuffer(encoder.encode(plaintext))
  );
  return {
    schema_version: SCHEMA_VERSION,
    key_id: key.key_id,
    iv: base64UrlEncode(ivBytes),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  };
}

async function deriveSharedSecret(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Promise<ArrayBuffer> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  return crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
}

async function deriveAesKey(
  sharedSecret: ArrayBuffer,
  keyId: string,
  direction: Direction,
  usages: KeyUsage[]
): Promise<CryptoKey> {
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
    usages
  );
}

function additionalData(keyId: string, direction: Direction): ArrayBuffer {
  return toArrayBuffer(encoder.encode(`project-os-fallback-v1:${keyId}:${direction}`));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return toArrayBuffer(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secureStringEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
