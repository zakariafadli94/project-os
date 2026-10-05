import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import type { ProjectState } from "../src/domain/project-state";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderRequestScope } from "../src/persistence/provider/contract";
import { machineDocumentHeadPath, machineDocumentRoot } from "../src/persistence/layout";
import { ManagedDocumentService } from "../src/documents/service";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ZoneNavigationSources, zoneNavigationDirtyRoot } from "../src/documents/zone-navigation-sources";
import {
  initializeManagedDocumentChangeJobSchema,
  ManagedDocumentChangeJobStore,
  type ManagedDocumentChangeJobInput,
  type ManagedDocumentDriftFinding,
  type ManagedDocumentChangeQuarantine
} from "../src/documents/change-job-store";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { parseTransaction } from "../src/domain/transaction";
import { packageRuntime } from "./helpers/package-runtime";
import { InternalExecutionFailure } from "../src/execution/coordinator";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { RuleAdmissionError } from "../src/admission/rule-admission";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { normalizeSystemAdmission } from "../src/admission/operation-context";
import { sha256Canonical } from "../src/materialization/hash";
import { sha256Text } from "../src/documents/hash";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import type { ExecutionAdmission } from "../src/execution/contract";
import { canonicalJson } from "../src/rules/contract";
import { applyRuleGovernance, globalGovernanceTransactionSchema, ruleVersionSchema } from "../src/domain/rule-governance";
import { RuleGovernanceRepository, globalGovernancePath } from "../src/persistence/rule-governance-repository";
import { eventIdForRevision } from "../src/domain/event";
import { governanceTx, ruleFixture, exceptionFixture } from "./helpers/rule-fixtures";
import { evaluateRules } from "../src/rules/evaluator";

const testEnv = env as unknown as Env;
const at = "2026-08-31T14:20:00+01:00";
let restoreTestEnvBindings: (() => Promise<void>) | null = null;
let resetAfterRetryFaultFixture = false;

