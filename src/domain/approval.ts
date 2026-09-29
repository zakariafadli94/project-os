import { z } from "zod";
import type { ProjectState } from "./project-state";
import type { Transaction } from "./transaction";
import { foundationalCheckIds, ruleVersionKey, type GlobalGovernanceState, type RuleVersion } from "./rule-governance";
import { verifyMutationContext, type MutationContext } from "../admission/mutation-context";
import { canonicalJson, sameScope } from "../rules/contract";

const text = z.string().trim().min(1);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const txId = z.string().regex(/^TXN-[A-Z0-9-]{10,}$/);
const ruleScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), project_id: projectId })
]);
const timestamp = z.string().datetime({ offset: true });
const approvalId = z.string().regex(/^APR-[A-Z0-9-]{4,}$/);

export const approvalGrantPayloadSchema = z.strictObject({
  approval_id: approvalId,
  actor_id: text,
  rule_id: text,
  rule_version: z.number().int().positive(),
  rule_scope: ruleScopeSchema,
  resource_id: text.refine(value => !/[?*]/.test(value), "Resource identity must be exact"),
  resource_type: text,
  resource_zone: text,
  resource_version: text.refine(value => !/[?*]/.test(value), "Resource version must be exact"),
  operation: text,
  expires_at: timestamp
});

export const approvalRevokePayloadSchema = z.strictObject({ approval_id: approvalId, reason: text });

export const approvalRecordSchema = z.strictObject({
  approval_id: approvalId,
  project_id: projectId,
  actor_id: text,
  approved_by: text,
  rule_id: text,
  rule_version: z.number().int().positive(),
  rule_scope: ruleScopeSchema,
  resource_id: text,
  resource_type: text,
  resource_zone: text,
  resource_version: text,
  operation: text,
  status: z.enum(["approved", "revoked"]),
  granted_at: timestamp,
  expires_at: timestamp,
  evidence_refs: z.array(text).min(1),
  grant_transaction_id: txId,
  revoked_at: timestamp.optional(),
  revoked_by: text.optional(),
  revocation_reason: text.optional(),
  revoke_transaction_id: txId.optional()
}).superRefine((record, ctx) => {
  if (Date.parse(record.expires_at) <= Date.parse(record.granted_at)) {
    ctx.addIssue({ code: "custom", path: ["expires_at"], message: "Approval must expire after it is granted" });
  }
  const revocation = [record.revoked_at, record.revoked_by, record.revocation_reason, record.revoke_transaction_id];
  if (record.status === "approved" && revocation.some(value => value !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "An approved record cannot carry revocation fields" });
  }
  if (record.status === "revoked" && revocation.some(value => value === undefined)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "A revoked record requires complete server revocation provenance" });
  }
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

declare const approvalTransitionBrand: unique symbol;
export interface ApprovalTransitionCapability { readonly [approvalTransitionBrand]: true }
export type ApprovalChange = { kind: "grant" | "revoke"; record: ApprovalRecord };
const transitionCapabilities = new WeakMap<object, { state: string; transaction: string; change: ApprovalChange }>();

