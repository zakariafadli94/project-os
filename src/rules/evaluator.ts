import { z } from "zod";
import { foundationalCheckIds, ruleExceptionSchema, ruleScopeSchema, type RuleVersion } from "../domain/rule-governance";
import { assertManagedDocumentExpectedVersion, ManagedDocumentConflictError } from "../documents/service";
import { resolveArtifactDestination } from "../persistence/artifact-routing";
import { workspaceProjectRoot } from "../persistence/layout";
import { checkCatalogue, normalizedMutationOperations, validateCheck } from "./check-catalogue";
import { validateLocalRuleAuthority } from "./local-rule-qualification";
import { liveAt, ruleReference, sameScope, verdict, type EvaluationResult, type OperationContext, type RuleResource, type RuleResult } from "./contract";
import { conflictVerdict, findRuleConflict, matchesResource, resolveEffectiveRules } from "./resolution";

const text = z.string().trim().min(1);
const approvalSchema = z.strictObject({
  approval_id: text, actor_id: text, approved_by: text, project_id: text,
  rule_id: text, rule_version: z.number().int().positive(), rule_scope: ruleScopeSchema,
  resource_id: text, resource_version: text, operation: text, status: z.enum(["approved", "revoked"]),
  granted_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }), evidence_refs: z.array(text).min(1)
});
function exactApproval(context: OperationContext, rule: RuleVersion, resource: RuleResource) {
  return context.approvals.map(value => approvalSchema.safeParse(value)).find(result => {
    if (!result.success) return false;
    const a = result.data;
    return a.status === "approved" && a.actor_id === context.actor.actor_id && a.project_id === context.project_id &&
      a.rule_id === rule.rule_id && a.rule_version === rule.version && sameScope(a.rule_scope, rule.scope) &&
      a.resource_id === resource.resource_id && a.resource_version === resource.version && a.operation === context.operation && liveAt(a.granted_at, a.expires_at, context.now);
  })?.data;
}
function exactException(context: OperationContext, rule: RuleVersion, resource: RuleResource) {
  if (!rule.exception_allowed || foundationalCheckIds.has(rule.check_id)) return;
  const map = rule.scope.kind === "global" ? context.global_governance!.exceptions : context.state.rule_exceptions;
  for (const [key, value] of Object.entries(map)) {
    const parsed = ruleExceptionSchema.safeParse(value);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (key === e.exception_id && e.status === "granted" && !e.revoked_at && e.rule_id === rule.rule_id && e.rule_version === rule.version &&
      e.project_id === context.project_id && e.resources.includes(resource.resource_id) && e.operations.includes(context.operation) && liveAt(e.granted_at, e.expires_at, context.now)) return e;
  }
}
function evaluateOne(context: OperationContext, rule: RuleVersion, resource: RuleResource): RuleResult {
  const exception = exactException(context, rule, resource);
  if (exception) return { ...verdict("allow", "RULE_EXCEPTION_APPLIED", rule, "Exact live canonical exception", exception.exception_id, "None"), exception_id: exception.exception_id, evidence_refs: exception.grant_refs };
  if (rule.enforcement === "explicit_approval" || rule.check_id === "exact_approval") {
    const approval = exactApproval(context, rule, resource);
    return approval
      ? { ...verdict("allow", "EXACT_APPROVAL_VERIFIED", rule, "Exact actor/rule/resource/version approval", approval.approval_id, "None"), approval_id: approval.approval_id, evidence_refs: approval.evidence_refs }
      : verdict("approval_required", "EXACT_APPROVAL_REQUIRED", rule, `Explicit approval for ${context.actor.actor_id}, ${resource.resource_id}@${resource.version}, ${context.operation}`, "No live exact server approval", "Obtain an explicit approval bound to this actor, project, rule version and resource version");
  }
  if (rule.check_id === "expected_version") {
    if (rule.parameters.required && resource.expected_version === undefined) return verdict("deny", "EXPECTED_VERSION_REQUIRED", rule, "Explicit expected resource version", "No expected version", "Refresh the resource and submit its exact expected version");
    if (resource.expected_version === undefined) return verdict("allow", "EXPECTED_VERSION_MATCH", rule, "Optional expected version", "No version precondition required by this rule", "None");
    const observations = context.observations.filter(o => o.project_id === context.project_id && o.resource_id === resource.resource_id && o.resource_version === resource.version &&
      o.evidence_refs.length > 0 && o.evidence_refs.every(ref => typeof ref === "string" && ref.trim()) && liveAt(o.observed_at, o.expires_at, context.now));
    if (new Set(observations.map(o => o.current_version)).size > 1) return verdict("unavailable", "RULE_EVIDENCE_AMBIGUOUS", rule, "One unambiguous live canonical version", "Conflicting current_version observations", "Refresh the canonical resource under its concurrency guard");
    const observation = observations[0];
    if (!observation || typeof observation.current_version !== "string") return verdict("unavailable", "RULE_EVIDENCE_UNAVAILABLE", rule, "Fresh canonical current_version observation", "Missing, expired or mismatched observation", "Read the canonical resource version server-side and retry");
    try { assertManagedDocumentExpectedVersion(resource.expected_version, observation.current_version, resource.resource_id); }
    catch (error) {
      if (!(error instanceof ManagedDocumentConflictError)) throw error;
      return verdict("deny", "STALE_DOCUMENT_VERSION", rule, `Expected ${resource.expected_version}`, `Current ${observation.current_version}`, "Refresh the current resource and revalidate the intended change");
    }
    return { ...verdict("allow", "EXPECTED_VERSION_MATCH", rule, resource.expected_version, observation.current_version, "None"), evidence_refs: observation.evidence_refs };
  }
  if (rule.check_id === "allowed_destination") {
    if (!resource.relative_path) return verdict("unavailable", "RULE_EVIDENCE_UNAVAILABLE", rule, "Typed artifact relative_path", "No path provided", "Resolve the artifact intent on the server");
    try {
      const destination = resolveArtifactDestination(context.state, resource.relative_path, resource.artifact_operation === "REVIEW_CANDIDATE" ? { operation: "REVIEW_CANDIDATE", project_id: context.project_id, request_id: resource.resource_id, mode: "create" } : undefined);
      const zone = destination.path.slice(workspaceProjectRoot(context.project_id, context.state.slug).length + 1).split("/")[0];
      if (resource.artifact_operation === "REVIEW_CANDIDATE" && (resource.resource_type !== "artifact" || resource.zone !== zone)) return verdict("unavailable", "RULE_EVIDENCE_UNAVAILABLE", rule, "Exact server-normalized review destination", "Review resource identity or zone mismatch", "Normalize the complete typed candidate request again");
      if (!(rule.parameters.allowed_zones as string[]).includes(zone)) return verdict("deny", "DESTINATION_FORBIDDEN", rule, JSON.stringify(rule.parameters.allowed_zones), destination.path, "Use a destination permitted by every active rule");
      return verdict("allow", "DESTINATION_ALLOWED", rule, JSON.stringify(rule.parameters.allowed_zones), destination.path, "None");
    } catch (error) { return verdict("deny", "DESTINATION_FORBIDDEN", rule, "Safe governed artifact destination", error instanceof Error ? error.message : "Invalid destination", "Use the canonical logical route and a safe relative path"); }
  }
  const check = checkCatalogue[rule.check_id];
  return verdict("unavailable", "RULE_CONTROL_UNAVAILABLE", rule, check.required_evidence.join(", "), "Server control adapter is not equipped for this check", "Equip and qualify the deterministic control before automatic enforcement");
}

