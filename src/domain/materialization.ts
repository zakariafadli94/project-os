import { z } from "zod";

export const CURRENT_PROJECTION_VERSION: number = 3;
export const MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH = 127 as const;

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const eventId = z.string().regex(/^EVT-[0-9]{6,}$/).nullable();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const positiveInt = z.number().int().positive();
const revision = z.number().int().nonnegative();

export const projectionOutputEvidenceSchema = z.strictObject({
  relative_path: z.string().min(1),
  input_hash: hash,
  content_hash: hash,
  source_revision: revision
});

export const materializationGenerationRefSchema = z.strictObject({
  target_revision: revision,
  projection_version: positiveInt
});

export const completedMaterializationRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  target_revision: revision,
  projection_version: positiveInt,
  record_kind: z.enum(["snapshot", "delta"]),
  parent: materializationGenerationRefSchema.nullable(),
  chain_depth: z.number().int().min(0).max(MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH),
  workspace_location: z.enum(["active", "archive"]),
  outputs: z.record(z.string().min(1), projectionOutputEvidenceSchema),
  removed_outputs: z.array(z.string().min(1)),
  total_output_count: z.number().int().nonnegative(),
  result_root_hash: hash,
  coalesced_revisions: z.array(revision),
  source_event_id: eventId,
  completed_at: timestamp
}).superRefine((value, ctx) => {
  if (value.record_kind === "snapshot" && (value.parent !== null || value.chain_depth !== 0)) {
    ctx.addIssue({ code: "custom", message: "snapshot materialization must have null parent and chain_depth=0" });
  }
  if (value.record_kind === "delta" && (value.parent === null || value.chain_depth < 1)) {
    ctx.addIssue({ code: "custom", message: "delta materialization requires parent and chain_depth>=1" });
  }
});

export const materializationHeadSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  target_revision: revision,
  projection_version: positiveInt,
  workspace_location: z.enum(["active", "archive"]),
  record_path: z.string().min(1),
  result_root_hash: hash,
  completed_at: timestamp
});

export type ProjectionOutputEvidence = z.infer<typeof projectionOutputEvidenceSchema>;
export type MaterializationGenerationRef = z.infer<typeof materializationGenerationRefSchema>;
export type CompletedMaterializationRecord = z.infer<typeof completedMaterializationRecordSchema>;
export type MaterializationHead = z.infer<typeof materializationHeadSchema>;

export function parseCompletedMaterializationRecord(input: unknown): CompletedMaterializationRecord {
  return completedMaterializationRecordSchema.parse(input);
}

export function parseMaterializationHead(input: unknown): MaterializationHead {
  return materializationHeadSchema.parse(input);
}
