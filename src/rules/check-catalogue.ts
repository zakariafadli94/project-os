import { z } from "zod";
import { operationValues } from "../domain/transaction";
import type { RuleVersion } from "../domain/rule-governance";
import { verdict, type CheckStage, type RuleResult } from "./contract";

export const normalizedMutationOperations: readonly string[] = [...operationValues,
  "package.freeze", "package.replace",
  "package.drift.observe",
  "artifact.write", "document.publish", "document.reopen", "working.write", "working.supersede", "working.fork", "review.promote",
  "input.intake", "input.recover", "project.materialize", "project.repair", "candidate.resolve"];
const physical = ["package.replace", "package.drift.observe", "artifact.write", "document.publish", "document.reopen", "working.write", "working.supersede", "working.fork", "review.promote", "input.intake", "input.recover", "project.materialize", "project.repair"];
export interface CheckDefinition {
  check_id: string; operations: readonly string[]; parameters: z.ZodType;
  required_evidence: readonly string[]; stages: readonly CheckStage[];
  result_codes: readonly string[]; adapter: "pure" | "requires_server_control";
  implementation_ref: string;
}
const empty = z.strictObject({});
const both: CheckStage[] = ["pre_admission", "post_execution"];
function definition(check_id: string, operations: readonly string[], parameters: z.ZodType, required_evidence: string[], stages: CheckStage[], result_codes: string[], implementation_ref: string, adapter: CheckDefinition["adapter"] = "requires_server_control"): CheckDefinition {
  return Object.freeze({ check_id, operations: Object.freeze([...operations]), parameters, required_evidence: Object.freeze(required_evidence), stages: Object.freeze(stages), result_codes: Object.freeze(result_codes), implementation_ref, adapter });
}
const definitions = [
  definition("expected_version", physical, z.strictObject({ required: z.boolean() }), ["current_version"], ["pre_admission"], ["EXPECTED_VERSION_MATCH", "EXPECTED_VERSION_REQUIRED", "STALE_DOCUMENT_VERSION", "RULE_EVIDENCE_UNAVAILABLE", "RULE_EVIDENCE_AMBIGUOUS"], "src/documents/service.ts#assertManagedDocumentExpectedVersion", "pure"),
  definition("allowed_destination", ["artifact.write"], z.strictObject({ allowed_zones: z.array(z.enum(["WORKING", "DELIVERABLES", "ARCHIVES", "RESEARCH", "REFERENCES", "SPECS", "MEETINGS", "ARTIFACTS", "REVIEW"])).min(1) }), ["canonical_artifact_routes", "relative_path"], ["pre_admission"], ["DESTINATION_ALLOWED", "DESTINATION_FORBIDDEN", "RULE_EVIDENCE_UNAVAILABLE"], "src/persistence/artifact-routing.ts#resolveArtifactDestination", "pure"),
  definition("exact_approval", normalizedMutationOperations, empty, ["exact_server_approval"], both, ["EXACT_APPROVAL_REQUIRED", "EXACT_APPROVAL_VERIFIED"], "src/rules/evaluator.ts#exactApproval", "pure"),
  definition("current_uniqueness", physical, empty, ["current_head_inventory", "canonical_head_version"], both, ["RULE_CONTROL_UNAVAILABLE"], "src/documents/working-head-service.ts"),
  definition("verified_archive", physical, empty, ["source_metadata", "archive_metadata", "integrity_hash", "archive_provenance"], ["post_execution"], ["RULE_CONTROL_UNAVAILABLE"], "src/artifacts/staged-publication.ts#samePayload"),
  definition("valid_links", physical, empty, ["declared_links", "resolved_target_versions"], ["post_execution"], ["RULE_CONTROL_UNAVAILABLE"], "docs/superpowers/specs/2026-09-12-sop-runtime-coverage-matrix.md#L5"),
  definition("coherent_phase", ["plan.phase.complete"], empty, ["canonical_phase", "attached_task_statuses"], ["pre_admission"], ["RULE_CONTROL_UNAVAILABLE"], "src/domain/transitions.ts"),
  definition("useful_resume", normalizedMutationOperations, empty, ["exact_server_approval_or_objective_resume_control"], both, ["RULE_CONTROL_UNAVAILABLE", "EXACT_APPROVAL_REQUIRED", "EXACT_APPROVAL_VERIFIED"], "docs/superpowers/specs/2026-09-12-sop-runtime-coverage-matrix.md#L4"),
  definition("terminal_staging", physical, empty, ["staging_inventory", "terminal_effect_receipts"], ["post_execution"], ["RULE_CONTROL_UNAVAILABLE"], "src/documents/input-intake-service.ts"),
  definition("verified_presence", physical, empty, ["expected_object_version", "verified_provider_metadata"], ["post_execution"], ["RULE_CONTROL_UNAVAILABLE"], "src/convergence/fenced-effects.ts#observeText")
];
export const checkCatalogue: Readonly<Record<string, CheckDefinition>> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(definitions.map(check => [check.check_id, check]))));
export function validateCheck(rule: RuleVersion): RuleResult | null {
  const check = checkCatalogue[rule.check_id];
  if (!check) return verdict("unavailable", "UNKNOWN_ACTIVE_CHECK", rule, "Registered deployed check", rule.check_id, "Deploy and qualify a supported check before activation");
  if (!check.parameters.safeParse(rule.parameters).success) return verdict("unavailable", "INVALID_CHECK_PARAMETERS", rule, "Parameters matching the strict check schema", JSON.stringify(rule.parameters), "Propose and qualify a corrected rule version");
  if (rule.operations.some(op => !check.operations.includes(op))) return verdict("unavailable", "UNSUPPORTED_CHECK_OPERATION", rule, check.operations.join(", "), rule.operations.join(", "), "Qualify a supported operation adapter");
  const stages = rule.check_stage === "both" ? both : [rule.check_stage];
  if (stages.some(stage => !check.stages.includes(stage))) return verdict("unavailable", "UNSUPPORTED_CHECK_STAGE", rule, check.stages.join(", "), rule.check_stage, "Qualify a supported check stage");
  return null;
}
