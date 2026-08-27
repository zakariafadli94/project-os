import { describe, expect, it } from "vitest";
import {
  asProjectOsPersistence,
  toProviderChangeEntry,
  toProviderObjectMetadata
} from "../src/persistence/compatibility/legacy-dropbox-runtime";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";

function runtime(): ProjectOsPersistenceRuntime {
  return {
    providerId: "dropbox",
    objects: {
      readText: async () => null,
      createText: async () => undefined,
      upsertText: async () => undefined,
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: { writeTextConditional: async (_path) => ({ path: "/x", size: 0 }) },
    serverSideCopy: { copyObject: async (_from, to) => ({ path: to, size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
}

describe("Dropbox V1 compatibility data conversion", () => {
  it("keeps an already prepared runtime unchanged", () => {
    const prepared = runtime();
    expect(asProjectOsPersistence(prepared)).toBe(prepared);
  });

  it("converts historical Dropbox metadata without changing evidence values", () => {
    expect(toProviderObjectMetadata({
      id: "id:abc",
      path: "/PROJECT_OS/example.txt",
      rev: "rev-17",
      content_hash: "a".repeat(64),
      size: 5,
      server_modified: "2026-08-25T12:00:00Z"
    })).toEqual({
      path: "/PROJECT_OS/example.txt",
      size: 5,
      modifiedAt: "2026-08-25T12:00:00Z",
      objectId: "id:abc",
      revisionToken: "rev-17",
      integrityHash: {
        algorithm: "dropbox-content-hash",
        value: "a".repeat(64)
      }
    });
  });

  it("converts historical Dropbox change evidence at the compatibility edge", () => {
    expect(toProviderChangeEntry({
      tag: "file",
      name: "example.txt",
      path: "/PROJECT_OS/example.txt",
      id: "id:abc",
      rev: "rev-17",
      content_hash: "b".repeat(64),
      size: 7
    })).toEqual({
      kind: "file",
      name: "example.txt",
      path: "/PROJECT_OS/example.txt",
      metadata: {
        path: "/PROJECT_OS/example.txt",
        size: 7,
        objectId: "id:abc",
        revisionToken: "rev-17",
        integrityHash: {
          algorithm: "dropbox-content-hash",
          value: "b".repeat(64)
        }
      }
    });
  });
});
