import { z } from "zod";
import { reviewCandidateRequestSchema, type ReviewCandidateRequest } from "../domain/artifact-write";
import type { BinaryArtifactPolicyEnv, BinaryArtifactPolicyViolation } from "./policy";

const capabilitySchema = z.strictObject({
  issued_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  requests: z.array(reviewCandidateRequestSchema).min(1).max(10)
});
export function reviewCandidatePolicyViolation(
  env: BinaryArtifactPolicyEnv, request: ReviewCandidateRequest
): BinaryArtifactPolicyViolation | null {
  if (env.PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE !== "scoped") {
    return { code: "REVIEW_CANDIDATE_DISABLED", message: "Review candidate ingress is disabled" };
  }
  const denied: BinaryArtifactPolicyViolation = { code: "REVIEW_CAPABILITY_DENIED", message: "No current exact review capability authorizes this request" };
  const raw = env.PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY;
  if (!raw || raw.length > 65536) return denied;
  try {
    const capability = capabilitySchema.parse(JSON.parse(raw));
    const issued = Date.parse(capability.issued_at), expires = Date.parse(capability.expires_at), now = Date.now();
    if (issued > now || expires <= now || expires <= issued || expires - issued > 3600000) return denied;
    const parsed = reviewCandidateRequestSchema.parse(request);
    if (!capability.requests.some(allowed => JSON.stringify(allowed) === JSON.stringify(parsed))) return denied;
    if (parsed.source.size < 1 || parsed.source.size > 10 * 1024 * 1024) {
      return { code: "BINARY_ARTIFACT_TOO_LARGE", message: "Review candidate size must be between 1 byte and 10 MiB" };
    }
    return null;
  } catch { return denied; }
}

export class ReviewCapabilityExpiredError extends Error {
  constructor() { super("Review capability is no longer valid before copy"); }
}
