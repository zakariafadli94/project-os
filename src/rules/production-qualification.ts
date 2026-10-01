import { z } from "zod";
import type { Env } from "../env";
import type { ProjectState } from "../domain/project-state";
import { parseCanonicalCommitRecord } from "../domain/commit-record";
import { ruleVersionSchema, ruleVersionKey, type RuleVersion } from "../domain/rule-governance";
import { deploymentIdentity } from "../deployment/identity";
import { sha256Text } from "../documents/hash";
import { normalizeArtifactAdmission, normalizeDocumentAdmission, normalizeTransactionAdmission, type ArtifactAdmissionIntent } from "../admission/operation-context";
import { AdmissionError, parseMutationContextOrNull, verifyMutationContext } from "../admission/mutation-context";
import { readProjectState } from "../schema/project-state";
import { admissionModeForProject } from "../convergence/rollout";
import { archiveProjectRoot, machineCommitRecordPath, machineDocumentHeadPath, machineDocumentRoot, machineDocumentVersionPath, machineRegistryJsonPath, workspaceProjectRoot } from "../persistence/layout";
import { documentIdFor, parseDocumentVersionRecord, parseManagedDocumentHead } from "../domain/managed-document";
import { approvalRecordSchema } from "../domain/approval";
import { DocumentLedgerRepository } from "../documents/repository";
import { parseManagedDocumentRequest } from "../domain/managed-document-request";
import { globalGovernancePath, RuleGovernanceRepository } from "../persistence/rule-governance-repository";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderOperationError } from "../persistence/provider/errors";
import { canonicalJson, compareCodePoints, sameScope, verdict } from "./contract";
import { checkCatalogue, normalizedMutationOperations, validateCheck } from "./check-catalogue";
import { evaluateRules } from "./evaluator";
import { QualificationResolutionFailure, qualificationEntries, type ControlProbe, type QualificationAudit, type QualificationEvidence, type RuleQualificationEvidenceResolver } from "./qualification";

/** Build-owned coverage of production admission boundaries. This is not Markdown/client evidence.
 * Coverage is intentionally limited to exact operation/resource tuples whose server normalizer and evidence
 * reader are deployed. A new allowed_destination rule needs no code change. */
