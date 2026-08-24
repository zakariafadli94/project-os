import type { ProjectionOutputEvidence } from "../domain/materialization";

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

export async function projectionIndexRootHash(
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>
): Promise<string> {
  return sha256Canonical([...outputs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
