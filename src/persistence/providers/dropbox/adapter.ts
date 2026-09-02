import type { PersistenceRuntime } from "../../provider/capabilities";
import type {
  ProviderChangeEntry,
  ProviderEntry,
  ProviderObjectMetadata
} from "../../provider/contract";
import { ProviderCapabilityError } from "../../provider/errors";
import type {
  DropboxChangeEntry,
  DropboxEntry,
  DropboxFileMetadata,
  DropboxTransport
} from "./client";
import { mapDropboxError, type DropboxOperation } from "./error-mapping";

export const DROPBOX_PROVIDER_ID = "dropbox";
export const DROPBOX_INTEGRITY_ALGORITHM = "dropbox-content-hash";

export function createDropboxPersistence(raw: DropboxTransport): PersistenceRuntime {
  if (!raw.getMetadata) throw new ProviderCapabilityError("metadata");
  if (!raw.listFolder) throw new ProviderCapabilityError("list");
  if (!raw.delete) throw new ProviderCapabilityError("delete");

  const runtime: PersistenceRuntime = {
    providerId: DROPBOX_PROVIDER_ID,
    objects: {
      readText: (path) => call("read", path, () => raw.download(path)),
      createText: (path, content) => call("create", path, () => raw.upload(path, content, "add")),
      upsertText: (path, content) => call("upsert", path, () => raw.upload(path, content, "overwrite")),
      getMetadata: async (path) => {
        const metadata = await call("metadata", path, () => raw.getMetadata!(path));
        return metadata ? mapMetadata(metadata) : null;
      },
      listChildren: async (path) => {
        const entries = await call("list", path, () => raw.listFolder!(path));
        return entries.map(mapEntry);
      },
      move: (from, to) => call("move", `${from} -> ${to}`, () => raw.move(from, to)),
      delete: (path) => call("delete", path, () => raw.delete!(path))
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };

  if (raw.beginRequestTrace) {
    runtime.diagnostics = {
      beginOperation: (operation) => raw.beginRequestTrace!(operation)
    };
  }

  if (raw.uploadConditional) {
    runtime.conditionalWrite = {
      writeTextConditional: async (path, content, expectedRevisionToken) => mapMetadata(
        await call(
          "conditional-write",
          path,
          () => raw.uploadConditional!(path, content, expectedRevisionToken)
        )
      )
    };
  }

  if (raw.copy) {
    runtime.serverSideCopy = {
      copyObject: async (from, to) => mapMetadata(
        await call("copy", `${from} -> ${to}`, () => raw.copy!(from, to))
      )
    };
  }

  if (raw.listFolderChanges) {
    runtime.changeFeed = {
      listChanges: async (input) => {
        const target = input.root ?? "<cursor>";
        const page = await call(
          "changes",
          target,
          () => raw.listFolderChanges!(input.root, input.cursor)
        );
        return {
          entries: page.entries.map(mapChangeEntry),
          cursor: page.cursor
        };
      }
    };
  }

  if (raw.ensureDirectory) {
    runtime.directoryProvisioning = {
      ensureDirectory: (path) => call("ensure-directory", path, () => raw.ensureDirectory!(path))
    };
  }

  return runtime;
}

async function call<T>(operation: DropboxOperation, target: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const mapped = mapDropboxError(error, operation);
    if (mapped === error && error instanceof Error) {
      throw new Error(`Dropbox ${operation} failed for ${target}: ${error.message}`);
    }
    throw mapped;
  }
}

function mapMetadata(metadata: DropboxFileMetadata): ProviderObjectMetadata {
  return {
    path: metadata.path,
    size: metadata.size,
    ...(metadata.server_modified ? { modifiedAt: metadata.server_modified } : {}),
    objectId: metadata.id,
    revisionToken: metadata.rev,
    integrityHash: {
      algorithm: DROPBOX_INTEGRITY_ALGORITHM,
      value: metadata.content_hash
    }
  };
}

function mapEntry(entry: DropboxEntry): ProviderEntry {
  const path = entry.path_display ?? entry.path_lower;
  return {
    kind: entry.tag,
    name: entry.name,
    ...(path ? { path } : {})
  };
}

function mapChangeEntry(entry: DropboxChangeEntry): ProviderChangeEntry {
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
    result.metadata = mapMetadata({
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
