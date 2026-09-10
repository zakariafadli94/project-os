import { decodeAdmission, type AdmissionEnvelope } from "../admission/transport";
import { parseTransaction, type Transaction } from "../domain/transaction";
import {
  FALLBACK_SCHEMA_VERSION,
  MAX_FALLBACK_CIPHERTEXT_BYTES,
  type FallbackOperation,
  type P256PublicJwk,
  decodeBase64url,
  parseP256PublicJwk
} from "./crypto";

export { MAX_FALLBACK_CIPHERTEXT_BYTES } from "./crypto";

export const MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES = 128 * 1024;
export const MAX_FALLBACK_PLAINTEXT_BYTES = 128 * 1024;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const projectId = /^PRJ-[0-9]{4,}$/;

export interface FallbackPublicKeyResponse {
  schema_version: "1.0";
  key_id: string;
  server_public_key: P256PublicJwk;
}

export interface FallbackEncryptedRequest {
  schema_version: "1.0";
  key_id: string;
  request_id: string;
  operation: FallbackOperation;
  caller_public_key: P256PublicJwk;
  iv: string;
  ciphertext: string;
}

export interface FallbackEncryptedResponse {
  schema_version: "1.0";
  key_id: string;
  request_id: string;
  operation: FallbackOperation;
  iv: string;
  ciphertext: string;
}

export interface FallbackEncryptAndRotateInput {
  key_id: string;
  request_id: string;
  operation: FallbackOperation;
  plaintext: string;
}

export type FallbackDecryptedRequest =
  | { operation: "project_context"; request_id: string; project_id: string }
  | {
    operation: "transaction";
    request_id: string;
    admission_json: string;
    admission: AdmissionEnvelope<Transaction>;
  };

export type FallbackContractCode = "invalid_envelope" | "invalid_request" | "payload_too_large";

export class FallbackContractError extends Error {
  constructor(readonly code: FallbackContractCode) {
    super(code);
    this.name = "FallbackContractError";
  }
}

export function parseFallbackPublicKeyResponse(value: unknown): FallbackPublicKeyResponse {
  const candidate = strictObject(value, ["schema_version", "key_id", "server_public_key"]);
  if (candidate.schema_version !== FALLBACK_SCHEMA_VERSION || !validOpaqueId(candidate.key_id)) throw invalidEnvelope();
  return {
    schema_version: FALLBACK_SCHEMA_VERSION,
    key_id: candidate.key_id,
    server_public_key: publicKey(candidate.server_public_key)
  };
}

export function parseFallbackEncryptedRequestJson(raw: string): FallbackEncryptedRequest {
  if (utf8Length(raw) > MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES) throw tooLarge();
  const candidate = strictObject(parseJsonWithoutDuplicateKeys(raw), [
    "schema_version", "key_id", "request_id", "operation", "caller_public_key", "iv", "ciphertext"
  ]);
  return {
    schema_version: schemaVersion(candidate.schema_version),
    key_id: opaque(candidate.key_id),
    request_id: opaque(candidate.request_id),
    operation: operation(candidate.operation),
    caller_public_key: publicKey(candidate.caller_public_key),
    iv: iv(candidate.iv),
    ciphertext: ciphertext(candidate.ciphertext)
  };
}

export function parseFallbackEncryptedResponseJson(raw: string): FallbackEncryptedResponse {
  const candidate = strictObject(parseJsonWithoutDuplicateKeys(raw), [
    "schema_version", "key_id", "request_id", "operation", "iv", "ciphertext"
  ]);
  return {
    schema_version: schemaVersion(candidate.schema_version),
    key_id: opaque(candidate.key_id),
    request_id: opaque(candidate.request_id),
    operation: operation(candidate.operation),
    iv: iv(candidate.iv),
    ciphertext: ciphertext(candidate.ciphertext)
  };
}

export function parseFallbackEncryptAndRotateInputJson(raw: string): FallbackEncryptAndRotateInput {
  const candidate = strictObject(parseJsonWithoutDuplicateKeys(raw), ["key_id", "request_id", "operation", "plaintext"]);
  if (typeof candidate.plaintext !== "string" || utf8Length(candidate.plaintext) > MAX_FALLBACK_PLAINTEXT_BYTES) {
    throw invalidRequest();
  }
  return {
    key_id: opaque(candidate.key_id),
    request_id: opaque(candidate.request_id),
    operation: operation(candidate.operation),
    plaintext: candidate.plaintext
  };
}

