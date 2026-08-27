import type { ProjectOsPersistenceRuntime } from "../provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../provider/contract";

export type PersistenceInput = ProjectOsPersistenceRuntime;

export interface LegacyDropboxFileMetadata {
  id: string;
  path: string;
  rev: string;
  content_hash: string;
  size: number;
  server_modified?: string;
}

export interface LegacyDropboxChangeEntry {
  tag: "file" | "folder" | "deleted";
  name: string;
  path: string;
  id?: string;
  rev?: string;
  content_hash?: string;
  size?: number;
  server_modified?: string;
}

export function asProjectOsPersistence(input: PersistenceInput): ProjectOsPersistenceRuntime {
  return input;
}

export function toProviderObjectMetadata(
  metadata: ProviderObjectMetadata | LegacyDropboxFileMetadata
): ProviderObjectMetadata {
  if (!("id" in metadata)) return metadata;
  return {
    path: metadata.path,
    size: metadata.size,
    ...(metadata.server_modified ? { modifiedAt: metadata.server_modified } : {}),
    objectId: metadata.id,
    revisionToken: metadata.rev,
    integrityHash: {
      algorithm: "dropbox-content-hash",
      value: metadata.content_hash
    }
  };
}

export function toProviderChangeEntry(
  entry: ProviderChangeEntry | LegacyDropboxChangeEntry
): ProviderChangeEntry {
  if ("kind" in entry) return entry;
  const result: ProviderChangeEntry = {
    kind: entry.tag,
    name: entry.name,
    path: entry.path
  };
  if (
    entry.tag === "file"
    && entry.id
    && entry.rev
    && entry.content_hash
    && entry.size !== undefined
  ) {
    result.metadata = toProviderObjectMetadata({
      id: entry.id,
      path: entry.path,
      rev: entry.rev,
      content_hash: entry.content_hash,
      size: entry.size,
      ...(entry.server_modified ? { server_modified: entry.server_modified } : {})
    });
  }
  return result;
}
