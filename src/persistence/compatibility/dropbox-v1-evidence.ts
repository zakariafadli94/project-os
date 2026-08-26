import type { ManagedProviderObservation } from "../../domain/managed-document";
import type { ProviderObjectMetadata } from "../provider/contract";

const DROPBOX_V1_HASH_ALGORITHM = "dropbox-content-hash";
const DROPBOX_FILE_ID = /^id:[A-Za-z0-9_-]+$/;
const SHA256_LIKE_HEX = /^[a-f0-9]{64}$/;

export interface DropboxV1Evidence {
  file_id: string;
  rev: string;
  content_hash: string;
  size: number;
}

export function requireDropboxV1Evidence(metadata: ProviderObjectMetadata): DropboxV1Evidence {
  if (!metadata.objectId || !DROPBOX_FILE_ID.test(metadata.objectId)) {
    throw new Error("Dropbox V1 file id is missing or invalid");
  }
  if (!metadata.revisionToken || metadata.revisionToken.length > 256) {
    throw new Error("Dropbox V1 revision token is missing or invalid");
  }
  if (
    !metadata.integrityHash
    || metadata.integrityHash.algorithm !== DROPBOX_V1_HASH_ALGORITHM
    || !SHA256_LIKE_HEX.test(metadata.integrityHash.value)
  ) {
    throw new Error("Dropbox V1 integrity hash is missing or incompatible");
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    throw new Error("Dropbox V1 size must be a non-negative safe integer");
  }
  return {
    file_id: metadata.objectId,
    rev: metadata.revisionToken,
    content_hash: metadata.integrityHash.value,
    size: metadata.size
  };
}

export function toManagedProviderObservation(metadata: ProviderObjectMetadata): ManagedProviderObservation {
  assertDropboxV1Path(metadata.path);
  const evidence = requireDropboxV1Evidence(metadata);
  return {
    path: metadata.path,
    file_id: evidence.file_id,
    rev: evidence.rev,
    content_hash: evidence.content_hash,
    size: evidence.size
  };
}

export function matchesDropboxV1Evidence(
  metadata: ProviderObjectMetadata,
  expected: DropboxV1Evidence
): boolean {
  try {
    const actual = requireDropboxV1Evidence(metadata);
    return actual.file_id === expected.file_id
      && actual.rev === expected.rev
      && actual.content_hash === expected.content_hash
      && actual.size === expected.size;
  } catch {
    return false;
  }
}

function assertDropboxV1Path(value: string): void {
  if (!value.startsWith("/") || value.includes("//") || /[\u0000-\u001F\u007F\\]/.test(value)) {
    throw new Error(`Dropbox V1 provider path is unsafe: ${value}`);
  }
  const segments = value.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Dropbox V1 provider path is unsafe: ${value}`);
  }
}
