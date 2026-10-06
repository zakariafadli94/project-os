import { z } from "zod";

export const canonicalReadPhaseSchema = z.enum(["local_checkpoint", "local_proof", "snapshot", "exact_commit", "suffix", "checkpoint", "before_signature", "after_signature"]);
export const canonicalReadCategorySchema = z.enum(["success", "deadline", "call_budget", "provider_error", "internal_error", "chain_invalid", "stale_state", "canonical_absent"]);
export type CanonicalReadPhase = z.infer<typeof canonicalReadPhaseSchema>;
export type CanonicalReadCategory = z.infer<typeof canonicalReadCategorySchema>;
const uuid = z.string().uuid();
const elapsed = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const canonicalReaderResultSchema = z.strictObject({
  phase: canonicalReadPhaseSchema, category: canonicalReadCategorySchema,
  elapsed_ms: elapsed, provider_call_count: z.number().int().min(0).max(32).nullable(),
  role: z.enum(["initiator", "joined"]), initiator_correlation_id: uuid.nullable()
});
export type CanonicalReaderResult = Readonly<z.infer<typeof canonicalReaderResultSchema>>;
export const admissionDiagnosticSchema = z.strictObject({
  schema_version: z.literal("1.0"), project_id: z.string().regex(/^PRJ-[0-9]{4}$/), correlation_id: uuid,
  status: z.enum(["ready", "unavailable"]), code: z.enum(["ADMISSION_DIAGNOSTIC_READY", "ADMISSION_DIAGNOSTIC_UNAVAILABLE"]),
  canonical_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  freshness: z.enum(["verified", "unknown"]), authority: z.enum(["issued_discarded", "not_issued"]), business_mutation: z.literal(false),
  runtime: z.strictObject({ worker_version_id: uuid.nullable(), worker_version_tag: z.string().regex(/^git-[a-f0-9]{40}$/i).nullable(), git_sha: z.string().regex(/^[a-f0-9]{40}$/i).nullable() }),
  reader: canonicalReaderResultSchema.nullable(),
  admission: z.strictObject({ stage: z.enum(["configuration", "canonical_read", "before_signature", "signature", "after_signature"]),
    category: z.enum(["success", "unavailable", "stale_state", "signature_error"]), elapsed_ms: elapsed })
}).superRefine((v, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "inconsistent_admission_diagnostic" });
  if ((v.reader === null) !== (v.admission.stage === "configuration")) invalid();
  if (v.reader?.role === "joined" && v.reader.provider_call_count !== null) invalid();
  if (v.reader?.role === "initiator" && (v.reader.provider_call_count === null || v.reader.initiator_correlation_id !== v.correlation_id)) invalid();
  if ((v.authority === "issued_discarded") !== (v.admission.stage === "after_signature")) invalid();
  if (v.status === "unavailable" && v.freshness !== "unknown") invalid();
  const allowedCategories = {
    configuration: ["unavailable"], canonical_read: ["unavailable"], before_signature: ["stale_state"],
    signature: ["signature_error"], after_signature: ["success", "stale_state"]
  };
  if (!allowedCategories[v.admission.stage].includes(v.admission.category)) invalid();
  if (["configuration", "canonical_read"].includes(v.admission.stage)) {
    if (v.canonical_revision !== null || v.reader?.category === "success") invalid();
  } else if (v.canonical_revision === null || v.reader?.category !== "success") invalid();
  if (v.freshness === "verified" && v.canonical_revision === null) invalid();
  if (v.runtime.git_sha !== null && v.runtime.worker_version_tag !== `git-${v.runtime.git_sha}`) invalid();
  const ready = v.admission.stage === "after_signature" && v.admission.category === "success" && v.authority === "issued_discarded"
    && v.reader?.category === "success" && v.canonical_revision !== null && v.freshness === "verified";
  if ((v.status === "ready") !== ready || (v.code === "ADMISSION_DIAGNOSTIC_READY") !== ready) invalid();
  if (v.status === "unavailable" && v.admission.category === "success") invalid();
});
export type AdmissionDiagnostic = z.infer<typeof admissionDiagnosticSchema>;
