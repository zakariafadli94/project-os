import { describe, expect, it, vi } from "vitest";
import { ruleVersionSchema } from "../src/domain/rule-governance";
import { ruleFixture, ruleAt } from "./helpers/rule-fixtures";

async function qualification() {
  const module = await vi.importActual<Record<string, (...args: any[]) => any>>("../src/rules/qualification").catch(() => null);
  expect(module, "rule qualification is available").not.toBeNull();
  return module!;
}
function candidate(changes: Record<string, unknown> = {}) {
  return ruleVersionSchema.parse(ruleFixture("GLOBAL", { status: "accepted_unenforced", operations: ["artifact.write"], check_id: "expected_version", parameters: { required: true }, ...changes }));
}
function proof(changes: Record<string, unknown> = {}) {
  const binding = { status: "verified", evidence_ref: "evidence:7101", verification_ref: "verification:7101" };
  const check_evidence = changes.deployed_check_id === "allowed_destination"
    ? { canonical_artifact_routes: binding, relative_path: binding } : { current_version: binding };
  return { rule_id: "RULE-7101", rule_version: 1, rule_scope: { kind: "global" },
    check_evidence,
    evidence_refs: ["qualification:7101"], accepted_source_refs: ["DEC-7101"], deployed_check_id: "expected_version", deployment_ref: "build:qualified",
    entry_coverage: [{ operation: "artifact.write", entries: ["API", "CT", "FB", "IN", "CF", "AD", "RP", "GI"], evidence_refs: ["coverage:7101"] }],
    positive_test_refs: ["test:positive"], negative_test_refs: ["test:negative"], contradiction_scan_ref: "scan:7101", historical_drift_ref: "drift:7101",
    qualified_at: ruleAt, expires_at: "2026-09-13T10:00:00.000Z", ...changes };
}
async function qualify(rule = candidate(), evidence: unknown = proof(), active_rules: unknown[] = []) {
  return (await qualification()).qualifyRuleActivation({ rule, evidence, active_rules, requested_evidence_refs: ["qualification:7101"], now: ruleAt });
}
describe("activation qualification", () => {
  it("refuses opaque qualification references without per-check evidence bindings", async () => {
    const { check_evidence: _removed, ...opaque } = proof();
    expect(await qualify(candidate(), opaque)).toMatchObject({ verdict: "deny", code: "INVALID_QUALIFICATION_EVIDENCE" });
  });
  it("accepts verified evidence bound to each exact required check key", async () => {
    expect(await qualify(candidate(), proof({ check_evidence: { current_version: { status: "verified", evidence_ref: "version:7101", verification_ref: "verification:7101" } } }))).toMatchObject({ verdict: "allow", code: "RULE_QUALIFIED" });
  });
  it("requires every key of a check with multiple evidence requirements", async () => {
    const rule = candidate({ check_id: "allowed_destination", parameters: { allowed_zones: ["ARTIFACTS"] } });
    const complete = proof({ deployed_check_id: "allowed_destination" });
    expect(await qualify(rule, complete)).toMatchObject({ verdict: "allow" });
    expect(await qualify(rule, { ...complete, check_evidence: { canonical_artifact_routes: { status: "verified", evidence_ref: "routes:7101", verification_ref: "verification:7101" } } })).toMatchObject({ verdict: "deny", code: "QUALIFICATION_CHECK_EVIDENCE_MISMATCH" });
  });
  it.each([
    [{}, "deny", "QUALIFICATION_CHECK_EVIDENCE_MISMATCH"],
    [{ current_version: { status: "verified", evidence_ref: "version:7101", verification_ref: "verification:7101" }, unexpected: { status: "verified", evidence_ref: "extra:7101", verification_ref: "verification:7101" } }, "deny", "QUALIFICATION_CHECK_EVIDENCE_MISMATCH"],
    [{ current_version: { status: "unchecked" } }, "unavailable", "QUALIFICATION_CHECK_EVIDENCE_UNAVAILABLE"],
    [{ current_version: { status: "unavailable" } }, "unavailable", "QUALIFICATION_CHECK_EVIDENCE_UNAVAILABLE"],
    [{ current_version: { status: "verified", evidence_ref: "version:7101" } }, "deny", "INVALID_QUALIFICATION_EVIDENCE"]
  ])("refuses incomplete or unchecked required check evidence %j", async (check_evidence, verdict, code) => {
    expect(await qualify(candidate(), proof({ check_evidence: { current_version: { status: "verified", evidence_ref: "version:7101", verification_ref: "verification:7101" } } }))).toMatchObject({ verdict: "allow" });
    expect(await qualify(candidate(), proof({ check_evidence }))).toMatchObject({ verdict, code });
  });
  it("qualifies exact server evidence covering source, deployed check, entries, tests and drift", async () => {
    expect(await qualify()).toMatchObject({ verdict: "allow", code: "RULE_QUALIFIED" });
  });
  it.each([
    { accepted_source_refs: [] }, { deployment_ref: "" }, { deployed_check_id: "unknown" }, { entry_coverage: [] },
    { positive_test_refs: [] }, { negative_test_refs: [] }, { contradiction_scan_ref: "" }, { historical_drift_ref: "" },
    { rule_version: 2 }, { evidence_refs: ["unrelated"] }, { expires_at: "2026-09-11T10:00:00.000Z" },
    { entry_coverage: [{ operation: "artifact.write", entries: ["API"], evidence_refs: ["coverage:partial"] }] }
  ])("refuses incomplete/inexact qualification %j", async (changes) => {
    expect((await qualify(candidate(), proof(changes))).verdict).not.toBe("allow");
  });
  it.each([{ check_id: "unknown" }, { parameters: { disabled: true } }, { check_stage: "post_execution" }])("refuses unequipped check configuration %j", async changes => {
    expect((await qualify(candidate(changes))).verdict).not.toBe("allow");
  });
  it("refuses activation evidence supplied only as client references", async () => {
    expect(await qualify(candidate(), null)).toMatchObject({ verdict: "unavailable", code: "QUALIFICATION_EVIDENCE_UNAVAILABLE" });
  });
  it("detects an activation contradiction with an overlapping active global rule", async () => {
    const active = candidate({ status: "active", rule_id: "RULE-ACTIVE", check_id: "allowed_destination", parameters: { allowed_zones: ["WORKING"] }, activation_evidence: ["q"] });
    const next = candidate({ check_id: "allowed_destination", parameters: { allowed_zones: ["ARCHIVES"] } });
    expect(await qualify(next, proof({ deployed_check_id: "allowed_destination" }), [active])).toMatchObject({ verdict: "deny", code: "RULESET_CONFLICT" });
  });
  it("never drops active rules already known by the Guard when the resolver omits them", async () => {
    const module = await qualification();
    const active = candidate({ status: "active", rule_id: "RULE-ACTIVE", check_id: "allowed_destination", parameters: { allowed_zones: ["WORKING"] }, activation_evidence: ["q"] });
    const next = candidate({ check_id: "allowed_destination", parameters: { allowed_zones: ["ARCHIVES"] } });
    expect(await module.resolveAndQualifyRuleActivation({ resolve: async () => ({ evidence: proof({ deployed_check_id: "allowed_destination" }), active_rules: [] }) }, {
      rule: next, known_active_rules: [active], requested_evidence_refs: ["qualification:7101"], now: ruleAt
    })).toMatchObject({ verdict: "deny", code: "RULESET_CONFLICT" });
  });
});
