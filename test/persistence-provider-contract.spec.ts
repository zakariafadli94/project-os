import { describe, expect, it } from "vitest";
import { ProviderCapabilityError } from "../src/persistence/provider/errors";
import {
  requireProjectOsPersistence,
  type PersistenceRuntime
} from "../src/persistence/provider/capabilities";
import type { ObjectPersistence, ProviderObjectMetadata } from "../src/persistence/provider/contract";

const metadata: ProviderObjectMetadata = {
  path: "/PROJECT_OS/example.txt",
  size: 3,
  objectId: "opaque-object-id",
  revisionToken: "opaque-revision",
  integrityHash: { algorithm: "example-hash", value: "abc123" }
};

describe("provider-neutral persistence contracts", () => {
  it("keeps object ids, revision tokens and hash semantics opaque", () => {
    expect(metadata.objectId).toBe("opaque-object-id");
    expect(metadata.revisionToken).toBe("opaque-revision");
    expect(metadata.integrityHash).toEqual({ algorithm: "example-hash", value: "abc123" });
  });

  it("fails composition when a required capability is absent", () => {
    const runtime: PersistenceRuntime = {
      providerId: "test",
      objects: fakeObjects(),
      evidence: {
        stableObjectId: { semantics: "stable-through-move" },
        revisionToken: { semantics: "opaque-object-revision" },
        integrityHash: { semantics: "identified-algorithm" }
      }
    };
    expect(() => requireProjectOsPersistence(runtime)).toThrow(ProviderCapabilityError);
  });
});

function fakeObjects(): ObjectPersistence {
  return {
    readText: async () => null,
    createText: async () => undefined,
    upsertText: async () => undefined,
    getMetadata: async () => null,
    listChildren: async () => [],
    move: async () => undefined,
    delete: async () => undefined
  };
}
