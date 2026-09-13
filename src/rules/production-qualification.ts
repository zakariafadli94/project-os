import { z } from "zod";
import type { Env } from "../env";
import type { ProjectState } from "../domain/project-state";
import { parseCanonicalCommitRecord } from "../domain/commit-record";
import { ruleVersionSchema, ruleVersionKey, type RuleVersion } from "../domain/rule-governance";
import { deploymentIdentity } from "../deployment/identity";
import { sha256Text } from "../documents/hash";
import { normalizeArtifactAdmission, type ArtifactAdmissionIntent } from "../admission/operation-context";
import { AdmissionError } from "../admission/mutation-context";
import { admissionModeForProject } from "../convergence/rollout";
import { archiveProjectRoot, machineCommitRecordPath, machineRegistryJsonPath, workspaceProjectRoot } from "../persistence/layout";
import { globalGovernancePath, RuleGovernanceRepository } from "../persistence/rule-governance-repository";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { canonicalJson, compareCodePoints, sameScope, verdict } from "./contract";
import { checkCatalogue, normalizedMutationOperations, validateCheck } from "./check-catalogue";
import { evaluateRules } from "./evaluator";
import { QualificationResolutionFailure, qualificationEntries, type QualificationAudit, type QualificationEvidence, type RuleQualificationEvidenceResolver } from "./qualification";

/** Build-owned coverage of the shared artifact admission boundary. This is not Markdown/client evidence.
 * Artifact current_version and approval readers are not supplied by production admission yet, so those checks
 * deliberately have no qualification coverage. A new allowed_destination rule needs no code change. */
export const deployedQualificationCoverage = Object.freeze({
  version: "artifact-admission-v3",
  checks: Object.freeze({ allowed_destination: Object.freeze({
    operations: Object.freeze(normalizedMutationOperations.filter(operation => operation === "artifact.write" && checkCatalogue.allowed_destination.operations.includes(operation))),
    entries: Object.freeze([...qualificationEntries]),
    normalizer: "src/admission/operation-context.ts#normalizeArtifactAdmission",
    boundary: "src/durable/project-guard-neutral.ts#admitRules",
    positive: "allowed-canonical-artifact-route",
    negative: "forbidden-canonical-artifact-route",
    artifact_intents: Object.freeze(["ordinary", "REVIEW_CANDIDATE"]),
    review_negative: "reject-nested-review-candidate-destination"
  }) })
});
const registrySchema = z.object({ schema_version: z.literal("1.0"), projects: z.array(z.object({ project_id: z.string().regex(/^PRJ-[0-9]{4,}$/), slug: z.string().min(1), status: z.enum(["active", "paused", "completed", "archived"]) })) });

/** Read-only: evidence is resolved from existing canonical objects/commit receipts, then live probes
 * exercise the deployed normalizer/evaluator. No caller-selected proof or new evidence store. */