export const deployedQualificationCoverage = Object.freeze({
  version: "artifact-admission-v5",
  checks: Object.freeze({ allowed_destination: Object.freeze({
    operations: Object.freeze(normalizedMutationOperations.filter(operation => operation === "artifact.write" && checkCatalogue.allowed_destination.operations.includes(operation))),
    entries: Object.freeze([...qualificationEntries]),
    normalizer: "src/admission/operation-context.ts#normalizeArtifactAdmission",
    boundary: "src/durable/project-guard-neutral.ts#admitRules",
    positive: "allowed-canonical-artifact-route",
    negative: "forbidden-canonical-artifact-route",
    artifact_intents: Object.freeze(["ordinary", "REVIEW_CANDIDATE"]),
    review_negative: "reject-nested-review-candidate-destination"
  }),
  coherent_phase: Object.freeze({
    operations: Object.freeze(["plan.phase.complete"]),
    entries: Object.freeze(["API", "CT", "FB", "IN", "GI"]),
    not_applicable_entries: Object.freeze(["CF", "AD", "RP"]),
    resource_types: Object.freeze(["plan"]), zones: Object.freeze(["PROJECT"]),
    enforcement: "automatic", check_stage: "pre_admission", parameters: Object.freeze({}),
    normalizer: "src/admission/operation-context.ts#normalizeTransactionAdmission",
    boundary: "src/durable/project-guard-neutral.ts#applyTransaction",
    positive_route: "src/index-neutral.ts#/v1/transactions;src/control-tower/mcp.ts#project_os_submit_transaction;src/fallback/contract.ts#transaction;src/inbox/runtime.ts#processTransactionInbox;src/durable/project-guard-neutral.ts#transaction",
    negative_route: "src/index-neutral.ts#scheduled-reconcile;src/durable/project-guard-neutral.ts#request-status;src/mutation-gate/classifier.ts#candidate-resolution",
    positive_test_ref: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-API",
    negative_test_ref: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-API",
    entry_evidence: Object.freeze({
      API: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-API",
      CT: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-CT",
      FB: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-FB",
      IN: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-IN",
      CF: "src/index-neutral.ts#scheduled-reconcile",
      AD: "src/durable/project-guard-neutral.ts#request-status",
      RP: "src/mutation-gate/classifier.ts#candidate-resolution",
      GI: "test/sop-phase-entry-parity.spec.ts#qualifies-coherent-phase-completion-and-checks-a-fresh-refusal-allow-through-GI"
    })
  }),
  exact_approval: Object.freeze({
    operations: Object.freeze(["document.publish", "review.promote"]),
    entries: Object.freeze(["API", "CT", "GI"]),
    not_applicable_entries: Object.freeze(["FB", "IN", "CF", "AD", "RP"]),
    resource_types: Object.freeze(["document"]), zones: Object.freeze(["DOCUMENTS"]),
    enforcement: "explicit_approval", check_stage: "pre_admission", parameters: Object.freeze({}),
    normalizer: "src/admission/operation-context.ts#normalizeDocumentAdmission",
    boundary: "src/durable/project-guard-neutral.ts#handleManagedDocument",
    positive_route: "src/index-neutral.ts#/v1/documents;src/control-tower/mcp.ts#project_os_write_working_document;src/durable/project-guard-neutral.ts#/document",
    negative_route: "src/fallback/contract.ts#transaction-only;src/inbox/runtime.ts#typed-transaction-or-artifact;src/index-neutral.ts#scheduled-reconcile;src/durable/project-guard-neutral.ts#request-status;src/mutation-gate/classifier.ts#candidate-resolution",
    positive_test_ref: "test/sop-document-entry-parity.spec.ts#requires-an-exact-live-grant-before-review-promotion-and-publication-via-API",
    negative_test_ref: "test/sop-document-entry-parity.spec.ts#requires-an-exact-live-grant-before-review-promotion-and-publication-via-API",
    entry_evidence: Object.freeze({
      API: "test/sop-document-entry-parity.spec.ts#requires-an-exact-live-grant-before-review-promotion-and-publication-via-API",
      CT: "test/sop-document-entry-parity.spec.ts#requires-an-exact-live-grant-before-review-promotion-and-publication-via-Control-Tower",
      GI: "test/sop-document-entry-parity.spec.ts#requires-an-exact-live-grant-before-review-promotion-and-publication-via-ProjectGuard",
      FB: "src/fallback/contract.ts#transaction-only",
      IN: "src/inbox/runtime.ts#typed-transaction-or-artifact",
      CF: "src/index-neutral.ts#scheduled-reconcile",
      AD: "src/durable/project-guard-neutral.ts#request-status",
      RP: "src/mutation-gate/classifier.ts#candidate-resolution"
    })
  }),
  expected_version: Object.freeze({
    operations: Object.freeze(["working.write"]),
    entries: Object.freeze(["API", "CT", "GI"]),
    not_applicable_entries: Object.freeze(["FB", "IN", "CF", "AD", "RP"]),
    resource_types: Object.freeze(["document"]), zones: Object.freeze(["DOCUMENTS"]),
    enforcement: "automatic", check_stage: "pre_admission", parameters: Object.freeze({ required: true }),
    normalizer: "src/admission/operation-context.ts#normalizeDocumentAdmission",
    boundary: "src/durable/project-guard-neutral.ts#resolveServerObservations;src/durable/project-guard-neutral.ts#handleManagedDocument",
    positive_route: "src/index-neutral.ts#/v1/documents;src/control-tower/mcp.ts#project_os_write_working_document;src/durable/project-guard-neutral.ts#/document",
    negative_route: "src/fallback/contract.ts#transaction-only;src/inbox/runtime.ts#typed-transaction-or-artifact;src/index-neutral.ts#scheduled-reconcile;src/durable/project-guard-neutral.ts#request-status;src/mutation-gate/classifier.ts#candidate-resolution",
    positive_test_ref: "test/project-guard-document.spec.ts#rejects-a-head-changed-during-observation-and-re-reads-independent-durable-head-version-evidence",
    negative_test_ref: "test/rule-evaluator.spec.ts#returns-actionable-rule-version-evidence-on-refusal",
    entry_evidence: Object.freeze({
      API: "src/index-neutral.ts#/v1/documents",
      CT: "src/control-tower/mcp.ts#project_os_write_working_document",
      GI: "test/project-guard-document.spec.ts#rejects-a-head-changed-during-observation-and-re-reads-independent-durable-head-version-evidence",
      FB: "src/fallback/contract.ts#transaction-only",
      IN: "src/inbox/runtime.ts#typed-transaction-or-artifact",
      CF: "src/index-neutral.ts#scheduled-reconcile",
      AD: "src/durable/project-guard-neutral.ts#request-status",
      RP: "src/mutation-gate/classifier.ts#candidate-resolution"
    })
  }),
  verified_presence: Object.freeze({
    operations: Object.freeze(["package.replace"]),
    entries: Object.freeze(["API", "CT", "GI"]),
    not_applicable_entries: Object.freeze(["FB", "IN", "CF", "AD", "RP"]),
    resource_types: Object.freeze(["package"]), zones: Object.freeze(["WORKING"]),
    enforcement: "automatic", check_stage: "post_execution", parameters: Object.freeze({}),
    normalizer: "src/admission/operation-context.ts#normalizeDocumentAdmission",
    boundary: "src/documents/package-replacement.ts#DocumentPackageReplacement.resume",
    positive_route: "src/index-neutral.ts#/v1/documents;src/control-tower/mcp.ts#project_os_write_working_document;src/durable/project-guard-neutral.ts#/document",
    negative_route: "src/fallback/contract.ts#transaction-only;src/inbox/runtime.ts#typed-transaction-or-artifact;src/index-neutral.ts#scheduled-reconcile;src/durable/project-guard-neutral.ts#request-status;src/mutation-gate/classifier.ts#candidate-resolution",
    positive_test_ref: "test/document-package-replacement.spec.ts#canonical-exact-deferred-RuleVersion-resolves-to-verified-package-postchecks",
    negative_test_ref: "test/document-package-replacement.spec.ts#canonical-exact-deferred-RuleVersion-denies-when-a-visible-member-vanishes-after-effects",
    entry_evidence: Object.freeze({
      API: "src/index-neutral.ts#/v1/documents",
      CT: "src/control-tower/mcp.ts#project_os_write_working_document",
      GI: "test/document-package-replacement.spec.ts#canonical-exact-deferred-RuleVersion-resolves-to-verified-package-postchecks",
      FB: "src/fallback/contract.ts#transaction-only",
      IN: "src/inbox/runtime.ts#typed-transaction-or-artifact",
      CF: "src/index-neutral.ts#scheduled-reconcile",
      AD: "src/durable/project-guard-neutral.ts#request-status",
      RP: "src/mutation-gate/classifier.ts#candidate-resolution"
    })
  }) })
});
const registrySchema = z.object({ schema_version: z.literal("1.0"), projects: z.array(z.object({ project_id: z.string().regex(/^PRJ-[0-9]{4,}$/), slug: z.string().min(1), status: z.enum(["active", "paused", "completed", "archived"]) })) });

