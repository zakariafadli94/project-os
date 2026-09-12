import { describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { ruleVersionSchema } from "../src/domain/rule-governance";
import { resolveEffectiveRules } from "../src/rules/resolution";
import { ruleFixture, exceptionFixture, ruleAt } from "./helpers/rule-fixtures";

async function runtime() {
  const module = await vi.importActual<Record<string, (...args: any[]) => any>>("../src/rules/evaluator").catch(() => null);
  expect(module, "rule evaluator is available").not.toBeNull();
  return module!;
}
function rule(id = "RULE-GLOBAL", scope = "GLOBAL", changes: Record<string, unknown> = {}) {
  return ruleVersionSchema.parse(ruleFixture(scope, { rule_id: id, status: "active", operations: ["artifact.write"],
    resource_scope: { resource_types: ["artifact"], zones: ["WORKING"] }, check_id: "expected_version", parameters: { required: true },
    activation_evidence: ["qualification:7101"], ...changes }));
}
function context(globalRules = [rule()], localRules: ReturnType<typeof rule>[] = []) {
  const state = emptyProjectState("PRJ-7101", "Rules", "rules");
  state.revision = 9;
  state.local_rules = Object.fromEntries(localRules.map(r => [`${r.rule_id}@${r.version}`, r]));
  return {
    actor: { actor_id: "founder", authority: "project.mutate" }, project_id: "PRJ-7101", operation: "artifact.write",
    expected_project_revision: 9, stage: "pre_admission", now: ruleAt, state,
    global_governance: { revision: 3, rules: Object.fromEntries(globalRules.map(r => [`${r.rule_id}@${r.version}`, r])), exceptions: {} as Record<string, unknown> },
    resources: [{ resource_id: "ART-7101", resource_type: "artifact", zone: "WORKING", version: "v2", expected_version: "v1", relative_path: "WORKING/report.md" }],
    observations: [{ project_id: "PRJ-7101", resource_id: "ART-7101", resource_version: "v2", observed_at: ruleAt,
      expires_at: "2026-09-12T11:00:00.000Z", evidence_refs: ["observation:7101"], current_version: "v1" }],
    approvals: [] as Record<string, unknown>[]
  };
}
function approval(changes: Record<string, unknown> = {}) {
  return { approval_id: "APP-7101", actor_id: "founder", approved_by: "reviewer", project_id: "PRJ-7101",
    rule_id: "RULE-GLOBAL", rule_version: 1, rule_scope: { kind: "global" }, resource_id: "ART-7101", resource_version: "v2",
    operation: "artifact.write", status: "approved", granted_at: ruleAt, expires_at: "2026-09-12T11:00:00.000Z", evidence_refs: ["approval:7101"], ...changes };
}
async function evaluate(input: unknown) { return (await runtime()).evaluateRules(input); }

describe("server-side effective rule evaluation", () => {
  it("inherits all global and project rules with exact versions", async () => {
    const input = context([rule()], [rule("RULE-LOCAL", "PRJ-7101")]);
    const resolved = await resolveEffectiveRules(input as any);
    expect(resolved.rules.map(r => [r.rule_id, r.version])).toEqual([["RULE-GLOBAL", 1], ["RULE-LOCAL", 1]]);
    expect(await evaluate(input)).toMatchObject({ verdict: "unavailable", code: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
  });
  it("binds canonical project identity and refuses stale canonical revisions", async () => {
    expect(await evaluate({ ...context(), project_id: "PRJ-7102" })).toMatchObject({ verdict: "deny", code: "PROJECT_SCOPE_MISMATCH" });
    expect(await evaluate({ ...context(), expected_project_revision: 8 })).toMatchObject({ verdict: "deny", code: "STALE_PROJECT_REVISION" });
    const independent = context([], []);
    expect(await evaluate(independent)).toMatchObject({ verdict: "allow" });
  });
  it("recognizes an external package-drift observation in the common rule evaluator", async () => {
    const input = context([rule("RULE-DRIFT", "GLOBAL", {
      operations: ["package.drift.observe"],
      resource_scope: { resource_types: ["package"], zones: ["WORKING"] },
      check_id: "exact_approval",
      parameters: {}
    })]);
    input.operation = "package.drift.observe";
    input.resources = [{ resource_id: "PKG-DRIFT", resource_type: "package", zone: "WORKING", version: "1:manifest", expected_version: "1:manifest", relative_path: "WORKING/PACKAGES/PKG-DRIFT/1" }];

    expect(await evaluate(input)).toMatchObject({ verdict: "approval_required", code: "EXACT_APPROVAL_REQUIRED" });
  });
  it("returns stable ordering and digest independent of map insertion order", async () => {
    const first = await evaluate(context([rule("RULE-ZZZZ"), rule("RULE-AAAA")]));
    const second = await evaluate(context([rule("RULE-AAAA"), rule("RULE-ZZZZ")]));
    expect(first.ruleset.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.ruleset.digest).toBe(second.ruleset.digest);
    expect(first.results.map((r: any) => r.rule.rule_id)).toEqual(["RULE-AAAA", "RULE-ZZZZ"]);
    expect((await evaluate(context([rule("RULE-AAAA", "GLOBAL", { version: 2 })]))).ruleset.digest).not.toBe(first.ruleset.digest);
  });
  it("orders Unicode rule identities by code point and keeps digest independent of locale collation", async () => {
    const input = context([rule("RULE-😀"), rule("RULE-é"), rule("RULE-a"), rule("RULE-\uE000"), rule("RULE-Z")]);
    const first = await evaluate(input);
    expect(first.results.map((r: any) => r.rule.rule_id)).toEqual(["RULE-Z", "RULE-a", "RULE-é", "RULE-\uE000", "RULE-😀"]);
    const collation = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => 0);
    try {
      const second = await evaluate(context(Object.values(input.global_governance.rules).reverse()));
      expect(second.ruleset.digest).toBe(first.ruleset.digest);
      expect(second.results.map((r: any) => r.rule.rule_id)).toEqual(["RULE-Z", "RULE-a", "RULE-é", "RULE-\uE000", "RULE-😀"]);
    } finally { collation.mockRestore(); }
  });
  it("keeps global constraints when a local rule with the same ID is weaker", async () => {
    const input = context([rule()], [rule("RULE-GLOBAL", "PRJ-7101", { parameters: { required: false } })]);
    input.resources[0].expected_version = undefined as any;
    const result = await evaluate(input);
    expect(result).toMatchObject({ verdict: "unavailable", code: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
    input.state.local_rules = {};
    expect(await evaluate(input)).toMatchObject({ verdict: "deny", code: "EXPECTED_VERSION_REQUIRED" });
  });
  it("detects contradictory destination requirements at runtime", async () => {
    const changes = { check_id: "allowed_destination", parameters: { allowed_zones: ["ARTIFACTS"] } };
    const result = await evaluate(context([rule("RULE-GLOBAL", "GLOBAL", changes), rule("RULE-OTHER", "GLOBAL", { ...changes, parameters: { allowed_zones: ["ARCHIVES"] } })]));
    expect(result).toMatchObject({ verdict: "deny", code: "RULESET_CONFLICT" });
  });
  it.each([
    [{ check_id: "unknown_check" }, "UNKNOWN_ACTIVE_CHECK"],
    [{ check_id: "toString" }, "UNKNOWN_ACTIVE_CHECK"],
    [{ check_id: "__proto__" }, "UNKNOWN_ACTIVE_CHECK"],
    [{ parameters: { disable_global: true } }, "INVALID_CHECK_PARAMETERS"],
    [{ check_stage: "post_execution" }, "UNSUPPORTED_CHECK_STAGE"]
  ])("fails closed for unsupported active contract %j", async (changes, code) => {
    expect(await evaluate(context([rule("RULE-GLOBAL", "GLOBAL", changes as Record<string, unknown>)]))).toMatchObject({ verdict: "unavailable", code });
  });
  it("exposes accepted unenforced and unknown-check gaps without silently activating them", async () => {
    const result = await evaluate(context([rule("RULE-GAP", "GLOBAL", { status: "accepted_unenforced", check_id: "unknown_check" })]));
    expect(result).toMatchObject({ verdict: "allow", gaps: [{ rule: { rule_id: "RULE-GAP", version: 1 }, code: "ACCEPTED_UNENFORCED" }] });
    expect(result.results).toEqual([]);
  });
  it("never converts missing global governance into an empty allow", async () => {
    expect(await evaluate({ ...context(), global_governance: null })).toMatchObject({ verdict: "unavailable", code: "GLOBAL_GOVERNANCE_UNAVAILABLE" });
  });
  it.each([{}, { revision: -1, rules: {}, exceptions: {} }, { revision: 1, exceptions: {} }])("fails closed for incomplete canonical global snapshots %j", async global_governance => {
    expect(await evaluate({ ...context(), global_governance })).toMatchObject({ verdict: "unavailable", code: "CANONICAL_RULESET_INVALID" });
  });
  it("refuses contradictory live observations instead of selecting the first", async () => {
    const input = context();
    input.observations.push({ ...input.observations[0], current_version: "v0" });
    expect(await evaluate(input)).toMatchObject({ verdict: "unavailable", code: "RULE_EVIDENCE_AMBIGUOUS" });
  });
  it("requires exact human approval for qualitative enforcement without model judgement", async () => {
    const input = context([rule("RULE-GLOBAL", "GLOBAL", { check_id: "useful_resume", parameters: {}, enforcement: "explicit_approval" })]);
    input.observations = [];
    expect(await evaluate(input)).toMatchObject({ verdict: "approval_required", code: "EXACT_APPROVAL_REQUIRED" });
    input.approvals = [approval()];
    expect(await evaluate(input)).toMatchObject({ verdict: "allow" });
  });
  it.each([{ rule_version: 2 }, { resource_version: "v1" }, { actor_id: "another" }, { project_id: "PRJ-7102" }, { status: "revoked" }, { expires_at: "2026-09-11T10:00:00.000Z" }, { rule_scope: { kind: "project", project_id: "PRJ-7101" } }])("rejects stale or mismatched approvals %j", async (changes) => {
    const input = context([rule("RULE-GLOBAL", "GLOBAL", { enforcement: "explicit_approval" })]);
    input.approvals = [approval(changes)];
    expect(await evaluate(input)).toMatchObject({ verdict: "approval_required" });
  });
  it("accepts a live exact canonical exception and records its ID", async () => {
    const input = context(); input.observations[0].current_version = "v0";
    input.global_governance.exceptions = { "EXC-7101": { ...exceptionFixture({ rule_id: "RULE-GLOBAL", resources: ["ART-7101"], operations: ["artifact.write"] }), status: "granted" } };
    const result = await evaluate(input);
    expect(result.verdict).toBe("allow");
    expect(result.results[0]).toMatchObject({ code: "RULE_EXCEPTION_APPLIED", exception_id: "EXC-7101" });
  });
  it.each([{ rule_version: 2 }, { project_id: "PRJ-7102" }, { resources: ["ART-9999"] }, { operations: ["task.start"] }, { status: "revoked" }, { expires_at: "2026-09-11T10:00:00.000Z" }])("does not apply an inexact/expired/revoked exception %j", async (changes) => {
    const input = context(); input.observations[0].current_version = "v0";
    input.global_governance.exceptions = { "EXC-7101": { ...exceptionFixture({ rule_id: "RULE-GLOBAL", resources: ["ART-7101"], operations: ["artifact.write"] }), status: "granted", ...changes } };
    expect(await evaluate(input)).toMatchObject({ verdict: "deny", code: "STALE_DOCUMENT_VERSION" });
  });
  it("cannot waive canonical concurrency through an exception", async () => {
    const input = context(); input.expected_project_revision = 8;
    input.global_governance.exceptions = { "EXC-7101": { ...exceptionFixture({ resources: ["ART-7101"], operations: ["artifact.write"] }), status: "granted" } };
    expect(await evaluate(input)).toMatchObject({ verdict: "deny", code: "STALE_PROJECT_REVISION" });
  });
  it("returns actionable rule/version evidence on refusal", async () => {
    const input = context(); input.observations[0].current_version = "v0";
    const result = await evaluate(input);
    expect(result.results[0]).toMatchObject({ verdict: "deny", code: "STALE_DOCUMENT_VERSION", rule: { rule_id: "RULE-GLOBAL", version: 1 }, expected: expect.any(String), observed: expect.any(String), required_action: expect.any(String) });
    expect(result.results[0].expected).toContain("v1"); expect(result.results[0].observed).toContain("v0");
  });
  it("treats missing, expired and mismatched objective observations as unavailable", async () => {
    const input = context(); input.observations = [];
    expect(await evaluate(input)).toMatchObject({ verdict: "unavailable", code: "RULE_EVIDENCE_UNAVAILABLE" });
    const stale = context(); stale.observations[0].expires_at = "2026-09-11T10:00:00.000Z";
    expect(await evaluate(stale)).toMatchObject({ verdict: "unavailable" });
    const foreign = context(); foreign.observations[0].project_id = "PRJ-7102";
    expect(await evaluate(foreign)).toMatchObject({ verdict: "unavailable" });
  });
  it("uses the existing artifact route calculation for destination checks", async () => {
    const input = context([rule("RULE-GLOBAL", "GLOBAL", { check_id: "allowed_destination", parameters: { allowed_zones: ["ARTIFACTS"] } })]);
    expect(await evaluate(input)).toMatchObject({ verdict: "allow" });
    input.resources[0].relative_path = "../escape";
    expect(await evaluate(input)).toMatchObject({ verdict: "deny", code: "DESTINATION_FORBIDDEN" });
  });
  it("exposes deferred postchecks and missing controls without inventing their effects", async () => {
    const input = context([rule("RULE-GLOBAL", "GLOBAL", { check_id: "valid_links", parameters: {}, check_stage: "post_execution" })]);
    expect(await evaluate(input)).toMatchObject({ verdict: "allow", deferred_rules: [{ rule_id: "RULE-GLOBAL", version: 1 }] });
    input.stage = "post_execution";
    expect(await evaluate(input)).toMatchObject({ verdict: "unavailable", code: "RULE_CONTROL_UNAVAILABLE" });
  });
});