const productionResolvers = new WeakSet<RuleQualificationEvidenceResolver>();
export function isProductionQualificationResolver(resolver: RuleQualificationEvidenceResolver): boolean { return productionResolvers.has(resolver); }
export function createProductionRuleQualificationResolver(runtime: ProjectOsPersistenceRuntime, env: Env): RuleQualificationEvidenceResolver {
  const resolver: RuleQualificationEvidenceResolver = { async resolve(request) {
    const { rule, now } = request;
    const fail = (code: string, observed: string): never => { throw new QualificationResolutionFailure(verdict("unavailable", code, rule, "Complete verified production qualification", observed, "Keep accepted_unenforced; restore or supply the exact canonical prerequisite")); };
    const deployment = deploymentIdentity(env);
    if (!deployment.worker_version_id || !deployment.git_sha) return null;
    const invalid = validateCheck(rule);
    if (invalid) throw new QualificationResolutionFailure(invalid);
    const coverage = deployedQualificationCoverage.checks[rule.check_id as keyof typeof deployedQualificationCoverage.checks];
    if (!coverage || rule.enforcement !== "automatic" || rule.operations.some(operation => !coverage.operations.includes(operation)) || rule.resource_scope.resource_types.some(type => type !== "artifact") || rule.resource_scope.zones.some(zone => !/^(WORKING|ARTIFACTS|DELIVERABLES|ARCHIVES|RESEARCH|REFERENCES|SPECS|MEETINGS|REVIEW)$/.test(zone))) fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "No deployed coverage for this check, operation, resource, zone or enforcement mode");
    const observed = new Map<string, ProviderObjectMetadata>();
    const hashes = new Map<string, string>();
    const listings = new Map<string, string>();
    const list = async (path: string) => {
      const entries = await runtime.objects.listChildren(path);
      const signature = canonicalJson(entries.slice().sort((a, b) => compareCodePoints(a.path ?? a.name, b.path ?? b.name)));
      if (listings.has(path) && listings.get(path) !== signature) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Directory inventory changed during qualification");
      listings.set(path, signature);
      return entries;
    };
    const identity = (metadata: ProviderObjectMetadata | null) => metadata?.objectId && metadata.revisionToken ? canonicalJson([metadata.objectId, metadata.revisionToken, metadata.size]) : null;
    const read = async (path: string, code: string): Promise<string> => {
      const before = await runtime.objects.getMetadata(path);
      if (!identity(before)) fail(code, `Canonical object unavailable: ${path}`);
      const raw = await runtime.objects.readText(path);
      const after = await runtime.objects.getMetadata(path);
      if (raw === null || identity(before) !== identity(after)) fail(code, `Canonical object changed: ${path}`);
      observed.set(path, after!);
      hashes.set(path, await sha256Text(raw!));
      return raw!;
    };
    const governance = await new RuleGovernanceRepository(runtime).read();
    if (!governance) fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Canonical governance unavailable");
    if (!request.requested_evidence_refs.length) fail("QUALIFICATION_REFERENCE_UNVERIFIED", "No acceptance reference");
    if (rule.scope.kind === "global") {
      const acceptedRule = governance!.state.rules[ruleVersionKey(rule.rule_id, rule.version)];
      if (!acceptedRule || canonicalJson(acceptedRule) !== canonicalJson(rule)) fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Exact canonical accepted rule missing");
      for (const ref of request.requested_evidence_refs) {
      const prefix = `${globalGovernancePath}#transaction=`;
      const entry = ref.startsWith(prefix) ? governance!.state.journal[ref.slice(prefix.length)] : undefined;
      if (!entry || entry.receipt.status !== "committed" || entry.transaction.operation !== "rule.accept" || entry.transaction.payload.rule_id !== rule.rule_id || entry.transaction.payload.version !== rule.version || entry.event?.type !== "rule.accept") fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Reference is not this rule version's committed acceptance");
      }
    }
    let registry: z.infer<typeof registrySchema>;
    try { registry = registrySchema.parse(JSON.parse(await read(machineRegistryJsonPath(), "QUALIFICATION_INVENTORY_UNAVAILABLE"))); }
    catch (error) { if (error instanceof QualificationResolutionFailure) throw error; return fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Registry is malformed"); }
    if (!registry.projects.length || new Set(registry.projects.map(p => p.project_id)).size !== registry.projects.length) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Registry is empty or ambiguous");
    const states: ProjectState[] = [];
    // Archived projects are terminal: they cannot receive new admissions.
    for (const project of registry.projects.filter(project => project.status !== "archived")) {
      try {
        const root = machineCommitRecordPath(project.project_id, 1).slice(0, -"REV-000001.json".length - 1);
        const entries = await list(root);
        const revisions = entries.map(entry => entry.kind === "file" && entry.path?.startsWith(`${root}/`) ? Number(entry.name.match(/^REV-([0-9]{6,})\.json$/)?.[1]) : NaN).sort((a, b) => a - b);
        // Migration may preserve only a contiguous suffix; never fabricate its missing prefix.
        const firstRevision = revisions[0];
        if (!revisions.length || revisions.some((revision, index) => !Number.isSafeInteger(revision) || revision < 1 || revision !== firstRevision + index)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical commit history is missing or noncontiguous");
        const readBoundCommit = async (revision: number) => {
          const commit = parseCanonicalCommitRecord(JSON.parse(await read(machineCommitRecordPath(project.project_id, revision), "QUALIFICATION_INVENTORY_UNAVAILABLE")));
          if (commit.project_id !== project.project_id || commit.new_revision !== revision || commit.previous_revision !== revision - 1) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical commit does not match its project/revision address");
          return commit;
        };
        const first = await readBoundCommit(firstRevision);
        const latestRevision = revisions.at(-1)!;
        const commit = latestRevision === firstRevision ? first : await readBoundCommit(latestRevision);
        const state = commit.state;
        if (state.project_id !== project.project_id || state.slug !== project.slug || state.status !== project.status) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Registry and canonical project identity differ");
        states.push(state);
      } catch (error) { if (error instanceof QualificationResolutionFailure) throw error; fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical project inventory could not be verified"); }
    }
    if (rule.scope.kind === "project") {
      const projectId = rule.scope.project_id;
      const state = states.find(state => state.project_id === projectId);
      const key = ruleVersionKey(rule.rule_id, rule.version);
      if (!state || canonicalJson(state.local_rules[key]) !== canonicalJson(rule)) fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Exact canonical local accepted rule missing");
      for (const ref of request.requested_evidence_refs) {
        try {
          const commit = parseCanonicalCommitRecord(JSON.parse(await read(ref, "QUALIFICATION_REFERENCE_UNVERIFIED")));
          if (ref !== machineCommitRecordPath(projectId, commit.new_revision) || commit.project_id !== projectId || commit.new_revision > state!.revision || commit.transaction.operation !== "rule.accept" || commit.transaction.payload.rule_id !== rule.rule_id || commit.transaction.payload.version !== rule.version || commit.event.type !== "rule.accept" || canonicalJson(commit.event.payload) !== canonicalJson(commit.transaction.payload) || canonicalJson(commit.state.local_rules[key]) !== canonicalJson(rule)) fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Reference is not this local rule version's committed acceptance");
        } catch (error) { if (error instanceof QualificationResolutionFailure) throw error; fail("QUALIFICATION_REFERENCE_UNVERIFIED", "Local acceptance commit is malformed"); }
      }
    }
    for (const source of rule.source_refs) {
      const match = source.match(/^\/PROJECT_OS\/\.project-os\/projects\/(PRJ-[0-9]{4,})\/commits\/REV-([0-9]{6,})\.json$/);
      const state = match && states.find(state => state.project_id === match[1]);
      if (!match || !state || (rule.scope.kind === "project" && state.project_id !== rule.scope.project_id)) fail("QUALIFICATION_SOURCE_UNVERIFIED", "Source must reference an exact canonical accepted-decision commit");
      try {
        const commit = parseCanonicalCommitRecord(JSON.parse(await read(source, "QUALIFICATION_SOURCE_UNVERIFIED")));
        if (commit.project_id !== state!.project_id || commit.new_revision !== Number(match![2]) || commit.transaction.operation !== "decision.accept" || canonicalJson(commit.event.payload) !== canonicalJson(commit.transaction.payload)) fail("QUALIFICATION_SOURCE_UNVERIFIED", "Source is not a bound accepted-decision commit");
        const decision = commit.transaction.operation === "decision.accept" ? state!.decisions[commit.transaction.payload.decision_id] : undefined;
        if (!decision || decision.status !== "accepted") fail("QUALIFICATION_SOURCE_UNVERIFIED", "Accepted decision is absent or superseded");
      } catch (error) { if (error instanceof QualificationResolutionFailure) throw error; fail("QUALIFICATION_SOURCE_UNVERIFIED", "Source commit is malformed"); }
    }
    const active_rules: RuleVersion[] = Object.values(governance!.state.rules).filter(rule => rule.status === "active");
    for (const state of states) for (const [key, value] of Object.entries(state.local_rules)) {
      const parsed = ruleVersionSchema.safeParse(value);
      if (!parsed.success || key !== ruleVersionKey(parsed.data.rule_id, parsed.data.version) || !sameScope(parsed.data.scope, { kind: "project", project_id: state.project_id })) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Local rule inventory is malformed");
      if (parsed.data!.status === "active") active_rules.push(parsed.data!);
    }
    const applicable = states.filter(state => rule.scope.kind === "global" || rule.scope.project_id === state.project_id);
    if (!applicable.length || applicable.some(state => admissionModeForProject(env.PROJECT_OS_ADMISSION_PROJECT_MODES, state.project_id) !== "strict")) fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "Every governed project must have strict production admission configured");
    let count = 0;
    const inventory = async (path: string, zone: string): Promise<void> => {
      if (++count > 256) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Synchronous inventory limit reached; no partial qualification");
      for (const entry of await list(path)) {
        const child = entry.path;
        if (!child || !child.startsWith(`${path}/`) || child.slice(path.length + 1).includes("/") || entry.kind === "deleted") fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Provider inventory has an unbound member");
        if (entry.kind === "folder") await inventory(child!, zone);
        else {
          if (++count > 256) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Synchronous inventory limit reached; no partial qualification");
          if (!(rule.parameters.allowed_zones as string[]).includes(zone)) fail("QUALIFICATION_HISTORICAL_DRIFT", "Existing scoped files violate the proposed destination rule");
          const metadata = await runtime.objects.getMetadata(child!);
          if (!identity(metadata)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Historical file identity unavailable");
          observed.set(child!, metadata!);
        }
      }
    };
    for (const state of applicable) {
      const root = state.status === "archived" ? archiveProjectRoot(state.project_id, state.slug) : workspaceProjectRoot(state.project_id, state.slug);
      for (const zone of rule.resource_scope.zones) await inventory(`${root}/${zone}`, zone);
    }
    const positive: string[] = [], negative: string[] = [];
    const probes: QualificationAudit["probes"] = [];
    for (const state of applicable) {
      const paths = ["qualification-probe.md", ...Object.values(state.artifact_routes).map(route => `${route.source_prefix}/qualification-probe.md`)];
      const intents: ArtifactAdmissionIntent[] = paths.map(relative_path => ({ request_id: "ART-QUALIFICATION-PROBE01", project_id: state.project_id, relative_path, content_sha256: "a".repeat(64), mode: "create" }));
      const reviewNegative: ArtifactAdmissionIntent = { request_id: "ART-QUALIFICATION-REVIEW02", project_id: state.project_id, relative_path: "nested/qualification-probe.pdf", content_sha256: "a".repeat(64), mode: "create", operation: "REVIEW_CANDIDATE" };
      if (rule.resource_scope.zones.includes("REVIEW")) intents.push({ ...reviewNegative, request_id: "ART-QUALIFICATION-REVIEW01", relative_path: "qualification-probe.pdf" }, reviewNegative);
      for (const intent of intents) {
        const { relative_path } = intent;
        try {
          const normalized = await normalizeArtifactAdmission(intent, state);
          if (intent === reviewNegative) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Review single-file negative control was unexpectedly admitted");
          // Applicability was bound to the exact canonical project above. Probe the candidate check
          // in the isolated global slot, so a not-yet-issued local attestation cannot authorize itself.
          const result = await evaluateRules({ actor: { actor_id: "qualification", authority: "server" }, project_id: state.project_id, operation: normalized.operation, expected_project_revision: state.revision, stage: "pre_admission", now, state: { ...state, local_rules: {} }, global_governance: { revision: governance!.state.revision, rules: { [ruleVersionKey(rule.rule_id, rule.version)]: { ...rule, scope: { kind: "global" }, status: "active" } }, exceptions: {} }, resources: normalized.resources, observations: [], approvals: [] });
          const exact = result.results.find(result => result.rule?.rule_id === rule.rule_id && result.rule.version === rule.version);
          const ref = `${machineCommitRecordPath(state.project_id, state.revision)}#probe=${await sha256Text(canonicalJson({ intent, rule, result, coverage: deployedQualificationCoverage.version }))}`;
          if (exact?.code === "DESTINATION_ALLOWED") positive.push(ref);
          if (exact?.code === "DESTINATION_FORBIDDEN") negative.push(ref);
          if (exact && (exact.verdict === "allow" || exact.verdict === "deny")) probes.push({ project_id: state.project_id, relative_path, ...(intent.operation ? { artifact_operation: intent.operation } : {}), code: exact.code, verdict: exact.verdict, evidence_ref: ref });
        } catch (error) {
          if (error instanceof QualificationResolutionFailure) throw error;
          // This explicit candidate intent stays in REVIEW. Only the canonical destination
          // boundary's exact refusal counts; unavailable/network/arbitrary errors never do.
          if (intent === reviewNegative && error instanceof AdmissionError && error.code === "ARTIFACT_DESTINATION_FORBIDDEN") {
            const result = { verdict: "deny" as const, code: error.code };
            const ref = `${machineCommitRecordPath(state.project_id, state.revision)}#probe=${await sha256Text(canonicalJson({ intent, rule, result, coverage: deployedQualificationCoverage.version }))}`;
            negative.push(ref);
            probes.push({ project_id: state.project_id, relative_path, artifact_operation: "REVIEW_CANDIDATE", ...result, evidence_ref: ref });
          } else if (intent === reviewNegative) {
            fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Review negative-control boundary was unavailable rather than a verified destination refusal");
          }
        }
      }
    }
    if (!positive.length || !negative.length) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Live deployed-rule probes did not establish both positive and negative outcomes");
    for (const [path, metadata] of observed) if (identity(await runtime.objects.getMetadata(path)) !== identity(metadata)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical evidence changed before qualification completed");
    for (const path of listings.keys()) await list(path);
    const current = await new RuleGovernanceRepository(runtime).read();
    if (current?.token !== governance!.token) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Global governance changed during qualification");
    const snapshot = await sha256Text(canonicalJson({ observed: [...observed], listings: [...listings], active_rules }));
    const build = `deployment:${deployment.worker_version_id}:${deployment.git_sha}:${deployedQualificationCoverage.version}`;
    const evidence: QualificationEvidence = {
      rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope, evidence_refs: request.requested_evidence_refs,
      accepted_source_refs: rule.source_refs, deployed_check_id: rule.check_id, deployment_ref: build,
      check_evidence: {
        canonical_artifact_routes: { status: "verified", evidence_ref: `${machineRegistryJsonPath()}#inventory=${snapshot}`, verification_ref: positive[0] },
        relative_path: { status: "verified", evidence_ref: positive[0], verification_ref: negative[0] }
      },
      entry_coverage: rule.operations.map(operation => ({ operation, entries: [...coverage.entries], evidence_refs: [build] })),
      positive_test_refs: positive, negative_test_refs: negative,
      contradiction_scan_ref: `${globalGovernancePath}#inventory=${snapshot}`, historical_drift_ref: `${machineRegistryJsonPath()}#inventory=${snapshot}`,
      qualified_at: now, expires_at: new Date(Date.parse(now) + 60_000).toISOString()
    };
    const audit: QualificationAudit = {
      catalogue_version: deployedQualificationCoverage.version, catalogue_sha256: await sha256Text(canonicalJson(deployedQualificationCoverage)),
      objects: [...observed].map(([path, metadata]) => ({ path, object_id: metadata.objectId!, revision_token: metadata.revisionToken!, size: metadata.size, ...(hashes.has(path) ? { content_sha256: hashes.get(path)! } : {}) })),
      directories: await Promise.all([...listings].map(async ([path, signature]) => ({ path, listing_sha256: await sha256Text(signature) }))),
      probes, active_rules_sha256: await sha256Text(canonicalJson(active_rules))
    };
    return { evidence, active_rules, audit };
  } };
  Object.freeze(resolver);
  productionResolvers.add(resolver);
  return resolver;
}
