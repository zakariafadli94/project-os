import { canonicalJson, type RuleReference, type RuleResource } from "../rules/contract";
import { z } from "zod";

export const RULE_ADMISSION_PERMIT_TTL_MS = 60_000;

export interface RuleAdmissionInput {
  actor: { actor_id: string; authority: string };
  project_id: string;
  operation: string;
  resources: RuleResource[];
  request_hash: string;
  global_revision: number;
  ruleset: { digest: string; rules: RuleReference[]; global_revision: number | null; project_revision: number };
}

interface RuleAdmissionClaims extends RuleAdmissionInput {
  issued_at: string;
  expires_at: string;
}

export interface RuleAdmissionPermit extends RuleAdmissionClaims {
  token: string;
}

const nonEmpty = z.string().trim().min(1);
const scope = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("global") }), z.strictObject({ kind: z.literal("project"), project_id: nonEmpty })]);
const resource = z.strictObject({ resource_id: nonEmpty, resource_type: nonEmpty, zone: nonEmpty, version: nonEmpty, expected_version: nonEmpty.optional(), relative_path: nonEmpty.optional(), artifact_operation: z.literal("REVIEW_CANDIDATE").optional() });
const ruleset = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), rules: z.array(z.strictObject({ rule_id: nonEmpty, version: z.number().int().positive(), scope })), global_revision: z.number().int().nonnegative().nullable(), project_revision: z.number().int().nonnegative() });
const inputSchema = z.strictObject({ actor: z.strictObject({ actor_id: nonEmpty, authority: nonEmpty }), project_id: z.string().regex(/^PRJ-[0-9]{4,}$/), operation: nonEmpty, resources: z.array(resource).min(1), request_hash: z.string().regex(/^[a-f0-9]{64}$/), global_revision: z.number().int().nonnegative(), ruleset });

export type RuleAdmissionCode =
  | "rule_admission_invalid"
  | "rule_admission_expired"
  | "rule_admission_request_mismatch"
  | "rule_admission_scope_mismatch"
  | "rule_admission_ruleset_stale";

export class RuleAdmissionError extends Error {
  constructor(readonly code: RuleAdmissionCode) {
    super(code);
    this.name = "RuleAdmissionError";
  }
}

export function parseRuleAdmissionInput(value: unknown): RuleAdmissionInput {
  return inputSchema.parse(value);
}

export async function issueRuleAdmissionPermit(input: RuleAdmissionInput, secret: string, nowMs: number): Promise<RuleAdmissionPermit> {
  const claims: RuleAdmissionClaims = {
    ...structuredClone(input),
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + RULE_ADMISSION_PERMIT_TTL_MS).toISOString()
  };
  const bytes = new TextEncoder().encode(canonicalJson(claims));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), bytes));
  return { ...claims, token: `${base64url(bytes)}.${base64url(signature)}` };
}

export async function verifyRuleAdmissionPermit(permit: RuleAdmissionPermit, input: RuleAdmissionInput, secret: string, nowMs: number): Promise<void> {
  const [encodedClaims, encodedSignature, extra] = permit.token.split(".");
  if (!encodedClaims || !encodedSignature || extra) throw new RuleAdmissionError("rule_admission_invalid");
  let signed: RuleAdmissionClaims;
  let bytes: Uint8Array;
  try {
    bytes = unbase64url(encodedClaims);
    signed = JSON.parse(new TextDecoder().decode(bytes)) as RuleAdmissionClaims;
  } catch {
    throw new RuleAdmissionError("rule_admission_invalid");
  }
  const signature = bufferOf(unbase64url(encodedSignature));
  const valid = await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), signature, bufferOf(bytes));
  if (!valid || canonicalJson(signed) !== canonicalJson(claimsOf(permit))) throw new RuleAdmissionError("rule_admission_invalid");
  const issuedAt = Date.parse(signed.issued_at);
  const expiresAt = Date.parse(signed.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt - issuedAt !== RULE_ADMISSION_PERMIT_TTL_MS || nowMs < issuedAt) throw new RuleAdmissionError("rule_admission_invalid");
  if (nowMs >= expiresAt) throw new RuleAdmissionError("rule_admission_expired");
  if (signed.request_hash !== input.request_hash) throw new RuleAdmissionError("rule_admission_request_mismatch");
  if (signed.project_id !== input.project_id || signed.operation !== input.operation || canonicalJson(signed.actor) !== canonicalJson(input.actor) || canonicalJson(signed.resources) !== canonicalJson(input.resources)) throw new RuleAdmissionError("rule_admission_scope_mismatch");
  if (signed.global_revision !== input.global_revision || canonicalJson(signed.ruleset) !== canonicalJson(input.ruleset)) throw new RuleAdmissionError("rule_admission_ruleset_stale");
}

function claimsOf(permit: RuleAdmissionPermit): RuleAdmissionClaims {
  const { token: _token, ...claims } = permit;
  return claims;
}

async function key(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function base64url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RuleAdmissionError("rule_admission_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
