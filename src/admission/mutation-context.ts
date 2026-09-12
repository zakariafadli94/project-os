import { z } from "zod";
import { canonicalJson, sha256Canonical } from "../materialization/hash";
import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";

const CONTEXT_TTL_MS = 300_000;

const claimsSchema = z.strictObject({
  actor: z.strictObject({ actor_id: z.string().min(1), authority: z.string().min(1) }),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  canonical_revision: z.number().int().nonnegative(),
  state_hash: z.string().regex(/^[a-f0-9]{64}$/),
  observed_at: z.string().datetime({ offset: true }),
  expiry: z.string().datetime({ offset: true })
});

const contextSchema = claimsSchema.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
}).strict();

export interface MutationContext {
  actor: { actor_id: string; authority: string };
  project_id: string;
  canonical_revision: number;
  state_hash: string;
  observed_at: string;
  expiry: string;
  token: string;
}

export interface MutationContextResponse {
  context: MutationContext;
  canonical_state: ProjectState;
  views: {
    state: string;
    handoff: string;
    status: "current" | "updating" | "unknown";
    verified_at: string | null;
  };
}

export type AdmissionCode =
  | "mutation_context_missing"
  | "mutation_context_expired"
  | "mutation_context_invalid"
  | "mutation_context_stale"
  | "canonical_unavailable"
  | "GLOBAL_GOVERNANCE_UNAVAILABLE"
  | "RULE_ADMISSION_STALE"
  | "ARTIFACT_DESTINATION_FORBIDDEN"
  | "idempotency_payload_mismatch"
  | "convergence_capacity_exceeded";

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionCode, readonly status: 409 | 428 | 503) {
    super(code);
    this.name = "AdmissionError";
  }
}

export function parseMutationContextOrNull(value: unknown): MutationContext | null {
  if (value === null) return null;
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) throw new AdmissionError("mutation_context_invalid", 428);
  return parsed.data;
}

export async function issueMutationContext(
  state: ProjectState,
  secret: string,
  nowMs: number,
  actor = { actor_id: "ingress", authority: "ingress_token" }
): Promise<MutationContext> {
  const claims = await contextClaims(state, nowMs, actor);
  const bytes = new TextEncoder().encode(canonicalJson(claims));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), bytes));
  return { ...claims, token: `${base64url(bytes)}.${base64url(signature)}` };
}

export async function verifyMutationContext(
  context: MutationContext | null,
  state: ProjectState,
  baseRevision: number,
  secret: string,
  nowMs: number
): Promise<void> {
  if (context === null) throw new AdmissionError("mutation_context_missing", 428);
  const parsed = parseMutationContextOrNull(context);
  if (parsed === null) throw new AdmissionError("mutation_context_missing", 428);
  const [payload, signature] = parsed.token.split(".");
  const bytes = unbase64url(payload);
  let signedClaims: z.infer<typeof claimsSchema>;
  try {
    signedClaims = claimsSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new AdmissionError("mutation_context_invalid", 428);
  }
  const signatureBytes = unbase64url(signature);
  const claimsBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret, ["verify"]),
    signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer,
    claimsBuffer
  );
  if (!valid || canonicalJson(signedClaims) !== canonicalJson(claimsOf(parsed))) {
    throw new AdmissionError("mutation_context_invalid", 428);
  }
  const observedAt = Date.parse(parsed.observed_at);
  const expiry = Date.parse(parsed.expiry);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiry) || observedAt > nowMs || expiry - observedAt !== CONTEXT_TTL_MS) {
    throw new AdmissionError("mutation_context_invalid", 428);
  }
  if (nowMs >= expiry) throw new AdmissionError("mutation_context_expired", 428);
  const expected = await contextClaims(state, observedAt, parsed.actor);
  if (
    baseRevision !== state.revision
    || parsed.project_id !== expected.project_id
    || parsed.canonical_revision !== expected.canonical_revision
    || parsed.state_hash !== expected.state_hash
  ) throw new AdmissionError("mutation_context_stale", 409);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AdmissionError("mutation_context_invalid", 428);
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    throw new AdmissionError("mutation_context_invalid", 428);
  }
}

async function contextClaims(state: ProjectState, nowMs: number, actor = { actor_id: "ingress", authority: "ingress_token" }) {
  return {
    actor,
    project_id: state.project_id,
    canonical_revision: state.revision,
    state_hash: await sha256Canonical(normalizeProjectState(state)),
    observed_at: new Date(nowMs).toISOString(),
    expiry: new Date(nowMs + CONTEXT_TTL_MS).toISOString()
  };
}

function claimsOf(context: MutationContext) {
  const { token: _token, ...claims } = context;
  return claims;
}

async function key(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}
