import { describe, expect, it } from "vitest";
import { parseArtifactWriteRequest } from "../src/domain/artifact-write";
import { binaryArtifactPolicyViolation } from "../src/artifacts/policy";

import { candidate } from "./helpers/review-candidate";
function configuration(request = candidate) {
  return {
    PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "off",
    PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE: "scoped",
    PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY: JSON.stringify({
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(), requests: [request]
    })
  };
}
describe("review candidate contract and scoped authorization", () => {
  it("parses an explicit candidate without losing evidence", () => {
    expect(parseArtifactWriteRequest(candidate)).toEqual(candidate);
  });
  it("allows only the exact scoped request with the global switch off", () => {
    expect(binaryArtifactPolicyViolation(configuration(), candidate as never)).toBeNull();
  });
  it("never lets global on authorize REVIEW", () => {
    expect(binaryArtifactPolicyViolation({ PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "on" }, candidate as never))
      .toMatchObject({ code: "REVIEW_CANDIDATE_DISABLED" });
  });
  it.each(["project_id", "content_sha256", "base_revision", "relative_path"])("rejects changed %s", key => {
    const changed = { ...candidate, [key]: key === "base_revision" ? 150 : "different" };
    expect(binaryArtifactPolicyViolation(configuration(), changed as never)).toMatchObject({ code: "REVIEW_CAPABILITY_DENIED" });
  });
  it.each([
    {}, { issued_at: "bad", expires_at: "bad", requests: [candidate] },
    { issued_at: "2020-01-01T00:00:00Z", expires_at: "2020-01-01T01:00:00Z", requests: [candidate] },
    { issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7200000).toISOString(), requests: [candidate] }
  ])("fails closed for invalid or expired capabilities", capability => {
    expect(binaryArtifactPolicyViolation({ ...configuration(), PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY: JSON.stringify(capability) }, candidate as never))
      .toMatchObject({ code: "REVIEW_CAPABILITY_DENIED" });
  });
  it.each([
    { mode: "replace" }, { relative_path: "nested/example.pdf" }, { media_type: "text/html" },
    { base_revision: undefined }, { source: { ...candidate.source, provider_id: undefined } },
    { request_id: "ART-REVIEW-CANDIDATE-0002" }
  ])("rejects unsafe or incomplete candidates", change => {
    expect(() => parseArtifactWriteRequest({ ...candidate, ...change })).toThrow();
  });
});
