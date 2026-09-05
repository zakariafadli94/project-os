import { describe, expect, it } from "vitest";
import { binaryArtifactPolicyViolation, parseBinaryArtifactPolicy } from "../src/artifacts/policy";
import type { StagedArtifactWriteRequest } from "../src/domain/artifact-write";

const request: StagedArtifactWriteRequest = {
  request_id: "ART-BINARY-POLICY-0001",
  project_id: "PRJ-0003",
  relative_path: "example.pdf",
  content_sha256: "a".repeat(64),
  source: {
    kind: "staged_provider_object",
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-POLICY-0001/example.pdf",
    object_id: "id:source",
    revision_token: "rev-1",
    size: 11,
    integrity: { algorithm: "dropbox-content-hash", value: "hash" }
  },
  mode: "create"
};

describe("binary artifact policy", () => {
  it("defaults to disabled", () => {
    expect(binaryArtifactPolicyViolation({}, request)).toMatchObject({ code: "BINARY_ARTIFACT_INGRESS_DISABLED" });
  });

  it("enforces the configured byte limit", () => {
    expect(binaryArtifactPolicyViolation({
      PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "on",
      PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES: "10"
    }, request)).toMatchObject({ code: "BINARY_ARTIFACT_TOO_LARGE" });
  });

  it("accepts the exact configured byte limit", () => {
    expect(binaryArtifactPolicyViolation({
      PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "on",
      PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES: "11"
    }, request)).toBeNull();
  });

  it.each(["0", "-1", "1.5", "invalid"])("rejects invalid configured max %s", (value) => {
    expect(() => parseBinaryArtifactPolicy({ PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES: value })).toThrow();
  });
});
