export const LAYERS = [
  "canonical",
  "event",
  "state",
  "manifest",
  "receipt",
  "human_state",
  "human_handoff",
  "generation",
  "head",
  "scheduler"
] as const;

export type Layer = typeof LAYERS[number];
export type HealthState = "current" | "pending" | "retry_wait" | "exhausted" | "blocked" | "unknown";
export type ObligationState = "pending" | "running" | "retry_wait" | "exhausted" | "blocked" | "verified";

export interface Evidence {
  revision: number | null;
  identity: string | null;
  hash: string | null;
  projection_version: number | null;
  root_hash: string | null;
}

export interface LayerHealth {
  state: HealthState;
  applicable: boolean;
  expected: Evidence;
  observed: Evidence;
  last_verified_at: string | null;
  first_pending_at: string | null;
  next_attempt_at: string | null;
  failure_count: number;
  code: string | null;
  verified_through: number | null;
  missing_count: number;
  first_missing_id: string | null;
  observation_complete: boolean;
}

export interface ConvergenceHealth {
  schema_version: "1.0";
  project_id: string;
  layers: Record<Layer, LayerHealth>;
  converged: boolean;
  due_without_alarm: boolean;
  first_observed_at: string;
  commit_accepted_at: string | null;
  commit_time_code: "commit_time_unknown" | null;
}

export interface Target {
  revision: number;
  projection_version: number;
}

export interface AttemptReservation {
  schema_version: "1.0";
  project_id: string;
  obligation_id: string;
  layer: Layer;
  from_revision: number;
  target: Target;
  attempt_number: number;
  incident: number;
  incarnation: string;
  reserved_at: string;
  lease_until: string;
}

export interface EffectIntent {
  id: string;
  path: string;
  destination: string | null;
  kind: "create" | "replace" | "delete" | "move";
  object_id: string | null;
  expected_token: string | null;
  desired_hash: string | null;
  authorized_previous_hash: string | null;
  state: "prepared" | "uncertain" | "verified" | "neutralized" | "blocked";
  verified_token: string | null;
}

export interface Progress {
  schema_version: "1.0";
  project_id: string;
  incarnation: string;
  lease_until: string;
  canonical_observed_revision: number;
  baseline_revision: number;
  baseline_kind: "commit" | "pre_commit001";
  event_verified_through: number;
  receipt_verified_through: number;
  missing_event_ids: string[];
  missing_receipt_ids: string[];
  active: Target | null;
  requested: Target | null;
  parked: Target[];
  obligations: Record<string, unknown>;
  effects: Record<string, EffectIntent>;
  partial_outputs: Record<string, unknown>;
  cursors: Record<string, string | null>;
  last_queue: "machine" | "human";
  next_alarm_at: string | null;
  alerts: Record<string, unknown>;
  first_observed_at: string;
  commit_accepted_at: string | null;
  last_error_code: string | null;
}

export interface VerifiedCanonical {
  project_id: string;
  state: import("../domain/project-state").ProjectState;
  record: import("../domain/commit-record").CanonicalCommitRecord | null;
  baseline_kind: "commit" | "pre_commit001";
  complete: boolean;
}

export interface SliceBudget {
  deadline_ms: number;
  calls_left: number;
  now(): number;
  signal: AbortSignal;
  beforeHttp(): void;
  canStartEffect(requiredCalls: number): boolean;
}
