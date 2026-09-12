import type { EvaluationResult, RuleResource } from "../rules/contract";

/** Server-created admission only. Never decode this interface from a public payload. */
export interface ExecutionAdmission {
  project_id: string;
  request_id: string;
  kind: string;
  operation: string;
  request_hash: string;
  actor: { actor_id: string; authority: string };
  resources: RuleResource[];
  /** Server-resolved exact address authority, independent of the proposed plan.
   * Missing scope is valid only for non-executable/null-plan family records. */
  resource_effect_scopes?: ResourceEffectScope[];
  diagnosed_drift_refs?: string[];
  global_revision: number;
  project_revision: number;
  ruleset: EvaluationResult["ruleset"];
  verdict: EvaluationResult["verdict"];
  results: EvaluationResult["results"];
  gaps: EvaluationResult["gaps"];
  deferred_rules: EvaluationResult["deferred_rules"];
}

export interface ExecutionStep {
  step_id: string;
  resource_id: string;
  expected_version: string;
  provider_id: string;
  action:
    | { kind: "copy_if_unchanged"; source: ExpectedSource; destination: EffectAddress; expected_destination: ExpectedObject; desired: { content_sha256: string } }
    | { kind: "write_if_unchanged"; destination: EffectAddress; expected_destination: ExpectedObject; desired: { content_sha256: string; content_ref: string } }
    | { kind: "delete_if_unchanged"; source: ExpectedSource; verified_copy: ExpectedSource };
}
export interface EffectAddress { path: string; logical_path: string }
export interface ResourceEffectScope {
  resource_id: string;
  resource_version: string;
  provider_id: string;
  sources: EffectAddress[];
  destinations: EffectAddress[];
  preservation_copies: EffectAddress[];
}
export interface EffectObjectIdentity { object_id: string; revision_token: string; content_sha256: string }
export type ExpectedObject = { state: "absent" } | { state: "present"; identity: EffectObjectIdentity };
export interface ExpectedSource extends EffectAddress { expected: EffectObjectIdentity }
export type ObservedObject = EffectAddress & ExpectedObject;
export interface EffectObservation { source?: ObservedObject; destination?: ObservedObject }
export interface ExecutionPlan {
  steps: ExecutionStep[];
  postchecks: string[];
  target_revision: number;
  supersedes?: ExecutionPredecessor;
}
export interface ExecutionPredecessor {
  project_id: string; kind: string; request_id: string; request_hash: string;
  effect_plan_hash: string; target_revision: number;
  compatibility: "identical_effects_and_postchecks";
}
export interface SupersedingTarget {
  project_id: string; kind: string; request_id: string; request_hash: string;
  target_revision: number; effect_plan_hash: string;
  finalization_ref: string; compatibility_ref: string;
}
export interface FailureStreak { fingerprint: string; progress_digest: string; count: number }
export interface ExecutionProgress {
  schema_version: "1.0";
  project_id: string;
  request_id: string;
  kind: string;
  request_hash: string;
  admission_ref: string;
  effect_plan_hash: string;
  sequence: number;
  status: "rejected" | "committed" | "finalizing" | "finalized" | "conflict" | "failed";
  terminal: boolean;
  code: string | null;
  completed_steps: { step_id: string; evidence_refs: string[]; observation_hash?: string; precondition_refs?: string[] }[];
  postchecks: { check_id: string; verdict: "allow" | "deny" | "unavailable"; evidence_refs: string[] }[];
  failure_streak: FailureStreak | null;
  next_attempt_at: string | null;
  incident_ref: string | null;
  superseded_by: SupersedingTarget | null;
  finalization_ref?: string | null;
  receipt_ref: string | null;
  lease: { owner: string; until: string } | null;
}
export type StepObservation = { status: "ready" | "verified"; observed: EffectObservation; evidence_refs: string[] } | { status: "conflict" | "unavailable" };
/** Adapter is server code, never client-supplied assertions. execute must use the
 * frozen expected version and conditional/idempotent provider operations. The
 * existing family owner (ProjectGuard/MaterializationGuard) serializes resume. */
export interface ExecutionAdapter {
  verify(step: ExecutionStep): Promise<StepObservation>;
  execute(step: ExecutionStep): Promise<void>;
  postcheck(checkId: string): Promise<{ verdict: "allow" | "deny" | "unavailable"; evidence_refs: string[] }>;
  supersedingTarget?(): Promise<SupersedingTarget | null>;
}
