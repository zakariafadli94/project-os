import type { ProjectState } from "../domain/project-state";
import type { GlobalGovernanceState, RuleScope, RuleVersion } from "../domain/rule-governance";
import type { ResolvedQualificationProof } from "./qualification";

export type CheckStage = "pre_admission" | "post_execution";
export type Verdict = "allow" | "deny" | "approval_required" | "unavailable";
export interface RuleReference { rule_id: string; version: number; scope: RuleScope }
export interface RuleResult {
  verdict: Verdict; code: string; rule: RuleReference | null;
  expected: string; observed: string; required_action: string;
  resource_id?: string; evidence_refs?: string[]; exception_id?: string; approval_id?: string;
  qualification_proof?: ResolvedQualificationProof;
}
export interface RuleResource {
  resource_id: string; resource_type: string; zone: string; version: string;
  expected_version?: string; relative_path?: string;
  artifact_operation?: "REVIEW_CANDIDATE";
}
export interface RuleObservation {
  project_id: string; resource_id: string; resource_version: string;
  observed_at: string; expires_at: string; evidence_refs: string[];
  current_version?: string;
}
/** Server-created context only. Ingress must never deserialize client-selected rules/proofs into this interface. */
export interface OperationContext {
  actor: { actor_id: string; authority: string };
  project_id: string; operation: string; expected_project_revision: number;
  stage: CheckStage; now: string; state: ProjectState;
  global_governance: GlobalGovernanceState | null;
  resources: RuleResource[]; observations: RuleObservation[]; approvals: unknown[];
}
export interface EvaluationResult extends RuleResult {
  ruleset: { digest: string; rules: RuleReference[]; global_revision: number | null; project_revision: number };
  results: RuleResult[]; gaps: { rule: RuleReference; code: string; check_id: string }[];
  deferred_rules: RuleReference[];
}
export function ruleReference(rule: RuleVersion): RuleReference {
  return { rule_id: rule.rule_id, version: rule.version, scope: structuredClone(rule.scope) };
}
export function verdict(verdict: Verdict, code: string, rule: RuleVersion | null, expected: string, observed: string, required_action: string): RuleResult {
  return { verdict, code, rule: rule ? ruleReference(rule) : null, expected, observed, required_action };
}
export function liveAt(start: string, end: string, now: string): boolean {
  return Date.parse(start) <= Date.parse(now) && Date.parse(now) < Date.parse(end);
}
export function sameScope(a: RuleScope, b: RuleScope): boolean {
  return a.kind === b.kind && (a.kind === "global" || (b.kind === "project" && a.project_id === b.project_id));
}
/** Unicode scalar/code-point ordering, independent of host locale and ICU collation data. */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compareCodePoints(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
