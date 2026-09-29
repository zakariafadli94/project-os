import { z } from "zod";
import { approvalRecordSchema } from "../domain/approval";
import { checkPhaseCompletion } from "../domain/phase-completion-check";
import { foundationalCheckIds, ruleExceptionSchema, ruleScopeSchema, type RuleVersion } from "../domain/rule-governance";
import { assertManagedDocumentExpectedVersion, ManagedDocumentConflictError } from "../documents/service";
import { resolveArtifactDestination } from "../persistence/artifact-routing";
import { workspaceProjectRoot } from "../persistence/layout";
import { checkCatalogue, normalizedMutationOperations, validateCheck } from "./check-catalogue";
import { validateLocalRuleAuthority } from "./local-rule-qualification";
import { canonicalJson, liveAt, ruleReference, sameScope, verdict, type EvaluationResult, type OperationContext, type RuleResource, type RuleResult } from "./contract";
import { conflictVerdict, findRuleConflict, matchesResource, resolveEffectiveRules } from "./resolution";

const text = z.string().trim().min(1);
function exactApproval(context: OperationContext, rule: RuleVersion, resource: RuleResource) {
  return context.approvals.map(value => approvalRecordSchema.safeParse(value)).find(result => {
    if (!result.success) return false;
    const a = result.data;
    return a.status === "approved" && a.actor_id === context.actor.actor_id && a.project_id === context.project_id &&
      a.rule_id === rule.rule_id && a.rule_version === rule.version && sameScope(a.rule_scope, rule.scope) &&
      a.resource_id === resource.resource_id && a.resource_type === resource.resource_type && a.resource_zone === resource.zone &&
      a.resource_version === resource.version && a.operation === context.operation && liveAt(a.granted_at, a.expires_at, context.now);
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
  if (rule.check_id === "coherent_phase") {
    if (context.operation !== "plan.phase.complete" || resource.resource_type !== "plan" || resource.zone !== "PROJECT"
      || resource.version !== String(context.state.revision) || !resource.phase_id) {
      return verdict("unavailable", "RULE_EVIDENCE_UNAVAILABLE", rule, "Exact normalized phase completion target at the current project revision", "Missing or incongruent phase resource", "Normalize the typed plan.phase.complete transaction from its canonical payload");
    }
    const evidence = context.state.last_event_id
      ? [`canonical:project/${context.project_id}/revision/${context.state.revision}/event/${context.state.last_event_id}/phase/${resource.phase_id}`]
      : [];
    if (!evidence.length) return verdict("unavailable", "RULE_EVIDENCE_UNAVAILABLE", rule, "Canonical phase state with event provenance", "Missing project event provenance", "Refresh the canonical project state before phase completion");
    const issue = checkPhaseCompletion(context.state, resource.phase_id);
    if (issue) {
      return {
        ...verdict("deny", issue.code, rule,
          "Active current phase with all attached tasks completed", issue.message, "Resolve the canonical phase condition before completing it"),
        evidence_refs: evidence
      };
    }
    return {
      ...verdict("allow", "PHASE_COMPLETION_ALLOWED", rule, "Active current phase with all attached tasks completed", resource.phase_id, "None"),
      evidence_refs: evidence
    };
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
  if (!Number.isFinite(Date.parse(context.now)) || !normalizedMutationOperations.includes(context.operation) || !context.resources.length || context.resources.some(r => !r.resource_id || !r.resource_type || !r.zone || !r.version)) return fail(verdict("unavailable", "INVALID_OPERATION_CONTEXT", null, "Server-normalized mutation, resource versions and time", "Incomplete or unsupported context", "Use the registered server operation adapter"));
  if (context.stage === "post_execution") {
    const admission = context.initial_admission;
    if (!admission || !/^[a-f0-9]{64}$/.test(context.request_hash ?? "")
      || admission.verdict !== "allow" || admission.project_id !== context.project_id
      || admission.operation !== context.operation || admission.request_hash !== context.request_hash
      || canonicalJson(admission.actor) !== canonicalJson(context.actor)
      || canonicalJson(admission.resources) !== canonicalJson(context.resources)
      || !Number.isSafeInteger(admission.project_revision) || admission.project_revision < 0
      || !admission.ruleset?.digest || admission.ruleset.project_revision !== admission.project_revision) {
      return fail(verdict("unavailable", "INITIAL_ADMISSION_PROOF_UNAVAILABLE", null, "Exact immutable admission bound to this project, actor, operation, request and resources", "Missing or mismatched canonical execution admission", "Reload the immutable admission from the execution journal; never substitute a client proof"));
    }
    if (!admission.deferred_rules.length) return {
      ...verdict("allow", "RULES_SATISFIED", null, "No deferred rule obligation in the initial admission", "No deferred rule postcheck", "None"),
      ruleset: admission.ruleset, results: [], gaps: [], deferred_rules: []
    };
    const results: RuleResult[] = [];
    for (const reference of admission.deferred_rules) {
      if (!admission.ruleset.rules.some(rule => canonicalJson(rule) === canonicalJson(reference))) {
        return fail(verdict("unavailable", "INITIAL_ADMISSION_PROOF_UNAVAILABLE", null, "Deferred rule is present in the frozen admission ruleset", "Admission rule reference mismatch", "Reload the exact immutable admission record"));
      }
      const candidates = admission.results.filter(result => result.verdict === "allow"
        && result.rule && canonicalJson(result.rule) === canonicalJson(reference)
        && typeof result.resource_id === "string" && admission.resources.some(resource => resource.resource_id === result.resource_id));
      if (!candidates.length || candidates.some(result =>
        !((result.code === "EXACT_APPROVAL_VERIFIED" && result.approval_id && result.evidence_refs?.length)
          || (result.code === "RULE_EXCEPTION_APPLIED" && result.exception_id && result.evidence_refs?.length)))) {
        return fail(verdict("unavailable", "INITIAL_ADMISSION_PROOF_UNAVAILABLE", null, "Exact initial approval or exception result with canonical evidence", "No reusable authorized initial proof for every deferred rule", "Refuse finalization until the original admission proof can be verified"));
      }
      results.push(...candidates.map(result => ({
        ...result, code: "INITIAL_ADMISSION_PROOF_RETAINED",
        expected: "The exact initial approval or exception remains the authorization for this admitted execution",
        observed: result.approval_id ?? result.exception_id!, required_action: "None"
      })));
    }
    return {
      ...verdict("allow", "INITIAL_ADMISSION_PROOF_RETAINED", null, "Exact initial authorization proof retained", "Every deferred authorization is bound to the immutable admission", "None"),
      ruleset: admission.ruleset, results, gaps: [], deferred_rules: []
    };
  }
  if (!context.global_governance) return fail(verdict("unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", null, "Fresh canonical global governance", "Global governance unavailable", "Restore the canonical governance reader; do not bypass global rules"));
  if (context.stage !== "pre_admission") return fail(verdict("unavailable", "INVALID_OPERATION_CONTEXT", null, "Registered evaluation stage", "Unsupported stage", "Use the registered server operation adapter"));
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
    if (rule.check_stage === "both") {
      if (context.stage === "pre_admission") deferred_rules.push(ruleReference(rule));
    } else if (rule.check_stage !== context.stage) {
      if (context.stage === "pre_admission") deferred_rules.push(ruleReference(rule));
      continue;
    }
    for (const resource of context.resources.filter(r => matchesResource(rule, r))) results.push({ ...evaluateOne(context, rule, resource), resource_id: resource.resource_id });
  }
  const rank = { allow: 0, approval_required: 1, unavailable: 2, deny: 3 };
  const primary = results.reduce<RuleResult>((worst, result) => rank[result.verdict] > rank[worst.verdict] ? result : worst,
    verdict("allow", "RULES_SATISFIED", null, "All applicable active rules satisfied", "All equipped checks passed or exact approval/exception applied", "None"));
  return { ...primary, ruleset: resolved.ruleset, results, gaps: resolved.gaps, deferred_rules };
}
