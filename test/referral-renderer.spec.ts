import { describe, expect, it } from "vitest";
import { renderReferralMarkdown } from "../src/referrals/renderer";

const envelope = {
  schema_version: "1.0" as const,
  referral_id: "REF-GOV-000000000001",
  source_project_id: "PRJ-0003",
  target_project_id: "PRJ-0002",
  referral_type: "improvement_request" as const,
  title: "Improve managed document identity visibility",
  created_at: "2026-08-30T10:00:00.000Z",
  source_refs: ["PRJ-0003/DELIVERABLES/AGENCY-V1-COCKPIT.md"],
  canonical: false as const,
  body: "Field observation"
};

describe("referral Markdown renderer", () => {
  it("renders the standard envelope without workflow or canonical-acceptance fields", () => {
    const markdown = renderReferralMarkdown(envelope);
    expect(markdown).toContain("referral_id: REF-GOV-000000000001");
    expect(markdown).toContain("source_project_id: PRJ-0003");
    expect(markdown).toContain("target_project_id: PRJ-0002");
    expect(markdown).toContain("referral_type: improvement_request");
    expect(markdown).toContain("canonical: false");
    expect(markdown).toContain("# Improve managed document identity visibility");
    expect(markdown).not.toContain("referral_status:");
    expect(markdown).not.toContain("task_id:");
    expect(markdown).not.toContain("decision_id:");
  });
});
