import { z } from "zod";

const DROPBOX_V1_HASH_ALGORITHM = "dropbox-content-hash";
const dropboxFileIdSchema = z.string().regex(/^id:[A-Za-z0-9_-]+$/);
const dropboxRevisionSchema = z.string().min(1).max(256);
const dropboxContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const providerIntegrityHashSchema = z.strictObject({
  algorithm: z.string().min(1),
  value: z.string().min(1)
});

const providerObservationSchema = z.strictObject({
  provider_id: z.string().min(1),
  path: z.string().min(1),
  object_id: z.string().min(1),
  revision_token: z.string().min(1),
  integrity_hash: providerIntegrityHashSchema,
  size: z.number().int().nonnegative().safe()
});

export type ProviderIntegrityHash = z.infer<typeof providerIntegrityHashSchema>;
export type ProviderObservation = z.infer<typeof providerObservationSchema>;

export function parseProviderObservation(input: unknown): ProviderObservation {
  return providerObservationSchema.parse(input);
}

export function providerIntegrityHashEquals(
  left: ProviderIntegrityHash,
  right: ProviderIntegrityHash
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

export function upcastDropboxV1Observation(input: unknown): ProviderObservation {
  const raw = requireRecord(input, "Dropbox V1 provider evidence");
  const path = readAlias(raw, "provider_path", "path", "Dropbox V1 provider path");
  const objectId = readAlias(raw, "provider_file_id", "file_id", "Dropbox V1 file id");
  const revisionToken = readAlias(raw, "provider_rev", "rev", "Dropbox V1 revision token");
  const contentHash = readAlias(
    raw,
    "provider_content_hash",
    "content_hash",
    "Dropbox V1 content hash"
  );

  assertDropboxPath(path);
  dropboxFileIdSchema.parse(objectId);
  dropboxRevisionSchema.parse(revisionToken);
  dropboxContentHashSchema.parse(contentHash);
  const size = z.number().int().nonnegative().safe().parse(raw.size);

  return parseProviderObservation({
    provider_id: "dropbox",
    path,
    object_id: objectId,
    revision_token: revisionToken,
    integrity_hash: {
      algorithm: DROPBOX_V1_HASH_ALGORITHM,
      value: contentHash
    },
    size
  });
}

function requireRecord(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

function readAlias(
  raw: Record<string, unknown>,
  primary: string,
  legacy: string,
  label: string
): string {
  const primaryValue = raw[primary];
  const legacyValue = raw[legacy];
  if (
    primaryValue !== undefined
    && legacyValue !== undefined
    && primaryValue !== legacyValue
  ) {
    throw new Error(`${label} aliases contradict each other`);
  }
  const value = primaryValue ?? legacyValue;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function assertDropboxPath(path: string): void {
  if (!path.startsWith("/") || path.includes("//") || /[\u0000-\u001F\u007F\\]/.test(path)) {
    throw new Error(`Dropbox V1 provider path is unsafe: ${path}`);
  }
  const segments = path.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Dropbox V1 provider path is unsafe: ${path}`);
  }
}
