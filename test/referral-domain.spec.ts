import { describe, expect, it } from "vitest";
import {
  parseReferralEnvelope,
  parseReferralWriteRequest,
  type ReferralType
} from "../src/domain/referral";

const at = "2026-08-30T07:46:00+01:00";

const valid = {
  schema_version: "1.0" as const,
  referral_id: "REF-GOV-000000000001",
  source_project_id: "PRJ-0003",
  target_project_id: "PRJ-0002",
  referral_type: "improvement_request" as ReferralType,
  title: "Improve managed document identity visibility",
  created_at: at,
  source_refs: ["PRJ-0003/DELIVERABLES/AGENCY-V1-COCKPIT.md"],
  body: "Field observation"
};

describe("cross-project referral domain", () => {
  it("accepts exactly the seven standard referral types", () => {
    const types: ReferralType[] = [
      "anomaly",
      "dependency",
      "research",
      "information",
      "decision_request",
      "improvement_request",
      "deliverable_reference"
    ];
    for (const referral_type of types) {
      expect(parseReferralWriteRequest({ ...valid, referral_type }).referral_type).toBe(referral_type);
    }
    expect(() => parseReferralWriteRequest({ ...valid, referral_type: "task" })).toThrow();
  });

  it("rejects a referral whose source and target are the same project", () => {
    expect(() => parseReferralWriteRequest({ ...valid, target_project_id: valid.source_project_id }))
      .toThrow(/source|target/i);
  });

  it("keeps lifecycle state out of the referral envelope", () => {
    const envelope = parseReferralEnvelope({ ...valid, canonical: false });
    expect(envelope.canonical).toBe(false);
    expect(envelope).not.toHaveProperty("referral_status");
    expect(() => parseReferralEnvelope({ ...valid, canonical: false, referral_status: "incoming" })).toThrow();
  });
});
