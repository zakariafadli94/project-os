import { describe, expect, it } from "vitest";
import {
  parseProviderObservation,
  providerIntegrityHashEquals,
  upcastDropboxV1Observation
} from "../../src/schema/provider-evidence";

const hash = "a".repeat(64);

describe("provider neutral durable evidence", () => {
  it("upcasts flattened Dropbox V1 evidence exactly without relabeling its hash", () => {
    const result = upcastDropboxV1Observation({
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9006/WORKING/file.md",
      provider_file_id: "id:AbC_123-x",
      provider_rev: "015abc",
      provider_content_hash: hash,
      size: 42
    });

    expect(result).toEqual({
      provider_id: "dropbox",
      path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9006/WORKING/file.md",
      object_id: "id:AbC_123-x",
      revision_token: "015abc",
      integrity_hash: {
        algorithm: "dropbox-content-hash",
        value: hash
      },
      size: 42
    });
    expect(result).not.toHaveProperty("content_sha256");
  });

  it("upcasts the historical head observation aliases exactly", () => {
    expect(upcastDropboxV1Observation({
      path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9006/REVIEW/file.md",
      file_id: "id:Head_123",
      rev: "rev-head",
      content_hash: hash,
      size: 7
    })).toMatchObject({
      provider_id: "dropbox",
      object_id: "id:Head_123",
      revision_token: "rev-head",
      integrity_hash: { algorithm: "dropbox-content-hash", value: hash },
      size: 7
    });
  });

  it("accepts only complete strict provider observations", () => {
    const observation = {
      provider_id: "dropbox",
      path: "/provider/object",
      object_id: "id:Opaque",
      revision_token: "opaque-revision",
      integrity_hash: { algorithm: "dropbox-content-hash", value: hash },
      size: 12
    };
    expect(parseProviderObservation(observation)).toEqual(observation);
    expect(() => parseProviderObservation({ ...observation, object_id: undefined })).toThrow();
    expect(() => parseProviderObservation({ ...observation, integrity_hash: { value: hash } })).toThrow();
    expect(() => parseProviderObservation({ ...observation, unexpected: true })).toThrow();
  });

  it("includes the declared algorithm in integrity equality semantics", () => {
    expect(providerIntegrityHashEquals(
      { algorithm: "dropbox-content-hash", value: hash },
      { algorithm: "dropbox-content-hash", value: hash }
    )).toBe(true);
    expect(providerIntegrityHashEquals(
      { algorithm: "dropbox-content-hash", value: hash },
      { algorithm: "sha256", value: hash }
    )).toBe(false);
  });

  it("rejects partial or malformed Dropbox V1 evidence instead of inventing provider truth", () => {
    expect(() => upcastDropboxV1Observation({
      provider_path: "/provider/object",
      provider_file_id: "id:Opaque",
      provider_rev: "rev",
      size: 1
    })).toThrow(/content.*hash|evidence/i);
  });
});
