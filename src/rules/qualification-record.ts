import { z } from "zod";
import type { GlobalGovernanceTransaction, RuleVersion } from "../domain/rule-governance";
import type { LocalActivationTransaction } from "../domain/local-rule-qualification";
import { sha256Text } from "../documents/hash";
import { canonicalJson } from "./contract";
import { resolvedQualificationProofSchema, type ResolvedQualificationProof } from "./qualification";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const governanceQualificationSchema = z.strictObject({
  schema_version: z.literal("1.0"), transaction_sha256: hash, rule_sha256: hash,
  proof: resolvedQualificationProofSchema, sha256: hash
});
export type GovernanceQualification = z.infer<typeof governanceQualificationSchema>;
export async function createGovernanceQualification(transaction: GlobalGovernanceTransaction | LocalActivationTransaction, rule: RuleVersion, proof: ResolvedQualificationProof): Promise<GovernanceQualification> {
  const record = { schema_version: "1.0" as const, transaction_sha256: await sha256Text(canonicalJson(transaction)), rule_sha256: await sha256Text(canonicalJson(rule)), proof: resolvedQualificationProofSchema.parse(proof) };
  return { ...record, sha256: await sha256Text(canonicalJson(record)) };
}
export async function verifyGovernanceQualification(record: GovernanceQualification, transaction: GlobalGovernanceTransaction | LocalActivationTransaction, rule: RuleVersion): Promise<void> {
  if (transaction.operation !== "rule.activate" || !rule || canonicalJson(record) !== canonicalJson(await createGovernanceQualification(transaction, rule, record.proof)) ||
    record.proof.evidence.rule_id !== rule.rule_id || record.proof.evidence.rule_version !== rule.version || canonicalJson(record.proof.evidence.rule_scope) !== canonicalJson(rule.scope) ||
    !transaction.payload.activation_evidence.every(ref => record.proof.evidence.evidence_refs.includes(ref))) throw new Error("Canonical activation qualification binding mismatch");
}
