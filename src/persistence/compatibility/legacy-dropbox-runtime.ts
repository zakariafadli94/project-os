import type { DropboxTransport } from "../providers/dropbox/client";
import { createDropboxPersistence } from "../providers/dropbox/adapter";
import type { ProjectOsPersistenceRuntime } from "../provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../provider/contract";
import { ProviderCapabilityError } from "../provider/errors";
import { withProviderResilience } from "../provider/resilience";

export type PersistenceInput = ProjectOsPersistenceRuntime | DropboxTransport;

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
  if (isPreparedRuntime(input)) return input;

  const raw = forwardLegacyDropboxTransport(input);
  const runtime = withProviderResilience(createDropboxPersistence(raw));
  return {
    providerId: runtime.providerId,
    objects: runtime.objects,
    conditionalWrite: runtime.conditionalWrite ?? {
      writeTextConditional: missing("conditional-write")
    },
    serverSideCopy: runtime.serverSideCopy ?? {
      copyObject: missing("server-side-copy")
    },
    changeFeed: runtime.changeFeed ?? {
      listChanges: missing("incremental-change-feed")
    },
    evidence: {
      stableObjectId: runtime.evidence?.stableObjectId ?? { semantics: "stable-through-move" },
      revisionToken: runtime.evidence?.revisionToken ?? { semantics: "opaque-object-revision" },
      integrityHash: runtime.evidence?.integrityHash ?? { semantics: "identified-algorithm" }
    }
  };
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

function forwardLegacyDropboxTransport(input: DropboxTransport): DropboxTransport {
  return {
    upload: (path, content, mode) => input.upload(path, content, mode),
    download: (path) => input.download(path),
    move: (from, to) => input.move(from, to),
    getMetadata: input.getMetadata
      ? (path) => input.getMetadata!(path)
      : missing("metadata"),
    listFolder: input.listFolder
      ? (path) => input.listFolder!(path)
      : missing("list"),
    delete: input.delete
      ? (path) => input.delete!(path)
      : missing("delete"),
    ...(input.uploadConditional
      ? {
          uploadConditional: (path: string, content: string, expectedRev: string) =>
            input.uploadConditional!(path, content, expectedRev)
        }
      : {}),
    ...(input.copy
      ? {
          copy: (from: string, to: string) => input.copy!(from, to)
        }
      : {}),
    ...(input.listFolderChanges
      ? {
          listFolderChanges: (root?: string, cursor?: string) => input.listFolderChanges!(root, cursor)
        }
      : {})
  };
}

function isPreparedRuntime(input: PersistenceInput): input is ProjectOsPersistenceRuntime {
  return typeof input === "object"
    && input !== null
    && "providerId" in input
    && "objects" in input
    && "conditionalWrite" in input
    && "serverSideCopy" in input
    && "changeFeed" in input;
}

function missing<T extends (...args: never[]) => Promise<never>>(capability: string): T;
function missing(capability: string) {
  return async (..._args: unknown[]): Promise<never> => {
    throw new ProviderCapabilityError(capability);
  };
}
