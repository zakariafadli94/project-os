import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const version = z.number().int().positive();
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const timestamp = z.string().datetime({ offset: true });
export const normalizedRuleOperationSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
const operations = z.array(normalizedRuleOperationSchema).min(1).transform(values => [...new Set(values)].sort());
const references = z.array(nonEmpty).min(1);
export const ruleScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), project_id: projectId })
]);
export const ruleVersionSchema = z.strictObject({
  rule_id: nonEmpty, version, scope: ruleScopeSchema, source_refs: references,
  title: nonEmpty, operations,
  resource_scope: z.strictObject({ resource_types: z.array(nonEmpty).min(1), zones: z.array(nonEmpty).min(1) }),
  check_id: nonEmpty, parameters: z.record(z.string(), z.unknown()),
  enforcement: z.enum(["automatic", "explicit_approval"]),
  check_stage: z.enum(["pre_admission", "post_execution", "both"]), exception_allowed: z.boolean(),
  status: z.enum(["draft", "accepted_unenforced", "active", "superseded", "retired"]),
  activation_evidence: z.array(nonEmpty), supersedes: version.optional(), created_by: nonEmpty, created_at: timestamp
});
export type RuleVersion = z.infer<typeof ruleVersionSchema>;
export type RuleScope = z.infer<typeof ruleScopeSchema>;
const exceptionFields = {
  exception_id: nonEmpty, rule_id: nonEmpty, rule_version: version, project_id: projectId,
  resources: z.array(nonEmpty.refine(value => !/[?*]/.test(value), "Resource must be exact")).min(1),
  operations, reason: nonEmpty, granted_by: nonEmpty, grant_refs: references, granted_at: timestamp, expires_at: timestamp
};
const validExpiry = (value: { expires_at: string; granted_at: string }) => Date.parse(value.expires_at) > Date.parse(value.granted_at);
export const ruleExceptionGrantSchema = z.strictObject(exceptionFields).refine(validExpiry, "Exception must expire after grant time");
export const ruleExceptionSchema = z.strictObject({
  ...exceptionFields, status: z.enum(["granted", "revoked"]),
  revoked_at: timestamp.optional(), revoked_by: nonEmpty.optional(), revocation_reason: nonEmpty.optional()
}).refine(validExpiry, "Exception must expire after grant time");
export type RuleException = z.infer<typeof ruleExceptionSchema>;
const ruleReference = { rule_id: nonEmpty, version };
export const governanceOperationValues = ["rule.propose", "rule.accept", "rule.activate", "rule.retire", "rule.exception.grant", "rule.exception.revoke"] as const;
export function governanceOperationSchemas<T extends z.ZodRawShape>(common: T) {
  return [
    z.strictObject({ ...common, operation: z.literal("rule.propose"), payload: z.strictObject({ rule: ruleVersionSchema.extend({ status: z.literal("draft"), activation_evidence: z.array(nonEmpty).max(0) }) }) }),
    z.strictObject({ ...common, operation: z.literal("rule.accept"), payload: z.strictObject(ruleReference) }),
    z.strictObject({ ...common, operation: z.literal("rule.activate"), payload: z.strictObject({ ...ruleReference, activation_evidence: references }) }),
    z.strictObject({ ...common, operation: z.literal("rule.retire"), payload: z.strictObject({ ...ruleReference, reason: nonEmpty }) }),
    z.strictObject({ ...common, operation: z.literal("rule.exception.grant"), payload: z.strictObject({ exception: ruleExceptionGrantSchema }) }),
    z.strictObject({ ...common, operation: z.literal("rule.exception.revoke"), payload: z.strictObject({ exception_id: nonEmpty, reason: nonEmpty, revoked_by: nonEmpty }) })
  ] as const;
}
export const globalGovernanceTransactionSchema = z.discriminatedUnion("operation", governanceOperationSchemas({
  schema_version: z.literal("1.0"), transaction_id: z.string().regex(/^TXN-[A-Z0-9-]{10,}$/),
  project_id: z.literal("GLOBAL"), base_revision: z.number().int().nonnegative(), created_at: timestamp
}));
export type GlobalGovernanceTransaction = z.infer<typeof globalGovernanceTransactionSchema>;
type Command<T = GlobalGovernanceTransaction> = T extends GlobalGovernanceTransaction ? Pick<T, "created_at" | "operation" | "payload"> : never;
export interface RuleGovernanceState { rules: Record<string, RuleVersion>; exceptions: Record<string, RuleException> }
export interface GlobalGovernanceState extends RuleGovernanceState { revision: number }
export const foundationalCheckIds = new Set(["authentication", "project_isolation", "transaction_only_writes", "expected_revision", "evidence_preservation"]);
export function ruleVersionKey(ruleId: string, ruleVersion: number): string { return `${ruleId}@${ruleVersion}`; }
function scopeMatches(scope: RuleScope, project: string): boolean {
  return project === "GLOBAL" ? scope.kind === "global" : scope.kind === "project" && scope.project_id === project;
}
type GovernanceResult = { kind: "commit"; state: RuleGovernanceState } | { kind: "rejected"; code: string; message: string };
const reject = (code: string, message: string): GovernanceResult => ({ kind: "rejected", code, message });

