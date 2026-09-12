import type { ProjectState } from "../domain/project-state";
import type { Transaction } from "../domain/transaction";
import { localActivationTransactionSchema, type LocalRuleQualification } from "../domain/local-rule-qualification";
import { ruleVersionKey, type RuleVersion } from "../domain/rule-governance";
import { canonicalJson, verdict, type RuleResource, type RuleResult } from "./contract";
import { resolveAndQualifyRuleActivation, type RuleQualificationEvidenceResolver } from "./qualification";
import { createGovernanceQualification, governanceQualificationSchema, verifyGovernanceQualification } from "./qualification-record";
import { matchesResource } from "./resolution";

declare const localActivationBrand: unique symbol;
export interface LocalRuleActivationCapability { readonly [localActivationBrand]: true }
const capabilities = new WeakMap<object, { state: string; transaction: string; record: LocalRuleQualification }>();

/** A capability is an in-process server object, never a transaction field or serialized proof. */
export async function prepareLocalRuleActivation(state: ProjectState, tx: Transaction, resolver: RuleQualificationEvidenceResolver, now = new Date().toISOString()): Promise<LocalRuleActivationCapability> {
  const { isProductionQualificationResolver } = await import("./production-qualification");
  if (!isProductionQualificationResolver(resolver)) throw new Error("LOCAL_RULE_QUALIFICATION_UNAVAILABLE");
  const activation = localActivationTransactionSchema.parse(tx);
  const rule = state.local_rules[ruleVersionKey(activation.payload.rule_id, activation.payload.version)];
  if (!rule || rule.scope.kind !== "project" || rule.scope.project_id !== state.project_id || activation.project_id !== state.project_id || activation.base_revision !== state.revision) throw new Error("LOCAL_RULE_QUALIFICATION_MISMATCH");
  const result = await resolveAndQualifyRuleActivation(resolver, { rule, known_active_rules: Object.values(state.local_rules), requested_evidence_refs: activation.payload.activation_evidence, now });
  if (result.verdict !== "allow" || !result.qualification_proof?.audit) throw new Error(result.verdict === "allow" ? "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" : result.code);
  const record: LocalRuleQualification = { activation, qualification: await createGovernanceQualification(activation, rule, result.qualification_proof) };
  const capability = Object.freeze({}) as LocalRuleActivationCapability;
  capabilities.set(capability, { state: canonicalJson(state), transaction: canonicalJson(tx), record });
  return capability;
}

/** Used only by the deterministic transition to bind the server proof to this exact state and tx. */
export function localRuleQualificationForTransition(capability: unknown, state: ProjectState, tx: Transaction): LocalRuleQualification | null {
  if (!capability || typeof capability !== "object") return null;
  const verified = capabilities.get(capability);
  return verified && verified.state === canonicalJson(state) && verified.transaction === canonicalJson(tx) ? structuredClone(verified.record) : null;
}

/** Returns unavailable, never silently dropping an unqualified applicable local rule. No rewrite of history. */
export async function validateLocalRuleAuthority(state: ProjectState, operation?: string, resources?: RuleResource[]): Promise<RuleResult | null> {
  for (const rule of Object.values(state.local_rules)) {
    if (rule.status !== "active" || (operation && !rule.operations.includes(operation)) || (resources && !resources.some(resource => matchesResource(rule, resource)))) continue;
    try {
      const record = state.local_rule_qualifications?.[ruleVersionKey(rule.rule_id, rule.version)];
      if (!record || rule.scope.kind !== "project" || rule.scope.project_id !== state.project_id) throw new Error("missing");
      const activation = localActivationTransactionSchema.parse(record.activation);
      const qualification = governanceQualificationSchema.parse(record.qualification);
      if (!qualification.proof.audit || activation.project_id !== state.project_id || activation.payload.rule_id !== rule.rule_id || activation.payload.version !== rule.version || activation.base_revision + 1 > state.revision || canonicalJson(activation.payload.activation_evidence) !== canonicalJson(rule.activation_evidence)) throw new Error("binding");
      const accepted: RuleVersion = { ...rule, status: "accepted_unenforced", activation_evidence: [] };
      await verifyGovernanceQualification(qualification, activation, accepted);
    } catch {
      return verdict("unavailable", "LOCAL_RULE_QUALIFICATION_UNAVAILABLE", rule, "Canonical hash-bound production qualification for this exact local rule version", "Legacy, missing, corrupt or mismatched local qualification", "Propose and explicitly qualify a successor version; do not treat historical activation as authority");
    }
  }
  return null;
}
