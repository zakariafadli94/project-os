import { z } from "zod";
import { ruleScopeSchema, type RuleVersion } from "../domain/rule-governance";
import { checkCatalogue, validateCheck } from "./check-catalogue";
import { liveAt, sameScope, verdict, type RuleResult } from "./contract";
import { conflictVerdict, findRuleConflict } from "./resolution";

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
  entry_coverage: z.array(z.strictObject({ operation: text, entries: z.array(z.enum(qualificationEntries)).min(1), evidence_refs: refs })).min(1),
  positive_test_refs: refs, negative_test_refs: refs, contradiction_scan_ref: text, historical_drift_ref: text,
  qualified_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true })
});
export type QualificationEvidence = z.infer<typeof qualificationEvidenceSchema>;
export const qualificationAuditSchema = z.strictObject({
  catalogue_version: text, catalogue_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objects: z.array(z.strictObject({ path: text, object_id: text, revision_token: text, size: z.number().int().nonnegative(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).min(1),
  directories: z.array(z.strictObject({ path: text, listing_sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  probes: z.array(z.strictObject({ project_id: text, relative_path: text, artifact_operation: z.literal("REVIEW_CANDIDATE").optional(), code: text, verdict: z.enum(["allow", "deny"]), evidence_ref: text })).min(2),
  active_rules_sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export const resolvedQualificationProofSchema = z.strictObject({ evidence: qualificationEvidenceSchema, audit: qualificationAuditSchema.optional() });
export type ResolvedQualificationProof = z.infer<typeof resolvedQualificationProofSchema>;
export type QualificationAudit = z.infer<typeof qualificationAuditSchema>;
export interface QualificationRequest {
  rule: RuleVersion; requested_evidence_refs: string[]; now: string;
  known_active_rules?: RuleVersion[];
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
    rule.operations.every(operation => proof.entry_coverage.some(coverage => coverage.operation === operation && qualificationEntries.every(entry => coverage.entries.includes(entry))));
  if (!exact) return verdict("deny", "QUALIFICATION_SCOPE_MISMATCH", rule, "Live exact rule/source/check/entry qualification", "Proof does not cover the exact activation", "Resolve current server proofs for every declared operation and entry");
  const active = input.active_rules.filter(other => other.status === "active" && !(sameScope(other.scope, rule.scope) && other.rule_id === rule.rule_id && other.version === rule.supersedes));
  for (const other of active) {
    const failure = validateCheck(other);
    if (failure) return failure;
  }
  const conflict = findRuleConflict([...active, rule]);
  if (conflict) return conflictVerdict(conflict);
  if (checkCatalogue[rule.check_id].adapter === "requires_server_control" && rule.enforcement === "automatic") return verdict("unavailable", "RULE_CONTROL_UNAVAILABLE", rule, "Deployed executable server control adapter", "Catalogue records requirements only", "Equip the deterministic control and qualify it before automatic activation");
  return { ...verdict("allow", "RULE_QUALIFIED", rule, "Complete activation qualification", "Server proof verified for the exact rule version", "None"), evidence_refs: proof.evidence_refs };
}

/** Guards use server wall time and a server-injected reader, never transaction-supplied proof objects. Resolver faults fail closed without committing activation. */
export async function resolveAndQualifyRuleActivation(resolver: RuleQualificationEvidenceResolver, request: QualificationRequest): Promise<RuleResult> {
  try {
    const resolved = await resolver.resolve(structuredClone(request));
    const result = qualifyRuleActivation({ ...request, evidence: resolved?.evidence ?? null, active_rules: [...(request.known_active_rules ?? []), ...(resolved?.active_rules ?? [])] });
    return result.verdict === "allow" && resolved ? { ...result, qualification_proof: resolvedQualificationProofSchema.parse({ evidence: resolved.evidence, ...(resolved.audit ? { audit: resolved.audit } : {}) }) } : result;
  } catch (error) {
    if (error instanceof QualificationResolutionFailure) return error.result;
    return verdict("unavailable", "QUALIFICATION_EVIDENCE_UNAVAILABLE", request.rule, "Available canonical qualification reader", "Server qualification evidence could not be verified", "Restore the canonical evidence reader and retry");
  }
}
