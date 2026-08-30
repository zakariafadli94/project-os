import { z } from "zod";

export const INTAKE_STATE_VALUES = [
  "observed",
  "processing",
  "ingested",
  "duplicate",
  "failed"
] as const;

const intakeStateSchema = z.enum(INTAKE_STATE_VALUES);

export type IntakeState = z.infer<typeof intakeStateSchema>;

export interface IntakeRecord {
  schema_version: "1.0";
  intake_id: string;
  project_id: string;
  provider_id: string;
  object_id: string;
  revision_token: string;
  logical_input_path: string;
  first_seen_at: string;
  last_attempt_at?: string;
  attempt_count: number;
  state: IntakeState;
  retryable?: boolean;
  step_evidence?: Record<string, unknown>;
  last_error?: string;
  document_id?: string;
  version_id?: string;
  reference_path?: string;
}

export interface IntakeHealthRecord {
  schema_version: "1.0";
  project_id: string;
  pending_count: number;
  oldest_pending_age_ms: number | null;
  stale_count: number;
  failed_retryable_count: number;
  failed_non_retryable_count: number;
  last_successful_intake_at: string | null;
  last_reconcile_at: string | null;
  last_direct_sweep_at: string | null;
  last_error_summary: string | null;
}

export function parseIntakeState(input: unknown): IntakeState {
  return intakeStateSchema.parse(input);
}

export async function intakeIdFor(
  projectId: string,
  providerId: string,
  objectId: string,
  revisionToken: string
): Promise<string> {
  for (const [label, value] of [
    ["project_id", projectId],
    ["provider_id", providerId],
    ["object_id", objectId],
    ["revision_token", revisionToken]
  ] as const) {
    if (!value) throw new Error(`${label} is required for intake identity`);
  }
  const bytes = new TextEncoder().encode(`${projectId}\n${providerId}\n${objectId}\n${revisionToken}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `INTAKE-${hex.slice(0, 24)}`;
}

export function isIntakeStale(firstSeenAt: string, now: string): boolean {
  const first = Date.parse(firstSeenAt);
  const current = Date.parse(now);
  if (!Number.isFinite(first) || !Number.isFinite(current)) {
    throw new Error("Intake stale calculation requires valid timestamps");
  }
  if (current < first) throw new Error("Intake stale calculation cannot run before first_seen_at");
  return current - first >= 15 * 60 * 1000;
}