/** Pure with respect to persistence: this creates a verdict, never a write authorization by itself. */
export async function evaluateRules(context: OperationContext): Promise<EvaluationResult> {
  const empty = { ruleset: { digest: "", rules: [], global_revision: context.global_governance?.revision ?? null, project_revision: context.state.revision }, results: [], gaps: [], deferred_rules: [] };
  const fail = (result: RuleResult): EvaluationResult => ({ ...empty, ...result });
  if (!context.actor?.actor_id || !context.actor.authority) return fail(verdict("deny", "SERVER_AUTHORITY_REQUIRED", null, "Authenticated server actor/authority", "Missing actor or authority", "Authenticate through the operation's authoritative entry"));
  if (context.project_id !== context.state.project_id) return fail(verdict("deny", "PROJECT_SCOPE_MISMATCH", null, context.state.project_id, context.project_id, "Resolve and bind the canonical project"));
  if (context.expected_project_revision !== context.state.revision) return fail(verdict("deny", "STALE_PROJECT_REVISION", null, String(context.state.revision), String(context.expected_project_revision), "Refresh canonical state and revalidate the operation"));
  if (!context.global_governance) return fail(verdict("unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", null, "Fresh canonical global governance", "Global governance unavailable", "Restore the canonical governance reader; do not bypass global rules"));
  if (!Number.isFinite(Date.parse(context.now)) || !["pre_admission", "post_execution"].includes(context.stage) || !normalizedMutationOperations.includes(context.operation) || !context.resources.length || context.resources.some(r => !r.resource_id || !r.resource_type || !r.zone || !r.version)) return fail(verdict("unavailable", "INVALID_OPERATION_CONTEXT", null, "Server-normalized mutation, resource versions, stage and time", "Incomplete or unsupported context", "Use the registered server operation adapter"));
  let resolved: Awaited<ReturnType<typeof resolveEffectiveRules>>;
  try {
    resolved = await resolveEffectiveRules(context);
    const localAuthority = await validateLocalRuleAuthority(context.state, context.operation, context.resources);
    if (localAuthority) return fail(localAuthority);
  }
  catch { return fail(verdict("unavailable", "CANONICAL_RULESET_INVALID", null, "Valid scoped canonical rules", "Invalid rule snapshot", "Repair canonical governance using its history")); }
  const results: RuleResult[] = [];
  const deferred_rules: ReturnType<typeof ruleReference>[] = [];
  for (const rule of resolved.rules) {
    const invalid = validateCheck(rule);
    if (invalid) results.push(invalid);
  }
  const conflict = findRuleConflict(resolved.rules);
  if (conflict) results.push(conflictVerdict(conflict));
  if (!results.length) for (const rule of resolved.rules) {
    if (rule.check_stage !== "both" && rule.check_stage !== context.stage) { deferred_rules.push(ruleReference(rule)); continue; }
    for (const resource of context.resources.filter(r => matchesResource(rule, r))) results.push({ ...evaluateOne(context, rule, resource), resource_id: resource.resource_id });
  }
  const rank = { allow: 0, approval_required: 1, unavailable: 2, deny: 3 };
  const primary = results.reduce<RuleResult>((worst, result) => rank[result.verdict] > rank[worst.verdict] ? result : worst,
    verdict("allow", "RULES_SATISFIED", null, "All applicable active rules satisfied", "All equipped checks passed or exact approval/exception applied", "None"));
  return { ...primary, ruleset: resolved.ruleset, results, gaps: resolved.gaps, deferred_rules };
}
