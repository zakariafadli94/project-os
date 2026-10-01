import { z } from "zod";
import { ruleScopeSchema, type RuleVersion } from "../domain/rule-governance";
import { checkCatalogue, validateCheck } from "./check-catalogue";
import { liveAt, sameScope, verdict, type RuleResult } from "./contract";
import { conflictVerdict, findRuleConflict } from "./resolution";
import type { CanonicalGovernance } from "../persistence/rule-governance-repository";

export const qualificationEntries = ["API", "CT", "FB", "IN", "CF", "AD", "RP", "GI"] as const;
const text = z.string().trim().min(1);
const refs = z.array(text).min(1);
/** Server-resolved proof of one catalogue requirement, scoped by the enclosing exact rule qualification. */
export const qualifiedCheckEvidenceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("verified"), evidence_ref: text, verification_ref: text }),
  z.strictObject({ status: z.literal("unchecked") }),
  z.strictObject({ status: z.literal("unavailable") })
]);
export const qualificationEvidenceSchema = z.strictObject({
  rule_id: text, rule_version: z.number().int().positive(), rule_scope: ruleScopeSchema,
  evidence_refs: refs, accepted_source_refs: refs, deployed_check_id: text, deployment_ref: text,
  check_evidence: z.record(text, qualifiedCheckEvidenceSchema),
  entry_coverage: z.array(z.strictObject({ operation: text, entries: z.array(z.enum(qualificationEntries)).min(1), not_applicable_entries: z.array(z.enum(qualificationEntries)).optional(), evidence_refs: refs })).min(1),
  positive_test_refs: refs, negative_test_refs: refs, contradiction_scan_ref: text, historical_drift_ref: text,
  server_control: z.strictObject({
    check_id: z.literal("verified_presence"), operation: z.literal("package.replace"),
    resource_type: z.literal("package"), zone: z.literal("WORKING"),
    enforcement: z.literal("automatic"), stage: z.literal("post_execution"),
    adapter_ref: z.literal("src/documents/package-replacement.ts#DocumentPackageReplacement.resume"),
    deployment_ref: text, allow_probe_ref: text, deny_probe_ref: text
  }).optional(),
  qualified_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true })
});
export type QualificationEvidence = z.infer<typeof qualificationEvidenceSchema>;
const controlProbeCommon = {
  rule_id: text, rule_version: z.number().int().positive(), project_id: text,
  project_revision: z.number().int().nonnegative(), operation: text,
  entry: z.enum(qualificationEntries), resource_id: text, resource_type: text, zone: text,
  resource_version: text, stage: z.literal("pre_admission"),
  verdict: z.enum(["allow", "deny", "approval_required"]), code: text, evidence_ref: text
};
const controlProbeBaseSchema = z.discriminatedUnion("check_id", [
  z.strictObject({ check_id: z.literal("coherent_phase"), ...controlProbeCommon,
    phase_id: text, phase_status: z.enum(["pending", "active", "completed"]).nullable(),
    current_phase_id: text.nullable(), attached_task_count: z.number().int().nonnegative(),
    attached_task_statuses_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    probe_source: z.enum(["canonical_observation", "ephemeral_evaluator_vector"]) }),
  z.strictObject({ check_id: z.literal("exact_approval"), ...controlProbeCommon,
    actor_id: text,
    probe_case: z.enum(["missing", "exact_live", "wrong_actor", "wrong_project", "wrong_rule_version", "wrong_resource_version", "wrong_operation", "expired", "revoked"]),
    approval_record_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    probe_source: z.literal("ephemeral_evaluator_vector") })
]);
export const controlProbeSchema = controlProbeBaseSchema.superRefine((probe, ctx) => {
  if (probe.check_id === "coherent_phase") {
    const allowed = probe.verdict === "allow" && probe.code === "PHASE_COMPLETION_ALLOWED";
    const denied = probe.verdict === "deny" && ["PHASE_NOT_FOUND", "PHASE_COMPLETED", "PHASE_NOT_CURRENT", "PHASE_STATE_INCONSISTENT", "PHASE_HAS_UNFINISHED_TASKS"].includes(probe.code);
    if (!allowed && !denied) ctx.addIssue({ code: "custom", path: ["code"], message: "Phase probe outcome must match the shared completion predicate" });
  } else {
    const exact = probe.probe_case === "exact_live" && probe.verdict === "allow" && probe.code === "EXACT_APPROVAL_VERIFIED";
    const required = probe.probe_case !== "exact_live" && probe.verdict === "approval_required" && probe.code === "EXACT_APPROVAL_REQUIRED";
    if (!exact && !required) ctx.addIssue({ code: "custom", path: ["code"], message: "Approval probe outcome must match the exact approval evaluator" });
  }
});
export type ControlProbe = z.infer<typeof controlProbeSchema>;
export const qualificationAuditSchema = z.strictObject({
  catalogue_version: text, catalogue_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objects: z.array(z.strictObject({ path: text, object_id: text, revision_token: text, size: z.number().int().nonnegative(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).min(1),
  directories: z.array(z.strictObject({ path: text, listing_sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  project_states: z.array(z.strictObject({ project_id: text, revision: z.number().int().nonnegative(), state_hash: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.string().datetime({ offset: true }), authority: z.literal("ProjectGuard") })).optional(),
  probes: z.array(z.strictObject({ project_id: text, relative_path: text, artifact_operation: z.literal("REVIEW_CANDIDATE").optional(), code: text, verdict: z.enum(["allow", "deny"]), evidence_ref: text })).optional(),
  control_probes: z.array(controlProbeSchema).optional(),
  active_rules_sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export const resolvedQualificationProofSchema = z.strictObject({ evidence: qualificationEvidenceSchema, audit: qualificationAuditSchema.optional() }).superRefine((proof, ctx) => {
  const checkId = proof.evidence.deployed_check_id;
  if (checkId !== "coherent_phase" && checkId !== "exact_approval") return;
  const probes = proof.audit?.control_probes;
  if (!probes?.length || probes.some(probe => probe.check_id !== checkId)) {
    ctx.addIssue({ code: "custom", path: ["audit", "control_probes"], message: "Control qualification requires matching typed probes" });
    return;
  }
  const coverage = proof.evidence.entry_coverage;
  const expected = coverage.flatMap(row => row.entries.map(entry => `${row.operation}\n${entry}`));
  const actual = [...new Set(probes.map(probe => `${probe.operation}\n${probe.entry}`))];
  if (new Set(expected).size !== expected.length || expected.length !== actual.length || expected.some(tuple => !actual.includes(tuple))) {
    ctx.addIssue({ code: "custom", path: ["audit", "control_probes"], message: "Control probes must cover every exercised operation/entry" });
  }
  if (checkId === "exact_approval") {
    const cases = ["missing", "exact_live", "wrong_actor", "wrong_project", "wrong_rule_version", "wrong_resource_version", "wrong_operation", "expired", "revoked"];
    for (const tuple of expected) for (const probeCase of cases) {
      const [operation, entry] = tuple.split("\n");
      if (!probes.some(probe => probe.check_id === checkId && probe.operation === operation && probe.entry === entry && probe.probe_case === probeCase)) {
        ctx.addIssue({ code: "custom", path: ["audit", "control_probes"], message: "Exact-approval probes must include every mismatch and exact-live case" });
        return;
      }
    }
  } else {
    for (const tuple of expected) {
      const [operation, entry] = tuple.split("\n");
      const matching = probes.filter(probe => probe.check_id === checkId && probe.operation === operation && probe.entry === entry);
      if (!matching.some(probe => probe.verdict === "allow") || !matching.some(probe => probe.verdict === "deny")) {
        ctx.addIssue({ code: "custom", path: ["audit", "control_probes"], message: "Phase probes must include positive and negative predicate vectors" });
        return;
      }
    }
  }
});
export type ResolvedQualificationProof = z.infer<typeof resolvedQualificationProofSchema>;
export type QualificationAudit = z.infer<typeof qualificationAuditSchema>;
export interface QualificationRequest {
  rule: RuleVersion; requested_evidence_refs: string[]; now: string;
  known_active_rules?: RuleVersion[];
  /** Server-only: the exact canonical snapshot already verified by RegistryGuard for this transaction. */
  known_global_governance?: { state: CanonicalGovernance; token: string };
}
/** A trusted server resolver must verify canonical provenance of every referenced item, including each check_evidence key's evidence and verification record, and return the complete live conflicting scope, including other projects for global activation. A verified slot attests that the referenced observation/control evidence satisfies that named catalogue requirement for this exact rule qualification; client declarations are never accepted here. */
export interface RuleQualificationEvidenceResolver {
  resolve(request: QualificationRequest): Promise<{ evidence: QualificationEvidence; active_rules: RuleVersion[]; audit?: QualificationAudit } | null>;
}
export const unavailableQualificationResolver: RuleQualificationEvidenceResolver = Object.freeze({ resolve: async () => null });

/** Only server resolvers may report a typed verified failure; transport faults remain unavailable. */
export class QualificationResolutionFailure extends Error {
  constructor(readonly result: RuleResult) { super(result.code); }
}

export function qualifyRuleActivation(input: QualificationRequest & { evidence: unknown; active_rules: RuleVersion[] }): RuleResult {
  const { rule } = input;
  if (input.evidence === null || input.evidence === undefined) return verdict("unavailable", "QUALIFICATION_EVIDENCE_UNAVAILABLE", rule, "Verified server qualification evidence", "No canonical qualification resolver/evidence available", "Keep accepted_unenforced until the server can verify qualification references");
  const invalid = validateCheck(rule);
  if (invalid) return invalid;
  if (rule.status !== "accepted_unenforced") return verdict("deny", "INVALID_RULE_TRANSITION", rule, "accepted_unenforced rule", rule.status, "Accept the exact draft before activation");
  const parsed = qualificationEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return verdict("deny", "INVALID_QUALIFICATION_EVIDENCE", rule, "Complete structured server qualification record", "Missing or malformed proof fields", "Complete accepted source, deployment, entry coverage, tests, contradiction scan and drift inventory");
  const proof = parsed.data;
  const requiredEvidence = checkCatalogue[rule.check_id].required_evidence;
  if (Object.keys(proof.check_evidence).length !== requiredEvidence.length || requiredEvidence.some(key => !Object.hasOwn(proof.check_evidence, key))) {
    return verdict("deny", "QUALIFICATION_CHECK_EVIDENCE_MISMATCH", rule, requiredEvidence.join(", "), Object.keys(proof.check_evidence).join(", ") || "No check evidence bindings", "Resolve exactly every required evidence key for the registered check; omit no key and add no undeclared key");
  }
  const unverified = requiredEvidence.filter(key => proof.check_evidence[key].status !== "verified");
  if (unverified.length) return verdict("unavailable", "QUALIFICATION_CHECK_EVIDENCE_UNAVAILABLE", rule, "Verified server evidence and verification reference for each check requirement", unverified.join(", "), "Verify the required canonical observations/control evidence before activating this rule");
  const exact = proof.rule_id === rule.rule_id && proof.rule_version === rule.version && sameScope(proof.rule_scope, rule.scope) &&
    proof.deployed_check_id === rule.check_id && liveAt(proof.qualified_at, proof.expires_at, input.now) &&
    input.requested_evidence_refs.length > 0 && input.requested_evidence_refs.every(ref => proof.evidence_refs.includes(ref)) &&
    rule.source_refs.every(ref => proof.accepted_source_refs.includes(ref)) &&
    rule.operations.every(operation => {
      const matches = proof.entry_coverage.filter(coverage => coverage.operation === operation);
      if (matches.length !== 1) return false;
      const coverage = matches[0];
      if (new Set(coverage.entries).size !== coverage.entries.length) return false;
      if (coverage.not_applicable_entries === undefined) return qualificationEntries.every(entry => coverage.entries.includes(entry));
      if (new Set(coverage.not_applicable_entries).size !== coverage.not_applicable_entries.length) return false;
      const exercised = new Set(coverage.entries);
      if (coverage.not_applicable_entries.some(entry => exercised.has(entry))) return false;
      const partition = [...coverage.entries, ...coverage.not_applicable_entries];
      return partition.length === qualificationEntries.length && qualificationEntries.every(entry => partition.includes(entry));
    });
  if (!exact) return verdict("deny", "QUALIFICATION_SCOPE_MISMATCH", rule, "Live exact rule/source/check/entry qualification", "Proof does not cover the exact activation", "Resolve current server proofs for every declared operation and entry");
  const active = input.active_rules.filter(other => other.status === "active" && !(sameScope(other.scope, rule.scope) && other.rule_id === rule.rule_id && other.version === rule.supersedes));
  for (const other of active) {
    const failure = validateCheck(other);
    if (failure) return failure;
  }
  const conflict = findRuleConflict([...active, rule]);
  if (conflict) return conflictVerdict(conflict);
  if (checkCatalogue[rule.check_id].adapter === "requires_server_control" && rule.enforcement === "automatic") {
    const control = proof.server_control;
    const equipped = rule.check_id === "verified_presence"
      && rule.operations.length === 1 && rule.operations[0] === "package.replace"
      && rule.resource_scope.resource_types.length === 1 && rule.resource_scope.resource_types[0] === "package"
      && rule.resource_scope.zones.length === 1 && rule.resource_scope.zones[0] === "WORKING"
      && rule.check_stage === "post_execution"
      && control?.check_id === rule.check_id && control.operation === rule.operations[0]
      && control.resource_type === rule.resource_scope.resource_types[0] && control.zone === rule.resource_scope.zones[0]
      && control.enforcement === rule.enforcement && control.stage === rule.check_stage
      && control.deployment_ref === proof.deployment_ref
      && proof.positive_test_refs.includes(control.allow_probe_ref) && proof.negative_test_refs.includes(control.deny_probe_ref);
    if (!equipped) return verdict("unavailable", "RULE_CONTROL_UNAVAILABLE", rule, "Exact build-bound deployed server control adapter with allow/deny probes", "No exact server-control attestation for this tuple", "Keep accepted_unenforced until the deterministic adapter and its probes are qualified");
  }
  return { ...verdict("allow", "RULE_QUALIFIED", rule, "Complete activation qualification", "Server proof verified for the exact rule version", "None"), evidence_refs: proof.evidence_refs };
}

/** Guards use server wall time and a server-injected reader, never transaction-supplied proof objects. Resolver faults fail closed without committing activation. */
export async function resolveAndQualifyRuleActivation(resolver: RuleQualificationEvidenceResolver, request: QualificationRequest): Promise<RuleResult> {
  try {
    const resolved = await resolver.resolve(structuredClone(request));
    const result = qualifyRuleActivation({ ...request, evidence: resolved?.evidence ?? null, active_rules: [...(request.known_active_rules ?? []), ...(resolved?.active_rules ?? [])] });
    if (result.verdict !== "allow" || !resolved) return result;
    const proof = resolvedQualificationProofSchema.safeParse({ evidence: resolved.evidence, ...(resolved.audit ? { audit: resolved.audit } : {}) });
    if (!proof.success) return verdict("unavailable", "QUALIFICATION_PROOF_MALFORMED", request.rule, "Schema-valid server qualification proof", proof.error.issues.map(issue => issue.path.join(".")).slice(0, 8).join(", "), "Repair the server proof producer; keep accepted_unenforced");
    return { ...result, qualification_proof: proof.data };
  } catch (error) {
    if (error instanceof QualificationResolutionFailure) return error.result;
    return verdict("unavailable", "QUALIFICATION_EVIDENCE_UNAVAILABLE", request.rule, "Available canonical qualification reader", "Server qualification evidence could not be verified", "Restore the canonical evidence reader and retry");
  }
}
