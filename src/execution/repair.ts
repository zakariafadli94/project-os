import { z } from "zod";
import { executionHash } from "./journal";
import type { NormalizedAdmissionOperation } from "../admission/operation-context";
import type { ExecutionAdmission } from "./contract";
import { canonicalJson } from "../rules/contract";
const text = z.string().min(1);
const repairSchema = z.strictObject({
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/), operation: z.literal("project.repair"), request_id: text,
  base_revision: z.number().int().nonnegative(), diagnosed_drift_refs: z.array(text).min(1),
  resources: z.array(z.strictObject({ resource_id: text, resource_type: text, zone: text, version: text, expected_version: text.optional(), relative_path: text.optional() })).min(1),
  action: z.strictObject({ kind: z.literal("resume_committed"), original_kind: text, original_request_id: text, effect_plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
});
export type RepairIntent = z.infer<typeof repairSchema>;
export function parseRepairIntent(value: unknown): RepairIntent { return repairSchema.parse(value); }
export async function normalizeRepairAdmission(intent: RepairIntent): Promise<NormalizedAdmissionOperation> {
  return { project_id: intent.project_id, operation: intent.operation, resources: intent.resources, request_hash: await executionHash(intent) };
}

/** Resolution is supplied by server-side observation journals, never by payload. */
export type RepairEvidenceResolver = (ref: string) => Promise<{
  project_id: string; project_revision: number; resources: RepairIntent["resources"]; diagnosis: string; evidence_ref: string;
} | null>;
export const unavailableRepairEvidence: RepairEvidenceResolver = async () => null;
export async function authorizeRepair(intent: RepairIntent, currentRevision: number,
  original: { admission: ExecutionAdmission; effect_plan_hash: string }, resolve: RepairEvidenceResolver): Promise<string[]> {
  if (intent.base_revision !== currentRevision) throw new Error("repair_revision_conflict");
  if (intent.project_id !== original.admission.project_id || intent.action.original_request_id !== original.admission.request_id
    || intent.action.original_kind !== original.admission.kind || intent.action.effect_plan_hash !== original.effect_plan_hash) throw new Error("repair_intent_conflict");
  if (canonicalJson(intent.resources) !== canonicalJson(original.admission.resources)) throw new Error("repair_resources_conflict");
  const refs: string[] = [];
  for (const ref of intent.diagnosed_drift_refs) {
    const evidence = await resolve(ref);
    if (!evidence || evidence.project_id !== intent.project_id || evidence.project_revision !== currentRevision
      || !evidence.diagnosis || !evidence.evidence_ref || canonicalJson(evidence.resources) !== canonicalJson(intent.resources)) throw new Error("repair_evidence_unavailable");
    refs.push(evidence.evidence_ref);
  }
  return refs;
}
