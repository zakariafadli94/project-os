import { describe, expect, it } from "vitest";
import {
  RULE_ADMISSION_PERMIT_TTL_MS,
  issueRuleAdmissionPermit,
  parseRuleAdmissionInput,
  verifyRuleAdmissionPermit
} from "../src/admission/rule-admission";

const secret = "rule-admission-test-secret";
const now = Date.parse("2026-09-12T12:00:00.000Z");
const input = {
  actor: { actor_id: "ingress", authority: "ingress_token" },
  project_id: "PRJ-8101",
  operation: "artifact.write",
  resources: [{ resource_id: "REQ-8101", resource_type: "artifact", zone: "DELIVERABLES", version: "sha-8101", relative_path: "DELIVERABLES/a.md" }],
  request_hash: "a".repeat(64),
  global_revision: 7,
  ruleset: { digest: "b".repeat(64), rules: [{ rule_id: "RULE-GLOBAL", version: 3, scope: { kind: "global" as const } }], global_revision: 7, project_revision: 12 }
};

describe("RegistryGuard rule-admission permit", () => {
  it("retains and signs the exact review-candidate operation discriminant", async () => {
    const review = parseRuleAdmissionInput({ ...input, resources: [{ ...input.resources[0], zone: "REVIEW", artifact_operation: "REVIEW_CANDIDATE" }] });
    expect(review.resources[0]).toHaveProperty("artifact_operation", "REVIEW_CANDIDATE");
    const permit = await issueRuleAdmissionPermit(review, secret, now);
    await expect(verifyRuleAdmissionPermit(permit, review, secret, now + 1)).resolves.toBeUndefined();
    const altered = { ...review, resources: review.resources.map(({ artifact_operation: _, ...resource }: any) => resource) };
    await expect(verifyRuleAdmissionPermit(permit, altered, secret, now + 1)).rejects.toMatchObject({ code: "rule_admission_scope_mismatch" });
  });
  it("binds one signed permit to its actor, project, operation, resources, request and global rules revision", async () => {
    const permit = await issueRuleAdmissionPermit(input, secret, now);

    expect(Date.parse(permit.expires_at) - Date.parse(permit.issued_at)).toBe(RULE_ADMISSION_PERMIT_TTL_MS);
    await expect(verifyRuleAdmissionPermit(permit, input, secret, now + 1)).resolves.toBeUndefined();
    await expect(verifyRuleAdmissionPermit(permit, { ...input, request_hash: "c".repeat(64) }, secret, now + 1))
      .rejects.toMatchObject({ code: "rule_admission_request_mismatch" });
    await expect(verifyRuleAdmissionPermit(permit, { ...input, project_id: "PRJ-8102" }, secret, now + 1))
      .rejects.toMatchObject({ code: "rule_admission_scope_mismatch" });
    await expect(verifyRuleAdmissionPermit(permit, { ...input, operation: "document.publish" }, secret, now + 1))
      .rejects.toMatchObject({ code: "rule_admission_scope_mismatch" });
    await expect(verifyRuleAdmissionPermit(permit, { ...input, global_revision: 8, ruleset: { ...input.ruleset, global_revision: 8 } }, secret, now + 1))
      .rejects.toMatchObject({ code: "rule_admission_ruleset_stale" });
  });

  it("refuses an uncommitted permit after its fixed short expiry", async () => {
    const permit = await issueRuleAdmissionPermit(input, secret, now);

    await expect(verifyRuleAdmissionPermit(permit, input, secret, now + RULE_ADMISSION_PERMIT_TTL_MS))
      .rejects.toMatchObject({ code: "rule_admission_expired" });
  });

  it("rejects a future-issued, malformed, or differently signed permit", async () => {
    const permit = await issueRuleAdmissionPermit(input, secret, now);

    await expect(verifyRuleAdmissionPermit(permit, input, secret, now - 1))
      .rejects.toMatchObject({ code: "rule_admission_invalid" });
    await expect(verifyRuleAdmissionPermit({ ...permit, token: "malformed" }, input, secret, now + 1))
      .rejects.toMatchObject({ code: "rule_admission_invalid" });
    await expect(verifyRuleAdmissionPermit(permit, input, "different-rule-admission-secret", now + 1))
      .rejects.toMatchObject({ code: "rule_admission_invalid" });
  });
});