/** Called only after ProjectGuard has a fresh signed Founder Control Tower context. */
export async function prepareApprovalTransition(
  state: ProjectState,
  tx: Transaction,
  context: MutationContext,
  signingKey: string,
  globalGovernance: GlobalGovernanceState,
  nowMs = Date.now(),
  priorChange?: ApprovalChange
): Promise<ApprovalTransitionCapability> {
  if (tx.operation !== "approval.grant" && tx.operation !== "approval.revoke") throw new Error("approval_transition_operation_invalid");
  await verifyMutationContext(context, state, tx.base_revision, signingKey, nowMs);
  if (context.actor.actor_id !== "control_tower" || context.actor.authority !== "control_tower_operator") {
    throw new Error("APPROVAL_AUTHORITY_REQUIRED");
  }
  if (tx.project_id !== state.project_id || tx.base_revision !== state.revision) throw new Error("APPROVAL_CANONICAL_STATE_MISMATCH");

  const grantedAt = new Date(nowMs).toISOString();
  let change: ApprovalChange;
  if (tx.operation === "approval.grant") {
    const payload = approvalGrantPayloadSchema.parse(tx.payload);
    if (priorChange) {
      const prior = approvalRecordSchema.parse(priorChange.record);
      if (priorChange.kind !== "grant" || prior.grant_transaction_id !== tx.transaction_id || prior.project_id !== state.project_id
        || prior.approval_id !== payload.approval_id || prior.status !== "approved" || prior.approved_by !== context.actor.actor_id
        || Date.parse(prior.expires_at) <= Date.parse(prior.granted_at)
        || !grantMatchesPayload(prior, payload)) throw new Error("APPROVAL_ADMISSION_CONFLICT");
      const capability = makeCapability(state, tx, { kind: "grant", record: prior });
      return capability;
    }
    if (Date.parse(payload.expires_at) <= nowMs) throw new Error("APPROVAL_EXPIRY_INVALID");
    if (state.approvals?.[payload.approval_id]) throw new Error("APPROVAL_EXISTS");
    const rule = findRule(state, globalGovernance, payload.rule_id, payload.rule_version, payload.rule_scope);
    if (!rule || rule.status !== "active" || !rule.operations.includes(payload.operation)
      || !rule.resource_scope.resource_types.includes(payload.resource_type)
      || !rule.resource_scope.zones.includes(payload.resource_zone)
      || (rule.enforcement !== "explicit_approval" && rule.check_id !== "exact_approval")
      || foundationalCheckIds.has(rule.check_id)) throw new Error("APPROVAL_RULE_SCOPE_INVALID");
    const record = approvalRecordSchema.parse({
      ...payload,
      project_id: state.project_id,
      approved_by: context.actor.actor_id,
      status: "approved",
      granted_at: grantedAt,
      evidence_refs: [`canonical:project/${state.project_id}/transaction/${tx.transaction_id}`],
      grant_transaction_id: tx.transaction_id
    });
    change = { kind: "grant", record };
  } else {
    const payload = approvalRevokePayloadSchema.parse(tx.payload);
    const existing = state.approvals?.[payload.approval_id];
    if (!existing) throw new Error("APPROVAL_NOT_FOUND");
    const parsed = approvalRecordSchema.parse(existing);
    if (parsed.status !== "approved" || parsed.project_id !== state.project_id) throw new Error("APPROVAL_NOT_REVOCABLE");
    if (priorChange) {
      const prior = approvalRecordSchema.parse(priorChange.record);
      if (priorChange.kind !== "revoke" || prior.revoke_transaction_id !== tx.transaction_id || prior.approval_id !== parsed.approval_id
        || prior.status !== "revoked" || prior.revoked_by !== context.actor.actor_id || prior.revocation_reason !== payload.reason
        || !sameGrant(prior, parsed)) throw new Error("APPROVAL_ADMISSION_CONFLICT");
      return makeCapability(state, tx, { kind: "revoke", record: prior });
    }
    change = { kind: "revoke", record: approvalRecordSchema.parse({
      ...parsed,
      status: "revoked",
      revoked_at: grantedAt,
      revoked_by: context.actor.actor_id,
      revocation_reason: payload.reason,
      revoke_transaction_id: tx.transaction_id
    }) };
  }

  return makeCapability(state, tx, change);
}

function makeCapability(state: ProjectState, tx: Transaction, change: ApprovalChange): ApprovalTransitionCapability {
  const capability = Object.freeze({}) as ApprovalTransitionCapability;
  transitionCapabilities.set(capability, { state: canonicalJson(state), transaction: canonicalJson(tx), change });
  return capability;
}

function grantMatchesPayload(record: ApprovalRecord, payload: z.infer<typeof approvalGrantPayloadSchema>): boolean {
  return record.actor_id === payload.actor_id && record.rule_id === payload.rule_id && record.rule_version === payload.rule_version
    && canonicalJson(record.rule_scope) === canonicalJson(payload.rule_scope) && record.resource_id === payload.resource_id
    && record.resource_type === payload.resource_type && record.resource_zone === payload.resource_zone
    && record.resource_version === payload.resource_version && record.operation === payload.operation && record.expires_at === payload.expires_at;
}

function sameGrant(left: ApprovalRecord, right: ApprovalRecord): boolean {
  return left.approval_id === right.approval_id && left.project_id === right.project_id && left.actor_id === right.actor_id
    && left.approved_by === right.approved_by && left.rule_id === right.rule_id && left.rule_version === right.rule_version
    && canonicalJson(left.rule_scope) === canonicalJson(right.rule_scope) && left.resource_id === right.resource_id
    && left.resource_type === right.resource_type && left.resource_zone === right.resource_zone
    && left.resource_version === right.resource_version && left.operation === right.operation
    && left.granted_at === right.granted_at && left.expires_at === right.expires_at
    && canonicalJson(left.evidence_refs) === canonicalJson(right.evidence_refs) && left.grant_transaction_id === right.grant_transaction_id;
}

export function approvalChangeForTransition(capability: unknown, state: ProjectState, tx: Transaction): ApprovalChange | null {
  if (!capability || typeof capability !== "object") return null;
  const verified = transitionCapabilities.get(capability);
  return verified && verified.state === canonicalJson(state) && verified.transaction === canonicalJson(tx)
    ? structuredClone(verified.change)
    : null;
}

export function normalizeApprovalMap(value: unknown, projectId: string): Record<string, ApprovalRecord> {
  if (value === undefined) return {};
  const entries = z.record(z.string(), approvalRecordSchema).parse(value);
  for (const [key, record] of Object.entries(entries)) {
    if (key !== record.approval_id || record.project_id !== projectId) throw new Error("Approval record identity mismatch");
  }
  return entries;
}

function findRule(
  state: ProjectState,
  globalGovernance: GlobalGovernanceState,
  ruleId: string,
  version: number,
  scope: ApprovalRecord["rule_scope"]
): RuleVersion | null {
  if (scope.kind === "project" && scope.project_id !== state.project_id) return null;
  const rule = scope.kind === "global"
    ? globalGovernance.rules[ruleVersionKey(ruleId, version)]
    : state.local_rules[ruleVersionKey(ruleId, version)];
  return rule && sameScope(rule.scope, scope) ? rule : null;
}
