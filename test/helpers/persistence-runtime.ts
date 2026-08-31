import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import { ProviderCapabilityError } from "../../src/persistence/provider/errors";
import { withProviderResilience, type ProviderResilienceOptions } from "../../src/persistence/provider/resilience";
import { createDropboxPersistence } from "../../src/persistence/providers/dropbox/adapter";
import type { DropboxTransport } from "../../src/persistence/providers/dropbox/client";

export function persistenceFromDropbox(
  input: DropboxTransport,
  resilienceOptions: ProviderResilienceOptions = {}
): ProjectOsPersistenceRuntime {
  const raw = forwardTransport(input);
  const runtime = withProviderResilience(createDropboxPersistence(raw), resilienceOptions);
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

function forwardTransport(input: DropboxTransport): DropboxTransport {
  return {
    upload: (path, content, mode) => input.upload(path, content, mode),
    download: (path) => input.download(path),
    move: (from, to) => input.move(from, to),
    getMetadata: input.getMetadata
      ? (path) => input.getMetadata!(path)
      : missingRaw("metadata"),
    listFolder: input.listFolder
      ? (path) => input.listFolder!(path)
      : missingRaw("list"),
    delete: input.delete
      ? (path) => input.delete!(path)
      : missingRaw("delete"),
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

function missing<T extends (...args: never[]) => Promise<never>>(capability: string): T;
function missing(capability: string) {
  return async (..._args: unknown[]): Promise<never> => {
    throw new ProviderCapabilityError(capability);
  };
}

function missingRaw(capability: string) {
  return async (..._args: unknown[]): Promise<never> => {
    throw new Error(`Test Dropbox transport does not support ${capability}`);
  };
}
