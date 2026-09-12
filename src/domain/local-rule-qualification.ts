import { z } from "zod";
import type { GovernanceQualification } from "../rules/qualification-record";

export const localActivationTransactionSchema = z.strictObject({
  schema_version: z.literal("1.0"), transaction_id: z.string().regex(/^TXN-[A-Z0-9-]{10,}$/),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/), base_revision: z.number().int().nonnegative(),
  created_at: z.string().datetime({ offset: true }), operation: z.literal("rule.activate"),
  payload: z.strictObject({ rule_id: z.string().min(1), version: z.number().int().positive(), activation_evidence: z.array(z.string().min(1)).min(1) })
});
export type LocalActivationTransaction = z.infer<typeof localActivationTransactionSchema>;
export interface LocalRuleQualification { activation: LocalActivationTransaction; qualification: GovernanceQualification }
// The strict envelope is synchronously decoded; hash/proof validation is server-side and asynchronous.
export const localRuleQualificationsSchema = z.record(z.string(), z.strictObject({ activation: localActivationTransactionSchema, qualification: z.unknown() }));
export function normalizeLocalRuleQualifications(value: unknown, projectId: string): Record<string, LocalRuleQualification> | undefined {
  if (value === undefined) return undefined;
  const records = localRuleQualificationsSchema.parse(value);
  for (const [key, record] of Object.entries(records)) {
    if (record.activation.project_id !== projectId || key !== `${record.activation.payload.rule_id}@${record.activation.payload.version}` || !record.qualification) throw new Error("Local qualification identity mismatch");
  }
  return records as Record<string, LocalRuleQualification>;
}
