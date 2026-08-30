import { z } from "zod";
import { INTAKE_STATE_VALUES, type IntakeHealthRecord, type IntakeRecord } from "../domain/intake";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const intakeIdSchema = z.string().regex(/^INTAKE-[A-F0-9]{24}$/);
const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestamp = timestampSchema.nullable();

export const intakeRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  intake_id: intakeIdSchema,
  project_id: projectIdSchema,
  provider_id: z.string().min(1),
  object_id: z.string().min(1),
  revision_token: z.string().min(1),
  logical_input_path: z.string().min(1),
  first_seen_at: timestampSchema,
  last_attempt_at: timestampSchema.optional(),
  attempt_count: z.number().int().nonnegative(),
  state: z.enum(INTAKE_STATE_VALUES),
  retryable: z.boolean().optional(),
  step_evidence: z.record(z.string(), z.unknown()).optional(),
  last_error: z.string().min(1).optional(),
  document_id: z.string().regex(/^DOC-[A-F0-9]{24}$/).optional(),
  version_id: z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/).optional(),
  reference_path: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (value.state === "failed" && value.retryable === undefined) {
    ctx.addIssue({ code: "custom", path: ["retryable"], message: "Failed intake requires retryable classification" });
  }
  if ((value.state === "ingested" || value.state === "duplicate") && value.retryable !== undefined) {
    ctx.addIssue({ code: "custom", path: ["retryable"], message: "Terminal successful intake must not carry retryable" });
  }
});

export const intakeHealthRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  pending_count: z.number().int().nonnegative(),
  oldest_pending_age_ms: z.number().int().nonnegative().nullable(),
  stale_count: z.number().int().nonnegative(),
  failed_retryable_count: z.number().int().nonnegative(),
  failed_non_retryable_count: z.number().int().nonnegative(),
  last_successful_intake_at: nullableTimestamp,
  last_reconcile_at: nullableTimestamp,
  last_direct_sweep_at: nullableTimestamp,
  last_error_summary: z.string().min(1).nullable()
});

export function parseIntakeRecord(input: unknown): IntakeRecord {
  return intakeRecordSchema.parse(input);
}

export function parseIntakeHealthRecord(input: unknown): IntakeHealthRecord {
  return intakeHealthRecordSchema.parse(input);
}
