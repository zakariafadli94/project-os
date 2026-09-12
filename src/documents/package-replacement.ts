import type { ProjectState } from "../domain/project-state";
import { packageNavigationPath, packageNavigationSchema, packageNavigationLedgerSchema, packageResourceVersion, type PackageNavigation, type PackageNavigationHead, type PackageRef, type PackageZone } from "../domain/document-package";
import { ExecutionJournal, executionHash, requiredRulePostchecks } from "../execution/journal";
import { ExecutionCoordinator } from "../execution/coordinator";
import type { EffectAddress, ExecutionAdmission, ExecutionAdapter, ExecutionPlan, ExecutionStep, ExpectedObject, ExpectedSource, ObservedObject, StepObservation } from "../execution/contract";
import { inspectStepObservation } from "../execution/effects";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { machineDocumentTextPayloadPath, workspaceProjectRoot } from "../persistence/layout";
import { ProviderConflictError } from "../persistence/provider/errors";
import { canonicalJson } from "../rules/contract";
import { ruleReference } from "../rules/contract";
import { matchesResource } from "../rules/resolution";
import { validateCheck } from "../rules/check-catalogue";
import type { RuleVersion } from "../domain/rule-governance";
import { DocumentLedgerRepository } from "./repository";
import { sha256Text } from "./hash";
import { renderState } from "../render/state";
import { renderHandoff } from "../render/handoff";
import { renderPackageIndex, renderPackageNavigationLinks } from "../render/package-navigation";

