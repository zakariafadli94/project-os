import type { SearchRecord } from "./contract";

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashSearchValue(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

export async function hashSearchRecords(records: readonly SearchRecord[]): Promise<string> {
  const ordered = [...records].sort((left, right) =>
    left.project_id.localeCompare(right.project_id) || left.record_id.localeCompare(right.record_id)
  );
  return hashSearchValue(ordered);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}
