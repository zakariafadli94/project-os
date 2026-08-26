import type { DropboxTransport } from "../providers/dropbox/client";
import { createDropboxPersistence } from "../providers/dropbox/adapter";
import type { ProjectOsPersistenceRuntime } from "../provider/capabilities";
import type { ProviderObjectMetadata } from "../provider/contract";
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

export function asProjectOsPersistence(input: PersistenceInput): ProjectOsPersistenceRuntime {
  if (isPreparedRuntime(input)) return input;

  const raw: DropboxTransport = {
    ...input,
    getMetadata: input.getMetadata ?? missing("metadata"),
    listFolder: input.listFolder ?? missing("list"),
    delete: input.delete ?? missing("delete")
  };
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
  if ("objectId" in metadata || "revisionToken" in metadata || "integrityHash" in metadata) {
    return metadata as ProviderObjectMetadata;
  }
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