function restoreOptionalEnvBinding(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Change jobs ${slug}`, slug, aliases: [], objective: "Durable change jobs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

function injectRetryAfterForCursor(mock: ReturnType<typeof installDropboxMock>, targetCursor: string) {
  const delegateFetch = mock.spy.getMockImplementation();
  if (!delegateFetch) throw new Error("Dropbox mock implementation unavailable");
  const continuedCursors: string[] = [];
  let retryAfterInjected = false;
  mock.spy.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
      const body = await request.clone().json() as { cursor?: unknown };
      if (typeof body.cursor === "string") continuedCursors.push(body.cursor);
      if (body.cursor === targetCursor && !retryAfterInjected) {
        retryAfterInjected = true;
        return new Response(JSON.stringify({ error_summary: "too_many_requests/" }), {
          status: 429,
          headers: { "Retry-After": "60" }
        });
      }
    }
    return delegateFetch(input, init);
  });
  return { continuedCursors, didInject: () => retryAfterInjected };
}

describe("durable managed-document change jobs", () => {
  afterEach(async () => {
    try { await restoreTestEnvBindings?.(); }
    finally {
      restoreTestEnvBindings = null;
      const shouldReset = resetAfterRetryFaultFixture;
      resetAfterRetryFaultFixture = false;
      try {
        vi.useRealTimers();
      } finally {
        try {
          if (shouldReset) await reset();
        } finally {
          vi.restoreAllMocks();
        }
      }
    }
  });

  async function tornRecoveryParent(intentHash = "a".repeat(64)) {
    const fixture = packageRuntime();
    fixture.runtime.pagedListing = { listPage: async ({ path, limit }) => {
      const children = [...fixture.files.keys()].filter(file => file.startsWith(`${path}/`)
        && !file.slice(path.length + 1).includes("/"));
      return { entries: children.slice(0, limit).map(file => ({ kind: "file" as const,
        name: file.slice(path.length + 1), path: file })), cursor: children.length > limit ? "more-history" : null };
    } };
    const projectId = "PRJ-9258";
    const sourcePath = `${machineDocumentRoot(projectId)}/navigation-sources/state.json`;
    fixture.put(sourcePath, canonicalJson({ schema_version: "1.0", project_id: projectId, state_revision: 1,
      zones: Object.fromEntries(["WORKING", "REVIEW", "DELIVERABLES"].map(zone => [zone, {
        generation: 0, adopted: false, adoption_request_id: null, adoption_generation: null,
        catalog_rebuild_request_id: null, catalog_cache_write_permits: [], in_flight_writes: [] }])) }));
    const metadata = await fixture.runtime.objects.getMetadata(sourcePath);
    if (!metadata?.integrityHash || !metadata.objectId || !metadata.revisionToken) throw new Error("source fixture unavailable");
    const binding = {
      discriminator: "navigation.head-write.recovery-parent@1",
      provider_id: fixture.runtime.providerId,
      project_id: projectId,
      actor: { actor_id: "project_guard", authority: "durable_object" },
      operation: "project.repair",
      project_revision: 12,
      intent_hash: intentHash,
      source_state: { path: sourcePath, object_id: metadata.objectId, revision_token: metadata.revisionToken,
        integrity_hash_algorithm: metadata.integrityHash.algorithm, integrity_hash: metadata.integrityHash.value }
    };
    const bindingHash = await executionHash(binding);
    const requestId = `DOCREQ-NAV-HEAD-PARENT-REPAIR-12-${intentHash.toUpperCase()}-${bindingHash.toUpperCase()}`;
    const normalized = await normalizeSystemAdmission(projectId, "project.repair", "DOCUMENTS", "document-reconcile@12", "12", binding);
    const sourceRef = `${sourcePath}#object_id=${encodeURIComponent(metadata.objectId!)}&revision_token=${encodeURIComponent(metadata.revisionToken!)}&integrity_hash_algorithm=${encodeURIComponent(metadata.integrityHash.algorithm)}&integrity_hash=${encodeURIComponent(metadata.integrityHash.value)}`;
    const admission: ExecutionAdmission = {
      project_id: projectId, request_id: requestId, kind: "navigation-head-recovery-parent", operation: "project.repair",
      request_hash: normalized.request_hash, actor: binding.actor, resources: normalized.resources,
      diagnosed_drift_refs: [sourceRef], global_revision: 1, project_revision: 12,
      ruleset: { global_revision: 1, project_revision: 12, digest: "b".repeat(64), rules: [] },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    const journal = new ExecutionJournal(fixture.runtime, projectId, admission.kind, requestId);
    const root = await journal.root();
    // Real canonical admission exists, but its initial progress create was interrupted.
    fixture.put(`${root}/admission.json`, canonicalJson({ schema_version: "1.0", admission, plan: null, effect_plan_hash: await executionHash(null) }));
    return { ...fixture, projectId, sourcePath, intentHash, binding, admission, journal, root };
  }

  // Synthetic, memory-only qualification, not production tuple qualification.
  // Real controls, qualification, activation, signatures and Registry checks
  // still execute. The injected evidence resolver is restored immediately.
  async function appendGovernanceFixture(runtime: ProjectOsPersistenceRuntime, operation: string, payload: unknown) {
    const repository = new RuleGovernanceRepository(runtime);
    const saved = await repository.read();
    if (!saved) throw new Error("governance fixture not initialized");
    const transaction = globalGovernanceTransactionSchema.parse({ ...governanceTx(operation, payload, saved.state.revision, "GLOBAL"),
      created_at: new Date().toISOString() });
    if (transaction.operation === "rule.activate") {
      const registry = testEnv.REGISTRY_GUARD.getByName("global");
      const original = await runInDurableObject(registry, instance => (instance as any).ruleQualificationResolver);
      try {
        await runInDurableObject(registry, instance => {
          (instance as any).ruleQualificationResolver = { resolve: async ({ rule, now }: any) => {
            const active = ruleVersionSchema.parse({ ...rule, status: "active" });
            const state = emptyProjectState("PRJ-9258", "Synthetic control probe", "synthetic-control-probe");
            state.revision = 1;
            const resource = { resource_id: "document-reconcile@1", resource_type: "project", zone: "DOCUMENTS", version: "1", expected_version: "1" };
            const probe = (operation: string, currentVersion: string) => evaluateRules({
              actor: { actor_id: "project_guard", authority: "durable_object" }, project_id: state.project_id,
              expected_project_revision: 1, stage: "pre_admission", now, state, operation, resources: [resource], approvals: [],
              global_governance: { revision: 1, rules: { [`${rule.rule_id}@${rule.version}`]: active }, exceptions: {} },
              observations: [{ project_id: state.project_id, resource_id: resource.resource_id, resource_version: "1",
                current_version: currentVersion, observed_at: now, expires_at: "2099-01-01T00:00:00.000Z", evidence_refs: ["fixture:current-version"] }]
            });
            for (const operation of rule.operations) {
              expect(await probe(operation, "1")).toMatchObject({ verdict: "allow" });
              expect(await probe(operation, "2")).toMatchObject({ verdict: "deny", results: [expect.objectContaining({ code: "STALE_DOCUMENT_VERSION" })] });
            }
            const binding = { status: "verified", evidence_ref: "fixture:current-version",
              verification_ref: "test/document-change-job-faults.spec.ts#synthetic-real-evaluator-version-probes" };
            return { active_rules: [], evidence: { rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope,
              evidence_refs: transaction.payload.activation_evidence, accepted_source_refs: rule.source_refs,
              deployed_check_id: "expected_version", deployment_ref: "fixture:memory-only-not-production",
              check_evidence: { current_version: binding },
              entry_coverage: rule.operations.map((operation: string) => ({ operation, entries: ["GI"],
                not_applicable_entries: ["API", "CT", "FB", "IN", "CF", "AD", "RP"], evidence_refs: [binding.verification_ref] })),
              positive_test_refs: ["fixture:real-expected-version-match"], negative_test_refs: ["fixture:real-stale-version-denial"],
              contradiction_scan_ref: "fixture:exact-version-and-scope", historical_drift_ref: "fixture:empty-memory-inventory",
              qualified_at: now, expires_at: "2099-01-01T00:00:00.000Z" } };
          } };
        });
        const response = await registry.fetch("https://registry-guard.internal/governance/transaction", { method: "POST",
          headers: { authorization: "Bearer rule-admission-test-authority", "content-type": "application/json" }, body: JSON.stringify(transaction) });
        const receipt = await response.json();
        expect(response.status, JSON.stringify(receipt)).toBe(200);
        expect(receipt).toMatchObject({ status: "committed" });
        const current = await repository.read();
        expect(current?.state.rules[`${transaction.payload.rule_id}@${transaction.payload.version}`].status).toBe("active");
        expect(current?.state.journal[transaction.transaction_id].qualification?.proof.evidence.deployment_ref).toBe("fixture:memory-only-not-production");
        return;
      } finally { await runInDurableObject(registry, instance => { (instance as any).ruleQualificationResolver = original; }); }
    }
    const result = applyRuleGovernance(saved.state, transaction, "GLOBAL");
    if (result.kind !== "commit") throw new Error(`governance fixture refused: ${JSON.stringify(result)}`);
    const revision = saved.state.revision + 1, eventId = eventIdForRevision(revision);
    const receipt = { schema_version: "1.0" as const, project_id: "GLOBAL", transaction_id: transaction.transaction_id,
      status: "committed" as const, previous_revision: saved.state.revision, new_revision: revision,
      event_id: eventId, committed_at: transaction.created_at };
    const event = { schema_version: "1.0" as const, event_id: eventId, project_id: "GLOBAL", revision,
      transaction_id: transaction.transaction_id, type: transaction.operation, timestamp: transaction.created_at, payload: transaction.payload };
    await repository.write({ ...result.state, revision,
      journal: { ...saved.state.journal, [transaction.transaction_id]: { transaction, receipt, event } } }, saved.token);
  }

  it("reconstructs only initial typed head parent progress before child admission or effects", async () => {
    const f = await tornRecoveryParent();
    await expect(f.journal.commit(f.admission, null, f.binding)).resolves.toEqual(f.admission);
    const saved = await f.journal.load();
    expect(saved?.progress).toMatchObject({ status: "admitted", terminal: false, sequence: 0, completed_steps: [] });
    expect(f.effects).toEqual([`create:${f.root}/progress.json`]);
    await expect(f.journal.commit(f.admission, null, f.binding)).resolves.toEqual(f.admission);
    expect(f.effects).toHaveLength(1);
  });

  it("refuses missing or invalid synthetic qualification through the real Registry reader and permit route", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-HEAD-QUALIFICATION-NEGATIVE-0001", "head-qualification-negative");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id), registry = testEnv.REGISTRY_GUARD.getByName("global");
    const originalGuard = await runInDurableObject(guard, instance => (instance as any).env.RULE_ADMISSION_SIGNING_KEY);
    const originalRegistry = await runInDurableObject(registry, instance => ({ signing: (instance as any).env.RULE_ADMISSION_SIGNING_KEY,
      governance: (instance as any).env.RULE_GOVERNANCE_TOKEN }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(guard, instance => restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalGuard));
      await runInDurableObject(registry, instance => {
        restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalRegistry.signing);
        restoreOptionalEnvBinding((instance as any).env, "RULE_GOVERNANCE_TOKEN", originalRegistry.governance);
      });
    };
    resetAfterRetryFaultFixture = true;
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-qualification-negative", created.project_id);
    await runInDurableObject(guard, async instance => {
      const runtime = (instance as any).persistence;
      const rule = ruleFixture("GLOBAL", { rule_id: "RULE-SYNTHETIC-QUALIFICATION", operations: ["project.materialize"],
        resource_scope: { resource_types: ["project"], zones: ["DOCUMENTS"] }, check_id: "expected_version", parameters: { required: false } });
      await appendGovernanceFixture(runtime, "rule.propose", { rule });
      await appendGovernanceFixture(runtime, "rule.accept", { rule_id: rule.rule_id, version: 1 });
      await appendGovernanceFixture(runtime, "rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: ["fixture:synthetic-only"] });
    });
    const positive = await registry.fetch("https://registry-guard.internal/governance");
    expect(positive.status).toBe(200);
    const global: any = await positive.json();
    const state = emptyProjectState(created.project_id, "Synthetic qualification", "head-qualification-negative");
    state.revision = 1;
    const normalized = await normalizeSystemAdmission(created.project_id, "project.materialize", "DOCUMENTS", "document-reconcile@1", "1", {});
    const actor = { actor_id: "project_guard", authority: "durable_object" };
    const evaluation = await evaluateRules({ actor, project_id: created.project_id, operation: "project.materialize",
      expected_project_revision: 1, stage: "pre_admission", now: new Date().toISOString(), state,
      global_governance: global, resources: normalized.resources, observations: [], approvals: [] });
    expect(evaluation.verdict).toBe("allow");
    const request = { actor, project_id: normalized.project_id, operation: normalized.operation,
      resources: normalized.resources, request_hash: normalized.request_hash,
      global_revision: global.revision, ruleset: evaluation.ruleset };
    const original = mock.files.get(globalGovernancePath)!;
    for (const condition of ["missing", "invalid"]) {
      const changed = JSON.parse(original);
      const activation: any = Object.values(changed.journal).find((entry: any) => entry.transaction.operation === "rule.activate");
      if (condition === "missing") { delete activation.qualification; delete activation.qualification_required; }
      else activation.qualification.sha256 = "0".repeat(64);
      await mock.writeExternal(globalGovernancePath, JSON.stringify(changed));
      const before = new Map(mock.files);
      const refused = await registry.fetch("https://registry-guard.internal/governance");
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: condition === "missing" ? "governance_qualification_unavailable" : "governance_unavailable" });
      const permit = await registry.fetch("https://registry-guard.internal/rule-admission", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(permit.status).toBe(503);
      expect(new Map(mock.files)).toEqual(before);
      await mock.writeExternal(globalGovernancePath, original);
    }
  });

  it.each(["source changed", "child admitted", "intent present", "completion present", "wrong actor", "wrong binding"])(
    "never reconstructs typed parent progress when %s", async (condition) => {
      const f = await tornRecoveryParent();
      if (condition === "source changed") f.put(f.sourcePath, f.files.get(f.sourcePath)!.content);
      if (condition === "child admitted") {
        const child = new ExecutionJournal(f.runtime, f.projectId, "navigation-head-recovery", `DOCREQ-NAV-HEAD-RECOVERY-${f.intentHash.toUpperCase()}`);
        f.put(`${await child.root()}/admission.json`, "{}");
      }
      if (condition === "intent present" || condition === "completion present") {
        f.put(`${machineDocumentRoot(f.projectId)}/navigation-sources/head-write-recovery/${f.intentHash}/${condition === "intent present" ? "intent" : "completion"}.json`, "{}");
      }
      if (condition === "wrong actor") f.binding.actor.actor_id = "other";
      if (condition === "wrong binding") f.binding.intent_hash = "c".repeat(64);
      await expect(f.journal.commit(f.admission, null, f.binding)).rejects.toThrow();
      expect(f.files.has(`${f.root}/progress.json`)).toBe(false);
      expect(f.effects).toEqual([]);
    }
  );

  it("never applies the missing-progress exception to an ordinary repair family", async () => {
    const f = await tornRecoveryParent();
    const admission = { ...f.admission, kind: "document-reconcile", request_id: "legacy-repair" };
    const journal = new ExecutionJournal(f.runtime, f.projectId, admission.kind, admission.request_id);
    f.put(`${await journal.root()}/admission.json`, canonicalJson({ schema_version: "1.0", admission, plan: null, effect_plan_hash: await executionHash(null) }));
    await expect(journal.commit(admission, null)).rejects.toThrow("execution_progress_unavailable");
    expect(f.effects).toEqual([]);
  });

  it.each(["noninitial history", "listing unavailable", "incomplete listing", "listing failed"])(
    "never resets a typed parent when its own history absence is unproved: %s", async condition => {
      const f = await tornRecoveryParent();
      if (condition === "noninitial history") f.put(`${f.root}/history/000000004.json`, canonicalJson({
        sequence: 4, status: "finalizing", completed_steps: [{ step_id: "prior-effect" }] }));
      if (condition === "listing unavailable") delete f.runtime.pagedListing;
      if (condition === "incomplete listing") f.runtime.pagedListing = { listPage: async () => ({ entries: [], cursor: "unread-history" }) };
      if (condition === "listing failed") f.runtime.pagedListing = { listPage: async () => { throw new Error("provider_unavailable"); } };
      const before = [...f.files.entries()];
      await expect(f.journal.commit(f.admission, null, f.binding)).rejects.toThrow();
      expect([...f.files.entries()]).toEqual(before);
      expect(f.files.has(`${f.root}/progress.json`)).toBe(false);
      expect(f.effects).toEqual([]);
    }
  );

  it("binds a new recovery child to its sole canonical parent before creating intention", async () => {
    const f = await tornRecoveryParent();
    await f.journal.commit(f.admission, null, f.binding);
    const parentRef = `${f.root}/admission.json`;
    const childAdmission: ExecutionAdmission = { ...f.admission, kind: "navigation-head-recovery", operation: "project.materialize",
      request_id: `DOCREQ-NAV-HEAD-RECOVERY-${f.intentHash.toUpperCase()}`, request_hash: f.intentHash,
      diagnosed_drift_refs: [parentRef] };
    const child = new ExecutionJournal(f.runtime, f.projectId, childAdmission.kind, childAdmission.request_id);
    await child.commit(childAdmission, null);
    // Feature absence is measured on real journal progress, not by mocking a claim method.
    if ("claimHeadRecoveryParent" in child) await child.claimHeadRecoveryParent(f.journal, f.binding);
    const claimed = await child.load();
    expect(claimed?.progress.completed_steps).toEqual([{ step_id: "head-recovery-parent", evidence_refs: [parentRef],
      observation_hash: await executionHash(f.binding) }]);
    expect(claimed?.progress.sequence).toBe(1);
    if ("claimHeadRecoveryParent" in child) await child.claimHeadRecoveryParent(f.journal, f.binding);
    expect((await child.load())?.progress.sequence).toBe(1);
  });

  async function claimedRecoveryChild() {
    const f = await tornRecoveryParent();
    await f.journal.commit(f.admission, null, f.binding);
    const admission: ExecutionAdmission = { ...f.admission, kind: "navigation-head-recovery", operation: "project.materialize",
      request_id: `DOCREQ-NAV-HEAD-RECOVERY-${f.intentHash.toUpperCase()}`, request_hash: f.intentHash,
      diagnosed_drift_refs: [`${f.root}/admission.json`] };
    const child = new ExecutionJournal(f.runtime, f.projectId, admission.kind, admission.request_id);
    await child.commit(admission, null);
    return { ...f, child, childAdmission: admission, childRoot: await child.root() };
  }

  it("does not reset a missing child progress after its canonical parent claim", async () => {
    const f = await claimedRecoveryChild();
    await f.child.claimHeadRecoveryParent(f.journal, f.binding);
    f.files.delete(`${f.childRoot}/progress.json`);
    f.effects.length = 0;
    const before = [...f.files.entries()];
    await expect(f.child.commit(f.childAdmission, null)).rejects.toThrow("execution_progress_unavailable");
    expect([...f.files.entries()]).toEqual(before);
    expect(f.effects).toEqual([]);
  });

  it.each(["claim CAS", "claim history"])("recovers an acknowledgement lost after successful %s without replaying its claim", async boundary => {
    const f = await claimedRecoveryChild();
    let injected = false;
    if (boundary === "claim CAS") {
      const original = f.runtime.conditionalWrite.writeTextConditional;
      f.runtime.conditionalWrite.writeTextConditional = async (...args) => {
        const result = await original(...args);
        if (!injected && args[0] === `${f.childRoot}/progress.json`) { injected = true; throw new Error("ack_lost_after_write"); }
        return result;
      };
      await expect(f.child.claimHeadRecoveryParent(f.journal, f.binding)).rejects.toThrow("ack_lost_after_write");
    } else {
      const original = f.runtime.objects.createText;
      f.runtime.objects.createText = async (...args) => {
        await original(...args);
        if (!injected && args[0].startsWith(`${f.childRoot}/history/`)) { injected = true; throw new Error("ack_lost_after_write"); }
      };
      await f.child.claimHeadRecoveryParent(f.journal, f.binding);
    }
    expect(injected).toBe(true);
    const recovered = await f.child.claimHeadRecoveryParent(f.journal, f.binding);
    expect(recovered.progress.sequence).toBe(1);
    expect(recovered.progress.completed_steps).toEqual([{ step_id: "head-recovery-parent", evidence_refs: [`${f.root}/admission.json`],
      observation_hash: await executionHash(f.binding) }]);
    expect([...f.files.keys()].filter(path => path.startsWith(`${f.childRoot}/history/`))).toHaveLength(1);
    expect(f.effects.filter(effect => effect === `write:${f.childRoot}/progress.json`)).toHaveLength(1);
  });

  it("permits only one concurrent canonical parent claim", async () => {
    const f = await claimedRecoveryChild();
    const first = (await f.child.load())!, second = (await f.child.load())!;
    const parent1 = (await f.journal.load())!, parent2 = (await f.journal.load())!;
    const results = await Promise.allSettled([
      f.child.claimHeadRecoveryParent(f.journal, f.binding, { parent: parent1, child: first }),
      f.child.claimHeadRecoveryParent(f.journal, f.binding, { parent: parent2, child: second })
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.child.load())?.progress.sequence).toBe(1);
    expect((await f.child.load())?.progress.completed_steps).toHaveLength(1);
    expect(f.effects.filter(effect => effect === `write:${f.childRoot}/progress.json`)).toHaveLength(1);
  });

  it.each(["resource", "zone", "version"].flatMap(field => ["claim", "effects", "tail"].map(phase => ({ field, phase }))))(
    "refuses recovery with a child resource vector outside intention before $phase: $field", async ({ field, phase }) => {
      const projectId = "PRJ-9258", resourceId = `head:DOC-${"A".repeat(24)}`;
      const intent = { schema_version: "1.0" as const, intent_type: "navigation.head-write.reconcile" as const,
        project_id: projectId, resource_id: resourceId, original_outcome: "unknown" as const,
        original_tickets: [{ project_id: projectId, zone: "WORKING" as const, resource_id: resourceId,
          generation: 1, write_hash: "a".repeat(64) }],
        current_head: { path: machineDocumentHeadPath(projectId, resourceId.slice(5)), object_id: "id:head",
          revision_token: "rev:head", content_sha256: "c".repeat(64), size: 10 },
        version_proofs: [{ version_id: "VER-FIXTURE", stage: "working" as const, immutable_payload_path: "/fixture/payload.md",
          record_sha256: "d".repeat(64), record_object_id: "id:record", record_revision_token: "rev:record", record_size: 10,
          payload_object_id: "id:payload", payload_revision_token: "rev:payload", payload_size: 10 }] };
      const hash = await executionHash(intent);
      const f = await tornRecoveryParent(hash);
      await f.journal.commit(f.admission, null, f.binding);
      const parentRef = `${f.root}/admission.json`;
      const resource = { resource_id: resourceId, resource_type: "document", zone: "WORKING", version: "c".repeat(64) };
      if (field === "resource") resource.resource_id = `head:DOC-${"B".repeat(24)}`;
      if (field === "zone") resource.zone = "REVIEW";
      if (field === "version") resource.version = "e".repeat(64);
      const admission: ExecutionAdmission = { ...f.admission, kind: "navigation-head-recovery", operation: "project.materialize",
        request_id: `DOCREQ-NAV-HEAD-RECOVERY-${hash.toUpperCase()}`, request_hash: hash,
        resources: [resource], diagnosed_drift_refs: [parentRef] };
      const child = new ExecutionJournal(f.runtime, projectId, admission.kind, admission.request_id);
      await child.commit(admission, null);
      if (phase !== "claim") await child.claimHeadRecoveryParent(f.journal, f.binding);
      if (phase === "tail") {
        const loaded = (await child.load())!;
        loaded.progress.status = "finalizing";
        loaded.progress.sequence++;
        await child.save(loaded.progress, loaded.token);
      }
      const intentPath = `${machineDocumentRoot(projectId)}/navigation-sources/head-write-recovery/${hash}/intent.json`;
      if (phase !== "claim") f.put(intentPath, canonicalJson(intent));
      const checkpoint = { intent_hash: hash, parent_request_id: f.admission.request_id, child_created: true, intent,
        discovery: { cursor: null, pending_roots: [], complete: true }, dirty: [null], cleared: 0, completion: [null] };
      const before = [...f.files.entries()];
      f.effects.length = 0;
      await expect(new DocumentLedgerRepository(f.runtime).recoverOneUnownedHeadWrite(projectId, 0, false, {
        pending_recovery_hash: hash, authorize: async () => { throw new Error("unexpected_new_admission"); },
        rememberRecovery: async () => { throw new Error("unexpected_new_locator"); },
        bound: { readCheckpoint: async () => checkpoint, writeCheckpoint: async () => {},
          authorizeParent: async () => { throw new Error("unexpected_new_parent"); }, assertCompatible: async () => {} }
      })).rejects.toThrow("navigation_head_recovery_parent_claim_invalid");
      expect([...f.files.entries()]).toEqual(before);
      expect(f.effects).toEqual([]);
    });

  it("prepares one recovery dirty marker without clearing its owned source fence", async () => {
    const f = packageRuntime();
    const projectId = "PRJ-9258";
    const resourceId = `head:DOC-${"A".repeat(24)}`;
    const rawHead = "physically verified head";
    const currentHash = await sha256Text(rawHead);
    const ownerHash = "d".repeat(64);
    f.put(machineDocumentHeadPath(projectId, resourceId.slice(5)), rawHead);
    f.runtime.pagedListing = { listPage: async ({ path }) => ({ entries: [...f.files.keys()]
      .filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map(file => ({ kind: "file" as const, name: file.slice(path.length + 1), path: file })), cursor: null }) };
    const sources = new ZoneNavigationSources(f.runtime);
    await sources.markCatalogReady(projectId, "WORKING", 0);
    await sources.beginAdoption(projectId, "WORKING", "DOCREQ-TEST-RECOVERY-ADOPT", 0);
    await sources.finishAdoption(projectId, "WORKING", "DOCREQ-TEST-RECOVERY-ADOPT", 0);
    const ticket = await sources.beginHeadWrite(projectId, "WORKING", resourceId, undefined, currentHash, false, ownerHash);
    expect(ticket).not.toBeNull();
    let witnessCreated = false;
    await sources.completeOwnedHeadWriteRecovery([ticket!], ownerHash, currentHash, undefined, {
      verifyCurrent: async () => await f.runtime.objects.readText(machineDocumentHeadPath(projectId, resourceId.slice(5))) === rawHead,
      beforeClear: async () => { witnessCreated = true; }, hasCompletionWitness: async () => witnessCreated
    }, { kind: "dirty", index: 0, hint: null });
    expect((await sources.readState(projectId, "WORKING")).in_flight_resource_ids).toContain(resourceId);
    expect(await sources.hasDirtyMarker(projectId, "WORKING", resourceId)).toBe(true);
    expect(witnessCreated).toBe(false);
  });

  it.each([{ legacy: false, corrupt: "none" }, { legacy: true, corrupt: "none" },
    ...["dirty", "manifest"].flatMap(component => ["future", "invalid"].map(value => ({ legacy: false, corrupt: `${component}-${value}` })))])(
    "ages recovery hints by real component acquisitions, preserving legacy age: $legacy corruption=$corrupt", async ({ legacy, corrupt }) => {
    const f = packageRuntime();
    const projectId = "PRJ-9258";
    const resourceId = `head:DOC-${"A".repeat(24)}`;
    const currentHash = "c".repeat(64);
    const ownerHash = "d".repeat(64);
    f.runtime.pagedListing = { listPage: async ({ path }) => ({ entries: [...f.files.keys()]
      .filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map(file => ({ kind: "file" as const, name: file.slice(path.length + 1), path: file })), cursor: null }) };
    const sources = new ZoneNavigationSources(f.runtime);
    await sources.markCatalogReady(projectId, "WORKING", 0);
    await sources.beginAdoption(projectId, "WORKING", "DOCREQ-HINT-AGE-ADOPT", 0);
    await sources.finishAdoption(projectId, "WORKING", "DOCREQ-HINT-AGE-ADOPT", 0);
    const original = await sources.beginHeadWrite(projectId, "WORKING", resourceId, undefined, currentHash, false, ownerHash);
    const sourcePath = `${machineDocumentRoot(projectId)}/navigation-sources/state.json`;
    const state = JSON.parse(f.files.get(sourcePath)!.content);
    state.zones.WORKING.generation = 2;
    state.zones.WORKING.in_flight_writes[0].generation = 2;
    state.state_revision++;
    f.put(sourcePath, JSON.stringify(state));
    const dirtyPath = `${zoneNavigationDirtyRoot(projectId, "WORKING")}/${await sha256Text(resourceId)}.json`;
    f.put(dirtyPath, JSON.stringify({ schema_version: "1.0", resource_id: resourceId, generation: 1, entry_hash: null }));
    const ticket = { ...original!, generation: 2 };
    const proof = { verifyCurrent: async () => true, beforeClear: async () => { throw new Error("dirty must not clear"); },
      hasCompletionWitness: async () => false };
    const base = Date.parse("2026-10-05T10:00:00.000Z");
    const advance = (hint: any) => sources.completeOwnedHeadWriteRecovery([ticket], ownerHash, currentHash, undefined, proof,
      { kind: "dirty", index: 0, hint }) as Promise<any>;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      let hint = await advance(null);
      vi.setSystemTime(base + 10_000);
      hint = await advance(hint);
      vi.setSystemTime(base + 20_000);
      hint = await advance(hint);
      expect(hint.phase).toBe("manifest_published");
      if (legacy) { delete hint.dirty_acquired_at_ms; delete hint.manifest_acquired_at_ms; }
      vi.setSystemTime(base + 30_000);
      hint = await advance(hint);
      // Dirty was physically written/read at +30s; manifest at +20s. The
      // older *real* component wins. A missing date never becomes +30s.
      const groupAcquiredAt = base + (legacy ? 0 : 20_000);
      expect(hint.acquired_at_ms).toBe(groupAcquiredAt);
      expect(hint.dirty_acquired_at_ms).toBe(base + 30_000);
      if (!legacy) expect(hint.manifest_acquired_at_ms).toBe(base + 20_000);
      const effectsBeforeHit = f.effects.length;
      vi.setSystemTime(base + 40_000);
      if (corrupt !== "none") {
        const invalid = { ...hint, [corrupt.startsWith("dirty") ? "dirty_acquired_at_ms" : "manifest_acquired_at_ms"]:
          corrupt.endsWith("future") ? Date.now() + 1 : -1 };
        const reacquired = await advance(invalid);
        expect(reacquired.phase).toBe("ready"); // the actual reread marker already matches generation 2
        expect(reacquired.manifest).toBeNull();
        expect(reacquired.dirty_acquired_at_ms).toBe(Date.now());
        expect(f.effects).toHaveLength(effectsBeforeHit);
        expect((await sources.readState(projectId, "WORKING")).in_flight_resource_ids).toContain(resourceId);
        return;
      }
      hint = await advance(hint);
      expect(hint.acquired_at_ms).toBe(groupAcquiredAt);
      expect(hint.dirty_acquired_at_ms).toBe(base + 30_000);
      expect(f.effects).toHaveLength(effectsBeforeHit);
      // A forged newer scalar cannot hide expiration of the retained bodies.
      vi.setSystemTime(groupAcquiredAt + 300_000);
      const expired = await advance(legacy ? hint : { ...hint, acquired_at_ms: Date.now() });
      expect(expired.manifest).toBeNull();
      expect(expired.acquired_at_ms).toBe(Date.now());
      expect((await sources.readState(projectId, "WORKING")).in_flight_resource_ids).toContain(resourceId);
    } finally { vi.useRealTimers(); }
  });

  it("reports a bounded checkpoint without advancing verification or changing durable jobs", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CHECKPOINT-READ-0001", "checkpoint-read");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const snapshot = async () => runInDurableObject(guard, async (_instance, state) =>
      ({
        tables: ["managed_document_change_control", "managed_document_drift_control", "managed_document_change_jobs",
          "managed_document_change_selection_control", "managed_document_change_continuation", "managed_document_change_job_failure_state",
          "managed_document_change_quarantine", "managed_document_drift_findings"]
          .map(table => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
        values: Array.from((await state.storage.list()).entries()),
        alarm: await state.storage.getAlarm()
      }));
    await runInDurableObject(guard, async (_instance, state) => {
      const jobs = new ManagedDocumentChangeJobStore(state.storage);
      jobs.registerPage({ expected_cursor: null, next_cursor: "private-provider-cursor", jobs: [] });
      jobs.completeScheduledVerification("2026-10-01T12:00:00.000Z");
      for (let index = 0; index < 8; index += 1) {
        const job = { job_id: `CHGJOB-${index.toString(16).toUpperCase().padStart(24, "0")}`,
          change: { kind: "file" as const, path: `/private/target-${index}`, name: `target-${index}` }, detection_source: "incremental" as const, priority: 10 };
        jobs.registerPage({ expected_cursor: jobs.cursor(), next_cursor: "private-provider-cursor", jobs: [job] });
        jobs.markQuarantined({ ...job, ordinal: index, attempts: 0, last_error: null }, "file_target_missing", "2026-10-02T12:00:00.000Z");
        jobs.recordDriftFinding({ finding_id: `DRIFT-${index.toString(16).toUpperCase().padStart(24, "0")}`,
          job_id: job.job_id, path: job.change.path, change_kind: "file", status: "unexpected_conflict", code: "file_target_missing",
          resource: { resource_type: "document", resource_id: "PRIVATE-RESOURCE", version: "private-version", zone: "WORKING" }, observed_at: "2026-10-02T12:00:00.000Z" });
      }
      const pending = { job_id: `CHGJOB-${"F".repeat(24)}`, change: { kind: "file" as const, path: "/private/pending", name: "pending" }, detection_source: "incremental" as const, priority: 10 };
      jobs.registerPage({ expected_cursor: jobs.cursor(), next_cursor: "private-provider-cursor", jobs: [pending] });
      jobs.markFailed(pending.job_id, "private-error-payload");

      const baseNow = Date.parse("2026-10-03T10:00:00.000Z");
      const executable = { job_id: "CHGJOB-111111111111111111111111", change: { kind: "file" as const, path: "/private/executable", name: "executable" }, detection_source: "incremental" as const, priority: 10 };
      const future = { job_id: "CHGJOB-222222222222222222222222", change: { kind: "file" as const, path: "/private/future", name: "future" }, detection_source: "incremental" as const, priority: 10 };
      const stopped = { job_id: "CHGJOB-333333333333333333333333", change: { kind: "file" as const, path: "/private/stopped", name: "stopped" }, detection_source: "incremental" as const, priority: 10 };
      for (const job of [executable, future, stopped]) {
        jobs.registerPage({ expected_cursor: jobs.cursor(), next_cursor: "private-provider-cursor", jobs: [job] });
      }
      const futureJob = jobs.pending().find(job => job.job_id === future.job_id)!;
      jobs.recordFailure(futureJob, "provider_retryable", {
        failure_fingerprint: "a".repeat(64), progress_fingerprint: "b".repeat(64),
        classification: "provider_retryable", now_ms: baseNow, retry_after_ms: 7 * 24 * 60 * 60 * 1000
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const stoppedJob = jobs.pending().find(job => job.job_id === stopped.job_id)!;
        jobs.recordFailure(stoppedJob, "internal_failure", {
          failure_fingerprint: "c".repeat(64), progress_fingerprint: "d".repeat(64),
          classification: "internal", now_ms: baseNow + attempt
        });
      }
      const wakeAt = baseNow + 90_000;
      jobs.beginContinuationSlice(true);
      jobs.finishContinuationSlice({ pending: true, next_wake_at: wakeAt, documents_priority_next: true,
        feed_retry_at: wakeAt + 30_000, outcome: {
          semantic_progress: 7, jobs_registered: 2, jobs_completed: 1, jobs_pending: 4, job_failures: 2,
          jobs_quarantined: 8, executable_jobs: 2, future_eligible_jobs: 1, stopped_unresolved_jobs: 1,
          earliest_eligible_at: baseNow + 7 * 24 * 60 * 60 * 1000,
          budget_yield: true, unread_feed: true, verification_completed: false, global_notification_owed: true,
          safe_errors: ["provider_retryable", "document_slice_failed"],
          raw_error_message: "private-error-payload", provider_path: "/private/provider-path",
          cursor: "private-provider-cursor", request_body: "private-request-body"
        } });
      await state.storage.put("navigation-head-recovery-diagnostic-v1", {
        project_id: created.project_id, observed_at: "Sat, 03 Oct 2026 09:59:59 GMT (private-token)", slice_ordinal: 12,
        resource_id: `head:DOC-${"A".repeat(24)}`, stage: "version_metadata", code: "proof_unavailable",
        raw_error_message: "private-error-payload", provider_path: "/private/provider-path"
      });
    });
    const before = await snapshot();
    const providerCallCount = mock.providerCalls.length;
    const localCheckpoint = await runInDurableObject(guard, async (_instance, state) =>
      new ManagedDocumentChangeJobStore(state.storage).readCheckpoint("2026-10-03T10:00:00.000Z"));
    expect(localCheckpoint.eligibility).toEqual({ executable: 2, future: 1, stopped: 1, earliest_eligible_at: Date.parse("2026-10-10T10:00:00.000Z") });
    expect(localCheckpoint.continuation.last_outcome?.verification_completed).toBe(false);
    expect(mock.providerCalls).toHaveLength(providerCallCount);
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    expect(response.status).toBe(200);
    const value = await response.json<any>();
    expect(value.document_change_checkpoint).toMatchObject({ read_only: true, project_id: created.project_id,
      schedule: { last_verified_at: "2026-10-01T12:00:00.000Z", next_verification_at: "2026-10-02T12:00:00.000Z", late_since: null, due: true },
      cursor: { present: true }, counts: { pending_jobs: 4, pending_jobs_with_error: 3, quarantines: 8, findings_by_status: { unexpected_conflict: 8 } },
      eligibility: { executable: 2, future: 1, stopped: 1, earliest_eligible_at: Date.parse("2026-10-10T10:00:00.000Z") },
      continuation: {
        slice_ordinal: 1, pending: true, scheduled: true, next_wake_at: Date.parse("2026-10-03T10:01:30.000Z"),
        documents_priority_next: true, feed_retry_at: Date.parse("2026-10-03T10:02:00.000Z"),
        last_outcome: {
          semantic_progress: 7, jobs_registered: 2, jobs_completed: 1, jobs_pending: 4, job_failures: 2,
          jobs_quarantined: 8, executable_jobs: 2, future_eligible_jobs: 1, stopped_unresolved_jobs: 1,
          earliest_eligible_at: Date.parse("2026-10-10T10:00:00.000Z"),
          budget_yield: true, unread_feed: true, verification_completed: false, global_notification_owed: true,
          safe_errors: ["provider_retryable", "document_slice_failed"]
        }
      } });
    expect(value.document_change_checkpoint.schedule.overdue_by_ms).toBeGreaterThan(0);
    expect(value.head_write_recovery_checkpoint).toEqual({ read_only: true, observation_scope: "local_only",
      project_id: created.project_id, observed_at: "2026-10-03T09:59:59.000Z", slice_ordinal: 12,
      resource_id: `head:DOC-${"A".repeat(24)}`, stage: "version_metadata", code: "proof_unavailable" });
    expect(value.document_change_checkpoint.cursor.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.document_change_checkpoint.recent_quarantines).toHaveLength(5);
    expect(value.document_change_checkpoint.recent_findings).toHaveLength(5);
    expect(JSON.stringify(value)).not.toMatch(/private-|PRIVATE-RESOURCE|\/private\//);
    expect(value.document_change_checkpoint.continuation.last_outcome).not.toHaveProperty("raw_error_message");
    expect(value.document_change_checkpoint.continuation.last_outcome).not.toHaveProperty("provider_path");
    expect(value.document_change_checkpoint.continuation.last_outcome).not.toHaveProperty("cursor");
    expect(value.document_change_checkpoint.continuation.last_outcome).not.toHaveProperty("request_body");
    const repeated = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    expect(repeated.status).toBe(200);
    const repeatedValue = await repeated.json<any>();
    expect(repeatedValue.document_change_checkpoint.eligibility).toEqual(value.document_change_checkpoint.eligibility);
    expect(repeatedValue.document_change_checkpoint.continuation).toEqual(value.document_change_checkpoint.continuation);
    expect(await snapshot()).toEqual(before);
  });

  it("persists the safe recovery boundary on provider failure without clearing the original fence", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-HEAD-DIAGNOSTIC-0001", "head-diagnostic");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const saved = await runInDurableObject(guard, async (instance, durableState) => {
      const target = instance as unknown as {
        persistence: ProjectOsPersistenceRuntime;
        loadOrRecoverState(): Promise<ProjectState>;
        managedDocumentService: ManagedDocumentService;
        recoverOneUnownedNavigationHeadWrite(id: string, runtime: ProjectOsPersistenceRuntime, ordinal: number): Promise<unknown>;
      };
      const state = await target.loadOrRecoverState();
      const content = "immutable diagnostic fixture";
      const working = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-WORKING-DIAGNOSTIC-0001",
        project_id: created.project_id, logical_path: "diagnostic.md", content,
        content_sha256: await sha256Text(content), created_at: at }, state);
      const sources = new ZoneNavigationSources(target.persistence);
      await sources.markCatalogReady(created.project_id, "WORKING", 0);
      await sources.beginAdoption(created.project_id, "WORKING", "DOCREQ-NAV-DIAGNOSTIC-0001", 0);
      await sources.finishAdoption(created.project_id, "WORKING", "DOCREQ-NAV-DIAGNOSTIC-0001", 0);
      const resourceId = `head:${working.document_id}`;
      await sources.beginHeadWrite(created.project_id, "WORKING", resourceId, undefined, "a".repeat(64));
      const before = [...mock.files.entries()];
      const original = target.persistence.objects.getMetadata.bind(target.persistence.objects);
      target.persistence.objects.getMetadata = async path => {
        if (path === machineDocumentHeadPath(created.project_id, working.document_id)) {
          throw new ProviderOperationError("private-token-provider-body", true, { providerId: "dropbox", code: "private-provider-code", status: 503 });
        }
        return original(path);
      };
      try {
        await expect(target.recoverOneUnownedNavigationHeadWrite(created.project_id, target.persistence, 7)).rejects.toThrow();
      } finally { target.persistence.objects.getMetadata = original; }
      expect([...mock.files.entries()]).toEqual(before);
      expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).toEqual([resourceId]);
      return { resourceId, diagnostic: await durableState.storage.get("navigation-head-recovery-diagnostic-v1") };
    });
    expect(saved.diagnostic).toMatchObject({ project_id: created.project_id, resource_id: saved.resourceId,
      slice_ordinal: 7, observed_at: expect.any(String), stage: "head_metadata", code: "provider_retryable" });
    expect(JSON.stringify(saved.diagnostic)).not.toContain("private-");
  });

  it("discovers bounded navigation refresh identities without provider calls or local mutations", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-NAV-DISCOVERY-0001", "navigation-discovery");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const requestId = "DOCREQ-NAV-DISCOVERY-REVIEW-0001";
    await runInDurableObject(guard, (_instance, state) => {
      const request = { operation: "navigation.reconcile", request_id: requestId, project_id: created.project_id,
        zone: "REVIEW", expected_project_revision: 1, expected_generation: 0, expected_index: null,
        created_at: "2026-10-04T20:00:00.000Z" };
      state.storage.sql.exec("INSERT INTO navigation_refresh_outbox VALUES (?, ?, ?)", "REVIEW", 2, JSON.stringify(request));
      state.storage.sql.exec("INSERT INTO navigation_refresh_outbox VALUES (?, ?, NULL)", "DELIVERABLES", 3);
      state.storage.sql.exec("INSERT INTO navigation_refresh_outbox VALUES (?, ?, NULL)", "WORKING", 4);
      state.storage.sql.exec("INSERT INTO navigation_refresh_outbox VALUES (?, ?, NULL)", "WORKING", 5);
      state.storage.sql.exec("INSERT INTO request_recovery VALUES ('document', ?)", requestId);
    });
    const read = async () => runInDurableObject(guard, async (instance, state) => ({
      checkpoint: (instance as any).readNavigationRefreshCheckpoint(created.project_id),
      rows: state.storage.sql.exec("SELECT * FROM navigation_refresh_outbox ORDER BY source_generation, zone").toArray(),
      alarm: await state.storage.getAlarm()
    }));
    const providerCalls = mock.providerCalls.length;
    const first = await read();
    expect(first.checkpoint).toEqual({ read_only: true, observation_scope: "local_only", has_more: true, requests: [
      { zone: "REVIEW", source_generation: 2, request_id: requestId, local_recovery_queued: true, local_recovery_stopped: false },
      { zone: "DELIVERABLES", source_generation: 3, request_id: null, local_recovery_queued: false, local_recovery_stopped: false },
      { zone: "WORKING", source_generation: 4, request_id: null, local_recovery_queued: false, local_recovery_stopped: false }
    ] });
    expect(await read()).toEqual(first);
    expect(mock.providerCalls).toHaveLength(providerCalls);
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    expect((await response.json<any>()).navigation_refresh_checkpoint).toEqual(first.checkpoint);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("UPDATE navigation_refresh_outbox SET request_json = ? WHERE zone = 'REVIEW'", JSON.stringify({ secret: "must-not-leak" }));
    });
    const malformed = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    const body = await malformed.json<any>();
    expect(body.navigation_refresh_checkpoint).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("omits the checkpoint when a retained continuation outcome field is malformed", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CHECKPOINT-OUTCOME-0001", "checkpoint-outcome");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const legacyResponse = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    const legacyBody = await legacyResponse.json<any>();
    expect(legacyResponse.status).toBe(200);
    expect(legacyBody.document_change_checkpoint.continuation.last_outcome).toBeNull();
    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("UPDATE managed_document_change_continuation SET last_outcome_json = ? WHERE singleton = 1",
        JSON.stringify({ jobs_pending: "private-malformed-value", verification_completed: true, private_diagnostic: "must-not-leak" }));
    });
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    const body = await response.json<any>();
    expect(response.status).toBe(200);
    expect(body.document_change_checkpoint).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/private-malformed-value|must-not-leak/);
  });

  it("omits the checkpoint when quarantine counters contain malformed stored values", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CHECKPOINT-COUNTERS-0001", "checkpoint-counters");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const rows = async () => runInDurableObject(guard, async (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM managed_document_change_quarantine ORDER BY job_id").toArray());
    await runInDurableObject(guard, async (_instance, state) => {
      for (const [id, attempts] of [["A", "private-row-secret"], ["B", -1], ["C", 1.5], ["D", 1]] as const) {
        state.storage.sql.exec("INSERT INTO managed_document_change_quarantine (job_id, path, code, attempts, quarantined_at) VALUES (?, ?, ?, ?, ?)",
          `CHGJOB-${id.repeat(24)}`, "/private/target", "file_target_missing", attempts, "2026-10-02T12:00:00.000Z");
      }
    });
    const before = await rows();
    const response = await guard.fetch("https://project-guard.internal/materialization-diagnostic-status");
    const body = await response.json<any>();
    expect(response.status).toBe(200);
    expect(body.document_change_checkpoint).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private-row-secret");
    expect(await rows()).toEqual(before);
  });

  it("bounds a scheduled document slice and leaves durable work for the next cron", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-document-budget";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-SCHEDULED-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    for (let index = 0; index < 6; index += 1) {
      await mock.writeExternal(`${root}/INPUTS/scheduled-${index}.pdf`, `%PDF scheduled ${index}`);
    }

    const response = await guard.fetch(
      "https://project-guard.internal/reconcile-documents?scheduled=1",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduled: true,
      jobs_registered: 6,
      jobs_completed: 1,
      jobs_pending: 5
    });
  });

  it("records provider budget exhaustion as a durable yield without failing or completing verification", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-BUDGET-YIELD-RED-0001", "scheduled-budget-yield-red");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed.listChanges = async () => { throw new Error("slice_budget_exhausted"); };
    const state = emptyProjectState(created.project_id, "Budget yield", "scheduled-budget-yield-red");
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined,
        () => Date.parse("2026-10-03T15:00:00.000Z"));
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-03T15:00:00.000Z" });
    });
    const verification = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).scheduledVerification("2026-10-03T15:00:00.000Z"));

    expect(summary).toMatchObject({ budget_yield: true, semantic_progress: 0, jobs_pending: 0, job_failures: 0, verification_completed: false });
    expect(verification.last_verified_at).toBeNull();
  });

  it("continues an eligible sibling while a has-more feed is parked behind its observed Retry-After", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-RETRY-0001", "feed-retry-sibling");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const now = Date.parse("2026-10-03T15:00:00.000Z");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      return { entries: [], cursor: "must-not-be-read-yet", has_more: true };
    };
    const state = emptyProjectState(created.project_id, "Feed retry", "feed-retry-sibling");
    const job = { job_id: "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC", change: { kind: "deleted" as const, name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental" as const, priority: 10 };
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.beginContinuationSlice(false);
      store.registerPage({ expected_cursor: null, next_cursor: "feed-cursor", jobs: [job] });
      store.finishContinuationSlice({ pending: true, next_wake_at: now + 60_000, documents_priority_next: false,
        feed_retry_at: now + 60_000, outcome: { unread_feed: true } });
      store.completeScheduledVerification("2026-10-01T15:00:00.000Z");
    });
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      (coordinator as any).processJob = async () => true;
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });

    expect(feedCalls).toBe(0);
    expect(summary).toMatchObject({ jobs_completed: 1, jobs_pending: 0, unread_feed: true, feed_retry_at: now + 60_000, verification_completed: false });
  });

  it("does not certify a scheduled scan while a pre-existing head-write ticket is unresolved", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-head-debt-verification";
    const created = await createProject("TXN-CHANGEJOB-HEAD-DEBT-VERIFY-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const sha256Raw = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const prepared = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        persistence: ProjectOsPersistenceRuntime;
        loadOrRecoverState(): Promise<ProjectState>;
        managedDocumentService: ManagedDocumentService;
      };
      const state = await target.loadOrRecoverState();
      const document = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-HEAD-DEBT-VERIFY-0001",
        project_id: created.project_id, logical_path: "verification/debt.md", content: "verified prior head",
        content_sha256: await sha256Raw("verified prior head"), created_at: at }, state);
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      const adoptionId = "DOCREQ-NAV-HEAD-DEBT-VERIFY-ADOPT-0001";
      expect(await sources.beginAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      const headPath = machineDocumentHeadPath(created.project_id, document.document_id);
      const headRaw = mock.files.get(headPath);
      if (headRaw === undefined) throw new Error("scheduled verification fixture head missing");
      const writeHash = await sha256Raw(headRaw);
      const ticket = await sources.beginHeadWrite(created.project_id, "WORKING", `head:${document.document_id}`, undefined, writeHash);
      if (!ticket) throw new Error("scheduled verification fixture ticket missing");
      mock.files.set(headPath, `${headRaw} `);
      return { documentId: document.document_id, headPath };
    });
    await runInDurableObject(guard, instance => {
      const target = instance as unknown as {
        createManagedDocumentChangeCoordinator: (runtime: ProjectOsPersistenceRuntime, scope: ProviderRequestScope,
          sliceOrdinal: number) => ManagedDocumentChangeCoordinator;
      };
      const originalCreateCoordinator = target.createManagedDocumentChangeCoordinator.bind(instance);
      vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation((runtime, scope, sliceOrdinal) => {
        runtime.changeFeed.listChanges = async () => ({ entries: [], cursor: "head-debt-empty-page", has_more: false });
        return originalCreateCoordinator(runtime, scope, sliceOrdinal);
      });
    });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(response.status).toBe(200);
    const summary = await response.json<Record<string, unknown>>();
    expect(summary).toMatchObject({ scheduled: true, scheduled_due: true, jobs_pending: 0, jobs_completed: 0,
      unread_feed: false, safe_errors: ["navigation_head_write_recovery_unresolved"], verification_completed: false });
    const durable = await runInDurableObject(guard, async (instance, durableState) => ({
      verification: new ManagedDocumentChangeJobStore(durableState.storage).scheduledVerification(new Date().toISOString()),
      jobCount: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM managed_document_change_jobs").one().count,
      ticket: await new ZoneNavigationSources((instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence)
        .readState(created.project_id, "WORKING")
    }));
    expect(durable.jobCount).toBe(0);
    expect(durable.verification).toMatchObject({ last_verified_at: null, next_verification_at: null });
    expect(durable.ticket.in_flight_resource_ids).toContain(`head:${prepared.documentId}`);
    expect(mock.files.get(prepared.headPath)).toBeTruthy();

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const afterAlarm = await runInDurableObject(guard, async (instance, durableState) => ({
      verification: new ManagedDocumentChangeJobStore(durableState.storage).scheduledVerification(new Date().toISOString()),
      outcome: new ManagedDocumentChangeJobStore(durableState.storage).continuation().last_outcome,
      source: await new ZoneNavigationSources((instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence)
        .readState(created.project_id, "WORKING")
    }));
    expect(afterAlarm.verification).toMatchObject({ last_verified_at: null, next_verification_at: null });
    expect(afterAlarm.outcome?.verification_completed).toBe(false);
    expect(afterAlarm.source.in_flight_resource_ids).toContain(`head:${prepared.documentId}`);
  });

  it("keeps an empty has-more page open without claiming semantic progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-EMPTY-HAS-MORE-0001", "empty-has-more");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed.listChanges = async () => ({ entries: [], cursor: "empty-page-next", has_more: true });
    const state = emptyProjectState(created.project_id, "Empty has more", "empty-has-more");
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined,
        () => Date.parse("2026-10-03T15:00:00.000Z"));
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-03T15:00:00.000Z" });
    });

    expect(summary).toMatchObject({ cursor_advanced: true, unread_feed: true, semantic_progress: 0, verification_completed: false });
  });

  it("advances a scheduled continuation through local alarms without another reconcile POST", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-local-continuation";
    const created = await createProject("TXN-CHANGEJOB-LOCAL-CONTINUATION-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const changeGuard = testEnv.DROPBOX_CHANGE_GUARD.getByName("global");
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    for (let index = 0; index < 12; index += 1) mock.writeExternalFolder(`${root}/INPUTS/local-${index}`);
    const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ jobs_pending: 11, jobs_completed: 1 });

    for (let index = 0; index < 2; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_050));
      await runInDurableObject(guard, instance => instance.alarm());
      if (index === 0) {
        const afterFirstAlarm = await runInDurableObject(guard, async (_instance, durableState) =>
          new ManagedDocumentChangeJobStore(durableState.storage).pendingCount());
        expect(afterFirstAlarm).toBe(3);
      }
    }
    const state = await runInDurableObject(guard, async (_instance, durableState) => ({
      pending: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
      checkpoint: new ManagedDocumentChangeJobStore(durableState.storage).continuation()
    }));
    expect(state.pending).toBe(0);
    expect(state.checkpoint.pending).toBe(false);
    expect(mock.folders.has(`${root}/INPUTS/local-11`)).toBe(true);
    const acknowledgement = await changeGuard.fetch("https://dropbox-change-guard.internal/status", { method: "GET" });
    expect(acknowledgement.status).toBe(200);
    expect(await acknowledgement.json<Record<string, unknown>>()).toMatchObject({ requested_generation: 1 });
  }, 15_000);

  it.each([
    { count: 1, other: false, preparation: false },
    { count: 32, other: false, preparation: false },
    { count: 32, other: true, preparation: false },
    { count: 32, other: true, preparation: true }
  ])("parks a full or solitary recovery cohort before discovery until its deadline: $count/$other/$preparation", async ({ count, other, preparation }) => {
    // A capacity check after parent admission is too late: it must prevent
    // fresh provider discovery, even with a sibling hint/preparation present.
    const mock = installDropboxMock();
    resetAfterRetryFaultFixture = true;
    const created = await createProject("TXN-CHANGEJOB-PARKED-COHORT-0001", "parked-cohort");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const prepared = await runInDurableObject(guard, async (instance, durableState) => {
      const target = instance as any;
      const state = await target.loadOrRecoverState();
      const document = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-PARKED-COHORT-SIBLING-0001",
        project_id: created.project_id, logical_path: "parked/sibling.md", content: "late independent document",
        content_sha256: await sha256Text("late independent document"), created_at: at }, state);
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      expect(await sources.beginAdoption(created.project_id, "WORKING", "DOCREQ-PARKED-COHORT-ADOPT-0001", 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", "DOCREQ-PARKED-COHORT-ADOPT-0001", 0)).toBe(true);
      expect(await sources.beginHeadWrite(created.project_id, "WORKING", `head:${document.document_id}`, undefined, "b".repeat(64))).toBeTruthy();
      const now = Date.now();
      const deadline = now + 30_000;
      const locators = Array.from({ length: count }, (_, index) => ({
        request_hash: (index + 1).toString(16).padStart(64, "0"),
        resource_id: `head:DOC-${(index + 1).toString(16).toUpperCase().padStart(24, "0")}`,
        next_attempt_at: deadline
      }));
      const key = "navigation-head-recovery-pending-v1";
      const stored = { project_id: created.project_id, ...locators[0], deferred: locators.slice(1), cursor: 0, other_candidates: other };
      await durableState.storage.put(key, stored);
      if (preparation) await durableState.storage.put("navigation-head-recovery-preparation-v1", { intentionally_unconsulted: true });
      return { now, deadline, stored };
    });
    const before = new Map(mock.files);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(prepared.now);
      await runInDurableObject(guard, async (instance, durableState) => {
        const target = instance as any;
        const key = "navigation-head-recovery-pending-v1";
        for (let attempt = 0; attempt < 2; attempt++) {
          const slice = target.createManagedDocumentSlice(Date.now());
          try {
            expect(await target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, attempt, false, slice.scope))
              .toEqual({ status: "unresolved", remainingCandidates: true, next_attempt_at: prepared.deadline });
            expect(slice.calls()).toBe(0);
          } finally { clearTimeout(slice.abortTimer); }
          expect(await durableState.storage.get(key)).toEqual(prepared.stored);
          expect(mock.files).toEqual(before);
        }
      });
      vi.setSystemTime(prepared.deadline);
      await runInDurableObject(guard, async (instance, durableState) => {
        const target = instance as any;
        const key = "navigation-head-recovery-pending-v1";
        // At the deadline rotate an EXISTING locator. These local fixture
        // hints have no canonical I: the real engine refuses it, never
        // inventing an admission or occupying a 33rd slot.
        for (let ordinal = 0; ordinal < Math.min(count, 2); ordinal++) {
          const slice = target.createManagedDocumentSlice(Date.now());
          const downloadStart = mock.downloadCalls.length;
          try {
            await expect(target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, ordinal, false, slice.scope))
              .rejects.toThrow("navigation_head_recovery_reacquisition_conflict");
            expect(mock.downloadCalls[downloadStart]).toBe(`${machineDocumentRoot(created.project_id)}/navigation-sources/head-write-recovery/${(ordinal + 1).toString(16).padStart(64, "0")}/intent.json`);
            expect(slice.calls()).toBeGreaterThan(0);
            expect(slice.calls()).toBeLessThanOrEqual(64);
          } finally { clearTimeout(slice.abortTimer); }
          expect(mock.files).toEqual(before);
          const pending = await durableState.storage.get<any>(key);
          expect([pending, ...pending.deferred]).toHaveLength(count);
          expect(pending.cursor).toBe(ordinal + 1);
        }
      });
    } finally { vi.useRealTimers(); }
  });

  it.each(["baseline", "superseded", "superseded-alone", "superseded-prepared"])("admits current-head recovery through ProjectGuard without rewriting the canonical head: %s", async (scenario) => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-CURRENT-HEAD-RECOVERY-0001", "current-head-recovery");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const originalGuard = await runInDurableObject(guard, instance => (instance as any).env.RULE_ADMISSION_SIGNING_KEY);
    const originalRegistry = await runInDurableObject(registry, instance => ({
      signingKey: (instance as any).env.RULE_ADMISSION_SIGNING_KEY, governanceToken: (instance as any).env.RULE_GOVERNANCE_TOKEN
    }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(guard, instance => restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalGuard));
      await runInDurableObject(registry, instance => {
        restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalRegistry.signingKey);
        restoreOptionalEnvBinding((instance as any).env, "RULE_GOVERNANCE_TOKEN", originalRegistry.governanceToken);
      });
    };
    resetAfterRetryFaultFixture = true;
    await bootstrapRuleAdmissionGovernance(testEnv, "current-head-recovery-rules", created.project_id);
    vi.useFakeTimers();
    const measured = await runInDurableObject(guard, async (instance) => {
      const target = instance as any;
      const state = await target.loadOrRecoverState();
      const content = "Keep the verified current document, not the unknown former intention.";
      const document = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-BASE-0001",
        project_id: created.project_id, logical_path: "recovery/current.md", content,
        content_sha256: await sha256Text(content), created_at: at }, state);
      const review = await target.managedDocumentService.promoteToReview({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-REVIEW-0001",
        project_id: created.project_id, document_id: document.document_id, expected_version_id: document.version_id, created_at: at }, state);
      await target.managedDocumentService.publish({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-PUBLISH-0001",
        project_id: created.project_id, document_id: document.document_id, expected_version_id: review.version_id, created_at: at }, state);
      const draft = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-DRAFT-0001",
        project_id: created.project_id, logical_path: "recovery/current.md", content: content + " next version",
        content_sha256: await sha256Text(content + " next version"), created_at: at }, state);
      await target.managedDocumentService.promoteToReview({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-REVIEW-0002",
        project_id: created.project_id, document_id: document.document_id, expected_version_id: draft.version_id, created_at: at }, state);
      const ledger = new DocumentLedgerRepository(target.persistence);
      const preparedHead = await ledger.readHead(created.project_id, document.document_id);
      // A genuine supported cycle preserves the published version while its
      // replacement is reviewed. Do not bypass DOCUMENT_IN_REVIEW to create a
      // fictitious third visible stage merely for this integration fixture.
      expect(preparedHead?.working_version_id).toBeUndefined();
      expect(preparedHead?.review_version_id).toBeTruthy();
      expect(preparedHead?.published_version_id).toBeTruthy();
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      const adoptionId = "DOCREQ-CURRENT-HEAD-RECOVERY-ADOPT-0001";
      expect(await sources.beginAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      const resource = `head:${document.document_id}`;
      expect(await sources.beginHeadWrite(created.project_id, "WORKING", resource, undefined, "a".repeat(64))).toBeTruthy();
      const headPath = machineDocumentHeadPath(created.project_id, document.document_id);
      const before = mock.files.get(headPath);
      const uploads = mock.uploadCalls.filter(path => path === headPath).length;
      const signingKey = target.env.RULE_ADMISSION_SIGNING_KEY;
      delete target.env.RULE_ADMISSION_SIGNING_KEY;
      try {
        const unavailable = await target.recoverOneUnownedNavigationHeadWrite(created.project_id, target.persistence, 0);
        expect(unavailable.status).toBe("unresolved");
        expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).toContain(resource);
        expect(await target.ctx.storage.get("navigation-head-recovery-pending-v1")).toBeUndefined();
      } finally { target.env.RULE_ADMISSION_SIGNING_KEY = signingKey; }
      const delegate = mock.spy.getMockImplementation()!;
      let interruptedBeforeIntent = false;
      let interruptedAfterClear = false;
      let observedOrdinal = -1;
      const faultBoundaries: Array<{ phase: string; ordinal: number }> = [];
      mock.spy.mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        const arg = request.headers.get("Dropbox-API-Arg");
        const path = arg ? (JSON.parse(arg) as { path?: string }).path : null;
        if (!interruptedBeforeIntent && url.pathname === "/2/files/upload" && path?.endsWith("/progress.json")) {
          const admissionRaw = mock.files.get(path.replace(/progress\.json$/, "admission.json"));
          if (admissionRaw && JSON.parse(admissionRaw).admission.kind === "navigation-head-recovery") {
            interruptedBeforeIntent = true;
            faultBoundaries.push({ phase: "child_initial_progress_before_write", ordinal: observedOrdinal });
            const locator = await target.ctx.storage.get("navigation-head-recovery-pending-v1");
            expect(locator).toMatchObject({ resource_id: resource });
            const childAdmission = JSON.parse(admissionRaw).admission;
            expect(childAdmission.diagnosed_drift_refs).toHaveLength(1);
            expect(JSON.parse(mock.files.get(childAdmission.diagnosed_drift_refs[0])!).admission)
              .toMatchObject({ kind: "navigation-head-recovery-parent", project_id: created.project_id });
            return new Response(JSON.stringify({ error_summary: "injected_before_recovery_intent" }), { status: 503 });
          }
        }
        if (!interruptedAfterClear && url.pathname === "/2/files/upload"
          && path?.includes("/head-write-recovery/") && path.endsWith("/receipt.json")) {
          const source = JSON.parse(mock.files.get(`${machineDocumentRoot(created.project_id)}/navigation-sources/state.json`)!);
          expect(source.zones.WORKING.in_flight_writes).toEqual([]);
          interruptedAfterClear = true;
          faultBoundaries.push({ phase: "receipt_before_write_after_fence_clear", ordinal: observedOrdinal });
          return new Response(JSON.stringify({ error_summary: "injected_after_recovery_fence_clear" }), { status: 503 });
        }
        return delegate(input, init);
      });
      let recovered = false;
      let parked = false;
      let replaced = false;
      let siblingResource: string | null = null;
      let preservedA: Array<[string, string]> = [];
      let siblingPreparation: unknown = null;
      let concurrentPreparationReplaced = false;
      let oldResourceBecameDueDuringSibling = false;
      const sliceCosts: number[] = [];
      const interruptions: string[] = [];
      let oldEightCallOutcome: unknown = null;
      for (let ordinal = 0; ordinal < (["superseded-alone", "superseded-prepared"].includes(scenario) ? 16 : 30) && !recovered && !parked; ordinal++) {
        observedOrdinal = ordinal;
        const slice = target.createManagedDocumentSlice(Date.now());
        try {
          const result = await target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime,
            scenario.startsWith("superseded") ? 0 : ordinal, false, slice.scope);
          recovered = scenario === "baseline" ? result.status === "recovered" : siblingResource !== null && result.status === "recovered"
            && !(await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids.includes(siblingResource);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          interruptions.push(text);
          if (text === "execution_evidence_unavailable" && interruptedBeforeIntent && !interruptedAfterClear) {
            expect(await target.ctx.storage.get("navigation-head-recovery-pending-v1")).toMatchObject({ resource_id: resource });
            expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).toContain(resource);
          } else {
            if (!text.includes("slice_budget_exhausted") && !interruptedAfterClear) throw error;
            expect(text.includes("slice_budget_exhausted") || interruptedAfterClear).toBe(true);
            expect(await target.ctx.storage.get("navigation-head-recovery-pending-v1")).toBeTruthy();
          }
        } finally {
          clearTimeout(slice.abortTimer);
          sliceCosts.push(slice.calls());
          expect(slice.calls()).toBeLessThanOrEqual(64);
        }
        if (ordinal === 7) oldEightCallOutcome = { recovered, interruptedBeforeIntent, interruptedAfterClear,
          diagnostic: await target.ctx.storage.get("navigation-head-recovery-diagnostic-v1"),
          pending: await target.ctx.storage.get("navigation-head-recovery-pending-v1"),
          progress: [...mock.files.entries()].filter(([path]) => path.endsWith("/progress.json"))
            .map(([, raw]) => JSON.parse(raw)).filter(record => ["navigation-head-recovery", "navigation-head-recovery-parent"].includes(record.kind)) };
        const pointer = await target.ctx.storage.get("navigation-head-recovery-pending-v1") as { next_attempt_at: number } | undefined;
        parked = ["superseded-alone", "superseded-prepared"].includes(scenario) && pointer !== undefined && pointer.next_attempt_at > Date.now();
        if (scenario === "superseded" && !oldResourceBecameDueDuringSibling && siblingResource) {
          const childB = [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
            .find(record => record?.admission?.kind === "navigation-head-recovery"
              && record.admission.resources.some((entry: any) => entry.resource_id === siblingResource));
          const current = pointer as unknown as { resource_id: string; next_attempt_at?: number; deferred: Array<{ resource_id: string; next_attempt_at?: number }> };
          const parkedA = current && [current, ...current.deferred].find(item => item.resource_id === resource);
          if (childB && parkedA?.next_attempt_at) {
            vi.setSystemTime(parkedA.next_attempt_at);
            oldResourceBecameDueDuringSibling = true;
          }
        }
        if (scenario.startsWith("superseded") && interruptedAfterClear && !replaced) {
          // A provider replacement preserves A's valid contents but changes
          // its exact physical version between slices. Independent B remains
          // recoverable; A must not monopolize it or acquire a false success.
          await mock.writeExternal(headPath, before!);
          replaced = true;
          preservedA = [...mock.files.entries()].filter(([path]) => path.includes("/executions/")
            || path.includes("/head-write-recovery/"));
          if (["superseded", "superseded-prepared"].includes(scenario)) {
            const sibling = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-CURRENT-HEAD-RECOVERY-SIBLING-0001",
            project_id: created.project_id, logical_path: "recovery/sibling.md", content: "independent sibling",
            content_sha256: await sha256Text("independent sibling"), created_at: at }, state);
            siblingResource = `head:${sibling.document_id}`;
            expect(await sources.beginHeadWrite(created.project_id, "WORKING", siblingResource, undefined, "b".repeat(64))).toBeTruthy();
            if (scenario === "superseded-prepared") {
              // Acquire real DATA for B, not an authority or a model's claim.
              const repository = new DocumentLedgerRepository(target.persistence) as any;
              const snapshot = await sources.headWriteRecoveryCandidateSnapshot(created.project_id);
              const tickets = snapshot!.candidates.find(group => group[0].resource_id === siblingResource)!;
              const proof = await repository.readCurrentHeadRecoveryProof(created.project_id, siblingResource, undefined, undefined, true);
              expect(proof.next_pointer_index).toBe(proof.pointer_bindings.length);
              siblingPreparation = await repository.makeHeadWriteRecoveryPreparation({ schema_version: "1.0",
                preparation_type: "navigation-head-recovery-preparation", project_id: created.project_id, provider_id: "dropbox",
                created_at_ms: Date.now(), expires_at_ms: Date.now() + 300_000, resource_id: siblingResource,
                original_tickets: tickets, source_state: snapshot!.source_state, ...proof });
              const transaction = target.ctx.storage.transaction.bind(target.ctx.storage);
              vi.spyOn(target.ctx.storage, "transaction").mockImplementation(async (closure: any) => {
                if (!concurrentPreparationReplaced) {
                  await target.ctx.storage.put("navigation-head-recovery-preparation-v1", siblingPreparation);
                  concurrentPreparationReplaced = true;
                }
                return transaction(closure);
              });
            }
          }
        }
      }
      expect(interruptedBeforeIntent).toBe(true);
      expect(interruptedAfterClear).toBe(true);
      if (scenario.startsWith("superseded")) for (const [path, raw] of preservedA) expect(mock.files.get(path)).toBe(raw);
      if (scenario === "superseded-prepared") {
        expect(parked).toBe(true);
        expect(concurrentPreparationReplaced).toBe(true);
        expect(await target.ctx.storage.get("navigation-head-recovery-preparation-v1")).toEqual(siblingPreparation);
        expect([...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
          .filter(record => record?.admission?.kind === "navigation-head-recovery-parent")).toHaveLength(1);
        return { sliceCosts, interruptions, parked, concurrentSiblingPreparationPreserved: true, oldEightCallOutcome };
      }
      if (scenario === "superseded-alone") {
        expect(parked).toBe(true);
        const pointer = await target.ctx.storage.get("navigation-head-recovery-pending-v1") as { next_attempt_at: number; other_candidates: boolean };
        const beforeIdle = new Map(mock.files);
        for (let attempt = 0; attempt < 2; attempt++) {
          const slice = target.createManagedDocumentSlice(Date.now());
          try {
            expect(await target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, attempt, false, slice.scope))
              .toEqual({ status: "unresolved", remainingCandidates: true, next_attempt_at: pointer.next_attempt_at });
            expect(slice.calls()).toBe(0);
          } finally { clearTimeout(slice.abortTimer); }
          expect(mock.files).toEqual(beforeIdle);
        }
        expect(pointer.other_candidates).toBe(false);
        expect(mock.files.get(headPath)).toBe(before);
        return { sliceCosts, interruptions, parked, originalIdentityPreserved: true, oldEightCallOutcome,
          next_attempt_at: pointer.next_attempt_at };
      }
      expect(recovered, JSON.stringify({ scenario, sliceCosts, interruptions,
        pending: await target.ctx.storage.get("navigation-head-recovery-pending-v1"), siblingResource,
        source: await sources.readState(created.project_id, "WORKING") })).toBe(true);
      if (scenario === "superseded") {
        expect(oldResourceBecameDueDuringSibling).toBe(true);
        expect(interruptions.filter(code => code === "navigation_head_recovery_completion_missing")).toHaveLength(2);
        expect(mock.files.get(headPath)).toBe(before);
        const remaining = await target.ctx.storage.get("navigation-head-recovery-pending-v1");
        expect(remaining).toBeTruthy();
        const progresses = [...mock.files.entries()].filter(([path]) => path.endsWith("/progress.json"))
          .map(([, raw]) => JSON.parse(raw)).filter(record => record.kind === "navigation-head-recovery");
        expect(progresses.some(record => record.status === "finalized" && record.terminal)).toBe(true);
        expect(progresses.some(record => !record.terminal)).toBe(true);
        const finalized = progresses.find(record => record.status === "finalized" && record.terminal);
        expect(JSON.parse(mock.files.get(finalized.receipt_ref)!)).toMatchObject({ resource_id: siblingResource,
          status: "committed", original_outcome: "unknown" });
        const pending = remaining as { request_hash: string };
        expect(progresses.find(record => record.request_hash === pending.request_hash)).toMatchObject({ terminal: false });
        const compact = await sources.compactCatalogManifest(created.project_id, "WORKING");
        expect(compact?.coalesced_dirty.find(item => item.resource_id === siblingResource)).toMatchObject({
          latest_generation: 3, covered_generations: [{ start: 2, end: 2 }] });
        return { sliceCosts, interruptions, interruptedBeforeIntent, interruptedAfterClear, recovered, faultBoundaries, oldEightCallOutcome,
          oldResourceBecameDueDuringSibling };
      }
      expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).not.toContain(resource);
      expect(await sources.hasDirtyMarker(created.project_id, "WORKING", resource)).toBe(true);
      expect(mock.files.get(headPath)).toBe(before);
      expect(mock.uploadCalls.filter(path => path === headPath)).toHaveLength(uploads);
      expect((await target.ctx.storage.get("navigation-head-recovery-pending-v1")) ?? null).toBeNull();
      const admissions = [...mock.files.entries()].filter(([path]) => path.endsWith("/admission.json")
        && path.includes("/executions/")).map(([, raw]) => JSON.parse(raw));
      expect(admissions.some(record => record.admission.kind === "navigation-head-recovery"
        && record.admission.operation === "project.materialize"
        && record.admission.resources.some((entry: any) => entry.resource_id === resource && entry.zone === "WORKING"))).toBe(true);
      const progress = [...mock.files.entries()].filter(([path]) => path.endsWith("/progress.json"))
        .map(([, raw]) => JSON.parse(raw)).find(record => record.kind === "navigation-head-recovery");
      expect(progress).toMatchObject({ status: "finalized", terminal: true, code: null });
      expect(JSON.parse(mock.files.get(progress.receipt_ref)!)).toMatchObject({ status: "committed", original_outcome: "unknown" });
      expect(JSON.parse(mock.files.get(progress.finalization_ref)!)).toMatchObject({ request_hash: progress.request_hash,
        postconditions: ["exact_current_head_revalidated", "source_dirty_generation_durable", "recovery_fence_absent"] });
      return { sliceCosts, interruptions, interruptedBeforeIntent, interruptedAfterClear, recovered, faultBoundaries, oldEightCallOutcome };
    });
    if (scenario === "superseded-alone") {
      const beforeDeadlineRetry = new Map(mock.files);
      vi.setSystemTime((measured as { next_attempt_at: number }).next_attempt_at);
      await runInDurableObject(guard, async (instance, durableState) => {
        const target = instance as any;
        const slice = target.createManagedDocumentSlice(Date.now());
        try {
          await expect(target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, 0, false, slice.scope))
            .rejects.toThrow("navigation_head_recovery_completion_missing");
          expect(slice.calls()).toBeGreaterThan(0);
          expect(slice.calls()).toBeLessThanOrEqual(64);
          expect((await durableState.storage.get<any>("navigation-head-recovery-pending-v1")).next_attempt_at).toBe(Date.now() + 30_000);
          expect(mock.files).toEqual(beforeDeadlineRetry);
        } finally { clearTimeout(slice.abortTimer); }
      });
    }
    vi.useRealTimers();
    console.log("current-head recovery real slice costs", JSON.stringify(measured));
  });

  it.each([{ latencyMs: 150, maximum: false, policy: "bootstrap" }, { latencyMs: 650, maximum: false, policy: "bootstrap" },
    { latencyMs: 650, maximum: true, policy: "bootstrap" }, { latencyMs: 650, maximum: false, policy: "active" },
    { latencyMs: 650, maximum: false, policy: "repair-only-refusal" }, { latencyMs: 650, maximum: false, policy: "retired" },
    { latencyMs: 650, maximum: false, policy: "exception-revoked" }, { latencyMs: 650, maximum: false, policy: "incompatible" },
    { latencyMs: 150, maximum: false, policy: "unrelated" },
    ...["source", "receipt", "certificate", "history"].map(boundary => ({ latencyMs: 150, maximum: false, policy: `ack-${boundary}` })),
    ...["receipt", "certificate", "history"].map(boundary => ({ latencyMs: 150, maximum: false, policy: `ack-parent-${boundary}` })),
    ...["oversized", "foreign-project", "foreign-provider", "wrong-head-id", "future"].map(kind => ({ latencyMs: 650, maximum: false, policy: `prep-${kind}` })),
    { latencyMs: 150, maximum: false, policy: "four-pointers" }, { latencyMs: 150, maximum: false, policy: "project-unrelated" },
    { latencyMs: 650, maximum: false, policy: "project-paused" }, { latencyMs: 650, maximum: false, policy: "concurrent-discovery" },
    { latencyMs: 650, maximum: false, policy: "fairness" }])(
    "finishes current-head recovery across real alarms with positive provider latency: $latencyMs ms maximum=$maximum policy=$policy", async ({ latencyMs, maximum, policy }) => {
    // Break caught: repeating the complete preflight before each NEW admission
    // can starve an unchanged, provable head forever under the real18s scope.
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-SLOW-HEAD-0001", "slow-head");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const guardKey = await runInDurableObject(guard, instance => (instance as any).env.RULE_ADMISSION_SIGNING_KEY);
    const registryKeys = await runInDurableObject(registry, instance => ({
      signing: (instance as any).env.RULE_ADMISSION_SIGNING_KEY, governance: (instance as any).env.RULE_GOVERNANCE_TOKEN
    }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(guard, instance => restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", guardKey));
      await runInDurableObject(registry, instance => {
        restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", registryKeys.signing);
        restoreOptionalEnvBinding((instance as any).env, "RULE_GOVERNANCE_TOKEN", registryKeys.governance);
      });
    };
    resetAfterRetryFaultFixture = true;
    await bootstrapRuleAdmissionGovernance(testEnv, "slow-head-rules", created.project_id);
    const prepared = await runInDurableObject(guard, async (instance, durableState) => {
      const target = instance as any;
      const state = await target.loadOrRecoverState();
      const content = "Unchanged bytes must survive slow but successful provider reads.";
      const document = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-SLOW-HEAD-BASE-0001",
        project_id: created.project_id, logical_path: "slow/current.md", content,
        content_sha256: await sha256Text(content), created_at: at }, state);
      if (maximum) {
        const ledger = new DocumentLedgerRepository(target.persistence);
        const head = await ledger.readHead(created.project_id, document.document_id);
        const working = await ledger.readVersion(created.project_id, document.document_id, head!.working_version_id!);
        const reviewId = `VER-REQ-${"B".repeat(24)}`;
        const publishedId = `VER-REQ-${"C".repeat(24)}`;
        await ledger.writeVersion({ ...working!, version_id: reviewId, stage: "review", parent_version_id: working!.version_id });
        await ledger.writeVersion({ ...working!, version_id: publishedId, stage: "published", parent_version_id: reviewId });
        await ledger.writeHead({ ...head!, review_version_id: reviewId, published_version_id: publishedId });
      }
      const sources = new ZoneNavigationSources(target.persistence);
      const resource = `head:${document.document_id}`;
      const zones = maximum ? ["WORKING", "REVIEW", "DELIVERABLES"] as const : ["WORKING"] as const;
      for (const zone of zones) {
        const adoptionId = `DOCREQ-SLOW-HEAD-ADOPT-${zone}-0001`;
        expect(await sources.markCatalogReady(created.project_id, zone, 0)).toBe(true);
        expect(await sources.beginAdoption(created.project_id, zone, adoptionId, 0)).toBe(true);
        expect(await sources.finishAdoption(created.project_id, zone, adoptionId, 0)).toBe(true);
        expect(await sources.beginHeadWrite(created.project_id, zone, resource, undefined, "a".repeat(64))).toBeTruthy();
      }
      if (maximum) {
        // Historical fixture: three legal pointers/three zones, two older
        // markers and one newer marker. Never reduce it after a failure.
        const sourcePath = `${machineDocumentRoot(created.project_id)}/navigation-sources/state.json`;
        const source = JSON.parse((await target.persistence.objects.readText(sourcePath))!);
        for (const zone of zones) {
          source.zones[zone].generation = 2;
          if (zone !== "REVIEW") source.zones[zone].in_flight_writes[0].generation = 2;
          await target.persistence.objects.upsertText(`${zoneNavigationDirtyRoot(created.project_id, zone)}/${await sha256Text(resource)}.json`,
            JSON.stringify({ schema_version: "1.0", resource_id: resource, generation: zone === "REVIEW" ? 2 : 1, entry_hash: null }));
        }
        source.state_revision++;
        await target.persistence.objects.upsertText(sourcePath, JSON.stringify(source));
      }
      if (policy === "four-pointers") {
        const headPath = machineDocumentHeadPath(created.project_id, document.document_id);
        const current = JSON.parse(mock.files.get(headPath)!);
        await mock.writeExternal(headPath, JSON.stringify({ ...current, reference_version_id: `VER-REQ-${"D".repeat(24)}`,
          review_version_id: `VER-REQ-${"B".repeat(24)}`, published_version_id: `VER-REQ-${"C".repeat(24)}` }));
      }
      if (!["bootstrap", "four-pointers", "concurrent-discovery"].includes(policy) && !policy.startsWith("ack-") && !policy.startsWith("prep-")) {
        const rule = ruleFixture("GLOBAL", { rule_id: "RULE-HEAD-RECOVERY-ACTIVE", operations: policy === "repair-only-refusal"
          ? ["project.repair"] : ["project.materialize", "project.repair"],
          resource_scope: { resource_types: ["project", "document"], zones: ["DOCUMENTS", "WORKING", "REVIEW", "DELIVERABLES"] },
          check_id: "expected_version", parameters: { required: ["repair-only-refusal", "exception-revoked"].includes(policy) } });
        await appendGovernanceFixture(target.persistence, "rule.propose", { rule });
        await appendGovernanceFixture(target.persistence, "rule.accept", { rule_id: rule.rule_id, version: 1 });
        await appendGovernanceFixture(target.persistence, "rule.activate", { rule_id: rule.rule_id, version: 1,
          activation_evidence: ["fixture:legacy-active-control"] });
        if (policy === "exception-revoked") await appendGovernanceFixture(target.persistence, "rule.exception.grant", {
          exception: exceptionFixture({ exception_id: "EXC-HEAD-RECOVERY", rule_id: rule.rule_id, project_id: created.project_id,
            resources: [`document-reconcile@${state.revision}`, resource], operations: rule.operations,
            granted_at: new Date().toISOString(), expires_at: "2099-01-01T00:00:00.000Z" }) });
        if (policy === "repair-only-refusal") {
          let refused = false;
          for (let attempt = 0; attempt < 4; attempt++) {
            const slice = target.createManagedDocumentSlice(Date.now());
            try { await target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, attempt, false,
              slice.scope, undefined, "project.repair");
              refused ||= (await durableState.storage.get<{ code?: string }>("navigation-head-recovery-diagnostic-v1"))?.code === "admission_unavailable"; }
            catch (error) { expect(String(error)).toContain("EXPECTED_VERSION_REQUIRED"); refused = true; }
            finally { clearTimeout(slice.abortTimer); }
          }
          expect(refused).toBe(true);
          const parents = [...mock.files.values()].map(raw => { try { return JSON.parse(raw).admission; } catch { return null; } })
            .filter(admission => admission?.kind === "navigation-head-recovery-parent");
          expect(parents).toEqual([]);
          expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).toContain(resource);
          await durableState.storage.delete("navigation-head-recovery-preparation-v1");
        }
      }
      let originalParentId: string | null = null;
      let originalParentBytes: string | null = null;
      if (policy === "concurrent-discovery") {
        const attempt = async (ordinal: number) => {
          const slice = target.createManagedDocumentSlice(Date.now());
          try { return await target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, ordinal, false, slice.scope); }
          finally { clearTimeout(slice.abortTimer); }
        };
        await attempt(0); // actual bounded preparation, no pre-intent effect
        const concurrent = await Promise.allSettled([attempt(1), attempt(1)]);
        expect(concurrent.some(result => result.status === "fulfilled")).toBe(true);
        const parents = [...mock.files.values()].map(raw => { try { return { raw, record: JSON.parse(raw) }; } catch { return null; } })
          .filter(item => item?.record.admission?.kind === "navigation-head-recovery-parent");
        expect(parents).toHaveLength(1);
        originalParentId = parents[0]!.record.admission.request_id;
        originalParentBytes = parents[0]!.raw;
        expect([...mock.files.keys()].some(path => path.includes("/head-write-recovery/") && path.endsWith("/intent.json"))).toBe(false);
        for (const key of (await durableState.storage.list({ prefix: "navigation-head-recovery-" })).keys()) await durableState.storage.delete(key);
        expect((await sources.readState(created.project_id, "WORKING")).in_flight_resource_ids).toContain(resource);
      }
      const startedAt = Date.now();
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.beginContinuationSlice(true, startedAt);
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
        documents_priority_next: false, feed_retry_at: null, outcome: {} });
      durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = 0 WHERE singleton = 1");
      // The explicit helper still runs the real alarm; the host must not claim
      // the fixture before the latency observer has been installed.
      await durableState.storage.setAlarm(startedAt + 60_000);
      return { resource, revision: state.revision, startedAt, originalParentId, originalParentBytes,
        headPath: machineDocumentHeadPath(created.project_id, document.document_id) };
    });
    const originalHead = mock.files.get(prepared.headPath);
    const delegate = mock.spy.getMockImplementation()!;
    let inActualAlarm = false;
    let transportCalls = 0;
    const scopes: Array<{ calls: () => number; scope: ProviderRequestScope; governanceCalls: () => number }> = [];
    const observations: unknown[] = [];
    const recoveryMeasurements: unknown[] = [];
    const admissionMeasurements: unknown[] = [];
    const providerOperations: Array<Record<string, unknown>> = [];
    let activeAlarmTurn = -1;
    let alarmCallStart = 0;
    let lostAckPath: string | null = null;
    let parentAckPreserved: Map<string, string> | null = null;
    let parentAckAdmission: { path: string; bytes: string } | null = null;
    let parentAckSequence: number | null = null;
    vi.useFakeTimers();
    try {
      mock.spy.mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (inActualAlarm && new URL(request.url).hostname.endsWith("dropboxapi.com")) {
          transportCalls += 1;
          vi.setSystemTime(Date.now() + latencyMs);
        }
        const response = await delegate(input, init);
        const argument = request.headers.get("Dropbox-API-Arg");
        const path = argument ? JSON.parse(argument).path as string : null;
        if (inActualAlarm && response.ok && !lostAckPath && policy.startsWith("ack-parent-")
          && new URL(request.url).pathname === "/2/files/upload" && path) {
          const child = [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
            .find(record => record?.kind === "navigation-head-recovery" && record.status === "finalized" && record.terminal);
          if (child) {
            const childAdmission = JSON.parse(mock.files.get(child.admission_ref)!).admission;
            const admissionPath = childAdmission.diagnosed_drift_refs[0];
            const admissionBytes = mock.files.get(admissionPath)!;
            const parent = JSON.parse(admissionBytes).admission;
            const parentRoot = admissionPath.replace(/\/admission\.json$/, "");
            const written = JSON.parse(mock.files.get(path)!);
            const matches = policy === "ack-parent-receipt" && path === `${parentRoot}/receipt.json`
              || policy === "ack-parent-certificate" && path.startsWith(`${parentRoot}/finalizations/`)
              || policy === "ack-parent-history" && path.startsWith(`${parentRoot}/history/`)
                && written.status === "finalized" && written.terminal === true;
            if (matches) {
              expect(parent.kind).toBe("navigation-head-recovery-parent");
              expect(written.request_id).toBe(parent.request_id);
              expect(written.request_hash).toBe(parent.request_hash);
              parentAckAdmission = { path: admissionPath, bytes: admissionBytes };
              parentAckSequence = JSON.parse(mock.files.get(`${parentRoot}/progress.json`)!).sequence;
              // All child, source, intention, catalog and business bytes are
              // frozen at this actual successful parent-tail upload. Only
              // that parent's original journal may advance afterward.
              parentAckPreserved = new Map([...mock.files.entries()].filter(([file]) => !file.startsWith(`${parentRoot}/`)));
              lostAckPath = path;
              return new Response(JSON.stringify({ error_summary: "parent_ack_lost_AFTER_successful_upload" }), { status: 503 });
            }
          }
        }
        if (inActualAlarm && response.ok && !lostAckPath && policy.startsWith("ack-")
          && new URL(request.url).pathname === "/2/files/upload" && path
          && (policy === "ack-source" && path.endsWith("/navigation-sources/state.json")
            || policy === "ack-receipt" && path.includes("/head-write-recovery/") && path.endsWith("/receipt.json")
            || policy === "ack-certificate" && path.includes("/head-write-recovery/") && path.includes("/certificate-")
            || policy === "ack-history" && path.includes("/history/"))) {
          expect(mock.files.has(path), "loss must occur after successful physical upload").toBe(true);
          lostAckPath = path;
          return new Response(JSON.stringify({ error_summary: "ack_lost_AFTER_successful_upload" }), { status: 503 });
        }
        return response;
      });
      await runInDurableObject(guard, instance => {
        const target = instance as any;
        const createSlice = target.createManagedDocumentSlice.bind(instance);
        vi.spyOn(target, "createManagedDocumentSlice").mockImplementation((...args: unknown[]) => {
          const slice = createSlice(...args);
          scopes.push({ ...slice, governanceCalls: () => target.governanceScopeCalls.get(slice.scope) ?? 0 });
          for (const [port, methods] of [[slice.runtime.objects, ["getMetadata", "readText", "createText"]],
            [slice.runtime.conditionalWrite, ["writeTextConditional"]]] as const) {
            for (const method of methods) {
              const original = (port as any)[method].bind(port);
              vi.spyOn(port as any, method).mockImplementation(async (...operationArgs: any[]) => {
                if (!inActualAlarm) return original(...operationArgs);
                const observation: Record<string, unknown> = { turn: activeAlarmTurn, method, path: operationArgs[0],
                  calls_at_entry: transportCalls - alarmCallStart,
                  elapsed_at_entry_ms: Date.now() - (slice.scope.deadlineMs - 18_000), completed: false };
                providerOperations.push(observation);
                try { const result = await original(...operationArgs); observation.completed = true; return result; }
                catch (error) { observation.error = error instanceof Error ? error.message : String(error); throw error; }
                finally {
                  observation.calls_at_exit = transportCalls - alarmCallStart;
                  observation.elapsed_at_exit_ms = Date.now() - (slice.scope.deadlineMs - 18_000);
                }
              });
            }
          }
          return slice;
        });
        for (const method of ["readManagedDocumentState", "ruleAdmissionRequired", "admitRules",
          "persistAdmissionProof", "readGlobalGovernance", "requestRulePermit"] as const) {
          const original = target[method].bind(instance);
          vi.spyOn(target, method).mockImplementation(async (...args: any[]) => {
            if (!inActualAlarm) return original(...args);
            const startedAt = Date.now();
            const callsBefore = transportCalls;
            const slice = scopes[scopes.length - 1];
            let completed = false;
            let required: boolean | undefined;
            let rejection: unknown;
            try {
              const result = await original(...args);
              completed = true;
              if (method === "ruleAdmissionRequired") required = result;
              return result;
            } catch (error) {
              rejection = { message: String(error), evaluation: (error as any)?.evaluation ?? (error as any)?.result };
              throw error;
            } finally {
              const normalized = method === "admitRules" || method === "ruleAdmissionRequired" ? args[1] : undefined;
              admissionMeasurements.push({ method, operation: normalized?.operation,
                kind: method === "persistAdmissionProof" ? args[0] : undefined, required, completed, rejection,
                elapsed_ms: Date.now() - startedAt, provider_calls: transportCalls - callsBefore,
                provider_calls_at_entry: callsBefore - alarmCallStart,
                elapsed_from_alarm_entry_ms: slice ? startedAt - (slice.scope.deadlineMs - 18_000) : null,
                scoped_calls_at_exit: slice?.calls(),
                governance_calls_at_exit: slice ? target.governanceScopeCalls.get(slice.scope) ?? 0 : null });
            }
          });
        }
        const recover = target.recoverOneUnownedNavigationHeadWrite.bind(instance);
        vi.spyOn(target, "recoverOneUnownedNavigationHeadWrite").mockImplementation(async (...args: any[]) => {
          const startedAt = Date.now();
          const callsBefore = transportCalls;
          try { return await recover(...args); }
          finally {
            const scope = args[4] as ProviderRequestScope | undefined;
            recoveryMeasurements.push({ elapsed_ms: Date.now() - startedAt,
              provider_calls: transportCalls - callsBefore, probe: args[3] === true,
              provider_calls_at_entry: callsBefore - alarmCallStart,
              elapsed_from_alarm_entry_ms: scope ? startedAt - (scope.deadlineMs - 18_000) : null,
              deadline_elapsed: scope ? Date.now() >= scope.deadlineMs : null,
              scoped_calls: scope ? scopes.find(slice => slice.scope === scope)?.calls() : null,
              governance_calls: scope ? target.governanceScopeCalls.get(scope) ?? 0 : null });
          }
        });
      });
      const read = () => runInDurableObject(guard, async (instance, durableState) => ({
        source: await new ZoneNavigationSources((instance as any).persistence).readState(created.project_id, "WORKING"),
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        diagnostic: await durableState.storage.get("navigation-head-recovery-diagnostic-v1"),
        preparation: await durableState.storage.get("navigation-head-recovery-preparation-v1"),
        locator: await durableState.storage.get("navigation-head-recovery-pending-v1"),
        checkpoints: [...(await durableState.storage.list({ prefix: "navigation-head-recovery-bound-v1:" })).values()],
        revision: (instance as any).loadState().revision
      }));
      const finalizedProgress = () => [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
        .find(record => record?.kind === "navigation-head-recovery" && record?.status === "finalized" && record?.terminal);
      const finalizedParent = () => [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
        .find(record => record?.kind === "navigation-head-recovery-parent" && record?.status === "finalized" && record?.terminal);
      let current = await read();
      const alarmLimit = maximum ? 30 : 10;
      let evicted = false;
      let changedPolicy = false;
      let suspensionBaseline: Map<string, string> | null = null;
      let suspendedAlarms = 0;
      let invalidPreparationApplied = false;
      for (let turn = 0; turn < alarmLimit && !(finalizedProgress() && finalizedParent()); turn++) {
        vi.setSystemTime(Math.max(Date.now(), current.continuation.next_wake_at ?? Date.now()) + 1);
        const callsBefore = transportCalls;
        const providerTraceBefore = mock.providerCalls.length;
        const scopesBefore = scopes.length;
        const alarmStartedAt = Date.now();
        alarmCallStart = callsBefore;
        activeAlarmTurn = turn;
        inActualAlarm = true;
        try { expect(await runDurableObjectAlarm(guard)).toBe(true); }
        finally { inActualAlarm = false; }
        const elapsedMs = Date.now() - alarmStartedAt;
        current = await read();
        if (policy.startsWith("prep-") && turn === 0) {
          expect(current.preparation).toBeDefined();
          const value = structuredClone(current.preparation) as any;
          if (policy === "prep-oversized") value.extra = "x".repeat(65_536);
          if (policy === "prep-foreign-project") value.project_id = "PRJ-9999";
          if (policy === "prep-foreign-provider") value.provider_id = "foreign";
          if (policy === "prep-wrong-head-id") value.current_head.object_id = "id:foreign-head";
          if (policy === "prep-future") { value.created_at_ms = Date.now() + 600_000; value.expires_at_ms = value.created_at_ms + 300_000; }
          const { preparation_digest: _digest, ...base } = value;
          value.preparation_digest = await sha256Text(canonicalJson(base));
          await runInDurableObject(guard, async (_instance, state) => { await state.storage.put("navigation-head-recovery-preparation-v1", value); });
          invalidPreparationApplied = true;
        }
        if (suspensionBaseline) {
          for (const [path, bytes] of suspensionBaseline) expect(mock.files.get(path), `suspended effect ${path}`).toBe(bytes);
          expect([...mock.files.keys()].filter(path => !suspensionBaseline!.has(path))).toEqual([]);
          suspendedAlarms++;
        } else if (!changedPolicy && ["retired", "exception-revoked", "incompatible", "unrelated", "project-unrelated", "project-paused"].includes(policy)
          && [...mock.files.values()].some(raw => { try {
            const progress = JSON.parse(raw);
            return progress.kind === "navigation-head-recovery" && progress.completed_steps?.some((step: any) => step.step_id === "head-recovery-parent");
          } catch { return false; } })) {
          await runInDurableObject(guard, async instance => {
            const runtime = (instance as any).persistence;
            if (policy.startsWith("project-")) {
              const target = instance as any;
              const state = await target.loadOrRecoverState();
              const transaction = parseTransaction({ schema_version: "1.0", project_id: created.project_id,
                transaction_id: `TXN-HEAD-POLICY-${policy.toUpperCase()}-0001`, base_revision: state.revision,
                created_at: new Date().toISOString(), operation: policy === "project-paused" ? "project.pause" : "research.add",
                payload: policy === "project-paused" ? { reason: "fixture pause between phases" }
                  : { research_id: "RES-UNRELATEDHEAD", title: "Unrelated accepted fixture observation", body: "No document or rule change" } });
              const result = applyTransaction(state, transaction);
              if (result.kind !== "commit") throw new Error(`typed fixture transition failed: ${JSON.stringify(result)}`);
              const receipt = { schema_version: "1.0", transaction_id: transaction.transaction_id, project_id: created.project_id,
                status: "committed", previous_revision: state.revision, new_revision: result.state.revision,
                event_id: result.event.event_id, committed_at: transaction.created_at };
              await target.repository.writeCommitRecord({ schema_version: "1.0", project_id: created.project_id,
                previous_revision: state.revision, new_revision: result.state.revision, transaction, state: result.state, event: result.event, receipt });
              target.persistCommit(result.state, receipt);
            } else if (policy === "exception-revoked") await appendGovernanceFixture(runtime, "rule.exception.revoke", {
              exception_id: "EXC-HEAD-RECOVERY", reason: "fixture revoked between phases", revoked_by: "founder" });
            else if (policy === "retired") await appendGovernanceFixture(runtime, "rule.retire", {
              rule_id: "RULE-HEAD-RECOVERY-ACTIVE", version: 1, reason: "fixture retired between phases" });
            else if (policy === "unrelated") await appendGovernanceFixture(runtime, "rule.propose", {
              rule: ruleFixture("GLOBAL", { rule_id: "RULE-UNRELATED-DRAFT" }) });
            else {
              const rule = ruleFixture("GLOBAL", { rule_id: "RULE-HEAD-RECOVERY-ACTIVE", version: 2, supersedes: 1,
                operations: ["project.materialize", "project.repair"],
                resource_scope: { resource_types: ["project", "document"], zones: ["DOCUMENTS", "WORKING"] },
                check_id: "expected_version", parameters: { required: true } });
              await appendGovernanceFixture(runtime, "rule.propose", { rule });
              await appendGovernanceFixture(runtime, "rule.accept", { rule_id: rule.rule_id, version: 2 });
              await appendGovernanceFixture(runtime, "rule.activate", { rule_id: rule.rule_id, version: 2,
                activation_evidence: ["fixture:legacy-replacement-control"] });
            }
          });
          changedPolicy = true;
          if (!["unrelated", "project-unrelated"].includes(policy)) suspensionBaseline = new Map(mock.files);
        }
        if (maximum && !evicted && [...mock.files.values()].some(raw => {
          try { const progress = JSON.parse(raw); return progress.kind === "navigation-head-recovery" && progress.status === "finalizing"; }
          catch { return false; }
        })) {
          await runInDurableObject(guard, async (_instance, durableState) => {
            const keys = await durableState.storage.list({ prefix: "navigation-head-recovery-" });
            for (const key of keys.keys()) await durableState.storage.delete(key);
            // Both bounded observations AND the scheduler locator are lost.
            // Existing SQL IDs may locate work; canonical journal/intention
            // reads still provide its only authority.
          });
          evicted = true;
        }
        if (latencyMs === 650 && turn === 0) {
          expect(current.preparation, "slow first alarm must preserve bounded proof acquisition for the next slice").toBeDefined();
          expect(current.locator).toBeUndefined();
          expect(current.source.in_flight_resource_ids).toContain(prepared.resource);
          expect(current.revision).toBe(prepared.revision);
        }
        observations.push({ turn, calls: transportCalls - callsBefore, elapsed_ms: elapsedMs,
          scoped_calls: scopes.slice(scopesBefore).map(slice => slice.calls()),
          governance_calls: scopes.slice(scopesBefore).map(slice => slice.governanceCalls()), diagnostic: current.diagnostic,
          checkpoints: current.checkpoints.map((value: any) => ({ dirty: value.dirty.map((hint: any) => hint?.phase ?? null),
            cleared: value.cleared, finalization_started: value.finalization_started,
            child_certificate_ref: value.child_certificate_ref })),
          provider_trace: mock.providerCalls.slice(providerTraceBefore),
          locator_present: current.locator !== undefined, priority: current.continuation.documents_priority_next });
        if (policy === "fairness" && turn === 1) expect(current.continuation.documents_priority_next,
          "one early head turn must release priority for independent recovery families").toBe(false);
        if (suspendedAlarms >= 2) break;
        if ((invalidPreparationApplied || policy === "four-pointers") && turn >= 1) break;
      }
      console.log("slow-provider actual head recovery", JSON.stringify({ latencyMs, maximum, policy, observations, recoveryMeasurements,
        admissionMeasurements, providerOperations }));
      expect(scopes.every(slice => slice.calls() <= 64)).toBe(true);
      expect(scopes.every(slice => slice.governanceCalls() <= 16)).toBe(true);
      expect(observations.every(value => (value as { elapsed_ms: number }).elapsed_ms <= 18_000)).toBe(true);
      if (maximum) expect(evicted, "maximum fixture must actually lose its local observations").toBe(true);
      expect(current.revision).toBe(prepared.revision + (policy.startsWith("project-") ? 1 : 0));
      expect(mock.files.get(prepared.headPath)).toBe(originalHead);
      if (policy.startsWith("prep-") || policy === "four-pointers") {
        expect(current.locator).toBeUndefined();
        expect(current.source.in_flight_resource_ids).toContain(prepared.resource);
        expect([...mock.files.values()].some(raw => { try {
          return ["navigation-head-recovery-parent", "navigation-head-recovery"].includes(JSON.parse(raw).admission?.kind);
        } catch { return false; } })).toBe(false);
        expect(finalizedProgress()).toBeUndefined();
        expect(finalizedParent()).toBeUndefined();
        return;
      }
      if (suspensionBaseline) {
        expect(suspendedAlarms).toBe(2);
        expect(finalizedProgress()).toBeUndefined();
        expect(finalizedParent()).toBeUndefined();
        expect(current.source.in_flight_resource_ids).toContain(prepared.resource);
        expect(current.locator).toBeTruthy();
        return;
      }
      const progress = finalizedProgress();
      expect(progress, JSON.stringify(observations)).toMatchObject({ terminal: true, code: null });
      const parent = finalizedParent();
      expect(parent, "the original generic operation must have its own real terminal certificate").toMatchObject({ terminal: true, code: null });
      const parentAdmission = JSON.parse(mock.files.get(parent.admission_ref)!).admission;
      const parentReceipt = JSON.parse(mock.files.get(parent.receipt_ref)!);
      const childAdmission = JSON.parse(mock.files.get(progress.admission_ref)!).admission;
      const parentCertificate = JSON.parse(mock.files.get(parent.finalization_ref)!);
      expect(parentReceipt).toMatchObject({ project_id: created.project_id, kind: parent.kind, request_id: parent.request_id,
        request_hash: parent.request_hash, status: "committed", original_operation: "project.materialize",
        child_receipt_ref: progress.receipt_ref, child_finalization_ref: progress.finalization_ref, intent_hash: progress.request_hash });
      expect(parentCertificate).toEqual({ ...parentReceipt, admission_ref: parent.admission_ref, receipt_ref: parent.receipt_ref,
        receipt_sha256: await executionHash(parentReceipt), child_admission_ref: progress.admission_ref,
        postconditions: ["bound_child_finalized", "original_generic_admission_preserved"] });
      expect(childAdmission.diagnosed_drift_refs).toEqual([parent.admission_ref]);
      expect(parentAdmission).toMatchObject({ request_hash: parent.request_hash, operation: "project.materialize" });
      if (policy === "concurrent-discovery") {
        expect(parent.request_id).toBe(prepared.originalParentId);
        expect(mock.files.get(parent.admission_ref)).toBe(prepared.originalParentBytes);
        expect([...mock.files.values()].filter(raw => { try { return JSON.parse(raw).admission?.kind === "navigation-head-recovery-parent"; }
          catch { return false; } })).toHaveLength(1);
      }
      if (["active", "unrelated"].includes(policy)) {
        expect(parentAdmission.ruleset.rules).toEqual([expect.objectContaining({ rule_id: "RULE-HEAD-RECOVERY-ACTIVE", version: 1 })]);
        expect(childAdmission.ruleset.rules).toEqual(parentAdmission.ruleset.rules);
      }
      if (["unrelated", "project-unrelated"].includes(policy)) expect(changedPolicy).toBe(true);
      if (policy.startsWith("ack-")) {
        expect(lostAckPath).not.toBeNull();
        expect(mock.files.get(lostAckPath!)).toBeTruthy();
        const parentIds = [...mock.files.values()].map(raw => { try { return JSON.parse(raw).admission; } catch { return null; } })
          .filter(admission => admission?.kind === "navigation-head-recovery-parent").map(admission => admission.request_id);
        expect(parentIds).toEqual([parent.request_id]);
        const histories = [...mock.files.entries()].filter(([path]) => path.startsWith(parent.admission_ref.replace("/admission.json", "/history/")))
          .map(([, bytes]) => JSON.parse(bytes).sequence);
        expect(histories.every(sequence => sequence > 0)).toBe(true);
      }
      if (policy.startsWith("ack-parent-")) {
        expect(parentAckPreserved).not.toBeNull();
        expect(parentAckAdmission).not.toBeNull();
        expect(parent.admission_ref).toBe(parentAckAdmission!.path);
        expect(mock.files.get(parentAckAdmission!.path)).toBe(parentAckAdmission!.bytes);
        const parentRoot = parent.admission_ref.replace(/\/admission\.json$/, "");
        expect(new Map([...mock.files.entries()].filter(([file]) => !file.startsWith(`${parentRoot}/`)))).toEqual(parentAckPreserved);
        expect(parent.sequence).toBeGreaterThan(parentAckSequence!);
        const histories = [...mock.files.entries()].filter(([path]) => path.startsWith(`${parentRoot}/history/`))
          .map(([, bytes]) => JSON.parse(bytes));
        expect(histories.map(record => record.sequence).sort()).toEqual([1, 2]);
        expect(histories.find(record => record.sequence === 2)).toEqual(parent);
        expect(current.locator ?? null).toBeNull();
      }
      if (policy === "active") {
        for (const certificatePath of [progress.finalization_ref, parent.finalization_ref]) for (const condition of ["missing", "foreign"]) {
          const original = mock.files.get(certificatePath)!;
          if (condition === "missing") mock.files.delete(certificatePath);
          else mock.files.set(certificatePath, canonicalJson({ ...JSON.parse(original), project_id: "PRJ-9999" }));
          const uploads = mock.uploadCalls.length;
          try {
            await runInDurableObject(guard, async (instance, storage) => {
              const target = instance as any;
              await storage.storage.put("navigation-head-recovery-pending-v1", { project_id: created.project_id,
                request_hash: progress.request_hash, resource_id: prepared.resource, cursor: 0 });
              const slice = target.createManagedDocumentSlice(Date.now());
              try { await expect(target.recoverOneUnownedNavigationHeadWrite(created.project_id, slice.runtime, 0, false, slice.scope))
                .rejects.toThrow(certificatePath === progress.finalization_ref
                  ? "navigation_head_recovery_finalization_invalid" : "navigation_head_recovery_parent_finalization_invalid"); }
              finally { clearTimeout(slice.abortTimer); }
            });
            expect(mock.uploadCalls).toHaveLength(uploads);
          } finally { mock.files.set(certificatePath, original); }
        }
      }
      expect(JSON.parse(mock.files.get(progress.finalization_ref)!)).toMatchObject({ request_hash: progress.request_hash,
        postconditions: ["exact_current_head_revalidated", "source_dirty_generation_durable", "recovery_fence_absent"] });
      expect(current.source.in_flight_resource_ids).not.toContain(prepared.resource);
      expect(current.locator ?? null).toBeNull();
    } finally { inActualAlarm = false; vi.useRealTimers(); }
  });

  it.each(["recover", "yield-again", "scheduled-recover", "future-sibling", "scheduled-future-sibling"])("gives a late head admission one early real alarm turn without permanent priority: %s", async scenario => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-HEAD-PRIORITY-0001", "head-priority");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const originalGuard = await runInDurableObject(guard, instance => (instance as any).env.RULE_ADMISSION_SIGNING_KEY);
    const originalRegistry = await runInDurableObject(registry, instance => ({
      signingKey: (instance as any).env.RULE_ADMISSION_SIGNING_KEY, governanceToken: (instance as any).env.RULE_GOVERNANCE_TOKEN
    }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(guard, instance => restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalGuard));
      await runInDurableObject(registry, instance => {
        restoreOptionalEnvBinding((instance as any).env, "RULE_ADMISSION_SIGNING_KEY", originalRegistry.signingKey);
        restoreOptionalEnvBinding((instance as any).env, "RULE_GOVERNANCE_TOKEN", originalRegistry.governanceToken);
      });
    };
    resetAfterRetryFaultFixture = true;
    await bootstrapRuleAdmissionGovernance(testEnv, "head-priority-rules", created.project_id);
    const prepared = await runInDurableObject(guard, async (instance, durableState) => {
      const target = instance as any;
      const state = await target.loadOrRecoverState();
      const content = "Current document survives an interrupted admission.";
      const document = await target.managedDocumentService.writeWorking({ request_id: "DOCREQ-HEAD-PRIORITY-BASE-0001",
        project_id: created.project_id, logical_path: "priority/current.md", content,
        content_sha256: await sha256Text(content), created_at: at }, state);
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      expect(await sources.beginAdoption(created.project_id, "WORKING", "DOCREQ-HEAD-PRIORITY-ADOPT-0001", 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", "DOCREQ-HEAD-PRIORITY-ADOPT-0001", 0)).toBe(true);
      const resource = `head:${document.document_id}`;
      expect(await sources.beginHeadWrite(created.project_id, "WORKING", resource, undefined, "a".repeat(64))).toBeTruthy();
      // Prepare DATA under its actual bounded scope, before the admission
      // fault. The first recovery phase is no longer an admission itself.
      const preparationSlice = target.createManagedDocumentSlice(Date.now());
      try {
        expect(await target.recoverOneUnownedNavigationHeadWrite(created.project_id, preparationSlice.runtime, 0, false, preparationSlice.scope))
          .toMatchObject({ status: "unresolved" });
        expect(preparationSlice.calls()).toBeLessThanOrEqual(64);
        expect(target.ctx.storage.sql.exec("SELECT 1 FROM admission_proofs WHERE kind = 'navigation-head-recovery-parent'").toArray()).toEqual([]);
      } finally { clearTimeout(preparationSlice.abortTimer); }
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const startedAt = Date.now();
      store.beginContinuationSlice(true, startedAt);
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
        documents_priority_next: false, feed_retry_at: null, outcome: {} });
      durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = 0 WHERE singleton = 1");
      await durableState.storage.setAlarm(startedAt + 1_000);
      return { resource, headPath: machineDocumentHeadPath(created.project_id, document.document_id), stateRevision: state.revision, startedAt,
        preparationCalls: preparationSlice.calls(),
        genericHash: (await normalizeSystemAdmission(created.project_id, "project.materialize", "DOCUMENTS", `document-reconcile@${state.revision}`, String(state.revision))).request_hash };
    });
    const headBefore = mock.files.get(prepared.headPath);
    const events: string[] = [];
    const scopes: Array<{ calls: () => number; scope: ProviderRequestScope; abortTimer: ReturnType<typeof setTimeout> }> = [];
    let admissionAttempts = 0;
    let alarmTurns = 0;
    let oldSixLoopOutcome: unknown = null;
    const phaseTrace: unknown[] = [{ phase: "DATA_prime_outside_alarm", calls: prepared.preparationCalls }];
    vi.useFakeTimers();
    try {
      await runInDurableObject(guard, instance => {
        const target = instance as any;
        const recoverRequests = target.resumePendingRequestRecovery.bind(instance);
        vi.spyOn(target, "resumePendingRequestRecovery").mockImplementation(async () => {
          events.push("other-recovery");
          await recoverRequests();
          // Controlled competing work consumes part of the SAME alarm clock;
          // no scope/deadline/call limit or real admission is bypassed.
          vi.setSystemTime(Date.now() + 6_000);
        });
        const createSlice = target.createManagedDocumentSlice.bind(instance);
        vi.spyOn(target, "createManagedDocumentSlice").mockImplementation((...args: unknown[]) => {
          const slice = createSlice(...args);
          scopes.push(slice);
          return slice;
        });
        const admit = target.admitRules.bind(instance);
        vi.spyOn(target, "admitRules").mockImplementation(async (...args: any[]) => {
          if (args[1].resources.some((resource: any) => resource.zone === "DOCUMENTS") && args[1].request_hash !== prepared.genericHash) {
            admissionAttempts += 1;
            events.push("head-admission");
            vi.setSystemTime(Date.now() + (scenario === "yield-again" && admissionAttempts > 1 ? 19_000 : 13_000));
          }
          return admit(...args);
        });
      });
      vi.setSystemTime(prepared.startedAt + 1_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      alarmTurns += 1;
      const read = () => runInDurableObject(guard, async (instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        diagnostic: await durableState.storage.get("navigation-head-recovery-diagnostic-v1"),
        pending: await durableState.storage.get("navigation-head-recovery-pending-v1"),
        source: await new ZoneNavigationSources((instance as any).persistence).readState(created.project_id, "WORKING"),
        revision: (instance as any).loadState().revision,
        executions: [...mock.files.entries()].filter(([path]) => path.endsWith("/progress.json"))
          .map(([, raw]) => JSON.parse(raw)).filter(record => ["navigation-head-recovery", "navigation-head-recovery-parent"].includes(record.kind))
          .map(record => ({ kind: record.kind, status: record.status, terminal: record.terminal, sequence: record.sequence }))
      }));
      const first = await read();
      phaseTrace.push({ alarm: alarmTurns, diagnostic: first.diagnostic, pending: first.pending, executions: first.executions,
        calls: scopes.map(slice => slice.calls()), injected_admission_delay_ms: 13_000 });
      expect(first.diagnostic, JSON.stringify({ events, admissionAttempts,
        calls: scopes.map(slice => slice.calls()), first })).toMatchObject({ resource_id: prepared.resource, stage: "admission" });
      expect(first.continuation.last_outcome?.budget_yield).toBe(true);
      expect(first.pending).toBeUndefined();
      expect(first.source.in_flight_resource_ids).toContain(prepared.resource);
      expect(mock.files.get(prepared.headPath)).toBe(headBefore);
      expect(first.continuation.documents_priority_next).toBe(true);
      events.length = 0;
      vi.setSystemTime(first.continuation.next_wake_at! + 1);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      alarmTurns += 1;
      const second = await read();
      phaseTrace.push({ alarm: alarmTurns, diagnostic: second.diagnostic, pending: second.pending, executions: second.executions,
        calls: scopes.map(slice => slice.calls()), injected_admission_delay_ms: scenario === "yield-again" ? 19_000 : 13_000 });
      expect(second.continuation.slice_ordinal).toBe(2);
      expect(events.indexOf("head-admission")).toBe(0);
      expect(events).toContain("other-recovery");
      expect(second.continuation.documents_priority_next).toBe(false);
      if (scenario === "yield-again") {
        expect(second.source.in_flight_resource_ids).toContain(prepared.resource);
        expect(second.pending).toBeUndefined();
        expect(second.diagnostic).toMatchObject({ stage: "admission" });
        expect(second.continuation.last_outcome?.budget_yield).toBe(true);
      } else {
        let final = second;
        const hasFutureSibling = scenario.includes("future-sibling");
        const siblingId = "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC";
        if (hasFutureSibling) await runInDurableObject(guard, (_instance, durableState) => {
          const store = new ManagedDocumentChangeJobStore(durableState.storage);
          store.registerPage({ expected_cursor: store.cursor(), next_cursor: store.cursor() ?? mock.currentCursor(), jobs: [{ job_id: siblingId,
            change: { kind: "deleted", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-head-priority/INPUTS/future.md`, name: "future.md" },
            detection_source: "incremental", priority: 10 }] });
          const sibling = store.pending().find(job => job.job_id === siblingId)!;
          store.recordFailure(sibling, "provider_retryable", { failure_fingerprint: "c".repeat(64), progress_fingerprint: "d".repeat(64),
            classification: "provider_retryable", now_ms: Date.now(), retry_after_ms: 24 * 60 * 60 * 1_000 });
        });
        if (scenario.startsWith("scheduled")) {
          expect(second.pending).toBeDefined();
          expect(second.source.in_flight_resource_ids).toContain(prepared.resource);
          const parents = [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
            .filter(record => record?.admission?.kind === "navigation-head-recovery-parent");
          expect(parents).toHaveLength(1);
          expect(parents[0].admission.resources[0]).toMatchObject({ zone: "DOCUMENTS", resource_id: `document-reconcile@${prepared.stateRevision}` });
          // The scheduled entry rotates to the independent slot after the
          // fence cleared. It must preserve the admitted certificate work.
          const scheduled = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
          expect(scheduled.status).toBe(200);
          final = await read();
          phaseTrace.push({ phase: "scheduled_route", pending: final.pending, executions: final.executions, calls: scopes.map(slice => slice.calls()) });
          expect(final.continuation.pending).toBe(true);
          expect(final.continuation.next_wake_at).not.toBeNull();
        } else if (hasFutureSibling) {
          vi.setSystemTime(final.continuation.next_wake_at! + 1);
          expect(await runDurableObjectAlarm(guard)).toBe(true);
          alarmTurns += 1;
          final = await read();
          phaseTrace.push({ alarm: alarmTurns, pending: final.pending, executions: final.executions, calls: scopes.map(slice => slice.calls()) });
        }
        if (hasFutureSibling) expect(final.continuation.next_wake_at).toBeLessThanOrEqual(Date.now() + 20_000);
        // C0 diagnostic ruling: retain the old six-loop result; at most ten
        // ACTUAL alarms plus the explicitly counted DATA prime. This does not
        // prove the unchanged ten-alarm cold-entry positive gate.
        for (let attempt = 0; alarmTurns < 10 && final.pending; attempt++) {
          vi.setSystemTime(final.continuation.next_wake_at! + 1);
          expect(await runDurableObjectAlarm(guard)).toBe(true);
          alarmTurns += 1;
          final = await read();
          phaseTrace.push({ alarm: alarmTurns, pending: final.pending, executions: final.executions, calls: scopes.map(slice => slice.calls()) });
          if (attempt === 5) oldSixLoopOutcome = { pending: final.pending, executions: final.executions, alarmTurns };
        }
        expect(final.source.in_flight_resource_ids).not.toContain(prepared.resource);
        expect(final.pending ?? null, JSON.stringify({ diagnostic: final.diagnostic, continuation: final.continuation,
          calls: scopes.map(slice => slice.calls()), events,
          executions: [...mock.files.entries()].filter(([path]) => path.endsWith("/progress.json"))
            .map(([, raw]) => JSON.parse(raw)).filter(record => record.kind === "navigation-head-recovery") })).toBeNull();
        const progress = [...mock.files.values()].map(raw => { try { return JSON.parse(raw); } catch { return null; } })
          .find(record => record?.kind === "navigation-head-recovery" && record?.status === "finalized");
        expect(progress).toMatchObject({ terminal: true, code: null });
        expect(JSON.parse(mock.files.get(progress.finalization_ref)!)).toMatchObject({ request_hash: progress.request_hash,
          postconditions: ["exact_current_head_revalidated", "source_dirty_generation_durable", "recovery_fence_absent"] });
        if (hasFutureSibling) expect(await runInDurableObject(guard, (_instance, durableState) =>
          durableState.storage.sql.exec("SELECT status, attempts FROM managed_document_change_jobs WHERE job_id = ?", siblingId).one()))
          .toMatchObject({ status: "pending", attempts: 1 });
      }
      expect(scopes.every(slice => slice.calls() <= 64)).toBe(true);
      expect(admissionAttempts).toBe(2);
      expect((await read()).revision).toBe(prepared.stateRevision);
      expect(mock.files.get(prepared.headPath)).toBe(headBefore);
      console.log("late-admission diagnostic phases", JSON.stringify({ scenario, alarmTurns, endToEndPhases: 1 + scopes.length,
        oldSixLoopOutcome, phaseTrace }));
    } finally { vi.useRealTimers(); }
  });

  it("recovers a stranded matching head flight in the local continuation without a new provider event", async () => {
    resetAfterRetryFaultFixture = true;
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "head-flight-local-recovery";
    const created = await createProject("TXN-CHANGEJOB-HEAD-FLIGHT-RECOVERY-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const visiblePath = `${root}/WORKING/recovery/flight.md`;

    const prepared = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        persistence: ProjectOsPersistenceRuntime;
        loadOrRecoverState(): Promise<ProjectState>;
        managedDocumentService: ManagedDocumentService;
      };
      const state = await target.loadOrRecoverState();
      const working = await target.managedDocumentService.writeWorking({
        request_id: "DOCREQ-WORKING-HEAD-FLIGHT-BASE-0001",
        project_id: created.project_id,
        logical_path: "recovery/flight.md",
        content: "original working bytes",
        content_sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("original working bytes")))]
          .map(byte => byte.toString(16).padStart(2, "0")).join(""),
        created_at: at
      }, state);
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      const adoptionId = "DOCREQ-NAV-WORKING-HEAD-FLIGHT-ADOPT-0001";
      expect(await sources.beginAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      return { documentId: working.document_id };
    });

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);
    const headPath = machineDocumentHeadPath(created.project_id, prepared.documentId);
    const headUploadsBefore = mock.uploadCalls.filter(path => path === headPath).length;
    const baselineHead = await runInDurableObject(guard, async instance =>
      new DocumentLedgerRepository((instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence)
        .readHead(created.project_id, prepared.documentId));
    await mock.writeExternal(visiblePath, "external bytes after source adoption");
    const originalFetch = mock.spy.getMockImplementation();
    expect(originalFetch).toBeDefined();
    let postUploadFaultArmed = false;
    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const apiArg = request.headers.get("Dropbox-API-Arg");
      let uploadPath: string | undefined;
      if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/upload" && apiArg) {
        try { uploadPath = (JSON.parse(apiArg) as { path?: unknown }).path as string | undefined; } catch { /* delegate malformed test input */ }
      }
      const response = await originalFetch!(input, init);
      if (!postUploadFaultArmed && uploadPath === headPath && response.ok
        && mock.uploadCalls.filter(path => path === headPath).length === headUploadsBefore + 1) {
        postUploadFaultArmed = true;
        faults.push({ endpoint: "/2/files/download", method: "POST", occurrence: 1, status: 409,
          error_summary: "path/conflict/file/...", path: headPath });
      }
      return response;
    });

    let interrupted: Response;
    try {
      interrupted = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    } finally {
      mock.spy.mockImplementation(originalFetch!);
    }
    expect(interrupted.status).toBe(200);
    expect(postUploadFaultArmed).toBe(true);
    const interruptedSummary = await interrupted.json<Record<string, unknown>>();
    expect(interruptedSummary).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(interruptedSummary.jobs_completed).toBeGreaterThan(0);

    const stranded = await runInDurableObject(guard, async (instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const job = store.pending().find(item => item.change.path === visiblePath);
      expect(job).toBeDefined();
      durableState.storage.sql.exec(
        "UPDATE managed_document_change_job_failure_state SET next_attempt_at = ? WHERE job_id = ?",
        Number.MAX_SAFE_INTEGER, job!.job_id
      );
      const continuation = store.continuation();
      store.finishContinuationSlice({ pending: true, next_wake_at: Date.now(), documents_priority_next: true,
        feed_retry_at: continuation.feed_retry_at, outcome: continuation.last_outcome ?? {} });
      const runtime = (instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence;
      const source = await new ZoneNavigationSources(runtime).readState(created.project_id, "WORKING");
      const head = await new DocumentLedgerRepository(runtime)
        .readHead(created.project_id, prepared.documentId);
      const persistedHead = mock.files.get(headPath);
      const rawSourceState = mock.files.get(`${machineDocumentRoot(created.project_id)}/navigation-sources/state.json`);
      if (!persistedHead || !rawSourceState) throw new Error("post-upload recovery precondition missing persisted proof bytes");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(persistedHead));
      const writeHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const sourceState = JSON.parse(rawSourceState) as { zones?: { WORKING?: { in_flight_writes?: Array<{
        resource_id: string; generation: number; write_hash?: string | null;
      }> } } };
      const ticket = sourceState.zones?.WORKING?.in_flight_writes?.find(item => item.resource_id === `head:${prepared.documentId}`);
      return { cursor: store.cursor(), targetJobId: job!.job_id, targetAttempts: job!.attempts,
        eligible: store.eligibilityCounts(Date.now()).executable,
        generation: source.generation, flights: source.in_flight_resource_ids, headVersion: head?.working_version_id,
        persistedHead, writeHash, ticket, uploadCount: mock.uploadCalls.filter(path => path === headPath).length };
    });
    expect(stranded.eligible).toBe(0);
    expect(stranded.uploadCount).toBe(headUploadsBefore + 1);
    expect(stranded.headVersion).toBeTruthy();
    expect(stranded.headVersion).not.toBe(baselineHead?.working_version_id);
    expect(stranded.ticket).toMatchObject({ resource_id: `head:${prepared.documentId}`, write_hash: stranded.writeHash });
    expect(stranded.flights).toContain(`head:${prepared.documentId}`);

    expect(await runDurableObjectAlarm(guard)).toBe(true);

    const afterAlarm = await runInDurableObject(guard, async (instance, durableState) => {
      const sources = new ZoneNavigationSources((instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence);
      const source = await sources.readState(created.project_id, "WORKING");
      const dirty = await sources.listDirtyPage(created.project_id, "WORKING", null, 8);
      const ledger = new DocumentLedgerRepository((instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence);
      const head = await ledger.readHead(created.project_id, prepared.documentId);
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const targetJob = store.pending().find(item => item.job_id === stranded.targetJobId);
      return { targetJob: targetJob ? { job_id: targetJob.job_id, attempts: targetJob.attempts,
        eligible: store.eligibilityCounts(Date.now()).executable } : null, generation: source.generation,
        flights: source.in_flight_resource_ids, dirty: dirty.resource_ids, headVersion: head?.working_version_id,
        outbox: durableState.storage.sql.exec<{ [key: string]: string | number | null; zone: string; source_generation: number }>(
          "SELECT zone, source_generation FROM navigation_refresh_outbox WHERE zone = ? ORDER BY source_generation", "WORKING"
        ).toArray(),
        versionPaths: [...mock.files.keys()].filter(path => path.startsWith(`${machineDocumentRoot(created.project_id)}/versions/${prepared.documentId}/`)).sort() };
    });
    expect(afterAlarm.targetJob).toEqual({ job_id: stranded.targetJobId, attempts: stranded.targetAttempts, eligible: 0 });
    expect(mock.files.get(visiblePath)).toBe("external bytes after source adoption");
    expect(afterAlarm.generation).toBe(stranded.generation);
    expect(afterAlarm.flights).toEqual([]);
    expect(afterAlarm.dirty).toEqual([`head:${prepared.documentId}`]);
    expect(afterAlarm.headVersion).toBe(stranded.headVersion);
    expect(afterAlarm.versionPaths.length).toBeGreaterThanOrEqual(2);
    expect(afterAlarm.versionPaths).toHaveLength(2);
    expect(mock.uploadCalls.filter(path => path === headPath)).toHaveLength(headUploadsBefore + 1);
    expect(afterAlarm.outbox).toContainEqual({ zone: "WORKING", source_generation: afterAlarm.generation });
  });

  it("leaves a mismatched scheduled head debt visible and reaches its valid sibling on the next scheduled slice", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-head-flight-siblings";
    const created = await createProject("TXN-CHANGEJOB-HEAD-FLIGHT-SIBLINGS-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const seeded = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        persistence: ProjectOsPersistenceRuntime;
        loadOrRecoverState(): Promise<ProjectState>;
        managedDocumentService: ManagedDocumentService;
      };
      const state = await target.loadOrRecoverState();
      const write = async (requestId: string, logicalPath: string, content: string) => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        return target.managedDocumentService.writeWorking({ request_id: requestId, project_id: created.project_id,
          logical_path: logicalPath, content,
          content_sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""), created_at: at }, state);
      };
      const mismatch = await write("DOCREQ-WORKING-HEAD-SIBLING-MISMATCH-0001", "recovery/mismatch.md", "mismatch");
      const valid = await write("DOCREQ-WORKING-HEAD-SIBLING-VALID-0001", "recovery/valid.md", "valid");
      const sources = new ZoneNavigationSources(target.persistence);
      expect(await sources.markCatalogReady(created.project_id, "WORKING", 0)).toBe(true);
      const adoptionId = "DOCREQ-NAV-WORKING-HEAD-SIBLING-ADOPT-0001";
      expect(await sources.beginAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      expect(await sources.finishAdoption(created.project_id, "WORKING", adoptionId, 0)).toBe(true);
      return { mismatchId: mismatch.document_id, validId: valid.document_id };
    });
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const before = await runInDurableObject(guard, async (instance, durableState) => {
      const runtime = (instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence;
      const sources = new ZoneNavigationSources(runtime);
      const hash = async (documentId: string) => {
        const path = machineDocumentHeadPath(created.project_id, documentId);
        const raw = await runtime.objects.readText(path);
        if (raw === null) throw new Error("scheduled sibling head missing");
        return { path, raw, digest: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
          .map(byte => byte.toString(16).padStart(2, "0")).join("") };
      };
      const mismatchHead = await hash(seeded.mismatchId);
      const validHead = await hash(seeded.validId);
      expect(await sources.beginHeadWrite(created.project_id, "WORKING", `head:${seeded.mismatchId}`, undefined, mismatchHead.digest)).toBeTruthy();
      expect(await sources.beginHeadWrite(created.project_id, "WORKING", `head:${seeded.validId}`, undefined, validHead.digest)).toBeTruthy();
      // The canonical bytes change without a provider change-feed event: this is the exact refusal case.
      mock.files.set(mismatchHead.path, `${mismatchHead.raw} `);
      const candidates = await sources.unownedHeadWriteRecoveryCandidates(created.project_id);
      const mismatchIndex = candidates.findIndex(group => group[0]?.resource_id === `head:${seeded.mismatchId}`);
      if (mismatchIndex < 0 || !candidates.some(group => group[0]?.resource_id === `head:${seeded.validId}`)) {
        throw new Error("scheduled sibling recovery candidates missing");
      }
      const ordinalBeforeMismatch = (mismatchIndex + candidates.length - 1) % candidates.length;
      durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = ? WHERE singleton = 1", ordinalBeforeMismatch);
      return { mismatchIndex, ordinalBeforeMismatch };
    });
    const route = "https://project-guard.internal/reconcile-documents?scheduled=1";
    const first = await guard.fetch(route, { method: "POST" });
    expect(first.status).toBe(200);
    const firstBody = await first.json<Record<string, unknown>>();
    expect(firstBody.safe_errors).toContain("navigation_head_write_recovery_unresolved");
    expect(firstBody.jobs_pending).toBeGreaterThan(0);
    expect(firstBody.next_local_wake_at).toEqual(expect.any(Number));
    const afterMismatch = await runInDurableObject(guard, async instance => {
      const runtime = (instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence;
      return new ZoneNavigationSources(runtime).readState(created.project_id, "WORKING");
    });
    expect(afterMismatch.in_flight_resource_ids).toEqual(expect.arrayContaining([
      `head:${seeded.mismatchId}`, `head:${seeded.validId}`
    ]));

    const second = await guard.fetch(route, { method: "POST" });
    expect(second.status).toBe(200);
    const secondBody = await second.json<Record<string, unknown>>();
    expect(secondBody.safe_errors).not.toContain("navigation_head_write_recovery_unresolved");
    expect(secondBody.next_local_wake_at).toEqual(expect.any(Number));
    const afterSibling = await runInDurableObject(guard, async instance => {
      const runtime = (instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence;
      const sources = new ZoneNavigationSources(runtime);
      const state = await sources.readState(created.project_id, "WORKING");
      const dirty = await sources.listDirtyPage(created.project_id, "WORKING", null, 8);
      return { state, dirty };
    });
    expect(afterSibling.state.in_flight_resource_ids).toContain(`head:${seeded.mismatchId}`);
    expect(afterSibling.state.in_flight_resource_ids).not.toContain(`head:${seeded.validId}`);
    expect(afterSibling.dirty.resource_ids).toContain(`head:${seeded.validId}`);
    expect(before.mismatchIndex).toBeGreaterThanOrEqual(0);
  });

  it("keeps the initial document continuation wakeable when admission fails before the first scan", async () => {
    const mock = installDropboxMock();
    const slug = "initial-admission-retry";
    const created = await createProject("TXN-CHANGEJOB-INITIAL-ADMISSION-RETRY-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const cursorBefore = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    await mock.writeExternal(`${root}/INPUTS/retry-after-admission.pdf`, "%PDF retry after admission");
    let admissionCalls = 0;
    vi.useFakeTimers();
    try {
      const requestAt = Date.now();
      await runInDurableObject(guard, (instance, durableState) => {
        const target = instance as unknown as { ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean> };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          if (admissionCalls === 1) throw new RuleAdmissionError("rule_admission_invalid");
          return false;
        });
      });

      const failed = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
      expect(failed.status).toBe(503);
      const initial = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        alarm: await durableState.storage.getAlarm()
      }));
      expect(initial.continuation).toMatchObject({ pending: true, next_wake_at: expect.any(Number) });
      expect(initial.alarm).not.toBeNull();

      vi.setSystemTime(requestAt + 2_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const resumed = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        cursor: new ManagedDocumentChangeJobStore(durableState.storage).cursor(),
        pending_jobs: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
        job_statuses: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs").toArray()
      }));
      expect(admissionCalls).toBe(2);
      expect(resumed.cursor).not.toBe(cursorBefore);
      expect(resumed.pending_jobs).toBe(0);
      expect(resumed.job_statuses.length).toBeGreaterThan(0);
      expect(resumed.continuation).toMatchObject({ pending: false, scheduled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries unavailable prelude admission across alarms and resumes without another reconcile POST", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-UNAVAILABLE-0001", "prelude-unavailable");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let admissionCalls = 0;
      let coordinatorCalls = 0;
      await runInDurableObject(guard, (instance, durableState) => {
        const target = instance as unknown as {
          ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
          enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void>;
          notifyDropboxChangeCoordinator: (...args: unknown[]) => Promise<boolean>;
        };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          if (admissionCalls <= 2) throw new RuleAdmissionError("rule_admission_invalid");
          return false;
        });
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation(() => ({
          reconcile: async () => {
            coordinatorCalls += 1;
            return {
              scanned: 0, ignored: 0, captured: 0, ingested: 0, duplicates: 0, restored: 0, conflicts: 0,
              intake_completed: 0, duplicate_cleaned: 0, withdrawn: 0, intake_resumed: 0, changed_document_ids: [],
              candidates: 0, mutation_gate_mode: "observe", policy_violations: 0,
              bootstrapped: 0, cursor_reset: false, baseline: false, cursor_advanced: false, archived: false,
              jobs_registered: 0, jobs_completed: 0, jobs_pending: 0, job_failures: 0, jobs_quarantined: 0,
              drift_findings: 0, expected_changes: 0, scheduled: false, scheduled_due: false,
              late_since: null, last_scheduled_verified_at: null, budget_yield: false, semantic_progress: 0,
              unread_feed: false, executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0,
              verification_completed: false, earliest_eligible_at: null, feed_retry_at: null, safe_errors: []
            } satisfies Awaited<ReturnType<ManagedDocumentChangeCoordinator["reconcile"]>>;
          }
        } as unknown as ManagedDocumentChangeCoordinator));
        vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockResolvedValue();
        vi.spyOn(target, "notifyDropboxChangeCoordinator").mockResolvedValue(true);
      });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const checkpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm()
        }));
        expect(checkpoint.continuation.pending).toBe(true);
        expect(checkpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
        expect(checkpoint.continuation.next_wake_at).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(checkpoint.alarm).not.toBeNull();
        expect(coordinatorCalls).toBe(0);
      }

      vi.setSystemTime(startedAt + 93_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const resumed = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(admissionCalls).toBe(3);
      expect(coordinatorCalls).toBe(1);
      expect(resumed.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks six identical typed prelude INTERNAL failures without a seventh alarm attempt", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-INTERNAL-0001", "prelude-internal-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let stateReads = 0;
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as { readManagedDocumentState: (...args: unknown[]) => Promise<unknown> };
        vi.spyOn(target, "readManagedDocumentState").mockImplementation(async () => {
          stateReads += 1;
          throw new InternalExecutionFailure("canonical_state_decode_failed", "read_state");
        });
      });

      let finalCheckpoint!: { continuation: ReturnType<ManagedDocumentChangeJobStore["continuation"]>; alarm: number | null; rawFailure: string | null };
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        finalCheckpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm(),
          rawFailure: durableState.storage.sql.exec<{ prelude_failure_state_json: string | null }>(
            "SELECT prelude_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
          ).one().prelude_failure_state_json
        }));
        if (attempt < 6) {
          expect(finalCheckpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
          expect(finalCheckpoint.alarm).not.toBeNull();
        }
      }
      expect(stateReads).toBe(6);
      expect(finalCheckpoint.continuation).toMatchObject({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
        last_outcome: { stopped_unresolved_jobs: 1, verification_completed: false,
          safe_errors: ["identical_internal_document_prelude_failure_limit"] } });
      expect(JSON.parse(finalCheckpoint.rawFailure!)).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });
      // The remaining alarm is only for the durable global OPEN/PARK notice;
      // the parked document prelude itself must not be attempted again.
      expect(finalCheckpoint.alarm).not.toBeNull();
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      expect(stateReads).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps repeated UNKNOWN prelude failures bounded and retryable without the typed stop", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PRELUDE-UNKNOWN-0001", "prelude-unknown-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let admissionCalls = 0;
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as { ruleAdmissionRequired: (...args: unknown[]) => Promise<boolean> };
        vi.spyOn(target, "ruleAdmissionRequired").mockImplementation(async () => {
          admissionCalls += 1;
          throw new Error("temporary governance read failure");
        });
      });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const checkpoint = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          prelude: durableState.storage.sql.exec<{ prelude_failure_state_json: string | null }>(
            "SELECT prelude_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
          ).one().prelude_failure_state_json
        }));
        expect(checkpoint.continuation.pending).toBe(true);
        expect(checkpoint.continuation.next_wake_at).toBeGreaterThan(Date.now());
        expect(checkpoint.continuation.next_wake_at).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(checkpoint.continuation.last_outcome?.stopped_unresolved_jobs ?? 0).toBe(0);
        expect(checkpoint.prelude).toBeNull();
      }
      expect(admissionCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves provider prelude Retry-After deadlines across old runnable work and unsafe values", async () => {
    installDropboxMock();
    vi.useFakeTimers();
    try {
      const cases = [
        { label: "over-24-hours", retryAfterMs: 25 * 60 * 60 * 1_000, sentinel: false },
        { label: "finite-unsafe", retryAfterMs: 1e16, sentinel: true },
        { label: "explicit-sentinel", retryAfterMs: Number.MAX_SAFE_INTEGER, sentinel: true }
      ] as const;
      for (const [index, scenario] of cases.entries()) {
        const created = await createProject(`TXN-CHANGEJOB-PRELUDE-RETRY-${index.toString().padStart(4, "0")}`, `prelude-retry-${scenario.label}`);
        const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
        const startedAt = Date.now();
        await runInDurableObject(guard, async (_instance, durableState) => {
          const store = new ManagedDocumentChangeJobStore(durableState.storage);
          store.beginContinuationSlice(true, startedAt);
          store.finishContinuationSlice({ pending: true, next_wake_at: startedAt,
            documents_priority_next: true, feed_retry_at: startedAt - 1,
            outcome: { semantic_progress: 0, executable_jobs: 1, unread_feed: true, safe_errors: [] } });
          await durableState.storage.setAlarm(startedAt);
        });
        await runInDurableObject(guard, instance => {
          const target = instance as unknown as { readManagedDocumentState: (...args: unknown[]) => Promise<unknown> };
          vi.spyOn(target, "readManagedDocumentState").mockRejectedValue(new ProviderOperationError("prelude limited", true, {
            providerId: "dropbox", status: 429, code: "too_many_requests", retryAfterMs: scenario.retryAfterMs
          }));
        });
        vi.setSystemTime(startedAt + 1_000);
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        const observed = await runInDurableObject(guard, async (_instance, durableState) => ({
          continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
          alarm: await durableState.storage.getAlarm(),
          preludeFailure: new ManagedDocumentChangeJobStore(durableState.storage).preludeFailureCheckpoint()
        }));
        if (scenario.sentinel) {
          expect(observed.continuation).toMatchObject({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
            feed_retry_at: Number.MAX_SAFE_INTEGER });
          expect(observed.alarm).toBeNull();
        } else {
          const deadline = startedAt + 1_000 + scenario.retryAfterMs;
          expect(observed.continuation).toMatchObject({ pending: true, next_wake_at: deadline, feed_retry_at: deadline });
          expect(observed.alarm).toBe(deadline);
        }
        expect(observed.continuation.last_outcome?.safe_errors).toContain("document_slice_failed");
        expect(observed.preludeFailure).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat the saturated feed deadline as immediately eligible", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-SATURATED-0001", "feed-saturated-deadline");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      return { entries: [], cursor: "must-remain-unread", has_more: true };
    };
    const state = emptyProjectState(created.project_id, "Saturated deadline", "feed-saturated-deadline");
    const now = Date.parse("2026-10-03T21:00:00.000Z");
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "seed-cursor", jobs: [] });
      store.finishContinuationSlice({ pending: true, next_wake_at: Number.MAX_SAFE_INTEGER,
        documents_priority_next: false, feed_retry_at: Number.MAX_SAFE_INTEGER, outcome: { unread_feed: true } });
    });
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now + 24 * 60 * 60 * 1_000).toISOString() });
    });

    expect(feedCalls).toBe(0);
    expect(summary).toMatchObject({ unread_feed: true, feed_retry_at: Number.MAX_SAFE_INTEGER, verification_completed: false });
  });

  it("allows a complete initial and distinct-drift governance sequence inside one bounded slice", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-GOVERNANCE-SCOPE-0001", "governance-scope");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const accepted = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        scopedGovernanceRequest(scope: { deadlineMs: number; signal: AbortSignal; now?: () => number }, request: () => Promise<Response>): Promise<Response>;
      };
      const scope = { deadlineMs: Date.now() + 10_000, signal: new AbortController().signal };
      for (let index = 0; index < 8; index += 1) {
        const response = await target.scopedGovernanceRequest(scope, async () => Response.json({ index }));
        expect(response.status).toBe(200);
      }
      return true;
    });

    expect(accepted).toBe(true);
  });

  it("admits initial work and a separately bound package drift with one live slice scope", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-GOVERNED-DRIFT-0001", "governed-drift");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const originalGuardBindings = await runInDurableObject(guard, instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      return { signingKey: bindings.RULE_ADMISSION_SIGNING_KEY, projectModes: bindings.PROJECT_OS_ADMISSION_PROJECT_MODES };
    });
    const originalRegistryBindings = await runInDurableObject(registry, instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      return { signingKey: bindings.RULE_ADMISSION_SIGNING_KEY, governanceToken: bindings.RULE_GOVERNANCE_TOKEN };
    });
    const originalRegistryRows = await runInDurableObject(registry, (_instance, durableState) => ({
      governanceMeta: durableState.storage.sql.exec<{ key: string; value: string }>(
        "SELECT key, value FROM meta WHERE key = 'rule_governance'").toArray(),
      globalRequests: durableState.storage.sql.exec<{ transaction_id: string; transaction_json: string; project_id: string | null; status: string; receipt_json: string | null }>(
        "SELECT transaction_id, transaction_json, project_id, status, receipt_json FROM requests WHERE project_id = 'GLOBAL'").toArray(),
      governanceEvents: durableState.storage.sql.exec<{ revision: number; event_json: string }>(
        "SELECT revision, event_json FROM governance_events").toArray()
    }));
    restoreTestEnvBindings = async () => {
      await runInDurableObject(registry, (_instance, durableState) => durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'");
        durableState.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'");
        durableState.storage.sql.exec("DELETE FROM governance_events");
        for (const row of originalRegistryRows.governanceMeta) {
          durableState.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", row.key, row.value);
        }
        for (const row of originalRegistryRows.globalRequests) {
          durableState.storage.sql.exec(
            "INSERT INTO requests (transaction_id, transaction_json, project_id, status, receipt_json) VALUES (?, ?, ?, ?, ?)",
            row.transaction_id, row.transaction_json, row.project_id, row.status, row.receipt_json
          );
        }
        for (const row of originalRegistryRows.governanceEvents) {
          durableState.storage.sql.exec("INSERT INTO governance_events (revision, event_json) VALUES (?, ?)", row.revision, row.event_json);
        }
      }));
      await runInDurableObject(guard, instance => {
        const bindings = (instance as unknown as { env: Env }).env as unknown as Record<string, unknown>;
        restoreOptionalEnvBinding(bindings, "RULE_ADMISSION_SIGNING_KEY", originalGuardBindings.signingKey);
        restoreOptionalEnvBinding(bindings, "PROJECT_OS_ADMISSION_PROJECT_MODES", originalGuardBindings.projectModes);
      });
      await runInDurableObject(registry, instance => {
        const bindings = (instance as unknown as { env: Env }).env as unknown as Record<string, unknown>;
        restoreOptionalEnvBinding(bindings, "RULE_ADMISSION_SIGNING_KEY", originalRegistryBindings.signingKey);
        restoreOptionalEnvBinding(bindings, "RULE_GOVERNANCE_TOKEN", originalRegistryBindings.governanceToken);
      });
    };
    const signingKey = "change-job-governance-test-key";
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, created.project_id);
    await runInDurableObject(guard, instance => Object.assign((instance as unknown as { env: Env }).env, {
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));

    const admissions = await runInDurableObject(guard, async instance => {
      const target = instance as unknown as {
        createManagedDocumentSlice(startedAt: number): { scope: { deadlineMs: number; signal: AbortSignal }; runtime: import("../src/persistence/provider/capabilities").ProjectOsPersistenceRuntime; abortTimer: ReturnType<typeof setTimeout> };
        loadOrRecoverState(): Promise<import("../src/domain/project-state").ProjectState | null>;
        ruleAdmissionRequired(state: import("../src/domain/project-state").ProjectState, operation: import("../src/admission/operation-context").NormalizedAdmissionOperation, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        admitRules(state: import("../src/domain/project-state").ProjectState, operation: import("../src/admission/operation-context").NormalizedAdmissionOperation, actor: undefined, scope: { deadlineMs: number; signal: AbortSignal }): Promise<{ operation: string; request_hash: string }>;
        persistAdmissionProof(kind: string, requestId: string, proof: never, runtime: import("../src/persistence/provider/capabilities").ProjectOsPersistenceRuntime): Promise<unknown>;
        executionPlanResolver: (admission: unknown) => Promise<unknown>;
      };
      const slice = target.createManagedDocumentSlice(Date.now());
      try {
        const state = await target.loadOrRecoverState();
        if (!state) throw new Error("expected initialized project state");
        const initial = await normalizeSystemAdmission(state.project_id, "project.materialize", "DOCUMENTS", `document-reconcile@${state.revision}`, String(state.revision));
        expect(await target.ruleAdmissionRequired(state, initial, slice.scope)).toBe(true);
        const initialProof = await target.admitRules(state, initial, undefined, slice.scope);

        const resource = { resource_id: `PKG-${"A".repeat(64)}`, resource_type: "package", zone: "WORKING", version: `1:${"b".repeat(64)}` };
        const drift = { project_id: state.project_id, operation: "package.drift.observe", resources: [resource], request_hash: await sha256Canonical({ finding_id: "DRIFT-GOVERNED-0001", resource }) };
        slice.scope.deadlineMs = Date.now();
        expect(await target.ruleAdmissionRequired(state, drift, slice.scope)).toBe(true);
        await expect(target.admitRules(state, drift, undefined, slice.scope)).rejects.toThrow("slice_budget_exhausted");

        const resumed = target.createManagedDocumentSlice(Date.now());
        try {
          expect(await target.ruleAdmissionRequired(state, drift, resumed.scope)).toBe(true);
          const driftProof = await target.admitRules(state, drift, undefined, resumed.scope);
          const originalPlanResolver = target.executionPlanResolver;
          target.executionPlanResolver = async () => { throw new Error("slice_budget_exhausted"); };
          await expect(target.persistAdmissionProof("document-drift", "DRIFT-GOVERNED-YIELD-0001", driftProof as never, resumed.runtime))
            .rejects.toThrow("slice_budget_exhausted");
          target.executionPlanResolver = originalPlanResolver;
          await target.persistAdmissionProof("document-drift", "DRIFT-GOVERNED-0001-slice-1", driftProof as never, resumed.runtime);
          return { initial: initialProof.operation, drift: driftProof.operation, driftHash: driftProof.request_hash, requestHash: drift.request_hash };
        } finally {
          clearTimeout(resumed.abortTimer);
        }
      } finally {
        clearTimeout(slice.abortTimer);
      }
    });

    expect(admissions).toMatchObject({ initial: "project.materialize", drift: "package.drift.observe" });
    expect(admissions.driftHash).toBe(admissions.requestHash);
  });

  it("persists and retries a bounded global notification owed after local completion", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-LOCAL-NOTIFY-0001", "local-notify-owed");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const originalDropboxChangeGuard = await runInDurableObject(guard, instance =>
      (instance as unknown as { env: Record<string, unknown> }).env.DROPBOX_CHANGE_GUARD);
    restoreTestEnvBindings = async () => runInDurableObject(guard, instance => {
      restoreOptionalEnvBinding((instance as unknown as { env: Record<string, unknown> }).env,
        "DROPBOX_CHANGE_GUARD", originalDropboxChangeGuard);
    });
    let releaseResponse!: (response: Response) => void;
    let fetchCount = 0;
    let stall = true;
    const fetchNotification = vi.fn(async () => {
      fetchCount += 1;
      if (!stall) return Response.json({ status: "registered", requested_generation: 1, completed_generation: 0 });
      return new Promise<Response>(resolve => { releaseResponse = resolve; });
    });
    vi.useFakeTimers();
    try {
      await runInDurableObject(guard, async (instance, durableState) => {
        const target = instance as unknown as {
          env: Env;
          createManagedDocumentSlice(startedAt: number): { scope: { deadlineMs: number; signal: AbortSignal }; abortTimer: ReturnType<typeof setTimeout> };
          notifyDropboxChangeCoordinator(store: ManagedDocumentChangeJobStore, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        };
        Object.assign(target.env, { DROPBOX_CHANGE_GUARD: { getByName: () => ({ fetch: fetchNotification }) } });
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.finishContinuationSlice({ pending: false, next_wake_at: null, documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 1, executable_jobs: 0, unread_feed: false } });
        const first = target.createManagedDocumentSlice(Date.now());
        try {
          const pending = target.notifyDropboxChangeCoordinator(store, first.scope);
          await vi.waitFor(() => expect(fetchCount).toBe(1));
          expect(store.continuation().last_outcome).toMatchObject({ global_notification_owed: true });
          expect(await durableState.storage.getAlarm()).not.toBeNull();
          await vi.advanceTimersByTimeAsync(18_001);
          await expect(pending).resolves.toBe(false);
          expect(store.continuation().last_outcome).toMatchObject({ global_notification_owed: true });
        } finally {
          releaseResponse?.(Response.json({ status: "registered", requested_generation: 1, completed_generation: 0 }));
          clearTimeout(first.abortTimer);
        }

      });
      stall = false;
      await runDurableObjectAlarm(guard);
      const replayed = await runInDurableObject(guard, (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(replayed.last_outcome).not.toHaveProperty("global_notification_owed");
    } finally {
      vi.useRealTimers();
    }
    expect(fetchCount).toBe(2);
  }, 10_000);

  it("preserves fresh feed and job progress when route and alarm dirty scans yield", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-yield-vector";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-VECTOR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    const jobIds = ["CHGJOB-111111111111111111111111", "CHGJOB-222222222222222222222222", "CHGJOB-333333333333333333333333"];
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "durable-sibling-cursor", jobs: jobIds.map((job_id, index) => ({
        job_id,
        change: { kind: "deleted" as const, name: `sibling-${index}.md`, path: `/inputs/sibling-${index}.md` },
        detection_source: "incremental" as const,
        priority: 10
      })) });
    });
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    let dirtyScanCalls = 0;
    const checkpointsSeenBeforeDirtyScan: Array<{ outcome: Record<string, unknown> | null; next_wake_at: number | null }> = [];
    vi.useFakeTimers();
    try {
      const requestAt = Date.now();
      await runInDurableObject(guard, (instance, durableState) => {
        const continuationStore = new ManagedDocumentChangeJobStore(durableState.storage);
        const target = instance as unknown as {
          enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
        };
        const createCoordinator = target.createManagedDocumentChangeCoordinator.bind(instance);
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation((...args) => {
          const coordinator = createCoordinator(...args);
          vi.spyOn(coordinator as any, "processJob").mockResolvedValue(true);
          return coordinator;
        });
        vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockImplementation(async () => {
          dirtyScanCalls += 1;
          const checkpoint = continuationStore.continuation();
          checkpointsSeenBeforeDirtyScan.push({ outcome: checkpoint.last_outcome, next_wake_at: checkpoint.next_wake_at });
          if (dirtyScanCalls === 1 || dirtyScanCalls === 3) throw new Error("slice_budget_exhausted");
        });
      });

      const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
      expect(first.status).toBe(200);
      const firstBody = await first.json<any>();
      expect(retryAfter.didInject()).toBe(true);
      expect(retryAfter.continuedCursors).toContain(targetCursor);
      expect(firstBody).toMatchObject({ jobs_completed: 1, jobs_pending: 2, unread_feed: true, budget_yield: true });
      expect(firstBody.feed_retry_at).toBeGreaterThan(requestAt + 50_000);
      expect(checkpointsSeenBeforeDirtyScan[0].outcome).toMatchObject({
        semantic_progress: 1, jobs_completed: 1, unread_feed: true, executable_jobs: 2,
        safe_errors: ["provider_retryable"]
      });
      expect(checkpointsSeenBeforeDirtyScan[0].next_wake_at).toBeGreaterThan(requestAt);
      expect(checkpointsSeenBeforeDirtyScan[0].next_wake_at).toBeLessThan(requestAt + 5_000);
      const afterRoute = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation());
      expect(afterRoute.last_outcome).toMatchObject({ semantic_progress: 1, unread_feed: true, executable_jobs: 2, budget_yield: true });

      vi.setSystemTime(requestAt + 2_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const afterAlarm = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        pending: new ManagedDocumentChangeJobStore(durableState.storage).pendingCount(),
        statuses: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray()
      }));
      expect(dirtyScanCalls).toBe(3);
      expect(checkpointsSeenBeforeDirtyScan[2].outcome).toMatchObject({
        semantic_progress: 2, jobs_completed: 2, unread_feed: true, executable_jobs: 0,
        safe_errors: [], feed_retry_at: firstBody.feed_retry_at
      });
      expect(checkpointsSeenBeforeDirtyScan[2].next_wake_at).toBeGreaterThan(requestAt + 50_000);
      expect(mock.providerCalls.filter(call => call.endpoint === "POST /2/files/list_folder/continue")).toHaveLength(1);
      expect(afterAlarm.pending).toBe(0);
      expect(afterAlarm.statuses).toEqual([{ status: "completed" }, { status: "completed" }, { status: "completed" }]);
      expect(afterAlarm.continuation.feed_retry_at).toBe(firstBody.feed_retry_at);
      expect(afterAlarm.continuation.last_outcome).toMatchObject({
        semantic_progress: 2,
        jobs_registered: 0,
        jobs_completed: 2,
        unread_feed: true,
        executable_jobs: 0,
        future_eligible_jobs: 0,
        budget_yield: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists coordinator progress and its feed Retry-After before a post-recovery provider failure", async () => {
    const mock = installDropboxMock();
    const slug = "post-recovery-failure-vector";
    const created = await createProject("TXN-CHANGEJOB-POST-RECOVERY-VECTOR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF post recovery retry");
    const jobId = "CHGJOB-777777777777777777777777";
    const cursor = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "post-recovery-feed-cursor", jobs: [{
        job_id: jobId,
        change: { kind: "deleted", name: "completed-before-hook.md", path: "/inputs/completed-before-hook.md" },
        detection_source: "incremental", priority: 10
      }] });
      return store.cursor();
    });
    if (typeof cursor !== "string") throw new Error("Expected exact continuation cursor");
    const retryAfter = injectRetryAfterForCursor(mock, cursor);
    const coordinatorWitnessKey = "test-post-recovery-fresh-coordinator-witness";
    const recoveryWitnessKey = "test-post-recovery-hook-entry-witness";
    const probeOnlyWitnessKey = "test-post-recovery-probe-only-delegated";
    vi.useFakeTimers();
    try {
      const requestAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(true, requestAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: requestAt + 1_000,
          documents_priority_next: true, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = 1 WHERE singleton = 1");
        await durableState.storage.setAlarm(requestAt + 1_000);
      });
      await runInDurableObject(guard, (instance, durableState) => {
        const target = instance as unknown as {
          recoverOneUnownedNavigationHeadWrite: (...args: unknown[]) => Promise<unknown>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
        };
        const createCoordinator = target.createManagedDocumentChangeCoordinator.bind(instance);
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation((...args) => {
          const coordinator = createCoordinator(...args);
          const reconcile = coordinator.reconcile.bind(coordinator);
          vi.spyOn(coordinator, "reconcile").mockImplementation(async (...reconcileArgs) => {
            const outcome = await reconcile(...reconcileArgs);
            await durableState.storage.put(coordinatorWitnessKey, {
              jobs_completed: outcome.jobs_completed, semantic_progress: outcome.semantic_progress,
              unread_feed: outcome.unread_feed, feed_retry_at: outcome.feed_retry_at
            });
            return outcome;
          });
          vi.spyOn(coordinator as any, "processJob").mockResolvedValue(true);
          return coordinator;
        });
        const recoverHeadWrite = target.recoverOneUnownedNavigationHeadWrite.bind(instance);
        vi.spyOn(target, "recoverOneUnownedNavigationHeadWrite").mockImplementation(async (...args) => {
          if (args[3] === true) {
            const result = await recoverHeadWrite(...args);
            await durableState.storage.put(probeOnlyWitnessKey, true);
            return result;
          }
          const outcome = await durableState.storage.get<Record<string, unknown>>(coordinatorWitnessKey);
          const jobStatus = durableState.storage.sql.exec<{ status: string }>(
            "SELECT status FROM managed_document_change_jobs WHERE job_id = ?", jobId).one().status;
          await durableState.storage.put(recoveryWitnessKey, { outcome, jobStatus });
          throw new ProviderOperationError("recovery proof read delayed", true,
            { providerId: "dropbox", retryAfterMs: 90_000 });
        });
      });
      vi.setSystemTime(requestAt + 2_000);
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const persisted = await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        const jobStatus = durableState.storage.sql.exec<{ status: string }>(
          "SELECT status FROM managed_document_change_jobs WHERE job_id = ?", jobId).one().status;
        return { continuation: store.continuation(), failure: store.preludeFailureCheckpoint(), jobStatus,
          coordinatorWitness: await durableState.storage.get<Record<string, unknown>>(coordinatorWitnessKey),
          recoveryWitness: await durableState.storage.get<Record<string, unknown>>(recoveryWitnessKey),
          probeOnlyDelegated: await durableState.storage.get<boolean>(probeOnlyWitnessKey),
          job: store.pending().find(item => item.job_id === jobId) ?? null };
      });
      expect(persisted.coordinatorWitness).toMatchObject({ jobs_completed: 1, semantic_progress: 1,
        unread_feed: true, feed_retry_at: expect.any(Number) });
      expect(persisted.recoveryWitness).toMatchObject({ jobStatus: "completed", outcome: persisted.coordinatorWitness });
      expect(persisted.probeOnlyDelegated).toBe(true);
      expect(persisted.jobStatus).toBe("completed");
      expect(retryAfter.didInject()).toBe(true);
      expect(persisted.continuation.last_outcome).toMatchObject({ jobs_completed: 1, semantic_progress: 1,
        unread_feed: true, safe_errors: ["provider_retryable", "document_slice_failed"] });
      expect(persisted.continuation.feed_retry_at).toBeGreaterThan(requestAt + 50_000);
      expect(persisted.continuation.next_wake_at).toBeGreaterThanOrEqual(requestAt + 90_000);
      expect(persisted.continuation.next_wake_at).toBeGreaterThanOrEqual(persisted.continuation.feed_retry_at!);
      expect(persisted.job).toBeNull();
      expect(persisted.failure).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("breaks the identical typed post-recovery streak after a non-internal hook failure", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-POST-RECOVERY-STREAK-0001", "post-recovery-streak-reset");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await runInDurableObject(guard, async (_instance, durableState) => {
        const store = new ManagedDocumentChangeJobStore(durableState.storage);
        store.beginContinuationSlice(false, startedAt);
        store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 1_000,
          documents_priority_next: false, feed_retry_at: null,
          outcome: { semantic_progress: 0, jobs_registered: 0, jobs_completed: 0, unread_feed: false,
            executable_jobs: 0, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [] } });
        durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = 1 WHERE singleton = 1");
        await durableState.storage.setAlarm(startedAt + 1_000);
      });
      let attempts = 0;
      const coordinatorWitnessKey = "test-post-recovery-streak-coordinator-witness";
      const hookWitnessesKey = "test-post-recovery-streak-hook-witnesses";
      await runInDurableObject(guard, (instance, durableState) => {
        const target = instance as unknown as {
          recoverOneUnownedNavigationHeadWrite: (...args: unknown[]) => Promise<unknown>;
          createManagedDocumentChangeCoordinator: (...args: unknown[]) => ManagedDocumentChangeCoordinator;
        };
        let coordinatorSequence = 0;
        const createCoordinator = target.createManagedDocumentChangeCoordinator.bind(instance);
        vi.spyOn(target, "createManagedDocumentChangeCoordinator").mockImplementation((...args) => {
          const coordinator = createCoordinator(...args);
          const reconcile = coordinator.reconcile.bind(coordinator);
          vi.spyOn(coordinator, "reconcile").mockImplementation(async (...reconcileArgs) => {
            const outcome = await reconcile(...reconcileArgs);
            await durableState.storage.put(coordinatorWitnessKey,
              { sequence: ++coordinatorSequence, semantic_progress: outcome.semantic_progress });
            return outcome;
          });
          return coordinator;
        });
        const recover = target.recoverOneUnownedNavigationHeadWrite.bind(instance);
        const sequence = [
          new InternalExecutionFailure("same_post_recovery_internal", "head_write_recovery"),
          new Error("non-internal post-recovery uncertainty"),
          new InternalExecutionFailure("same_post_recovery_internal", "head_write_recovery")
        ];
        vi.spyOn(target, "recoverOneUnownedNavigationHeadWrite").mockImplementation(async (...args) => {
          if (args[3] === true) return recover(...args);
          const witness = await durableState.storage.get<Record<string, unknown>>(coordinatorWitnessKey);
          const previous = await durableState.storage.get<Array<Record<string, unknown>>>(hookWitnessesKey) ?? [];
          previous.push(witness ?? { missing: true });
          await durableState.storage.put(hookWitnessesKey, previous);
          const failure = sequence[attempts++];
          if (!failure) throw new Error("Unexpected extra head-write recovery attempt");
          throw failure;
        });
      });

      const checkpoints: Array<{ failure: ReturnType<ManagedDocumentChangeJobStore["preludeFailureCheckpoint"]>; progress: number | undefined; progressFingerprint: string; witnesses: Array<Record<string, unknown>> }> = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        vi.setSystemTime(startedAt + attempt * 31_000);
        await runInDurableObject(guard, (_instance, durableState) => {
          durableState.storage.sql.exec("UPDATE managed_document_change_continuation SET slice_ordinal = 1 WHERE singleton = 1");
        });
        expect(await runDurableObjectAlarm(guard)).toBe(true);
        checkpoints.push(await runInDurableObject(guard, async (_instance, durableState) => {
          const store = new ManagedDocumentChangeJobStore(durableState.storage);
          const outcome = store.continuation().last_outcome;
          return { failure: store.preludeFailureCheckpoint(), progress: typeof outcome?.semantic_progress === "number"
            ? outcome.semantic_progress : undefined,
            progressFingerprint: await store.feedProgressFingerprint(0),
            witnesses: await durableState.storage.get<Array<Record<string, unknown>>>(hookWitnessesKey) ?? [] };
        }));
      }

      expect(attempts).toBe(3);
      expect(checkpoints.every(checkpoint => checkpoint.progress === checkpoints[0].progress)).toBe(true);
      expect(checkpoints.every(checkpoint => checkpoint.progressFingerprint === checkpoints[0].progressFingerprint)).toBe(true);
      expect(checkpoints.map(checkpoint => checkpoint.witnesses.length)).toEqual([1, 2, 3]);
      expect(checkpoints.map(checkpoint => checkpoint.witnesses.at(-1))).toEqual([
        { sequence: 1, semantic_progress: checkpoints[0].progress },
        { sequence: 2, semantic_progress: checkpoints[1].progress },
        { sequence: 3, semantic_progress: checkpoints[2].progress }
      ]);
      expect(checkpoints[0].failure).toMatchObject({ consecutive_failures: 1, total_attempts: 1, stopped: false });
      expect(checkpoints[1].failure).toMatchObject({ consecutive_failures: 0, total_attempts: 1, stopped: false });
      expect(checkpoints[2].failure).toMatchObject({ consecutive_failures: 1, total_attempts: 2, stopped: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives due document and navigation recovery a turn before repeated slow owed acknowledgements", async () => {
    installDropboxMock();
    const slug = "notify-fair-recovery";
    const created = await createProject("TXN-CHANGEJOB-NOTIFY-FAIR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    let acknowledgementCalls = 0;
    const acknowledgementProgress: Array<{ jobs: Array<{ status: string }>; scanPending: number }> = [];
    const seedDueWork = async (startedAt: number, suffix: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const currentCursor = store.cursor();
      const jobs: ManagedDocumentChangeJobInput[] = Array.from({ length: 9 }, (_, index) => {
        const jobSuffix = `${suffix}${index.toString(16).padStart(2, "0")}`;
        return { job_id: `CHGJOB-${jobSuffix.repeat(8)}`,
          change: { kind: "deleted", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/INPUTS/gone-${jobSuffix}.md`, name: `gone-${jobSuffix}.md` },
          detection_source: "incremental", priority: 10 };
      });
      store.registerPage({ expected_cursor: currentCursor, next_cursor: `notify-cursor-${suffix}`, jobs });
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt,
        documents_priority_next: true, feed_retry_at: null,
        outcome: { semantic_progress: 0, jobs_registered: 1, jobs_completed: 0, jobs_pending: 1, unread_feed: true,
          executable_jobs: 1, future_eligible_jobs: 0, stopped_unresolved_jobs: 0, safe_errors: [], global_notification_owed: true } });
      durableState.storage.sql.exec(
        "INSERT INTO navigation_refresh_scan (singleton, requested_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
        new Date(startedAt).toISOString()
      );
      // The helper runs a scheduled alarm immediately, even if it is future.
      // Keep the host scheduler from claiming this due fixture between the
      // seed/observer/manual-trigger callbacks and creating an extra ACK turn.
      await durableState.storage.setAlarm(startedAt + 60_000);
    });
    try {
      const firstStartedAt = Date.now();
      await seedDueWork(firstStartedAt, "C");
      await runInDurableObject(guard, instance => {
        const target = instance as unknown as {
          notifyDropboxChangeCoordinator(store: ManagedDocumentChangeJobStore, scope: { deadlineMs: number; signal: AbortSignal }): Promise<boolean>;
        };
        vi.spyOn(target, "notifyDropboxChangeCoordinator").mockImplementation(async store => {
          acknowledgementCalls += 1;
          const storage = (store as unknown as { storage: { sql: { exec<T>(query: string): { toArray(): T[] } } } }).storage;
          acknowledgementProgress.push({
            jobs: storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray(),
            scanPending: storage.sql.exec("SELECT singleton FROM navigation_refresh_scan WHERE singleton = 1").toArray().length
          });
          const continuation = store.continuation();
          store.finishContinuationSlice({ pending: continuation.pending, next_wake_at: continuation.next_wake_at,
            documents_priority_next: continuation.documents_priority_next, feed_retry_at: continuation.feed_retry_at,
            outcome: { ...(continuation.last_outcome ?? {}), global_notification_owed: true } });
          vi.setSystemTime(Date.now() + 19_000);
          return false;
        });
      });

      const firstAlarm = await runDurableObjectAlarm(guard);
      expect(firstAlarm).toBe(true);
      const firstAfter = await runInDurableObject(guard, async (_instance, durableState) => ({
        continuation: new ManagedDocumentChangeJobStore(durableState.storage).continuation(),
        jobs: durableState.storage.sql.exec<{ status: string }>("SELECT status FROM managed_document_change_jobs ORDER BY ordinal").toArray()
      }));
      expect(firstAfter.continuation.last_outcome?.global_notification_owed).toBe(true);
      expect(acknowledgementProgress[0]?.jobs).toHaveLength(9);
      expect(acknowledgementProgress[0]?.jobs.some(job => job.status === "completed")).toBe(true);
      expect(acknowledgementProgress[0]?.jobs.some(job => job.status === "pending")).toBe(true);
      expect(acknowledgementProgress[0]?.scanPending).toBe(0);

      const secondStartedAt = Date.now() + 1_000;
      vi.setSystemTime(secondStartedAt);
      await seedDueWork(secondStartedAt, "D");
      const secondAlarm = await runDurableObjectAlarm(guard);
      expect(secondAlarm).toBe(true);
      expect(acknowledgementProgress[1]?.jobs).toHaveLength(18);
      expect(acknowledgementProgress[1]?.jobs.some(job => job.status === "completed")).toBe(true);
      expect(acknowledgementProgress[1]?.jobs.some(job => job.status === "pending")).toBe(true);
      expect(acknowledgementProgress[1]?.scanPending).toBe(0);
      expect(acknowledgementCalls).toBe(2);
      const owed = await runInDurableObject(guard, async (_instance, durableState) =>
        new ManagedDocumentChangeJobStore(durableState.storage).continuation().last_outcome?.global_notification_owed);
      expect(owed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the fresh Retry-After vector when a route dirty scan fails non-budget", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-error-vector";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-ERROR-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    await runInDurableObject(guard, instance => {
      const target = instance as unknown as { enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void> };
      vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockRejectedValue(new InternalExecutionFailure("navigation_scan_invariant", "dirty_zone_scan"));
    });
    await runInDurableObject(guard, (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const current = store.continuation();
      store.finishContinuationSlice({ pending: current.pending, next_wake_at: current.next_wake_at,
        documents_priority_next: current.documents_priority_next, feed_retry_at: current.feed_retry_at,
        outcome: { ...(current.last_outcome ?? {}), global_notification_owed: true } });
    });

    const requestedAt = Date.now();
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const continuation = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).continuation());
    expect(retryAfter.didInject()).toBe(true);
    expect(retryAfter.continuedCursors).toContain(targetCursor);
    console.log("g4-scan-failure-outcome", JSON.stringify(continuation.last_outcome));

    expect(body).toMatchObject({ unread_feed: true, jobs_registered: 0, jobs_completed: 0,
      budget_yield: false, safe_errors: ["provider_retryable", "navigation_refresh_scan_failed"] });
    expect(body.feed_retry_at).toBeGreaterThan(requestedAt + 50_000);
    expect(continuation.last_outcome).toMatchObject({ unread_feed: true, jobs_registered: 0, jobs_completed: 0,
      safe_errors: ["provider_retryable", "navigation_refresh_scan_failed"], global_notification_owed: true });
    expect(continuation.next_wake_at).toBeGreaterThan(requestedAt + 50_000);
    expect(await runInDurableObject(guard, (_instance, durableState) => durableState.storage.sql.exec("SELECT singleton FROM navigation_refresh_scan").toArray())).toHaveLength(1);
  });

  it("keeps a future feed Retry-After instead of forcing a route one-second wake after dirty-scan yield", async () => {
    await reset();
    resetAfterRetryFaultFixture = true;
    const mock = installDropboxMock();
    const slug = "dirty-scan-feed-backoff";
    const created = await createProject("TXN-CHANGEJOB-DIRTY-SCAN-BACKOFF-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);
    const targetCursor = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).cursor());
    if (typeof targetCursor !== "string") throw new Error("Expected persisted Dropbox cursor after baseline");
    const retryAfter = injectRetryAfterForCursor(mock, targetCursor);
    const unrelatedContinue = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      body: JSON.stringify({ cursor: "unrelated-preflight-cursor" })
    });
    expect(unrelatedContinue.status).not.toBe(429);
    await mock.writeExternal(`${root}/INPUTS/unread.pdf`, "%PDF unread page");
    await runInDurableObject(guard, instance => {
      const target = instance as unknown as { enqueueNavigationRefreshForDirtyZones: (...args: unknown[]) => Promise<void> };
      vi.spyOn(target, "enqueueNavigationRefreshForDirtyZones").mockRejectedValue(new Error("slice_budget_exhausted"));
    });

    const requestedAt = Date.now();
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const continuation = await runInDurableObject(guard, (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).continuation());
    expect(retryAfter.didInject()).toBe(true);
    expect(retryAfter.continuedCursors).toContain(targetCursor);
    expect(body).toMatchObject({ unread_feed: true, budget_yield: true, jobs_pending: 0, executable_jobs: 0 });
    expect(body.feed_retry_at).toBeGreaterThan(requestedAt + 50_000);
    expect(continuation.next_wake_at).toBeGreaterThan(requestedAt + 50_000);
  });

  it("keeps dirty-zone navigation probes inside the remaining shared document deadline", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-NAV-SCOPE-0001", "scheduled-nav-scope");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    vi.useFakeTimers();
    const startedAt = Date.now() - 17_900;
    let apiStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { apiStarted = resolve; });
    const sourceStatePath = `/PROJECT_OS/.project-os/projects/${created.project_id}/documents/navigation-sources/state.json`;
    let scopedApiCalls = 0;
    let scopedSignalPresent = false;
    let scopedSignalType = "missing";
    let scopedSignalAborted = false;
    const delegateFetch = mock.spy.getMockImplementation();
    if (!delegateFetch) throw new Error("Dropbox mock implementation unavailable");
    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      let requestedPath: string | undefined;
      const apiArg = request.headers.get("Dropbox-API-Arg");
      if (apiArg) {
        try { requestedPath = (JSON.parse(apiArg) as { path?: string }).path; }
        catch { /* The delegated mock handles malformed test requests. */ }
      }
      if (!requestedPath && url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/get_metadata") {
        try { requestedPath = (JSON.parse(await request.clone().text()) as { path?: string }).path; }
        catch { /* The delegated mock handles malformed test requests. */ }
      }
      const readsNavigationState = requestedPath === sourceStatePath
        && (url.pathname === "/2/files/get_metadata" || url.pathname === "/2/files/download");
      if (!readsNavigationState) return delegateFetch(input, init);

      scopedApiCalls += 1;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      scopedSignalPresent = signal !== undefined && signal !== null;
      scopedSignalType = signal instanceof AbortSignal ? "AbortSignal" : typeof signal;
      apiStarted();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          scopedSignalAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    });

    await runInDurableObject(guard, async (instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.beginContinuationSlice(true);
      store.finishContinuationSlice({ pending: true, next_wake_at: startedAt + 20_000,
        documents_priority_next: false, feed_retry_at: null, outcome: { unread_feed: true } });
      state.storage.sql.exec(
        "INSERT INTO navigation_refresh_scan (singleton, requested_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
        new Date(startedAt).toISOString()
      );
      await state.storage.setAlarm(startedAt + 20_000);
      const slice = (instance as unknown as {
        createManagedDocumentSlice(at: number): { runtime: ReturnType<typeof packageRuntime>["runtime"]; scope: { deadlineMs: number }; abortTimer: ReturnType<typeof setTimeout> };
        enqueueNavigationRefreshForDirtyZones(projectId: string, runtime: ReturnType<typeof packageRuntime>["runtime"]): Promise<void>;
      }).createManagedDocumentSlice(startedAt);
      try {
        const scan = (instance as unknown as {
          enqueueNavigationRefreshForDirtyZones(projectId: string, runtime: typeof slice.runtime): Promise<void>;
        }).enqueueNavigationRefreshForDirtyZones(created.project_id, slice.runtime);
        const rejected = expect(scan).rejects.toThrow("slice_budget_exhausted");
        await requestStarted;
        await vi.advanceTimersByTimeAsync(101);
        await rejected;
      } finally {
        clearTimeout(slice.abortTimer);
      }
    });
    expect(scopedApiCalls).toBe(1);
    expect(scopedSignalPresent).toBe(true);
    expect(scopedSignalType).toBe("AbortSignal");
    expect(scopedSignalAborted).toBe(true);
    const checkpoint = await runInDurableObject(guard, async (_instance, state) => ({
      continuation: new ManagedDocumentChangeJobStore(state.storage).continuation(),
      scanPending: state.storage.sql.exec("SELECT singleton FROM navigation_refresh_scan WHERE singleton = 1").toArray().length === 1,
      alarmAt: await state.storage.getAlarm()
    }));
    expect(checkpoint.continuation.pending).toBe(true);
    expect(checkpoint.scanPending).toBe(true);
    expect(checkpoint.alarmAt).not.toBeNull();
    vi.useRealTimers();
  }, 15_000);

  it("gives a healthy sibling a scheduled turn after a failed head across coordinator restart", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAIRNESS-RED-0001", "scheduled-fairness-red");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Scheduled fairness", "scheduled-fairness-red");
    const firstId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingId = "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({
        expected_cursor: null,
        next_cursor: "fairness-seed",
        jobs: [
          { job_id: firstId, change: { kind: "deleted", name: "first.md", path: "/inputs/first.md" }, detection_source: "incremental", priority: 10 },
          { job_id: siblingId, change: { kind: "deleted", name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental", priority: 10 }
        ]
      });
    });

    const runScheduledSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        if (job.job_id === firstId) throw new Error("repeatable internal failure");
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });

    const first = await runScheduledSlice("2026-10-03T15:00:00.000Z");
    const second = await runScheduledSlice("2026-10-03T15:00:01.000Z");
    const third = await runScheduledSlice("2026-10-03T15:00:02.000Z");
    const pending = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).pending().map(job => job.job_id));

    expect(first).toMatchObject({ jobs_pending: 2, jobs_completed: 0, job_failures: 1 });
    expect(second).toMatchObject({ jobs_pending: 1, jobs_completed: 1, job_failures: 0 });
    expect(third).toMatchObject({ jobs_pending: 1, jobs_completed: 0, job_failures: 1 });
    expect(visited).toEqual([firstId, siblingId, firstId]);
    expect(pending).toEqual([firstId]);
  });

  it("lets a deferred job yield within its fixed cohort despite higher-priority arrivals", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAIRNESS-DEFERRED-0001", "scheduled-fairness-deferred");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Deferred fairness", "scheduled-fairness-deferred");
    const firstId = "CHGJOB-111111111111111111111111";
    const siblingId = "CHGJOB-222222222222222222222222";
    const firstArrivalId = "CHGJOB-333333333333333333333333";
    const secondArrivalId = "CHGJOB-444444444444444444444444";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "deferred-seed",
        jobs: [
          { job_id: firstId, change: { kind: "deleted", name: "deferred.md", path: "/inputs/deferred.md" }, detection_source: "incremental", priority: 10 },
          { job_id: siblingId, change: { kind: "deleted", name: "sibling.md", path: "/inputs/sibling.md" }, detection_source: "incremental", priority: 10 }
        ]
      });
    });
    const runSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage);
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        return job.job_id !== firstId;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const addArrival = (jobId: string, name: string, priority: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({
        expected_cursor: store.cursor(),
        next_cursor: store.cursor() ?? "deferred-seed",
        jobs: [{ job_id: jobId, change: { kind: "deleted", name, path: `/inputs/${name}` }, detection_source: "baseline", priority }]
      });
    });

    const first = await runSlice("2026-10-03T16:00:00.000Z");
    await addArrival(firstArrivalId, "arrival-one.md", 0);
    const second = await runSlice("2026-10-03T16:00:01.000Z");
    await addArrival(secondArrivalId, "arrival-two.md", 10);
    const third = await runSlice("2026-10-03T16:00:02.000Z");

    expect(first).toMatchObject({ jobs_pending: 2, jobs_completed: 0, job_failures: 0 });
    expect(second).toMatchObject({ jobs_completed: 1, job_failures: 0 });
    expect(third).toMatchObject({ jobs_completed: 1, job_failures: 0 });
    expect(visited).toEqual([firstId, siblingId, firstArrivalId]);
  });

  it("starts a fresh cohort for page siblings only after the prior cohort is exhausted", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-COHORT-PAGE-0001", "scheduled-cohort-page");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    runtime.changeFeed = { listChanges: async () => ({
      entries: [
        { kind: "deleted", name: "page-one.md", path: "/inputs/page-one.md" },
        { kind: "deleted", name: "page-two.md", path: "/inputs/page-two.md" }
      ],
      cursor: "cohort-page-2"
    }) };
    const state = emptyProjectState(created.project_id, "Cohort page", "scheduled-cohort-page");
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "cohort-page-1",
        jobs: [{ job_id: "CHGJOB-AAAAAAAAAAAAAAAABBBBBBBB", change: { kind: "deleted", name: "prior.md", path: "/inputs/prior.md" }, detection_source: "incremental", priority: 10 }]
      });
    });
    const result = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage);
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.change.name);
        return true;
      };
      return coordinator.reconcile(state, { now: "2026-10-03T17:30:00.000Z" });
    });

    expect(result).toMatchObject({ jobs_registered: 2, jobs_completed: 3, jobs_pending: 0, job_failures: 0 });
    expect(visited).toEqual(["prior.md", "page-one.md", "page-two.md"]);
  });

  it("stops only six identical classified internal failures while leaving the obligation pending", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-INTERNAL-STOP-0001", "scheduled-internal-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Internal failure stop", "scheduled-internal-stop");
    const jobId = "CHGJOB-555555555555555555555555";
    const siblingId = "CHGJOB-666666666666666666666666";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "internal-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "internal.md", path: "/inputs/internal.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 2473 WHERE job_id = ?", jobId);
    });

    const runFailureSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async () => { throw new InternalExecutionFailure("repeatable_internal_error", "process"); };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const base = Date.parse("2026-10-03T16:30:00.000Z");
    const failureSlices = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      failureSlices.push(await runFailureSlice(new Date(base + attempt * 86_400_000).toISOString()));
    }

    const stoppedState = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: store.cursor() ?? "internal-seed", jobs: [
        { job_id: siblingId, change: { kind: "deleted", name: "healthy.md", path: "/inputs/healthy.md" }, detection_source: "baseline", priority: 0 }
      ] });
      return {
        pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })),
        quarantines: store.quarantines(),
        findings: store.driftFindingsForJob(jobId),
        checkpoint: await store.readCheckpoint("2026-10-10T16:30:00.000Z")
      };
    });

    const visited: string[] = [];
    const afterStop = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse("2026-10-11T16:30:00.000Z"));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now: "2026-10-11T16:30:00.000Z" });
    });
    const final = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => job.job_id), checkpoint: await store.readCheckpoint("2026-10-11T16:30:00.000Z") };
    });

    expect(failureSlices.slice(0, 5).every(summary => summary.jobs_pending === 1 && summary.jobs_quarantined === 0)).toBe(true);
    expect(failureSlices[5]).toMatchObject({ jobs_pending: 1, jobs_quarantined: 0, job_failures: 1 });
    expect(stoppedState.pending).toEqual([
      { job_id: siblingId, attempts: 0 },
      { job_id: jobId, attempts: 2479 }
    ]);
    expect(stoppedState.quarantines).toEqual([]);
    expect(stoppedState.findings).toEqual([expect.objectContaining({ status: "unexpected_conflict", code: "identical_internal_failure_limit" })]);
    expect(stoppedState.checkpoint.schedule.last_verified_at).toBeNull();
    expect(stoppedState.checkpoint.recent_findings).toEqual([expect.objectContaining({ code: "identical_internal_failure_limit" })]);
    expect(afterStop).toMatchObject({ jobs_pending: 1, jobs_completed: 1, job_failures: 0 });
    expect(visited).toEqual([siblingId]);
    expect(final.pending).toEqual([jobId]);
    expect(final.checkpoint.schedule.last_verified_at).toBeNull();
  });

  it("keeps repeated unknown errors retryable and unresolved without internal-stop quarantine", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-UNKNOWN-RETRY-0001", "scheduled-unknown-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Unknown retry", "scheduled-unknown-retry");
    const jobId = "CHGJOB-777777777777777777777777";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "unknown-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "unknown.md", path: "/inputs/unknown.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 2473 WHERE job_id = ?", jobId);
    });

    const base = Date.parse("2026-10-03T18:00:00.000Z");
    const runFailureSlice = (nowMs: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => nowMs);
      (coordinator as any).processJob = async () => { throw new Error("unclassified persistent failure"); };
      return coordinator.reconcile(state, { scheduled: true, now: new Date(nowMs).toISOString() });
    });
    const first = await runFailureSlice(base);
    const beforeEligible = await runFailureSlice(base);
    const summaries = [first];
    for (let attempt = 1; attempt < 6; attempt += 1) {
      const summary = await runInDurableObject(guard, async (_instance, durableState) => {
        const nowMs = base + attempt * 86_400_000;
        const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => nowMs);
        (coordinator as any).processJob = async () => { throw new Error("unclassified persistent failure"); };
        return coordinator.reconcile(state, { scheduled: true, now: new Date(nowMs).toISOString() });
      });
      summaries.push(summary);
    }
    const remaining = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })), quarantines: store.quarantines(), findings: store.driftFindingsForJob(jobId) };
    });

    expect(first).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(beforeEligible).toMatchObject({ jobs_pending: 1, job_failures: 0 });
    expect(summaries.every(summary => summary.jobs_pending === 1 && summary.job_failures === 1)).toBe(true);
    expect(remaining.pending).toEqual([{ job_id: jobId, attempts: 2479 }]);
    expect(remaining.quarantines).toEqual([]);
    expect(remaining.findings).toEqual([]);
  });

  it("parks six identical typed internal feed failures without a seventh feed attempt", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-INTERNAL-FEED-STOP-0001", "internal-feed-stop");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Internal feed stop", "internal-feed-stop");
    const now = Date.parse("2026-10-03T19:00:00.000Z");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => {
      feedCalls += 1;
      throw new InternalExecutionFailure("provider_scope_invalid", "feed_page_read");
    };
    const summaries = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const summary = await runInDurableObject(guard, async (_instance, durableState) => {
        const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
        return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
      });
      summaries.push(summary);
    }
    const seventh = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const checkpoint = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).feedFailureCheckpoint());

    expect(feedCalls).toBe(6);
    expect(summaries.slice(0, 5).every(summary => summary.stopped_unresolved_jobs === 0 && summary.verification_completed === false)).toBe(true);
    expect(summaries[5]).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 1, job_failures: 0,
      safe_errors: ["identical_internal_feed_failure_limit"], feed_retry_at: Number.MAX_SAFE_INTEGER, verification_completed: false });
    expect(seventh).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 1, job_failures: 0,
      safe_errors: ["identical_internal_feed_failure_limit"], verification_completed: false });
    expect(checkpoint).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });

    await runInDurableObject(guard, (_instance, durableState) => new ManagedDocumentChangeJobStore(durableState.storage)
      .registerPage({ expected_cursor: null, next_cursor: "feed-progress-after-stop", jobs: [
        { job_id: `CHGJOB-${"F".repeat(24)}`, change: { kind: "deleted", path: "/PROJECT_OS/WORKSPACE/PROJECTS/feed-progress/deleted.md", name: "deleted.md" },
          detection_source: "incremental", priority: 10 }
      ] }));
    const afterProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const resetCheckpoint = await runInDurableObject(guard, async (_instance, durableState) =>
      new ManagedDocumentChangeJobStore(durableState.storage).feedFailureCheckpoint());
    expect(feedCalls).toBe(7);
    expect(afterProgress).toMatchObject({ stopped_unresolved_jobs: 0, safe_errors: ["internal_feed_failure"], verification_completed: false });
    expect(resetCheckpoint).toMatchObject({ consecutive_failures: 1, total_attempts: 7, stopped: false });
  });

  it("tracks feed failure streaks only from durable job progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FEED-STABLE-PROGRESS-0001", "feed-stable-progress");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const failureFingerprint = "a".repeat(64);
    const firstProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "stable-feed-cursor", jobs: [] });
      return store.feedProgressFingerprint(1);
    });
    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).recordInternalFeedFailure(failureFingerprint, firstProgress);
    });
    const cursorOnlyProgress = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: "stable-feed-cursor", next_cursor: "empty-page-cursor", jobs: [] });
      return store.feedProgressFingerprint(0);
    });
    expect(cursorOnlyProgress).toBe(firstProgress);

    const repeatedFailure = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      let checkpoint = store.feedFailureCheckpoint();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        checkpoint = store.recordInternalFeedFailure(failureFingerprint, cursorOnlyProgress);
      }
      return checkpoint;
    });
    expect(repeatedFailure).toMatchObject({ consecutive_failures: 6, total_attempts: 6, stopped: true });

    const progressed = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: "empty-page-cursor", next_cursor: "job-registration-cursor", jobs: [
        { job_id: "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB", change: { kind: "file", path: "/inputs/real-progress.md", name: "real-progress.md" },
          detection_source: "incremental", priority: 10 }
      ] });
      const progress = await store.feedProgressFingerprint(0);
      const checkpoint = store.recordInternalFeedFailure(failureFingerprint, progress);
      return { progress, checkpoint };
    });
    expect(progressed.progress).not.toBe(firstProgress);
    expect(progressed.checkpoint).toMatchObject({ consecutive_failures: 1, total_attempts: 7, stopped: false });
  });

  it("keeps unknown feed errors retryable without the typed internal stop", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-UNKNOWN-FEED-0001", "unknown-feed-retry");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Unknown feed retry", "unknown-feed-retry");
    let feedCalls = 0;
    runtime.changeFeed.listChanges = async () => { feedCalls += 1; throw new Error("unknown feed failure"); };
    const now = Date.parse("2026-10-03T20:00:00.000Z");
    const run = () => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => now);
      return coordinator.reconcile(state, { scheduled: true, now: new Date(now).toISOString() });
    });
    const first = await run();
    const second = await run();
    expect(feedCalls).toBe(2);
    expect(first).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 0, safe_errors: ["feed_error"], verification_completed: false });
    expect(second).toMatchObject({ unread_feed: true, stopped_unresolved_jobs: 0, safe_errors: ["feed_error"], verification_completed: false });
  });

  it("honors provider retry-after while allowing eligible siblings through", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROVIDER-WAIT-0001", "scheduled-provider-wait");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Provider wait", "scheduled-provider-wait");
    const blockedId = "CHGJOB-888888888888888888888888";
    const siblingId = "CHGJOB-999999999999999999999999";
    const visited: string[] = [];

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({ expected_cursor: null, next_cursor: "provider-seed", jobs: [
        { job_id: blockedId, change: { kind: "deleted", name: "rate-limited.md", path: "/inputs/rate-limited.md" }, detection_source: "incremental", priority: 10 },
        { job_id: siblingId, change: { kind: "deleted", name: "healthy.md", path: "/inputs/healthy.md" }, detection_source: "incremental", priority: 10 }
      ] });
    });
    const runSlice = (now: string) => runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => Date.parse(now));
      (coordinator as any).processJob = async (_state: unknown, job: ManagedDocumentChangeJobInput) => {
        visited.push(job.job_id);
        if (job.job_id === blockedId) {
          throw new ProviderOperationError("provider retry detail", true, {
            providerId: "dropbox", status: 429, code: "too_many_requests", requestId: "volatile-request-id", retryAfterMs: 60_000
          });
        }
        return true;
      };
      return coordinator.reconcile(state, { scheduled: true, now });
    });
    const start = Date.parse("2026-10-03T19:00:00.000Z");
    const first = await runSlice(new Date(start).toISOString());
    const second = await runSlice(new Date(start).toISOString());
    const tooEarly = await runSlice(new Date(start + 59_000).toISOString());
    const eligible = await runSlice(new Date(start + 60_000).toISOString());
    const later = [];
    for (let minute = 2; minute <= 6; minute += 1) {
      later.push(await runSlice(new Date(start + minute * 60_000).toISOString()));
    }
    const stateAfter = await runInDurableObject(guard, async (_instance, durableState) => {
      const rows = durableState.storage.sql.exec("SELECT * FROM managed_document_change_job_failure_state ORDER BY job_id").toArray();
      return { rows, pending: new ManagedDocumentChangeJobStore(durableState.storage).pending().map(job => job.job_id) };
    });

    expect(first).toMatchObject({ job_failures: 1, jobs_pending: 2 });
    expect(second).toMatchObject({ jobs_completed: 1, jobs_pending: 1 });
    expect(tooEarly).toMatchObject({ job_failures: 0, jobs_completed: 0, jobs_pending: 1 });
    expect(eligible).toMatchObject({ job_failures: 1, jobs_pending: 1 });
    expect(later.every(summary => summary.job_failures === 1 && summary.jobs_pending === 1)).toBe(true);
    expect(visited.filter(jobId => jobId === blockedId)).toHaveLength(7);
    expect(visited[1]).toBe(siblingId);
    expect(stateAfter.pending).toEqual([blockedId]);
    expect(stateAfter.rows).toHaveLength(1);
    expect(stateAfter.rows[0]).toMatchObject({ classification: "provider_retryable", stopped: 0 });
    expect(JSON.stringify(stateAfter.rows)).not.toMatch(/provider retry detail|volatile-request-id/);
  });

  it("bases retry-after on the provider failure observation time, not slice entry", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-RETRY-OBSERVED-0001", "scheduled-retry-observed");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Retry observation", "scheduled-retry-observed");
    const jobId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAC";
    const startedAt = Date.parse("2026-10-03T20:00:00.000Z");
    let clockMs = startedAt;

    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).registerPage({
        expected_cursor: null,
        next_cursor: "retry-observation-seed",
        jobs: [{ job_id: jobId, change: { kind: "deleted", name: "delayed.md", path: "/inputs/delayed.md" }, detection_source: "incremental", priority: 10 }]
      });
    });

    await runInDurableObject(guard, async (_instance, durableState) => {
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => clockMs);
      (coordinator as any).processJob = async () => {
        // Model a provider response arriving 15 seconds after the scheduled slice began.
        clockMs = startedAt + 15_000;
        throw new ProviderOperationError("delayed provider response", true, {
          providerId: "dropbox", status: 429, code: "too_many_requests", retryAfterMs: 60_000
        });
      };
      await coordinator.reconcile(state, { scheduled: true, now: new Date(startedAt).toISOString() });
    });

    const stored = await runInDurableObject(guard, async (_instance, durableState) =>
      durableState.storage.sql.exec("SELECT next_attempt_at FROM managed_document_change_job_failure_state WHERE job_id = ?", jobId).one());
    expect(stored.next_attempt_at).toBe(startedAt + 75_000);
    const beforeDeadline = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const nowMs = startedAt + 74_999;
      return store.selectNextPending(store.beginSelectionCohort(nowMs), nowMs);
    });
    expect(beforeDeadline).toBeNull();
    const atDeadline = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const nowMs = startedAt + 75_000;
      return store.selectNextPending(store.beginSelectionCohort(nowMs), nowMs);
    });
    expect(atDeadline?.job_id).toBe(jobId);
  });

  it("parks a finite Retry-After whose deadline cannot be represented safely", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-RETRY-BOUNDARY-0001", "scheduled-retry-boundary");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const jobId = "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBC";
    const base = Date.parse("2026-10-03T21:00:00.000Z");
    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "retry-boundary-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "boundary.md", path: "/inputs/boundary.md" }, detection_source: "incremental", priority: 10 }
      ] });
      const job = store.pending()[0];
      store.recordFailure(job, "bounded diagnostic", {
        failure_fingerprint: "0".repeat(64), progress_fingerprint: "1".repeat(64),
        classification: "provider_retryable", now_ms: base, retry_after_ms: 1e16
      });
      const cohort = store.beginSelectionCohort(base + 86_400_000);
      expect(cohort).toBeGreaterThan(0);
      expect(store.selectNextPending(cohort, base + 86_400_000)).toBeNull();
      const maximumTimeCohort = store.beginSelectionCohort(Number.MAX_SAFE_INTEGER);
      expect(store.selectNextPending(maximumTimeCohort, Number.MAX_SAFE_INTEGER)).toBeNull();
      const row = durableState.storage.sql.exec("SELECT next_attempt_at FROM managed_document_change_job_failure_state WHERE job_id = ?", jobId).one();
      expect(row.next_attempt_at).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it("resets the internal failure streak after a changed error or durable finding progress", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FAILURE-RESET-0001", "scheduled-failure-reset");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { runtime } = packageRuntime();
    const state = emptyProjectState(created.project_id, "Failure reset", "scheduled-failure-reset");
    const jobId = "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAB";
    let failureCode = "first_internal_error";

    await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "failure-reset-seed", jobs: [
        { job_id: jobId, change: { kind: "deleted", name: "reset.md", path: "/inputs/reset.md" }, detection_source: "incremental", priority: 10 }
      ] });
      durableState.storage.sql.exec("UPDATE managed_document_change_jobs SET attempts = 100 WHERE job_id = ?", jobId);
    });
    const runSlice = (day: number) => runInDurableObject(guard, async (_instance, durableState) => {
      const sliceAt = Date.parse("2026-10-03T20:00:00.000Z") + day * 86_400_000;
      // Failure observation must use the same fixture clock as selection; real
      // wall time eventually overtakes day 1 and silently skips one attempt.
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, undefined, () => sliceAt);
      (coordinator as any).processJob = async () => { throw new InternalExecutionFailure(failureCode, "process"); };
      return coordinator.reconcile(state, {
        scheduled: true,
        now: new Date(sliceAt).toISOString()
      });
    });

    for (let day = 0; day < 5; day += 1) await runSlice(day);
    failureCode = "different_internal_error";
    const changedError = await runSlice(5);
    await runInDurableObject(guard, async (_instance, durableState) => {
      new ManagedDocumentChangeJobStore(durableState.storage).recordDriftFinding({
        finding_id: "DRIFT-0123456789ABCDEF01234567",
        job_id: jobId,
        path: "/inputs/reset.md",
        change_kind: "deleted",
        status: "expected_reconciled",
        code: "PACKAGE_EXPECTED_DELETE",
        request_id: "DOCREQ-STABLE-FINDING-0001",
        observed_at: "2026-10-09T20:00:00.000Z"
      });
    });
    const changedProgress = await runSlice(6);
    const beforeSixthAfterProgress = [];
    for (let day = 7; day < 11; day += 1) beforeSixthAfterProgress.push(await runSlice(day));
    const sixthAfterProgress = await runSlice(11);
    const final = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      return { pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })), findings: store.driftFindingsForJob(jobId) };
    });

    expect(changedError).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(changedProgress).toMatchObject({ jobs_pending: 1, job_failures: 1 });
    expect(beforeSixthAfterProgress.every(summary => summary.jobs_pending === 1 && summary.job_failures === 1)).toBe(true);
    expect(sixthAfterProgress).toMatchObject({ jobs_pending: 1, job_failures: 1, jobs_quarantined: 0 });
    expect(final.pending).toEqual([{ job_id: jobId, attempts: 112 }]);
    expect(final.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PACKAGE_EXPECTED_DELETE" }),
      expect.objectContaining({ code: "identical_internal_failure_limit" })
    ]));
  });

  it("resumes a frozen CURRENT-index resource fanout across bounded scheduled slices", async () => {
    const projectId = "PRJ-9327";
    const state = emptyProjectState(projectId, "Fanout", "package-fanout");
    const runtime = packageRuntime().runtime;
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-package-fanout/WORKING/CURRENT.md`;
    await runtime.objects.createText(path, "externally changed index");
    runtime.objects.listChildren = async (parent) => parent === path.slice(0, path.lastIndexOf("/"))
      ? [{ kind: "file", name: "CURRENT.md", path }]
      : [];
    runtime.changeFeed = { listChanges: async () => ({ entries: [], cursor: "fanout-pending" }) };
    const resources = Array.from({ length: 10 }, (_, index) => ({
      resource_id: `PKG-${index.toString(16).toUpperCase().padStart(64, "0")}`,
      resource_type: "package",
      zone: "WORKING",
      version: `1:${index.toString(16).padStart(64, "0")}`
    }));
    const callbackResources: string[] = [];
    const callbackSnapshotIds: (string | undefined)[] = [];
    let normalReconcileCalls = 0;
    let snapshotUnavailable = false;
    let snapshotRestored = false;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);

    const results = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      store.registerPage({ expected_cursor: null, next_cursor: "fanout-seed", jobs: [] });
      const job: ManagedDocumentChangeJobInput = {
        job_id: `CHGJOB-${"A".repeat(24)}`,
        change: { kind: "file", name: "CURRENT.md", path },
        detection_source: "incremental",
        priority: 10
      };
      store.registerPage({ expected_cursor: "fanout-seed", next_cursor: "fanout-pending", jobs: [job] });
      const coordinator = new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe",
        async (_state, operation) => { callbackResources.push(operation.resources[0].resource_id); },
        async () => undefined);
      (coordinator as any).mutationGate.processChanges = async () => ({ candidates: 0, policy_violations: 0 });
      (coordinator as any).stableWorkProducts.reconcile = async () => ({ handled: false, captured: 0, restored: 0, conflicts: 0 });
      (coordinator as any).reconciler.reconcileChanges = async () => { normalReconcileCalls += 1; return ({ scanned: 0, ignored: 0, captured: 0, ingested: 0, duplicates: 0, restored: 0, conflicts: 0, intake_completed: 0, duplicate_cleaned: 0, withdrawn: 0, intake_resumed: 0, changed_document_ids: [] }); };
      (coordinator as any).packageDrift = {
        observe: async (_state: unknown, _change: unknown, snapshotRequestId?: string) => {
          callbackSnapshotIds.push(snapshotRequestId);
          if (snapshotRestored) return { handled: true, status: "expected_reconciled", code: "PACKAGE_EXPECTED_WRITE", request_id: "DOCREQ-SNAPSHOT-PROOF-0001", resource: resources[0] };
          if (snapshotUnavailable) return { handled: true, status: "unexpected_conflict", code: "PACKAGE_NAVIGATION_UNAVAILABLE", snapshot_request_id: snapshotRequestId };
          return { handled: true, status: "unexpected_conflict", code: "PACKAGE_UNEXPECTED_MUTATION", resources, snapshot_request_id: "DOCREQ-SNAPSHOT-PROOF-0001" };
        }
      };
      const first = await coordinator.reconcile(state);
      const firstFindings = store.driftFindingsForJob(job.job_id);
      snapshotRestored = true;
      const restored = await coordinator.reconcile(state);
      const restoredFindings = store.driftFindingsForJob(job.job_id);
      snapshotRestored = false;
      snapshotUnavailable = true;
      const unavailable = await coordinator.reconcile(state);
      const unavailableFindings = store.driftFindingsForJob(job.job_id);
      snapshotUnavailable = false;
      const second = await coordinator.reconcile(state);
      return { first, second, restored, unavailable, firstFindings, restoredFindings, unavailableFindings, findings: store.driftFindingsForJob(job.job_id) };
    });

    expect(results.first).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0, restored: 0 });
    expect(results.firstFindings).toHaveLength(9); // frozen-snapshot sentinel plus eight resources
    expect(results.restored).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0 });
    expect(results.restoredFindings).toHaveLength(9);
    expect(results.unavailable).toMatchObject({ jobs_completed: 0, jobs_pending: 1, job_failures: 0 });
    expect(results.unavailableFindings).toHaveLength(9);
    expect(results.second).toMatchObject({ jobs_completed: 1, jobs_pending: 0, job_failures: 0, restored: 0 });
    expect(results.findings).toHaveLength(11);
    expect(callbackResources).toHaveLength(10);
    expect(new Set(callbackResources).size).toBe(10);
    expect(callbackSnapshotIds).toEqual([undefined, "DOCREQ-SNAPSHOT-PROOF-0001", "DOCREQ-SNAPSHOT-PROOF-0001", "DOCREQ-SNAPSHOT-PROOF-0001"]);
    expect(normalReconcileCalls).toBe(0);
  });

  it("advances the provider cursor after durable registration while isolating a failed job from a healthy sibling", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-isolation";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    // Establish the initial provider cursor before introducing the page under test.
    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const badInput = `${root}/INPUTS/bad.pdf`;
    const goodInput = `${root}/INPUTS/good.pdf`;
    faults.push({
      endpoint: "/2/files/copy_v2",
      occurrence: 1,
      status: 409,
      error_summary: "to/conflict/file/...",
      path: badInput
    });

    await mock.writeExternal(badInput, "%PDF poison job");
    await mock.writeExternal(goodInput, "%PDF healthy job");

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      cursor_advanced: true,
      jobs_registered: 2,
      jobs_completed: 0,
      jobs_pending: 2,
      job_failures: 1,
      budget_yield: true,
      ignored: 0
    });

    expect(mock.files.has(badInput)).toBe(true);

    // The first failure now carries a durable bounded retry time. Mature that
    // specific local fixture job so this test continues to cover recovery
    // after its injected provider fault has been consumed.
    await runInDurableObject(guard, async (_instance, durableState) => {
      const pendingBadJob = new ManagedDocumentChangeJobStore(durableState.storage).pending()
        .find(job => job.change.path === badInput);
      expect(pendingBadJob).toBeDefined();
      durableState.storage.sql.exec(
        "UPDATE managed_document_change_job_failure_state SET next_attempt_at = 0 WHERE job_id = ?",
        pendingBadJob!.job_id
      );
    });

    for (let slice = 0; slice < 8 && mock.files.has(badInput); slice += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_050));
      await runInDurableObject(guard, instance => instance.alarm());
    }
    expect(mock.files.has(badInput)).toBe(false);
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/bad.pdf`)).toBe("%PDF poison job");
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/good.pdf`)).toBe("%PDF healthy job");
  });

  it("routes a folder change without requesting file metadata", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-routing";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobs_registered: 1,
      jobs_completed: 1,
      jobs_pending: 0,
      job_failures: 0
    });
    expect(mock.providerCalls).not.toContainEqual({ endpoint: "POST /2/files/get_metadata", paths: [folder] });
  });

  it("terminally quarantines a legacy file job whose target is now a folder", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-quarantine";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(),
        next_cursor: "legacy-folder-cursor",
        jobs: [{
          job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
          change: { kind: "file", name: "REVENUE-OS", path: folder },
          detection_source: "incremental",
          priority: 10
        }]
      });
    });

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 1, job_failures: 0 });

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
      path: folder,
      code: "directory_used_as_file_target",
      attempts: 1
    })]);
  });

  it("keeps parent-list routing when an older runtime has no exact-kind capability", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-FOLDER-FALLBACK-0001", "folder-kind-fallback");
    const { runtime } = packageRuntime();
    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-folder-kind-fallback/DELIVERABLES/REVENUE-OS`;
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const listedParents: string[] = [];
    runtime.objects.listChildren = async parent => {
      listedParents.push(parent);
      return [{ kind: "folder", name: "REVENUE-OS", path: folder }];
    };
    const state = emptyProjectState(created.project_id, "Folder fallback", "folder-kind-fallback");

    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const store = new ManagedDocumentChangeJobStore(durableState.storage);
      const cursor = store.cursor();
      if (cursor === null) throw new Error("Folder fallback fixture baseline cursor is missing");
      store.registerPage({ expected_cursor: cursor, next_cursor: cursor, jobs: [{
        job_id: "CHGJOB-FAFAFAFAFAFAFAFAFAFAFAFA",
        change: { kind: "file", name: "REVENUE-OS", path: folder },
        detection_source: "incremental", priority: 10
      }] });
      return new ManagedDocumentChangeCoordinator(runtime, durableState.storage)
        .reconcile(state, { now: "2026-10-04T18:00:00.000Z" });
    });

    expect(listedParents).toEqual([folder.slice(0, folder.lastIndexOf("/"))]);
    expect(summary).toMatchObject({ jobs_quarantined: 1, jobs_pending: 0, job_failures: 0 });
  });

  it("quarantines a first-page folder target without draining its entire parent listing", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-large-parent-folder-target";
    const created = await createProject("TXN-CHANGEJOB-LARGE-PARENT-FOLDER-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const parent = `${root}/DELIVERABLES`;
    const folder = `${parent}/REVENUE-OS`;
    const jobId = "CHGJOB-121212121212121212121212";
    mock.writeExternalFolder(folder);

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const cursor = store.cursor();
      if (cursor === null) throw new Error("Large-parent fixture baseline cursor is missing");
      store.registerPage({
        expected_cursor: cursor,
        next_cursor: cursor,
        jobs: [{
          job_id: jobId,
          change: { kind: "file", name: "REVENUE-OS", path: folder },
          detection_source: "incremental",
          priority: 10
        }]
      });
    });

    const documentRoot = `${machineDocumentRoot(created.project_id)}/`;
    const documentFilesBefore = [...mock.files.keys()].filter(path => path.startsWith(documentRoot)).sort();
    const delegateFetch = mock.spy.getMockImplementation();
    if (!delegateFetch) throw new Error("Dropbox mock implementation unavailable");
    const listingRequests: string[] = [];
    const pageOneEntries = [{
      ".tag": "folder",
      id: "id:whole-parent-target",
      name: "REVENUE-OS",
      path_display: folder,
      path_lower: folder.toLowerCase()
    }];
    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder") {
        const body = await request.clone().json() as { path?: unknown };
        if (body.path === parent) {
          listingRequests.push("first-page");
          return Response.json({ entries: pageOneEntries, cursor: "whole-parent-page-1", has_more: true });
        }
      }
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
        const body = await request.clone().json() as { cursor?: unknown };
        if (typeof body.cursor === "string" && /^whole-parent-page-\d+$/.test(body.cursor)) {
          listingRequests.push(body.cursor);
          const page = Number(body.cursor.slice("whole-parent-page-".length));
          return Response.json({
            entries: [{
              ".tag": "folder",
              id: `id:whole-parent-unrelated-${page}`,
              name: `unrelated-${page}`,
              path_display: `${parent}/unrelated-${page}`,
              path_lower: `${parent}/unrelated-${page}`.toLowerCase()
            }],
            cursor: `whole-parent-page-${page + 1}`,
            has_more: page < 65
          });
        }
      }
      return delegateFetch(input, init);
    });

    const firstResponse = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    const secondResponse = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const [first, second] = await Promise.all([
      firstResponse.json<Record<string, unknown>>(),
      secondResponse.json<Record<string, unknown>>()
    ]);
    const durable = await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      return {
        pending: store.pending().map(job => ({ job_id: job.job_id, attempts: job.attempts })),
        quarantines: store.quarantines()
      };
    });

    expect([first, second], `Whole-parent request diagnostics: ${JSON.stringify({
      listing_http_requests: listingRequests.length,
      first_page_restarts: listingRequests.filter(cursor => cursor === "first-page").length
    })}`).toMatchObject([
      { jobs_pending: 0, jobs_quarantined: 1, job_failures: 0, budget_yield: false },
      { jobs_pending: 0, jobs_quarantined: 0, job_failures: 0, budget_yield: false }
    ]);
    expect(durable.pending).toEqual([]);
    expect(durable.quarantines).toEqual([expect.objectContaining({
      job_id: jobId,
      path: folder,
      code: "directory_used_as_file_target",
      attempts: 1
    })]);
    expect(mock.files.has(folder)).toBe(false);
    expect([...mock.files.keys()].filter(path => path.startsWith(documentRoot)).sort()).toEqual(documentFilesBefore);
  });

  it("quarantines a proven-absent file target once and admits a new observation after it reappears", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-missing-metadata";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-MISSINGMETA-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/vanished.pdf`;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(), next_cursor: "missing-metadata-retry-cursor",
        jobs: [{ job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", change: { kind: "file", name: "vanished.pdf", path: absentPath }, detection_source: "incremental", priority: 10 }]
      });
    });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_completed: 0, job_failures: 0, jobs_quarantined: 1 });
    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", path: absentPath, code: "file_target_missing", attempts: 1
    })]);

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(second.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 0, job_failures: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines[0]?.attempts).toBe(1);

    await mock.writeExternal(absentPath, "%PDF target reappeared with a new provider revision");
    const reappeared = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(reappeared.json()).resolves.toMatchObject({ jobs_registered: 1, jobs_completed: 1, jobs_pending: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      const jobs = state.storage.sql.exec<{ job_id: string; status: string; attempts: number }>(
        "SELECT job_id, status, attempts FROM managed_document_change_jobs ORDER BY ordinal"
      ).toArray();
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.job_id)).size).toBe(2);
      expect(jobs.map((job) => job.status)).toEqual(["completed", "completed"]);
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toHaveLength(1);
  });

  it("keeps a file-kind change retryable when exact metadata lookup fails", async () => {
    const faults: DropboxMockFault[] = [];
    installDropboxMock({ faults });
    const slug = "change-job-list-failure";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-LISTFAIL-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/unknown.pdf`;
    await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "list-failure-cursor", jobs: [{
        job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
        change: { kind: "file", name: "unknown.pdf", path: absentPath }, detection_source: "incremental", priority: 10
      }] });
    });
    faults.push({ endpoint: "/2/files/get_metadata", occurrence: 1, status: 503, error_summary: "temporarily_unavailable", path: absentPath });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 1, jobs_completed: 0, job_failures: expect.any(Number), jobs_quarantined: 0 });
    let pending: unknown[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      pending = new ManagedDocumentChangeJobStore(state.storage).pending();
    });
    expect(pending).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE", attempts: expect.any(Number), last_error: expect.stringContaining("Dropbox metadata lookup failed")
    })]);
  }, 15_000);

  it("terminally quarantines an external move that conflicts with immutable candidate evidence", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-candidate-evidence-conflict";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-CANDIDATE-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const original = `${root}/DELIVERABLES/external.md`;
    const moved = `${root}/DELIVERABLES/external-moved.md`;
    await mock.writeExternal(original, "# externally moved");
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);

    const move = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_path: original, to_path: moved })
    });
    expect(move.ok).toBe(true);

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      jobs_quarantined: 1,
      jobs_pending: 0,
      job_failures: 0
    });

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual(expect.arrayContaining([expect.objectContaining({
      path: moved,
      code: "mutation_candidate_evidence_conflict",
      attempts: 1
    })]));
  });

  it("keeps the old durable cursor when its reset baseline fails despite a foreign project continuation", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-reset-atomic";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    let cursorBefore: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorBefore = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(cursorBefore).not.toBeNull();

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    await mock.writeExternal(`${root}/ARTIFACTS/reset-proof.md`, "# reset proof");

    const foreign = await createProject("TXN-CHANGEJOB-PROJECT-FOREIGN-CURSOR-0001", "foreign-cursor-consumer");
    const foreignGuard = testEnv.PROJECT_GUARD.getByName(foreign.project_id);
    const foreignBaseline = await foreignGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(foreignBaseline.status).toBe(200);
    const foreignCursor = await runInDurableObject(foreignGuard, (_instance, state) =>
      state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor);
    expect(foreignCursor).not.toBeNull();
    expect(foreignCursor).not.toBe(cursorBefore);

    // Both reset responses are bound to the saved target cursor. This preserves
    // one for its retry even if another project's real continuation runs first.
    faults.push(
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/...",
        cursor: cursorBefore!
      },
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/...",
        cursor: cursorBefore!
      },
      {
        endpoint: "/2/files/list_folder",
        occurrence: 1,
        status: 400,
        error_summary: "invalid_arg/...",
        path: root
      }
    );

    const unrelatedListing = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/PROJECT_OS/WORKSPACE/UNRELATED-PROJECT" })
    });
    expect(unrelatedListing.status).toBe(200);

    const providerCallOffset = mock.providerCalls.length;
    const firstReset = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(firstReset.status).toBe(200);
    await expect(firstReset.json()).resolves.toMatchObject({ safe_errors: ["provider_blocked"], unread_feed: true });

    const firstResetProviderCalls = mock.providerCalls.slice(providerCallOffset);
    expect(firstResetProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder/continue", paths: [] });
    expect(firstResetProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder", paths: [root] });

    let cursorAfterFailure: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorAfterFailure = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
      expect(cursorAfterFailure).toBe(cursorBefore);
      // This test owns a manual retry; alarm-only recovery is exercised separately.
      await state.storage.deleteAlarm();
    });
    expect(cursorAfterFailure).toBe(cursorBefore);

    const foreignRetry = await foreignGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(foreignRetry.status).toBe(200);
    await expect(foreignRetry.json()).resolves.toMatchObject({ cursor_reset: false, baseline: false });

    // Advance the durable Retry-After eligibility rather than retrying the
    // failed feed immediately. This test is about atomic cursor preservation.
    await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      expect(store.cursor()).toBe(cursorBefore);
      const continuation = store.continuation();
      store.finishContinuationSlice({
        pending: continuation.pending,
        next_wake_at: Date.now(),
        documents_priority_next: continuation.documents_priority_next,
        feed_retry_at: Date.now(),
        outcome: continuation.last_outcome ?? { unread_feed: true }
      });
    });

    const retryProviderCallOffset = mock.providerCalls.length;
    const retry = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      cursor_reset: true,
      baseline: true,
      cursor_advanced: true
    });
    const retryProviderCalls = mock.providerCalls.slice(retryProviderCallOffset);
    expect(retryProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder/continue", paths: [] });
    expect(retryProviderCalls).toContainEqual({ endpoint: "POST /2/files/list_folder", paths: [root] });
  });

  it("deduplicates a replayed page and preserves global pending order across later pages", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0003", "change-job-store-order");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-store-order/INPUTS`;
      const firstPage: ManagedDocumentChangeJobInput[] = [
        {
          job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
          change: { kind: "deleted", name: "first.md", path: `${root}/first.md` },
          detection_source: "incremental",
          priority: 10
        },
        {
          job_id: "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB",
          change: { kind: "deleted", name: "second.md", path: `${root}/second.md` },
          detection_source: "incremental",
          priority: 10
        }
      ];

      const initialCursor = store.cursor();
      expect(store.registerPage({
        expected_cursor: initialCursor,
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 0, cursor_advanced: false });
      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB"
      ]);

      store.markFailed("CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA", "retry me");
      store.markCompleted("CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB");
      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-2",
        jobs: [
          {
            job_id: "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
            change: { kind: "deleted", name: "third.md", path: `${root}/third.md` },
            detection_source: "incremental",
            priority: 10
          },
          {
            job_id: "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD",
            change: { kind: "deleted", name: "fourth.md", path: `${root}/fourth.md` },
            detection_source: "incremental",
            priority: 10
          }
        ]
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
        "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD"
      ]);
    });
  });

  it("persists an external drift conflict without replacing its first observation", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0004", "change-job-drift-finding");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let findings: ManagedDocumentDriftFinding[] = [];

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const finding = {
        finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
        job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-drift-finding/WORKING/PACKAGES/PKG-${"A".repeat(64)}/1/a.md`,
        change_kind: "deleted" as const,
        status: "unexpected_conflict" as const,
        code: "PACKAGE_UNEXPECTED_DISAPPEARANCE",
        request_id: "DOCREQ-DRIFT-0001",
        resource: { resource_id: `PKG-${"A".repeat(64)}`, resource_type: "package", zone: "WORKING", version: `1:${"b".repeat(64)}` },
        observed_at: "2026-09-12T00:00:00.000Z"
      };
      store.recordDriftFinding(finding);
      store.recordDriftFinding({ ...finding, observed_at: "2026-09-12T01:00:00.000Z", code: "PACKAGE_EXPECTED_EFFECT_DIVERGED" });
      findings = store.driftFindings();
    });

    expect(findings).toEqual([expect.objectContaining({
      finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
      status: "unexpected_conflict",
      code: "PACKAGE_EXPECTED_EFFECT_DIVERGED",
      opened_at: "2026-09-12T00:00:00.000Z",
      observed_at: "2026-09-12T01:00:00.000Z"
    })]);
  });

  it("persists daily verification lateness until a later successful verification", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0005", "change-job-lateness");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let first: unknown;
    let early: unknown;
    let late: unknown;
    let cleared: unknown;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      first = store.scheduledVerification("2026-09-12T00:00:00.000Z");
      store.completeScheduledVerification("2026-09-12T00:00:00.000Z");
      early = store.scheduledVerification("2026-09-12T23:59:59.000Z");
      late = store.scheduledVerification("2026-09-13T00:00:01.000Z");
      store.completeScheduledVerification("2026-09-13T00:00:01.000Z");
      cleared = store.scheduledVerification("2026-09-13T00:00:02.000Z");
    });

    expect(first).toMatchObject({ due: true, late_since: null });
    expect(early).toMatchObject({ due: false, late_since: null });
    expect(late).toMatchObject({ due: true, late_since: "2026-09-13T00:00:00.000Z" });
    expect(cleared).toMatchObject({ due: false, late_since: null, last_verified_at: "2026-09-13T00:00:01.000Z" });
  });

  it("keeps daily verification due until the final provider change page is consumed", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-PAGED-0001", "change-job-paged-daily");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    let initialCursor: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      initialCursor = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(initialCursor).not.toBeNull();
    const previousFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const cursorTransitions: Array<{ requested: string; returned: string; has_more: boolean }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
        const request = input instanceof Request ? input.clone() : new Request(input, init);
        const body = await request.json<{ cursor: string }>();
        // The provider fixture has two immutable pages, not one page per call.
        // Polling the terminal cursor again cannot invent a third change page.
        const response = body.cursor === initialCursor
          ? { entries: [], cursor: "daily-page-1", has_more: true }
          : body.cursor === "daily-page-1" || body.cursor === "daily-page-2"
            ? { entries: [], cursor: "daily-page-2", has_more: false }
            : null;
        if (response) {
          cursorTransitions.push({ requested: body.cursor, returned: response.cursor, has_more: response.has_more });
          return Response.json(response);
        }
      }
      return previousFetch(input, init);
    });

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ scheduled_due: true, last_scheduled_verified_at: null });
    let intermediateCursor: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      intermediateCursor = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(intermediateCursor).toBe("daily-page-1");

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(second.status).toBe(200);
    const result = await second.json<{ scheduled_due: boolean; last_scheduled_verified_at: string | null }>();
    expect(result.scheduled_due).toBe(true);
    expect(result.last_scheduled_verified_at).not.toBeNull();
    // An independent incremental poll may legitimately run before readback.
    const independentPoll = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(independentPoll.status).toBe(200);
    console.info("daily cursor interleaving", { project_id: created.project_id, initialCursor, cursorTransitions });
    let finalCursor: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      finalCursor = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(finalCursor).toBe("daily-page-2");
    const third = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(await third.json()).toMatchObject({ scheduled_due: false });
  });
});
