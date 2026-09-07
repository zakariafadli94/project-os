import { describe, expect, it } from "vitest";
import {
  classifyPostcheckResponse,
  classifyReadinessResponse,
  classifyRevocationResponse,
} from "../scripts/recovery-http-policy.mjs";

describe("INPUT recovery HTTP policy", () => {
  it("retries a transient 404 while the zero-traffic version override propagates", () => {
    expect(classifyReadinessResponse(404, '{"error":"not_found"}')).toBe("retry");
  });

  it("recognizes the authenticated invalid-project probe as ready", () => {
    expect(classifyReadinessResponse(400, '{"error":"invalid_project_id"}')).toBe("ready");
  });

  it("fails closed on an unexpected readiness response", () => {
    expect(classifyReadinessResponse(500, '{"error":"internal"}')).toBe("fail");
  });

  it("accepts 401 or 404 as revocation after base identity restoration", () => {
    expect(classifyRevocationResponse(401)).toBe("revoked");
    expect(classifyRevocationResponse(404)).toBe("revoked");
    expect(classifyRevocationResponse(200)).toBe("retry");
  });

  it("retries a transient post-recovery 401 or 404 while the version override propagates", () => {
    expect(classifyPostcheckResponse(401)).toBe("retry");
    expect(classifyPostcheckResponse(404)).toBe("retry");
  });

  it("accepts only HTTP 200 for post-recovery verification", () => {
    expect(classifyPostcheckResponse(200)).toBe("ready");
    expect(classifyPostcheckResponse(500)).toBe("fail");
  });
});
