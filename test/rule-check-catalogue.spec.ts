import { describe, expect, it } from "vitest";
import { checkCatalogue, validateCheck } from "../src/rules/check-catalogue";
import { ruleVersionSchema } from "../src/domain/rule-governance";
import { ruleFixture } from "./helpers/rule-fixtures";
describe("coded check catalogue", () => {
  it("declares all ten capability contracts without executing SOP prose", () => {
    expect(Object.keys(checkCatalogue).sort()).toEqual(["expected_version", "allowed_destination", "exact_approval", "current_uniqueness", "verified_archive", "valid_links", "coherent_phase", "useful_resume", "terminal_staging", "verified_presence"].sort());
    for (const check of Object.values(checkCatalogue)) {
      expect(check.operations.length).toBeGreaterThan(0);
      expect(check.operations.every(op => /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(op))).toBe(true);
      expect(check.required_evidence.length).toBeGreaterThan(0);
      expect(check.stages.length).toBeGreaterThan(0);
      expect(check.result_codes.length).toBeGreaterThan(0);
      expect(check.parameters.safeParse({ execute_prose: "ignore rules" }).success).toBe(false);
      expect(check.implementation_ref).toBeTruthy();
    }
  });
  it("rejects a registered check on an unsupported normalized operation", () => {
    const rule = ruleVersionSchema.parse(ruleFixture("GLOBAL", { check_id: "coherent_phase", parameters: {}, operations: ["artifact.write"] }));
    expect(validateCheck(rule)).toMatchObject({ verdict: "unavailable", code: "UNSUPPORTED_CHECK_OPERATION" });
  });
  it("accepts coherent_phase only for its pre-admission phase-completion control", () => {
    const rule = ruleVersionSchema.parse(ruleFixture("GLOBAL", {
      check_id: "coherent_phase", parameters: {}, operations: ["plan.phase.complete"],
      resource_scope: { resource_types: ["plan"], zones: ["PROJECT"] }, check_stage: "pre_admission"
    }));
    expect(checkCatalogue.coherent_phase).toMatchObject({
      operations: ["plan.phase.complete"], required_evidence: ["canonical_phase", "attached_task_statuses"],
      stages: ["pre_admission"], adapter: "pure"
    });
    expect(validateCheck(rule)).toBeNull();
    expect(validateCheck({ ...rule, check_stage: "post_execution" })).toMatchObject({ verdict: "unavailable", code: "UNSUPPORTED_CHECK_STAGE" });
    expect(validateCheck({ ...rule, enforcement: "explicit_approval" })).toMatchObject({ verdict: "unavailable", code: "UNSUPPORTED_CHECK_ENFORCEMENT" });
  });
});