export function parseFallbackDecryptedRequest(raw: string): FallbackDecryptedRequest {
  if (utf8Length(raw) > MAX_FALLBACK_PLAINTEXT_BYTES) throw tooLarge();
  const value = parseJsonWithoutDuplicateKeys(raw);
  const candidate = strictObject(value, ["operation", "request_id", "project_id"], ["operation", "request_id", "admission_json"]);
  const requestId = opaque(candidate.request_id);
  if (candidate.operation === "project_context") {
    if (Object.keys(candidate).length !== 3 || typeof candidate.project_id !== "string" || !projectId.test(candidate.project_id)) {
      throw invalidRequest();
    }
    return { operation: "project_context", request_id: requestId, project_id: candidate.project_id };
  }
  if (candidate.operation !== "transaction" || Object.keys(candidate).length !== 3 || typeof candidate.admission_json !== "string") {
    throw invalidRequest();
  }
  if (utf8Length(candidate.admission_json) === 0 || utf8Length(candidate.admission_json) > MAX_FALLBACK_PLAINTEXT_BYTES) throw invalidRequest();
  const rawAdmission = parseJsonWithoutDuplicateKeys(candidate.admission_json);
  if (!rawAdmission || typeof rawAdmission !== "object" || Array.isArray(rawAdmission) || (rawAdmission as Record<string, unknown>).admission_version !== "1.0") {
    throw invalidRequest();
  }
  try {
    return {
      operation: "transaction",
      request_id: requestId,
      admission_json: candidate.admission_json,
      admission: decodeAdmission(rawAdmission, parseTransaction)
    };
  } catch {
    throw invalidRequest();
  }
}

function strictObject(value: unknown, ...allowedShapes: string[][]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidEnvelope();
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort();
  if (!allowedShapes.some((shape) => {
    const expected = [...shape].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  })) throw invalidEnvelope();
  return candidate;
}

function schemaVersion(value: unknown): "1.0" {
  if (value !== FALLBACK_SCHEMA_VERSION) throw invalidEnvelope();
  return FALLBACK_SCHEMA_VERSION;
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !validOpaqueId(value)) throw invalidEnvelope();
  return value;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && opaqueId.test(value);
}

function operation(value: unknown): FallbackOperation {
  if (value !== "project_context" && value !== "transaction") throw invalidEnvelope();
  return value;
}

function publicKey(value: unknown): P256PublicJwk {
  try {
    return parseP256PublicJwk(value);
  } catch {
    throw invalidEnvelope();
  }
}

function iv(value: unknown): string {
  try {
    if (typeof value !== "string" || decodeBase64url(value, 12).byteLength !== 12) throw invalidEnvelope();
    return value;
  } catch {
    throw invalidEnvelope();
  }
}

function ciphertext(value: unknown): string {
  try {
    if (typeof value !== "string" || decodeBase64url(value, MAX_FALLBACK_CIPHERTEXT_BYTES).byteLength < 17) throw invalidEnvelope();
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "FallbackCryptoError" && error.message === "payload_too_large") throw tooLarge();
    throw invalidEnvelope();
  }
}

function parseJsonWithoutDuplicateKeys(raw: string): unknown {
  if (typeof raw !== "string") throw invalidEnvelope();
  try {
    scanJson(raw);
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof FallbackContractError) throw error;
    throw invalidEnvelope();
  }
}

function scanJson(raw: string): void {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(raw[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (raw[index] !== '"') throw invalidEnvelope();
    index += 1;
    while (index < raw.length) {
      const character = raw[index]!;
      if (character === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index)) as string;
      }
      if (character === "\\") {
        const escaped = raw[index + 1];
        if (!escaped || !'"\\/bfnrtu'.includes(escaped)) throw invalidEnvelope();
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 2, index + 6))) throw invalidEnvelope();
          index += 6;
        } else {
          index += 2;
        }
        continue;
      }
      if (character < " ") throw invalidEnvelope();
      index += 1;
    }
    throw invalidEnvelope();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = raw[index];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw invalidEnvelope();
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") throw invalidEnvelope();
        index += 1;
        parseValue();
        skipWhitespace();
        if (raw[index] === "}") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") throw invalidEnvelope();
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      while (true) {
        parseValue();
        skipWhitespace();
        if (raw[index] === "]") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") throw invalidEnvelope();
        index += 1;
      }
    }
    if (raw.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (raw.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (raw.startsWith("null", index)) {
      index += 4;
      return;
    }
    const number = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) throw invalidEnvelope();
    index += number[0].length;
  };
  parseValue();
  skipWhitespace();
  if (index !== raw.length) throw invalidEnvelope();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidEnvelope(): FallbackContractError {
  return new FallbackContractError("invalid_envelope");
}

function invalidRequest(): FallbackContractError {
  return new FallbackContractError("invalid_request");
}

function tooLarge(): FallbackContractError {
  return new FallbackContractError("payload_too_large");
}