/** Pure lifecycle transition; catalogue qualification is performed by the next layer. */
export function applyRuleGovernance(state: RuleGovernanceState, tx: Command, project: string): GovernanceResult {
  const next = structuredClone(state);
  if (tx.operation === "rule.propose") {
    const rule = tx.payload.rule;
    if (!scopeMatches(rule.scope, project)) return reject("RULE_SCOPE_MISMATCH", "Rule scope must match governance authority");
    const latest = Object.values(next.rules).filter(item => item.rule_id === rule.rule_id).sort((a, b) => b.version - a.version)[0];
    if (latest ? rule.version <= latest.version || rule.supersedes !== latest.version : rule.supersedes !== undefined) {
      return reject("INVALID_RULE_VERSION", "New versions must increase and reference the latest prior version");
    }
    if (latest && !scopeMatches(latest.scope, project)) return reject("RULE_SCOPE_MISMATCH", "Replacement cannot change rule scope");
    next.rules[ruleVersionKey(rule.rule_id, rule.version)] = structuredClone(rule);
  } else if (tx.operation === "rule.exception.grant") {
    const exception = tx.payload.exception;
    if (project !== "GLOBAL" && exception.project_id !== project) return reject("RULE_SCOPE_MISMATCH", "Exception must name this project");
    const rule = next.rules[ruleVersionKey(exception.rule_id, exception.rule_version)];
    if (!rule || !scopeMatches(rule.scope, project)) return reject("RULE_NOT_FOUND", "Exact rule version does not exist in this scope");
    if (rule.status !== "active") return reject("INVALID_RULE_TRANSITION", "Exceptions require an active rule");
    if (!rule.exception_allowed || foundationalCheckIds.has(rule.check_id)) return reject("RULE_EXCEPTION_FORBIDDEN", "This protection cannot be waived");
    if (next.exceptions[exception.exception_id]) return reject("RULE_EXCEPTION_EXISTS", "Exception history cannot be overwritten");
    if (Date.parse(exception.expires_at) <= Date.parse(tx.created_at) || Date.parse(exception.granted_at) > Date.parse(tx.created_at)) return reject("RULE_EXCEPTION_EXPIRED", "Exception must be valid at grant admission");
    if (exception.operations.some(operation => !rule.operations.includes(operation))) return reject("RULE_EXCEPTION_SCOPE", "Exception operations must be covered by the exact rule");
    next.exceptions[exception.exception_id] = { ...structuredClone(exception), status: "granted" };
  } else if (tx.operation === "rule.exception.revoke") {
    const exception = next.exceptions[tx.payload.exception_id];
    if (!exception || (project !== "GLOBAL" && exception.project_id !== project)) return reject("RULE_EXCEPTION_NOT_FOUND", "Exception does not exist in this scope");
    if (exception.status !== "granted") return reject("INVALID_RULE_TRANSITION", "Only a granted exception can be revoked");
    next.exceptions[exception.exception_id] = { ...exception, status: "revoked", revoked_at: tx.created_at, revoked_by: tx.payload.revoked_by, revocation_reason: tx.payload.reason };
  } else {
    const key = ruleVersionKey(tx.payload.rule_id, tx.payload.version);
    const rule = next.rules[key];
    if (!rule || !scopeMatches(rule.scope, project)) return reject("RULE_NOT_FOUND", "Exact rule version does not exist in this scope");
    if (tx.operation === "rule.accept") {
      if (rule.status !== "draft") return reject("INVALID_RULE_TRANSITION", "Only draft rules can be accepted");
      next.rules[key] = { ...rule, status: "accepted_unenforced" };
    } else if (tx.operation === "rule.activate") {
      if (rule.status !== "accepted_unenforced") return reject("INVALID_RULE_TRANSITION", "Only accepted unenforced rules can be activated");
      if (rule.supersedes !== undefined) {
        const priorKey = ruleVersionKey(rule.rule_id, rule.supersedes);
        const prior = next.rules[priorKey];
        if (!prior || prior.version >= rule.version || prior.status !== "active" || !scopeMatches(prior.scope, project)) return reject("INVALID_RULE_VERSION", "Activation must supersede the exact active predecessor");
        next.rules[priorKey] = { ...prior, status: "superseded" };
      } else if (Object.values(next.rules).some(item => item.rule_id === rule.rule_id && item.status === "active")) {
        return reject("INVALID_RULE_VERSION", "Activation cannot implicitly override an active version");
      }
      next.rules[key] = { ...rule, status: "active", activation_evidence: [...tx.payload.activation_evidence] };
    } else {
      if (rule.status !== "active") return reject("INVALID_RULE_TRANSITION", "Only active rules can be retired");
      next.rules[key] = { ...rule, status: "retired" };
    }
  }
  return { kind: "commit", state: next };
}
export function normalizeRuleMap(input: unknown, project: string): Record<string, RuleVersion> {
  const rules = z.record(z.string(), ruleVersionSchema).parse(input === undefined ? {} : input);
  for (const [key, rule] of Object.entries(rules)) {
    if (key !== ruleVersionKey(rule.rule_id, rule.version) || !scopeMatches(rule.scope, project)) throw new Error("Invalid rule key or scope");
  }
  return rules;
}
export function normalizeExceptionMap(input: unknown, project: string): Record<string, RuleException> {
  const exceptions = z.record(z.string(), ruleExceptionSchema).parse(input === undefined ? {} : input);
  for (const [key, exception] of Object.entries(exceptions)) {
    if (key !== exception.exception_id || (project !== "GLOBAL" && exception.project_id !== project)) throw new Error("Invalid exception key or scope");
  }
  return exceptions;
}