/** Read-only: evidence is resolved from existing canonical objects/commit receipts, then live probes
 * exercise the deployed normalizer/evaluator. No caller-selected proof or new evidence store. */
const productionResolvers = new WeakSet<RuleQualificationEvidenceResolver>();
export function isProductionQualificationResolver(resolver: RuleQualificationEvidenceResolver): boolean { return productionResolvers.has(resolver); }
export function createProductionRuleQualificationResolver(runtime: ProjectOsPersistenceRuntime, env: Env, options: { projectGuardStateReads?: boolean } = {}): RuleQualificationEvidenceResolver {
  const resolver: RuleQualificationEvidenceResolver = { async resolve(request) {
    const { rule, now } = request;
    const fail = (code: string, observed: string): never => { throw new QualificationResolutionFailure(verdict("unavailable", code, rule, "Complete verified production qualification", observed, "Keep accepted_unenforced; restore or supply the exact canonical prerequisite")); };
    const deployment = deploymentIdentity(env);
    if (!deployment.worker_version_id || !deployment.git_sha) return null;
    const invalid = validateCheck(rule);
    if (invalid) throw new QualificationResolutionFailure(invalid);
    const coverage: any = deployedQualificationCoverage.checks[rule.check_id as keyof typeof deployedQualificationCoverage.checks];
    const exactList = (actual: string[], expected: readonly string[]) => actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
    const isArtifactCoverage = rule.check_id === "allowed_destination";
    if (!coverage || rule.operations.some(operation => !coverage.operations.includes(operation))) fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "No deployed coverage for this check or operation");
    if (isArtifactCoverage) {
      if (rule.enforcement !== "automatic" || rule.resource_scope.resource_types.some(type => type !== "artifact") || rule.resource_scope.zones.some(zone => !/^(WORKING|ARTIFACTS|DELIVERABLES|ARCHIVES|RESEARCH|REFERENCES|SPECS|MEETINGS|REVIEW)$/.test(zone))) fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "No deployed coverage for this check, operation, resource, zone or enforcement mode");
    } else if (rule.enforcement !== coverage.enforcement || rule.check_stage !== coverage.check_stage
      || canonicalJson(rule.parameters) !== canonicalJson(coverage.parameters)
      || !exactList(rule.resource_scope.resource_types, coverage.resource_types)
      || !exactList(rule.resource_scope.zones, coverage.zones)
      || ((rule.check_id === "coherent_phase" || rule.check_id === "expected_version" || rule.check_id === "verified_presence") && !exactList(rule.operations, coverage.operations))) {
      fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "No deployed coverage for this exact pre-admission check/resource tuple");
    }
    const observed = new Map<string, ProviderObjectMetadata>();
    const hashes = new Map<string, string>();
    const listings = new Map<string, string>();
    const io = async <T>(operation: string, path: string, run: () => Promise<T>): Promise<T> => {
      try { return await run(); }
      catch (error) {
        const status = error instanceof ProviderOperationError ? error.diagnostics?.status : undefined;
        // Never return arbitrary exception messages, response bodies, headers or credentials.
        const failure = error instanceof Error && error.message.includes("Too many subrequests") ? "subrequest_limit"
          : error instanceof Error && error.message.includes("slice_budget_exhausted") ? "request_budget"
          : error instanceof ProviderOperationError ? "provider" : "unclassified";
        return fail("QUALIFICATION_IO_UNAVAILABLE", `operation=${operation}; path=${path}; failure=${failure}; status=${Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : "unknown"}`);
      }
    };
    const metadata = (path: string, operation = "metadata") => io(operation, path, () => runtime.objects.getMetadata(path));
    const list = async (path: string) => {
      const entries = await io("list", path, () => runtime.objects.listChildren(path));
      const signature = canonicalJson(entries.slice().sort((a, b) => compareCodePoints(a.path ?? a.name, b.path ?? b.name)));
      if (listings.has(path) && listings.get(path) !== signature) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Directory inventory changed during qualification");
      listings.set(path, signature);
      return entries;
    };
    const identity = (metadata: ProviderObjectMetadata | null) => metadata?.objectId && metadata.revisionToken ? canonicalJson([metadata.objectId, metadata.revisionToken, metadata.size]) : null;
    const read = async (path: string, code: string): Promise<string> => {
      const before = await metadata(path);
      if (!identity(before)) fail(code, `Canonical object unavailable: ${path}`);
      const raw = await io("read", path, () => runtime.objects.readText(path));
      const after = await metadata(path);
      if (raw === null || identity(before) !== identity(after)) fail(code, `Canonical object changed: ${path}`);
      observed.set(path, after!);
      hashes.set(path, await sha256Text(raw!));
      return raw!;
    };
    const governance = options.projectGuardStateReads && request.known_global_governance
      ? request.known_global_governance
      : await io("governance_read", globalGovernancePath, () => new RuleGovernanceRepository(runtime).read());
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
    const projectStates: NonNullable<QualificationAudit["project_states"]> = [];
    const stateReferences = new Map<string, string>();
    // Archived projects are terminal: they cannot receive new admissions.
    for (const project of registry.projects.filter(project => project.status !== "archived")) {
      try {
        if (options.projectGuardStateReads) {
          // One fresh serialized observation per project. Later project mutations belong to
          // the activation window; RegistryGuard/source/listing freshness is rechecked below.
          const started = Date.now();
          const response = await io("project_state", `project-guard:${project.project_id}`, () => env.PROJECT_GUARD.getByName(project.project_id).fetch("https://project-guard.internal/mutation-context"));
          if (!response.ok || !env.MUTATION_CONTEXT_SIGNING_KEY) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Fresh ProjectGuard canonical state unavailable");
          const body = z.strictObject({ context: z.unknown(), canonical_state: z.unknown() }).parse(await response.json());
          const state = readProjectState(body.canonical_state).state;
          const context = parseMutationContextOrNull(body.context);
          if (!context || Date.parse(context.observed_at) < started || state.project_id !== project.project_id || state.slug !== project.slug || state.status !== project.status) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "ProjectGuard canonical identity/freshness mismatch");
          await verifyMutationContext(context, state, state.revision, env.MUTATION_CONTEXT_SIGNING_KEY!, Date.now());
          projectStates.push({ project_id: state.project_id, revision: state.revision, state_hash: context!.state_hash, observed_at: context!.observed_at, authority: "ProjectGuard" });
          stateReferences.set(state.project_id, `project-guard:${state.project_id}:revision=${state.revision}:sha256=${context!.state_hash}`);
          states.push(state);
          continue;
        }
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
    if (!isArtifactCoverage) {
      const control = coverage as typeof deployedQualificationCoverage.checks.coherent_phase | typeof deployedQualificationCoverage.checks.exact_approval | typeof deployedQualificationCoverage.checks.expected_version | typeof deployedQualificationCoverage.checks.verified_presence;
      const positive: string[] = [], negative: string[] = [];
      const currentVersionEvidence: string[] = [];
      const controlProbes: ControlProbe[] = [];
      const probeRule: RuleVersion = { ...rule, scope: { kind: "global" }, status: "active" };
      const probeGovernance = { revision: governance!.state.revision, rules: { [ruleVersionKey(probeRule.rule_id, probeRule.version)]: probeRule }, exceptions: {} };
      const probeResult = async (state: ProjectState, operation: string, resources: any[], approvals: unknown[] = [], observations: any[] = []) => {
        const evaluation = await evaluateRules({ actor: { actor_id: "qualification-probe", authority: "server" }, project_id: state.project_id,
          operation, expected_project_revision: state.revision, stage: "pre_admission", now, state: { ...state, local_rules: {} },
          global_governance: probeGovernance, resources, observations, approvals });
        const result = evaluation.results.find(item => item.rule?.rule_id === rule.rule_id && item.rule.version === rule.version);
        if (!result) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Read-only production evaluator did not return the exact candidate check");
        return result!;
      };
      const probeRef = async (state: ProjectState, value: unknown) => `${stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision)}#control-probe=${await sha256Text(canonicalJson({ value, coverage: deployedQualificationCoverage.version }))}`;
      const entryCoverage = control.operations.filter(operation => rule.operations.includes(operation)).map(operation => ({
        operation,
        entries: [...control.entries] as (typeof qualificationEntries)[number][],
        not_applicable_entries: [...control.not_applicable_entries] as (typeof qualificationEntries)[number][],
        evidence_refs: [deployedQualificationCoverage.version, ...control.entries.map(entry => control.entry_evidence[entry as keyof typeof control.entry_evidence]), ...control.not_applicable_entries.map(entry => control.entry_evidence[entry as keyof typeof control.entry_evidence])]
      }));
      if (!entryCoverage.length) fail("QUALIFICATION_COVERAGE_UNAVAILABLE", "No operation-specific control coverage");
      const expectedCaseCodes = new Map<string, { code: string; verdict: "approval_required" | "allow" }>([
        ["missing", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["exact_live", { code: "EXACT_APPROVAL_VERIFIED", verdict: "allow" }],
        ["wrong_actor", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["wrong_project", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["wrong_rule_version", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["wrong_resource_version", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["wrong_operation", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["expired", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }],
        ["revoked", { code: "EXACT_APPROVAL_REQUIRED", verdict: "approval_required" }]
      ]);
      const documents = new Map<string, Array<{ document_id: string; logical_path: string; working?: string; review?: string }>>();
      if (rule.check_id === "exact_approval" || rule.check_id === "expected_version") {
        const ledger = new DocumentLedgerRepository(runtime);
        for (const state of applicable) {
          const headsPath = `${machineDocumentRoot(state.project_id)}/heads`;
          const headEntries = await list(headsPath);
          if (headEntries.length > 256) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Managed document head inventory exceeds the synchronous qualification bound");
          const heads: Array<{ document_id: string; logical_path: string; working?: string; review?: string }> = [];
          const headIds = await ledger.listHeadIds(state.project_id);
          const listedIds = headEntries.filter(entry => entry.kind === "file").map(entry => /^((?:DOC-)[A-F0-9]{24})\.json$/.exec(entry.name)?.[1] ?? null).filter((id): id is string => id !== null).sort();
          if (canonicalJson(headIds) !== canonicalJson(listedIds)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Managed document head inventory changed during qualification");
          for (const documentId of headIds) {
            const headPath = machineDocumentHeadPath(state.project_id, documentId);
            const rawHead = await read(headPath, "QUALIFICATION_INVENTORY_UNAVAILABLE");
            const head = parseManagedDocumentHead(JSON.parse(rawHead));
            if (head.project_id !== state.project_id || head.document_id !== documentId || head.kind !== "work_product") fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Managed document head identity is malformed");
            if (await documentIdFor(state.project_id, head.logical_path) !== documentId) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Managed document head path does not bind its document identity");
            const bound: { document_id: string; logical_path: string; working?: string; review?: string } = { document_id: documentId, logical_path: head.logical_path };
            for (const versionId of [head.working_version_id, head.review_version_id, head.published_version_id].filter((id): id is string => Boolean(id))) {
              const versionPath = machineDocumentVersionPath(state.project_id, documentId, versionId);
              const record = parseDocumentVersionRecord(JSON.parse(await read(versionPath, "QUALIFICATION_INVENTORY_UNAVAILABLE")));
              if (record.project_id !== state.project_id || record.document_id !== documentId || record.version_id !== versionId || record.kind !== "work_product") fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Managed document version identity is malformed");
              if (!identity(await metadata(record.immutable_payload_path))) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Immutable managed document payload is unavailable");
              if (versionId === head.working_version_id) bound.working = versionId;
              if (versionId === head.review_version_id) bound.review = versionId;
            }
            heads.push(bound);
          }
          documents.set(state.project_id, heads);
        }
      }
      const positiveRouteRefs = applicable.flatMap(state => [control.positive_test_ref, ...control.entries.map(entry => `${stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision)}#entry=${entry}:${control.entry_evidence[entry as keyof typeof control.entry_evidence]}`)]);
      const nonApplicableRouteRefs = applicable.flatMap(state => control.not_applicable_entries.map(entry => `${stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision)}#entry=${entry}:${control.entry_evidence[entry as keyof typeof control.entry_evidence]}`));
      const negativeRouteRefs = applicable.map(() => control.negative_test_ref);

      for (const state of applicable) {
        const stateRef = stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision);
        if (rule.check_id === "verified_presence") {
          for (const entry of control.entries) {
            positive.push(`${control.positive_test_ref}#entry=${entry}`);
            negative.push(`${control.negative_test_ref}#entry=${entry}`);
          }
        } else if (rule.check_id === "coherent_phase") {
          if (!state.last_event_id) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical phase state has no event provenance");
          const taskDigest = await sha256Text(canonicalJson(Object.values(state.tasks).map(task => ({ task_id: task.task_id, phase_id: task.phase_id, status: task.status })).sort((a, b) => compareCodePoints(a.task_id, b.task_id))));
          const realPhase = state.current_phase_id && state.plan_phases[state.current_phase_id] ? state.current_phase_id : `PHASE-${(await sha256Text(state.project_id)).slice(0, 24).toUpperCase()}`;
          const positiveState = structuredClone(state);
          positiveState.current_phase_id = realPhase;
          positiveState.last_event_id ??= `EVT-QUALIFICATION-${state.revision}`;
          for (const [id, phase] of Object.entries(positiveState.plan_phases)) positiveState.plan_phases[id] = { ...phase, status: id === realPhase ? "active" : phase.status === "active" ? "pending" : phase.status };
          positiveState.plan_phases[realPhase] = positiveState.plan_phases[realPhase] ?? { phase_id: realPhase, title: "Qualification vector", next_actions: [], status: "active", created_at: now, updated_at: now };
          positiveState.plan_phases[realPhase] = { ...positiveState.plan_phases[realPhase], status: "active" };
          positiveState.tasks = Object.fromEntries(Object.entries(positiveState.tasks).map(([id, task]) => [id, task.phase_id === realPhase ? { ...task, status: "completed" } : task]));
          const negativePhase = `PHASE-${(await sha256Text(`${state.project_id}:missing`)).slice(0, 24).toUpperCase()}`;
          for (const entry of control.entries) for (const positiveCase of [true, false]) {
            const phaseId = positiveCase ? realPhase : negativePhase;
            const normalized = await normalizeTransactionAdmission({ transaction_id: `TXN-QUALIFICATION-${positiveCase ? "ALLOW" : "DENY"}-${entry}-${state.project_id.slice(-4)}`,
              project_id: state.project_id, base_revision: state.revision, operation: "plan.phase.complete", payload: { phase_id: phaseId }, created_at: now } as any);
            const outcome = await probeResult(positiveCase ? positiveState : structuredClone(state), "plan.phase.complete", normalized.resources);
            if (positiveCase && (outcome.verdict !== "allow" || outcome.code !== "PHASE_COMPLETION_ALLOWED")) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Shared phase evaluator failed its positive ephemeral vector");
            if (!positiveCase && (outcome.verdict !== "deny" || outcome.code !== "PHASE_NOT_FOUND")) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Shared phase evaluator failed its negative ephemeral vector");
            const vectorHash = await sha256Text(canonicalJson({ project: state.project_id, revision: state.revision, phase: phaseId, positiveCase, taskDigest }));
            const ref = `${stateRef}#control-probe=${vectorHash}`;
            (positiveCase ? positive : negative).push(ref);
            controlProbes.push({ check_id: "coherent_phase", rule_id: rule.rule_id, rule_version: rule.version, project_id: state.project_id,
              project_revision: state.revision, operation: "plan.phase.complete", entry: entry as typeof qualificationEntries[number], resource_id: normalized.resources[0].resource_id, resource_type: "plan", zone: "PROJECT",
              resource_version: String(state.revision), stage: "pre_admission", verdict: outcome.verdict as "allow" | "deny", code: outcome.code, evidence_ref: ref,
              phase_id: phaseId, phase_status: positiveCase ? "active" : null,
              current_phase_id: positiveCase ? realPhase : state.current_phase_id, attached_task_count: positiveCase ? Object.values(positiveState.tasks).filter(task => task.phase_id === realPhase).length : 0,
              attached_task_statuses_sha256: taskDigest, probe_source: "ephemeral_evaluator_vector" });
          }
        } else if (rule.check_id === "exact_approval") {
          for (const operation of rule.operations) {
            const op = operation as "document.publish" | "review.promote";
            const versionField = op === "document.publish" ? "review" : "working";
            const actual = (documents.get(state.project_id) ?? []).find(head => head[versionField]);
            const documentId = actual?.document_id ?? `DOC-${(await sha256Text(`${state.project_id}:${op}:ephemeral`)).slice(0, 24).toUpperCase()}`;
            const resourceVersion = actual?.[versionField] ?? `VER-REQ-${(await sha256Text(`${state.project_id}:${op}:ephemeral-version`)).slice(0, 24).toUpperCase()}`;
            const request = parseManagedDocumentRequest({ operation: op === "document.publish" ? "publish" : "review.promote",
              request_id: `DOCREQ-QUALIFICATION-${op === "document.publish" ? "PUBLISH" : "PROMOTE"}01`, project_id: state.project_id,
              document_id: documentId, expected_version_id: resourceVersion, created_at: now });
            const normalized = await normalizeDocumentAdmission(request, { canonical_resource_version: resourceVersion });
            for (const entry of control.entries) for (const [probeCase, expected] of expectedCaseCodes) {
              const actorId = "qualification-probe";
              const baseApproval = {
                approval_id: "APR-QUALIFICATION01", project_id: state.project_id, actor_id: actorId, approved_by: "control_tower",
                rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope, resource_id: normalized.resources[0].resource_id,
                resource_type: normalized.resources[0].resource_type, resource_zone: normalized.resources[0].zone, resource_version: normalized.resources[0].version,
                operation: op, status: "approved" as const, granted_at: new Date(Date.parse(now) - 1_000).toISOString(), expires_at: new Date(Date.parse(now) + 60_000).toISOString(),
                evidence_refs: [`canonical:qualification-vector/${rule.rule_id}@${rule.version}`], grant_transaction_id: "TXN-QUALIFICATION-GRANT01"
              };
              const record = probeCase === "missing" ? undefined : approvalRecordSchema.parse({ ...baseApproval,
                ...(probeCase === "wrong_actor" ? { actor_id: "some-other-actor" } : {}),
                ...(probeCase === "wrong_project" ? { project_id: "PRJ-9999" } : {}),
                ...(probeCase === "wrong_rule_version" ? { rule_version: rule.version + 1 } : {}),
                ...(probeCase === "wrong_resource_version" ? { resource_version: `${normalized.resources[0].version}-stale` } : {}),
                ...(probeCase === "wrong_operation" ? { operation: op === "document.publish" ? "review.promote" : "document.publish" } : {}),
                ...(probeCase === "expired" ? { granted_at: new Date(Date.parse(now) - 120_000).toISOString(), expires_at: new Date(Date.parse(now) - 60_000).toISOString() } : {}),
                ...(probeCase === "revoked" ? { status: "revoked", revoked_at: now, revoked_by: "control_tower", revocation_reason: "qualification vector", revoke_transaction_id: "TXN-QUALIFICATION-REVOKE01" } : {})
              });
              const outcome = await probeResult(state, op, normalized.resources, record ? [record] : []);
              if (outcome.verdict !== expected.verdict || outcome.code !== expected.code) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", `Shared exact-approval evaluator failed the ${probeCase} vector`);
              const valueHash = record ? await sha256Text(canonicalJson(record)) : undefined;
              const ref = `${stateRef}#control-probe=${await sha256Text(canonicalJson({ operation: op, entry, probeCase, resources: normalized.resources, valueHash }))}`;
              (probeCase === "exact_live" ? positive : negative).push(ref);
              controlProbes.push({ check_id: "exact_approval", rule_id: rule.rule_id, rule_version: rule.version, project_id: state.project_id,
                project_revision: state.revision, operation: op, entry: entry as typeof qualificationEntries[number], resource_id: normalized.resources[0].resource_id, resource_type: normalized.resources[0].resource_type,
                zone: normalized.resources[0].zone, resource_version: normalized.resources[0].version, stage: "pre_admission", verdict: outcome.verdict as "allow" | "approval_required",
                code: outcome.code, evidence_ref: ref, actor_id: actorId, probe_case: probeCase as Extract<ControlProbe, { check_id: "exact_approval" }>['probe_case'], ...(valueHash ? { approval_record_sha256: valueHash } : {}),
                probe_source: "ephemeral_evaluator_vector" } as ControlProbe);
            }
          }
        } else {
          const operation = "working.write";
          const actual = (documents.get(state.project_id) ?? []).find(head => head.working);
          const canonicalWorking = actual?.working
            ? { document_id: actual.document_id, logical_path: actual.logical_path, version: actual.working }
            : fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "No canonical working head is available for the deployed current-version reader");
          const expectedVersion = canonicalWorking.version;
          currentVersionEvidence.push(machineDocumentVersionPath(state.project_id, canonicalWorking.document_id, expectedVersion));
          const staleVersion = `VER-REQ-${(await sha256Text(`${state.project_id}:${expectedVersion}:stale`)).slice(0, 24).toUpperCase()}`;
          const content = "# Expected-version qualification vector\n";
          for (const entry of control.entries) for (const [probeCase, submittedVersion, expected] of [
            ["exact", expectedVersion, { verdict: "allow", code: "EXPECTED_VERSION_MATCH" }],
            ["stale", staleVersion, { verdict: "deny", code: "STALE_DOCUMENT_VERSION" }]
          ] as const) {
            const request = parseManagedDocumentRequest({ operation, request_id: `DOCREQ-QUALIFICATION-${probeCase.toUpperCase()}01`,
              project_id: state.project_id, logical_path: canonicalWorking.logical_path, content,
              content_sha256: await sha256Text(content), expected_version_id: submittedVersion, created_at: now });
            const normalized = await normalizeDocumentAdmission(request);
            const observation = { project_id: state.project_id, resource_id: normalized.resources[0].resource_id,
              resource_version: normalized.resources[0].version, observed_at: new Date(Date.parse(now) - 1_000).toISOString(),
              expires_at: new Date(Date.parse(now) + 60_000).toISOString(),
              evidence_refs: [machineDocumentHeadPath(state.project_id, canonicalWorking.document_id), machineDocumentVersionPath(state.project_id, canonicalWorking.document_id, expectedVersion)],
              current_version: expectedVersion };
            const outcome = await probeResult(state, operation, normalized.resources, [], [observation]);
            if (outcome.verdict !== expected.verdict || outcome.code !== expected.code) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", `Shared expected-version evaluator failed the ${probeCase} vector`);
            const ref = await probeRef(state, { operation, entry, probeCase, resources: normalized.resources, observation });
            (probeCase === "exact" ? positive : negative).push(ref);
          }
        }
      }
      if (!positive.length || !negative.length) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Read-only control evaluator probes lack positive or negative outcomes");
      for (const [path, priorMetadata] of observed) if (identity(await metadata(path, "metadata_revalidation")) !== identity(priorMetadata)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical evidence changed before qualification completed");
      for (const path of listings.keys()) await list(path);
      const current = await io("governance_revalidation", globalGovernancePath, () => new RuleGovernanceRepository(runtime).read());
      if (current?.token !== governance!.token) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Global governance changed during qualification");
      const snapshot = await sha256Text(canonicalJson({ observed: [...observed], listings: [...listings], active_rules, project_states: projectStates }));
      const build = `deployment:${deployment.worker_version_id}:${deployment.git_sha}:${deployedQualificationCoverage.version}`;
      const stateEvidence = applicable.map(state => stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision));
      const evidence: QualificationEvidence = {
        rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope, evidence_refs: request.requested_evidence_refs,
        accepted_source_refs: rule.source_refs, deployed_check_id: rule.check_id, deployment_ref: build,
        check_evidence: rule.check_id === "verified_presence"
          ? {
              expected_object_version: { status: "verified", evidence_ref: "src/execution/effects.ts#inspectStepObservation", verification_ref: control.positive_test_ref },
              verified_provider_metadata: { status: "verified", evidence_ref: "src/documents/package-replacement.ts#DocumentPackageReplacement.observe", verification_ref: control.negative_test_ref }
            }
          : Object.fromEntries(checkCatalogue[rule.check_id].required_evidence.map((key, index) => [key, { status: "verified",
            evidence_ref: key === "current_version" && currentVersionEvidence[0] ? currentVersionEvidence[0] : stateEvidence[0] ?? `${machineRegistryJsonPath()}#inventory=${snapshot}`,
            verification_ref: index === 0 ? positive[0] : negative[0] }])),
        entry_coverage: entryCoverage.map(row => ({ ...row, evidence_refs: [...row.evidence_refs, ...positiveRouteRefs, ...nonApplicableRouteRefs, ...negativeRouteRefs] })),
        positive_test_refs: [...new Set([...positiveRouteRefs, ...positive])], negative_test_refs: [...new Set([...negativeRouteRefs, ...negative])],
        ...(rule.check_id === "verified_presence" ? { server_control: {
          check_id: "verified_presence" as const, operation: "package.replace" as const, resource_type: "package" as const, zone: "WORKING" as const,
          enforcement: "automatic" as const, stage: "post_execution" as const,
          adapter_ref: "src/documents/package-replacement.ts#DocumentPackageReplacement.resume" as const,
          deployment_ref: build, allow_probe_ref: control.positive_test_ref, deny_probe_ref: control.negative_test_ref
        } } : {}),
        contradiction_scan_ref: `${globalGovernancePath}#inventory=${snapshot}`, historical_drift_ref: `${machineRegistryJsonPath()}#inventory=${snapshot}`,
        qualified_at: now, expires_at: new Date(Date.parse(now) + 60_000).toISOString()
      };
      const audit: QualificationAudit = {
        catalogue_version: deployedQualificationCoverage.version, catalogue_sha256: await sha256Text(canonicalJson(deployedQualificationCoverage)),
        objects: [...observed].map(([path, metadata]) => ({ path, object_id: metadata.objectId!, revision_token: metadata.revisionToken!, size: metadata.size, ...(hashes.has(path) ? { content_sha256: hashes.get(path)! } : {}) })),
        directories: await Promise.all([...listings].map(async ([path, signature]) => ({ path, listing_sha256: await sha256Text(signature) }))),
        ...(projectStates.length ? { project_states: projectStates } : {}), control_probes: controlProbes, active_rules_sha256: await sha256Text(canonicalJson(active_rules))
      };
      return { evidence, active_rules, audit };
    }
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
          // allowed_destination checks membership/path, not file content or version.
          // These recursive listings are signed and revalidated below; canonical proof objects
          // remain separately identity-bound. Avoid two redundant metadata calls per member.
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
          const ref = `${stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision)}#probe=${await sha256Text(canonicalJson({ intent, rule, result, coverage: deployedQualificationCoverage.version }))}`;
          if (exact?.code === "DESTINATION_ALLOWED") positive.push(ref);
          if (exact?.code === "DESTINATION_FORBIDDEN") negative.push(ref);
          if (exact && (exact.verdict === "allow" || exact.verdict === "deny")) probes.push({ project_id: state.project_id, relative_path, ...(intent.operation ? { artifact_operation: intent.operation } : {}), code: exact.code, verdict: exact.verdict, evidence_ref: ref });
        } catch (error) {
          if (error instanceof QualificationResolutionFailure) throw error;
          // This explicit candidate intent stays in REVIEW. Only the canonical destination
          // boundary's exact refusal counts; unavailable/network/arbitrary errors never do.
          if (intent === reviewNegative && error instanceof AdmissionError && error.code === "ARTIFACT_DESTINATION_FORBIDDEN") {
            const result = { verdict: "deny" as const, code: error.code };
            const ref = `${stateReferences.get(state.project_id) ?? machineCommitRecordPath(state.project_id, state.revision)}#probe=${await sha256Text(canonicalJson({ intent, rule, result, coverage: deployedQualificationCoverage.version }))}`;
            negative.push(ref);
            probes.push({ project_id: state.project_id, relative_path, artifact_operation: "REVIEW_CANDIDATE", ...result, evidence_ref: ref });
          } else if (intent === reviewNegative) {
            fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Review negative-control boundary was unavailable rather than a verified destination refusal");
          }
        }
      }
    }
    if (!positive.length || !negative.length) fail("QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE", "Live deployed-rule probes did not establish both positive and negative outcomes");
    for (const [path, priorMetadata] of observed) if (identity(await metadata(path, "metadata_revalidation")) !== identity(priorMetadata)) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Canonical evidence changed before qualification completed");
    for (const path of listings.keys()) await list(path);
    const current = await io("governance_revalidation", globalGovernancePath, () => new RuleGovernanceRepository(runtime).read());
    if (current?.token !== governance!.token) fail("QUALIFICATION_INVENTORY_UNAVAILABLE", "Global governance changed during qualification");
    const snapshot = await sha256Text(canonicalJson({ observed: [...observed], listings: [...listings], active_rules, ...(projectStates.length ? { project_states: projectStates } : {}) }));
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
      ...(projectStates.length ? { project_states: projectStates } : {}),
      probes, active_rules_sha256: await sha256Text(canonicalJson(active_rules))
    };
    return { evidence, active_rules, audit };
  } };
  Object.freeze(resolver);
  productionResolvers.add(resolver);
  return resolver;
}
