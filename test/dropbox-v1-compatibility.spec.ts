import { expect, it } from "vitest";
import {
  documentIdFor,
  externalVersionIdFor
} from "../src/domain/managed-document";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../src/persistence/compatibility/dropbox-v1-evidence";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";

const metadata: ProviderObjectMetadata = {
  path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/a.md",
  size: 12,
  objectId: "id:ABC_123",
  revisionToken: "015abc",
  integrityHash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) }
};

it("emits the exact schema-1.0 Dropbox V1 evidence fields", () => {
  expect(requireDropboxV1Evidence(metadata)).toEqual({
    file_id: "id:ABC_123",
    rev: "015abc",
    content_hash: "a".repeat(64),
    size: 12
  });
  expect(toManagedProviderObservation(metadata)).toEqual({
    path: metadata.path,
    file_id: "id:ABC_123",
    rev: "015abc",
    content_hash: "a".repeat(64),
    size: 12
  });
});

it.each([
  [{ ...metadata, objectId: undefined }, /file id/i],
  [{ ...metadata, revisionToken: undefined }, /revision/i],
  [{ ...metadata, objectId: "object-without-dropbox-prefix" }, /file id/i],
  [{ ...metadata, integrityHash: { algorithm: "sha256", value: "a".repeat(64) } }, /hash/i],
  [{ ...metadata, integrityHash: { algorithm: "dropbox-content-hash", value: "NOT-HEX" } }, /hash/i],
  [{ ...metadata, size: -1 }, /size/i]
] as Array<[ProviderObjectMetadata, RegExp]>)
("fails closed when runtime evidence cannot reproduce Dropbox V1 schema values", (input, pattern) => {
  expect(() => requireDropboxV1Evidence(input)).toThrow(pattern);
});

it("preserves existing managed-document identity derivation exactly", async () => {
  await expect(documentIdFor("PRJ-0002", "strategy/commercial.md"))
    .resolves.toBe("DOC-F51F33E059EA070C9FCD4B0E");
  await expect(externalVersionIdFor("a1c10ce0dd78"))
    .resolves.toBe("VER-EXT-B06148949BF75A976EB92D0C");
});