export interface PackageReplaceRequest { operation: "package.replace"; request_id: string; project_id: string; candidate: PackageRef; zone: PackageZone; expected_navigation_generation: number; expected_project_revision: number; created_at: string }
export interface PackageExecutionOptions { effectBudget?: number; /** Server-resolved canonical rules, never public payload. */ postcheckRules?: readonly RuleVersion[] }
export class DocumentPackageReplacement {
  private readonly repository: DocumentLedgerRepository;
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) { this.repository = new DocumentLedgerRepository(runtime); }

  async resume(request: PackageReplaceRequest, state: ProjectState, admission: ExecutionAdmission, options: PackageExecutionOptions = {}) {
    const candidate = request.candidate, version = packageResourceVersion(candidate);
    if (request.project_id !== state.project_id || candidate.project_id !== state.project_id || request.expected_project_revision !== state.revision || admission.project_revision !== state.revision || admission.project_id !== state.project_id || admission.request_id !== request.request_id || admission.operation !== "package.replace" || admission.request_hash !== await executionHash(request) || admission.verdict !== "allow" || !admission.resources.some((r) => r.resource_id === candidate.package_id && r.version === version && r.zone === request.zone)) throw new Error("package_admission_binding");
    if (request.zone !== "WORKING" && !admission.results.some((r) => r.verdict === "allow" && r.code === "EXACT_APPROVAL_VERIFIED" && r.resource_id === candidate.package_id && r.approval_id && r.evidence_refs?.length)) throw new Error("package_exact_approval_required");
    const manifest = await this.repository.readPackage(candidate);
    const base = workspaceProjectRoot(state.project_id, state.slug);
    const root = `${request.zone}/PACKAGES/${candidate.package_id}/${candidate.version}`;
    const address = (relative: string): EffectAddress => ({ path: `${base}/${relative}`, logical_path: relative });
    const commitJournal = new ExecutionJournal(this.runtime, state.project_id, "document", request.request_id);
    const existingCommit = await commitJournal.readAdmission();
    const prepareJournal = new ExecutionJournal(this.runtime, state.project_id, "document-package-prepare", request.request_id);
    let prepared = await prepareJournal.readAdmission();
    let budget = options.effectBudget ?? Number.MAX_SAFE_INTEGER;
    const budgetPort = { available: () => budget > 0, consume: () => { budget--; } };
    const navPath = packageNavigationPath(state.project_id);
    let navigation: PackageNavigation = {};
    let nextHead: PackageNavigationHead;
    if (!prepared) {
      navigation = await this.repository.readPackageNavigation(state.project_id);
      const current = navigation[request.zone];
      if ((current?.generation ?? 0) !== request.expected_navigation_generation) throw new Error("package_navigation_conflict");
      const currentIndex = await this.runtime.objects.readText(`${base}/${request.zone}/CURRENT.md`);
      if (!current && currentIndex !== null) throw new Error("package_destination_collision");
      if (current && currentIndex !== renderPackageIndex(current)) throw new Error("package_navigation_conflict");
      if (await this.runtime.objects.getMetadata(`${base}/${root}/INDEX.md`)) throw new Error("package_destination_collision");
      const predecessor = current?.packages.find((p) => p.ref.package_id === candidate.package_id);
      if (predecessor && (!manifest.predecessor || canonicalJson(manifest.predecessor) !== canonicalJson(predecessor.ref))) throw new Error("package_predecessor_conflict");
      const steps: ExecutionStep[] = [];
      for (const member of manifest.members) {
        const source = await this.source({ path: member.immutable_payload_path, logical_path: member.immutable_payload_path.split(`/projects/${state.project_id}/`)[1] });
        if (source.expected.content_sha256 !== member.content_sha256) throw new Error("package_member_payload_conflict");
        steps.push(this.copyStep(`prepare:${member.relative_path}`, candidate, source, address(`${root}/${member.relative_path}`)));
      }
      if (predecessor) {
        const old = await this.repository.readPackage(predecessor.ref);
        for (const member of old.members) {
          const source = await this.source(address(`${predecessor.root}/${member.relative_path}`));
          if (source.expected.content_sha256 !== member.content_sha256) throw new Error("package_predecessor_changed");
          steps.push(this.copyStep(`archive:${member.relative_path}`, candidate, source, address(`ARCHIVES/PACKAGES/${candidate.package_id}/${predecessor.ref.version}/${request.zone}/${member.relative_path}`)));
        }
        const previousIndex = await this.source(address(`${predecessor.root}/INDEX.md`));
        steps.push(this.copyStep("archive:INDEX.md", candidate, previousIndex, address(`ARCHIVES/PACKAGES/${candidate.package_id}/${predecessor.ref.version}/${request.zone}/INDEX.md`)));
      }
      for (const step of steps) if (step.action.kind === "copy_if_unchanged" && await this.runtime.objects.getMetadata(step.action.destination.path)) throw new Error("package_destination_collision");
      nextHead = { schema_version: "1.0", project_id: state.project_id, zone: request.zone, generation: request.expected_navigation_generation + 1, source_request_id: request.request_id, packages: [...(current?.packages.filter((p) => p.ref.package_id !== candidate.package_id) ?? []), { ref: candidate, root }].sort((a, b) => a.ref.package_id < b.ref.package_id ? -1 : a.ref.package_id > b.ref.package_id ? 1 : 0) };
      // The next canonical head and projection inputs are frozen before any copy.
      const intent = { request, next_head: nextHead, navigation: { ...navigation, [request.zone]: nextHead }, previous_navigation: current ?? null, previous_all_navigation: navigation };
      await this.immutable(`${await prepareJournal.root()}/package-intent.json`, intent);
      const plan: ExecutionPlan = { target_revision: state.revision, steps, postchecks: [`package_copies_verified:${await executionHash(intent)}`] };
      await prepareJournal.commit(this.scopedAdmission({ ...admission, kind: "document-package-prepare", deferred_rules: [] }, plan), plan);
      prepared = await prepareJournal.readAdmission();
    }
    const intentRaw = await this.runtime.objects.readText(`${await prepareJournal.root()}/package-intent.json`);
    if (!intentRaw) throw new Error("package_intent_unavailable");
    const intent = JSON.parse(intentRaw);
    if (canonicalJson(intent.request) !== canonicalJson(request) || !prepared!.plan!.postchecks.includes(`package_copies_verified:${await executionHash(intent)}`)) throw new Error("package_intent_conflict");
    nextHead = packageNavigationSchema.parse(intent.next_head);
    navigation = intent.navigation;
    if (!existingCommit) {
      const preparedProgress = await new ExecutionCoordinator(prepareJournal).resume(prepared!.plan!, this.adapter(prepareJournal, prepared!.admission, budgetPort, async () => ({ verdict: "allow", evidence_refs: [`${await prepareJournal.root()}/admission.json`] })));
      if (preparedProgress.status !== "finalized") return preparedProgress;
      // Copy completion is a canonical prerequisite, not an opaque reference.
      await this.repository.readPackageExecutionEvidence(state.project_id, "document-package-prepare", request.request_id);
      if (!budgetPort.available()) return { ...preparedProgress, status: "finalizing" as const, terminal: false, code: "PACKAGE_EFFECT_BUDGET", phase: "prepare" };
      if (canonicalJson(await this.repository.readPackageNavigation(state.project_id)) !== canonicalJson(intent.previous_all_navigation)) throw new Error("package_navigation_conflict");
      const previousLedgerRaw = await this.runtime.objects.readText(navPath);
      const previousMembers = previousLedgerRaw ? packageNavigationLedgerSchema.parse(JSON.parse(previousLedgerRaw)).visible_members : [];
      const visibleMembers = [];
      for (const head of Object.values(navigation)) for (const entry of head!.packages) {
        const frozen = await this.repository.readPackage(entry.ref);
        for (const member of frozen.members) {
          const path = `${base}/${entry.root}/${member.relative_path}`;
          if (entry.root !== root) {
            const prior = previousMembers?.find(m => m.path === path);
            if (!prior) throw new Error("package_navigation_visible_unavailable");
            visibleMembers.push(prior); continue;
          }
          const step = prepared!.plan!.steps.find(s => s.action.kind === "copy_if_unchanged" && s.action.destination.path === path);
          if (step?.action.kind !== "copy_if_unchanged") throw new Error("package_copy_source_unproven");
          const raw = await this.runtime.objects.readText(`${await prepareJournal.root()}/effects/${await executionHash(step)}.json`);
          const receipt = raw ? JSON.parse(raw) : null;
          if (!receipt || receipt.step_hash !== await executionHash(step) || receipt.source_identity !== canonicalJson(step.action.source.expected)) throw new Error("package_copy_source_unproven");
          const observed = JSON.parse(receipt.destination_identity);
          if (observed.path !== path || observed.state !== "present" || observed.identity.content_sha256 !== member.content_sha256) throw new Error("package_copy_source_unproven");
          visibleMembers.push({ path, provider_id: this.runtime.providerId, ...observed.identity });
        }
      }
      const ledger = packageNavigationLedgerSchema.parse({ schema_version: "1.0", project_id: state.project_id, source_request_id: request.request_id, heads: navigation, visible_members: visibleMembers });
      const steps: ExecutionStep[] = [];
      for (const step of prepared!.plan!.steps.filter((s) => s.step_id.startsWith("archive:"))) {
        if (step.action.kind !== "copy_if_unchanged") throw new Error("package_archive_plan_conflict");
        const preserved = await this.source(step.action.destination);
        steps.push({ ...step, step_id: `remove:${step.step_id}`, action: { kind: "delete_if_unchanged", source: step.action.source, verified_copy: preserved } });
      }
      const index = `# ${candidate.package_id} v${candidate.version}\n\n${manifest.members.map((m) => `- [[${root}/${m.relative_path}]]`).join("\n")}\n`;
      const contents: [EffectAddress, string][] = [
        [address(`${root}/INDEX.md`), index],
        [address(`${request.zone}/CURRENT.md`), renderPackageIndex(nextHead)],
        [{ path: navPath, logical_path: "documents/packages/navigation.json" }, canonicalJson(ledger)],
        [address("STATE.md"), renderState(state) + renderPackageNavigationLinks(navigation)],
        [address("HANDOFF.md"), renderHandoff(state) + renderPackageNavigationLinks(navigation)]
      ];
      for (const [destination, content] of contents) {
        const hash = await sha256Text(content);
        await this.repository.storeTextPayload(state.project_id, hash, content);
        const prior = await this.observe(destination);
        steps.push({ step_id: `write:${destination.logical_path}`, resource_id: candidate.package_id, expected_version: version, provider_id: this.runtime.providerId, action: { kind: "write_if_unchanged", destination, expected_destination: prior.state === "absent" ? { state: "absent" } : { state: "present", identity: prior.identity }, desired: { content_sha256: hash, content_ref: `sha256:${hash}` } } });
      }
      const plan: ExecutionPlan = { target_revision: state.revision, steps, postchecks: ["package_presence_links_navigation", ...requiredRulePostchecks(admission)] };
      await this.immutable(`${await commitJournal.root()}/prepare-proof.json`, { prepare_admission: `${await prepareJournal.root()}/admission.json`, prepare_finalization: preparedProgress.finalization_ref, effect_plan_hash: preparedProgress.effect_plan_hash });
      await commitJournal.commit(this.scopedAdmission(admission, plan), plan);
    }
    const committed = (await commitJournal.readAdmission())!;
    return new ExecutionCoordinator(commitJournal).resume(committed.plan!, this.adapter(commitJournal, committed.admission, budgetPort, async (checkId) => {
      if (checkId !== "package_presence_links_navigation") {
        const rule = options.postcheckRules?.find((r) => checkId === `rule:${canonicalJson(ruleReference(r))}`);
        if (!rule || rule.status !== "active" || validateCheck(rule) || (rule.scope.kind === "project" && rule.scope.project_id !== state.project_id) || !rule.operations.includes("package.replace") || !admission.resources.some((r) => matchesResource(rule, r)) || !["verified_presence", "valid_links", "current_uniqueness", "verified_archive"].includes(rule.check_id)) return { verdict: "unavailable", evidence_refs: [] };
      }
      const evidence: string[] = [];
      for (const head of Object.values(navigation)) {
        const current = await this.observe(address(`${head!.zone}/CURRENT.md`));
        if (current.state !== "present" || current.identity.content_sha256 !== await sha256Text(renderPackageIndex(head!))) return { verdict: "deny", evidence_refs: [] };
        evidence.push(await this.prove(commitJournal, current));
      }
      for (const head of Object.values(navigation)) for (const entry of head!.packages) {
        const frozen = await this.repository.readPackage(entry.ref);
        for (const member of frozen.members) {
          const present = await this.observe(address(`${entry.root}/${member.relative_path}`));
          if (present.state !== "present" || present.identity.content_sha256 !== member.content_sha256) return { verdict: "deny", evidence_refs: [] };
          evidence.push(await this.prove(commitJournal, present));
        }
        const index = await this.runtime.objects.getMetadata(`${base}/${entry.root}/INDEX.md`);
        if (!index) return { verdict: "deny", evidence_refs: [] };
      }
      for (const step of prepared!.plan!.steps.filter((s) => s.step_id.startsWith("archive:"))) {
        if (step.action.kind !== "copy_if_unchanged") return { verdict: "deny", evidence_refs: [] };
        const archived = await this.observe(step.action.destination);
        if (archived.state !== "present" || archived.identity.content_sha256 !== step.action.desired.content_sha256) return { verdict: "deny", evidence_refs: [] };
        evidence.push(await this.prove(commitJournal, archived));
      }
      for (const step of committed.plan!.steps) if (step.action.kind === "write_if_unchanged") {
        const written = await this.observe(step.action.destination);
        if (written.state !== "present" || written.identity.content_sha256 !== step.action.desired.content_sha256) return { verdict: "deny", evidence_refs: [] };
        evidence.push(await this.prove(commitJournal, written));
      }
      const visibleLedgerRaw = await this.runtime.objects.readText(navPath);
      if (!visibleLedgerRaw) return { verdict: "deny", evidence_refs: [] };
      const visibleLedger = packageNavigationLedgerSchema.parse(JSON.parse(visibleLedgerRaw));
      if (!visibleLedger.visible_members) return { verdict: "unavailable", evidence_refs: [] };
      for (const expected of visibleLedger.visible_members) {
        const observed = await this.runtime.objects.getMetadata(expected.path);
        if (expected.provider_id !== this.runtime.providerId || observed?.objectId !== expected.object_id || observed.revisionToken !== expected.revision_token) return { verdict: "deny", evidence_refs: [] };
        evidence.push(await this.prove(commitJournal, { path: expected.path, object_id: observed.objectId, revision_token: observed.revisionToken }));
      }
      return { verdict: "allow", evidence_refs: evidence };
    }));
  }

  private copyStep(step_id: string, ref: PackageRef, source: ExpectedSource, destination: EffectAddress): ExecutionStep {
    return { step_id, resource_id: ref.package_id, expected_version: packageResourceVersion(ref), provider_id: this.runtime.providerId, action: { kind: "copy_if_unchanged", source, destination, expected_destination: { state: "absent" }, desired: { content_sha256: source.expected.content_sha256 } } };
  }
  private scopedAdmission(admission: ExecutionAdmission, plan: ExecutionPlan): ExecutionAdmission {
    const resource = admission.resources.find((r) => r.resource_type === "package")!;
    const scope = { resource_id: resource.resource_id, resource_version: resource.version, provider_id: this.runtime.providerId, sources: [] as EffectAddress[], destinations: [] as EffectAddress[], preservation_copies: [] as EffectAddress[] };
    // Only this server builder derives addresses from verified manifests/current heads.
    for (const { action } of plan.steps) { if ("source" in action) scope.sources.push({ path: action.source.path, logical_path: action.source.logical_path }); if ("destination" in action) scope.destinations.push(action.destination); if (action.kind === "delete_if_unchanged") scope.preservation_copies.push({ path: action.verified_copy.path, logical_path: action.verified_copy.logical_path }); }
    return { ...admission, resource_effect_scopes: [scope] };
  }
  private async observe(location: EffectAddress): Promise<ObservedObject> {
    location = { path: location.path, logical_path: location.logical_path };
    const metadata = await this.runtime.objects.getMetadata(location.path);
    if (!metadata) return { ...location, state: "absent" };
    if (!metadata.objectId || !metadata.revisionToken) throw new Error("package_provider_identity_unavailable");
    const bytes = await this.runtime.objects.readBytes?.(location.path, Math.max(1, metadata.size));
    const text = bytes ? null : await this.runtime.objects.readText(location.path);
    const data = bytes ?? (text === null ? null : new TextEncoder().encode(text));
    if (!data || data.length !== metadata.size) throw new Error("package_bytes_unavailable");
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const after = await this.runtime.objects.getMetadata(location.path);
    if (after?.objectId !== metadata.objectId || after.revisionToken !== metadata.revisionToken) throw new Error("package_object_changed");
    return { ...location, state: "present", identity: { object_id: metadata.objectId, revision_token: metadata.revisionToken, content_sha256: hash } };
  }
  private async source(location: EffectAddress): Promise<ExpectedSource> { const value = await this.observe(location); if (value.state !== "present") throw new Error("package_source_missing"); return { ...location, expected: value.identity }; }
  private async immutable(path: string, value: unknown): Promise<void> { const content = canonicalJson(value); try { await this.runtime.objects.createText(path, content); } catch (error) { if (!(error instanceof ProviderConflictError) || await this.runtime.objects.readText(path) !== content) throw error; } }
  private async prove(journal: ExecutionJournal, value: unknown): Promise<string> { const path = `${await journal.root()}/observations/${await executionHash(value)}.json`; await this.immutable(path, value); return path; }
  private adapter(journal: ExecutionJournal, admission: ExecutionAdmission, budget: { available(): boolean; consume(): void }, postcheck: ExecutionAdapter["postcheck"]): ExecutionAdapter {
    const receiptPath = async (step: ExecutionStep) => `${await journal.root()}/effects/${await executionHash(step)}.json`;
    const verify = async (step: ExecutionStep): Promise<StepObservation> => {
      const action = step.action;
      const destination = await this.observe(action.kind === "delete_if_unchanged" ? action.verified_copy : action.destination);
      const source = "source" in action ? await this.observe(action.source) : undefined;
      const receipt = await this.runtime.objects.readText(await receiptPath(step));
      const receiptRecord = receipt ? JSON.parse(receipt) : null;
      const sourceProven = action.kind !== "copy_if_unchanged" || receiptRecord?.source_identity === canonicalJson(action.source.expected);
      const observed = action.kind === "delete_if_unchanged" ? { source, destination } : { destination };
      const verified: StepObservation = { status: "verified", observed, evidence_refs: [await this.prove(journal, observed)] };
      if (inspectStepObservation(step, verified, admission) === "verified" && receiptRecord?.step_hash === await executionHash(step) && sourceProven && receiptRecord.destination_identity === canonicalJson(destination)) return verified;
      const ready: StepObservation = { status: "ready", observed: { ...(source ? { source } : {}), destination }, evidence_refs: [await this.prove(journal, { source, destination })] };
      if (inspectStepObservation(step, ready, admission) !== "ready") return { status: "conflict" };
      return budget.available() && (action.kind !== "copy_if_unchanged" || this.runtime.serverSideCopy.copyObjectVersion) ? ready : { status: "unavailable" };
    };
    return { verify, postcheck, execute: async (step) => {
      if (inspectStepObservation(step, await verify(step), admission) !== "ready") throw new Error("package_effect_precondition_changed");
      budget.consume();
      const action = step.action;
      let createdDestination: { objectId?: string; revisionToken?: string } | undefined;
      if (action.kind === "copy_if_unchanged") {
        if (!this.runtime.serverSideCopy.copyObjectVersion) throw new Error("package_exact_copy_unavailable");
        const expected = action.source.expected;
        const result = await this.runtime.serverSideCopy.copyObjectVersion(action.source.path, action.destination.path, { objectId: expected.object_id, revisionToken: expected.revision_token, contentSha256: expected.content_sha256 });
        if (result.source.objectId !== expected.object_id || result.source.revisionToken !== expected.revision_token || result.source.contentSha256 !== expected.content_sha256 || result.destination.path !== action.destination.path) throw new Error("package_copy_source_unproven");
        if (!result.destination.objectId || !result.destination.revisionToken) throw new Error("package_copy_destination_unproven");
        createdDestination = result.destination;
      }
      else if (action.kind === "delete_if_unchanged") {
        if (!this.runtime.objects.deleteIfUnchanged) throw new Error("package_conditional_delete_unavailable");
        const result = await this.runtime.objects.deleteIfUnchanged(action.source.path, { objectId: action.source.expected.object_id, revisionToken: action.source.expected.revision_token });
        if (result === "changed") throw new Error("package_source_changed");
        if (result !== "deleted") throw new Error("package_delete_unproven");
      } else {
        const content = await this.runtime.objects.readText(machineDocumentTextPayloadPath(admission.project_id, action.desired.content_sha256));
        if (content === null || await sha256Text(content) !== action.desired.content_sha256) throw new Error("package_content_ref_unavailable");
        if (action.expected_destination.state === "absent") await this.runtime.objects.createText(action.destination.path, content);
        else await this.runtime.conditionalWrite.writeTextConditional(action.destination.path, content, action.expected_destination.identity.revision_token);
      }
      const destination = await this.observe(action.kind === "delete_if_unchanged" ? action.verified_copy : action.destination);
      if (createdDestination && (destination.state !== "present" || destination.identity.object_id !== createdDestination.objectId || destination.identity.revision_token !== createdDestination.revisionToken)) throw new Error("package_copy_destination_changed");
      await this.immutable(await receiptPath(step), { destination_identity: canonicalJson(destination), step_hash: await executionHash(step), ...(action.kind === "copy_if_unchanged" ? { source_identity: canonicalJson(action.source.expected) } : {}) });
    } };
  }
}
