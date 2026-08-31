import { describe, expect, it } from "vitest";
import { parseReferralWriteRequest } from "../src/domain/referral-write";

const valid = {
  schema_version: "1.0" as const,
  request_id: "REF-PRJ0003-PRJ0002-20260831-A1B2",
  source_project_id: "PRJ-0003",
  target_project_id: "PRJ-0002",
  relative_path: "improvements/input-lifecycle-anomaly.md",
  content: "# Referral\n\nInvestigate stale INPUTS lifecycle.",
  content_sha256: "a".repeat(64),
  created_at: "2026-08-31T14:10:00+01:00",
  referral_type: "project_os_improvement_anomaly",
  topic: "input_lifecycle"
};

describe("referral write request", () => {
  it("parses a strict cross-project referral envelope", () => {
    expect(parseReferralWriteRequest(valid)).toEqual(valid);
  });

  it.each([
    ["unsafe request id", { request_id: "ref-bad" }],
    ["unsafe source project", { source_project_id: "PRJ-3" }],
    ["unsafe target project", { target_project_id: "../../PRJ-0002" }],
    ["same source and target", { target_project_id: "PRJ-0003" }],
    ["absolute path", { relative_path: "/escape.md" }],
    ["path traversal", { relative_path: "../escape.md" }],
    ["empty path segment", { relative_path: "a//b.md" }],
    ["unsafe hash", { content_sha256: "ABC" }],
    ["invalid timestamp", { created_at: "2026-08-31" }],
    ["empty referral type", { referral_type: "   " }],
    ["empty topic", { topic: "" }]
  ])("rejects %s", (_name, patch) => {
    expect(() => parseReferralWriteRequest({ ...valid, ...patch })).toThrow();
  });

  it("allows referral type and topic to be omitted", () => {
    const { referral_type: _type, topic: _topic, ...withoutOptional } = valid;
    expect(parseReferralWriteRequest(withoutOptional)).toEqual(withoutOptional);
  });

  it("rejects undeclared fields", () => {
    expect(() => parseReferralWriteRequest({ ...valid, trusted: true })).toThrow();
  });
});
