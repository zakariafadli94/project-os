import { z } from "zod";

export const CURRENT_PROJECTION_VERSION: number = 6;
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

const currentViewEvidenceSchema = projectionOutputEvidenceSchema.extend({
  provider_object_id: z.string().min(1),
  provider_revision: z.string().min(1)
});

export const currentViewsProofSchema = z.strictObject({
  target_revision: revision,
  projection_version: positiveInt,
  views: z.strictObject({
    "global:PROJECT": currentViewEvidenceSchema,
    "global:PLAN": currentViewEvidenceSchema,
    "global:STATE": currentViewEvidenceSchema,
    "global:HANDOFF": currentViewEvidenceSchema
  })
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
  current_views_proof: currentViewsProofSchema.optional(),
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
  if (value.projection_version >= CURRENT_PROJECTION_VERSION && !value.current_views_proof) {
    ctx.addIssue({ code: "custom", message: "current projection requires a four-view publication proof" });
  }
  if (value.current_views_proof) {
    if (
      value.current_views_proof.target_revision !== value.target_revision
      || value.current_views_proof.projection_version !== value.projection_version
    ) {
      ctx.addIssue({ code: "custom", message: "current-view proof generation binding mismatch" });
    }
    const paths = {
      "global:PROJECT": "PROJECT.md",
      "global:PLAN": "PLAN.md",
      "global:STATE": "STATE.md",
      "global:HANDOFF": "HANDOFF.md"
    } as const;
    for (const [key, evidence] of Object.entries(value.current_views_proof.views)) {
      if (evidence.source_revision !== value.target_revision) {
        ctx.addIssue({ code: "custom", message: "current-view proof source revision mismatch" });
      }
      if (evidence.relative_path !== paths[key as keyof typeof paths]) {
        ctx.addIssue({ code: "custom", message: `current-view proof path mismatch for ${key}` });
      }
      const recorded = value.outputs[key];
      if (
        !recorded
        || recorded.relative_path !== evidence.relative_path
        || recorded.input_hash !== evidence.input_hash
        || recorded.content_hash !== evidence.content_hash
        || recorded.source_revision !== evidence.source_revision
      ) {
        ctx.addIssue({ code: "custom", message: `current-view proof is not part of the generation output group for ${key}` });
      }
    }
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
export type CurrentViewsProof = z.infer<typeof currentViewsProofSchema>;
export type MaterializationGenerationRef = z.infer<typeof materializationGenerationRefSchema>;
export type CompletedMaterializationRecord = z.infer<typeof completedMaterializationRecordSchema>;
export type MaterializationHead = z.infer<typeof materializationHeadSchema>;

export function parseCompletedMaterializationRecord(input: unknown): CompletedMaterializationRecord {
  return completedMaterializationRecordSchema.parse(input);
}

export function parseMaterializationHead(input: unknown): MaterializationHead {
  return materializationHeadSchema.parse(input);
}
