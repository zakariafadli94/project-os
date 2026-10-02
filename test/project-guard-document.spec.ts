import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { encodeAdmission } from "../src/admission/transport";
import { normalizeDocumentAdmission } from "../src/admission/operation-context";
import { canonicalJson } from "../src/rules/contract";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentRequestLedger } from "../src/documents/request-ledger";
import { ExecutionJournal } from "../src/execution/journal";
import { documentIdFor } from "../src/domain/managed-document";
import { ruleFixture } from "./helpers/rule-fixtures";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentVersionPath, machineStatePath } from "../src/persistence/layout";
import { toManagedProviderObservation } from "../src/persistence/compatibility/dropbox-v1-evidence";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCompactCatalogRoot } from "../src/documents/zone-navigation-sources";
import { createSliceBudget } from "../src/convergence/budget";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { navigationCatalogRebuildProgressSchema, navigationReconcileSchema } from "../src/domain/zone-navigation";
import { executionHash } from "../src/execution/journal";
import { emptyProjectState } from "../src/domain/transitions";
import { workspaceProjectRoot } from "../src/persistence/layout";
import { ManagedDocumentChangeJobStore } from "../src/documents/change-job-store";

const testEnv = env as unknown as Env;
const at = "2026-08-24T19:35:00+01:00";
const governanceSigningKey = "project-document-governance";
const admissionGap = { rule: { rule_id: "RULE-DOCUMENT-GAP-0001", version: 1, scope: { kind: "global" } }, code: "ACCEPTED_UNENFORCED", check_id: "expected_version" };

async function createProject(transactionId: string): Promise<Receipt> {
  const suffix = transactionId.slice(-4).toLowerCase();
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
      payload: { name: `Document ${suffix}`, slug: `document-${suffix}`, aliases: [], objective: "Managed docs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("ProjectGuard managed documents", () => {
  beforeEach(async () => {
    installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("admits and finalizes a governed catalog rebuild without publishing an index or a business revision", async () => {
    const created = await createProject("TXN-CATALOG-REBUILD-GUARD-9097");
    const projectId = created.project_id;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const materialization = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const runtime = createProductionPersistence(testEnv, projectId);
    const sources = new ZoneNavigationSources(runtime);
    const sourceBudget = createSliceBudget(() => Date.now(), new AbortController().signal);
    expect(await sources.beginAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-REBUILD-SETUP", 0, sourceBudget)).toBe(true);
    expect(await sources.finishAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-REBUILD-SETUP", 0, sourceBudget)).toBe(true);
    const manifestPath = `${zoneNavigationCompactCatalogRoot(projectId, "REVIEW")}/ready.json`;
    const manifest = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone: "REVIEW",
      ready_generation: 0, shards: [], completed_generations: [], coalesced_dirty: [] });
    await runtime.objects.createText(manifestPath, manifest);
    const metadata = await runtime.objects.getMetadata(manifestPath);
    expect(metadata).not.toBeNull();
    const token = "catalog-rebuild-operator-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      INGRESS_TOKEN: token,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${token}` } });
    const { context }: any = await contextResponse.json();
    await runInDurableObject(guard, instance => {
      const target = instance as any;
      const admit = target.admitRules.bind(target);
      vi.spyOn(target, "admitRules").mockImplementation(async (...args: any[]) => ({ ...await admit(...args), gaps: [admissionGap] }));
    });
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-CATALOG-REBUILD-GUARD-0001", project_id: projectId,
      zone: "REVIEW", expected_project_revision: created.new_revision, expected_generation: 0,
      expected_source_generation: 0, expected_index: null, purpose: "compact_catalog_rebuild",
      expected_catalog_manifest: { object_id: metadata!.objectId, revision_token: metadata!.revisionToken,
        content_sha256: await sha256Text(manifest) }, created_at: at
    });
    const response = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ request_id: request.request_id, status: "pending" });

    let receipt: { receipt_json: string } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await runDurableObjectAlarm(materialization);
      receipt = await new ManagedDocumentRequestLedger(runtime.objects).readReceipt(projectId, request.request_id);
      if (receipt) break;
    }
    expect(receipt).not.toBeNull();
    expect(JSON.parse(receipt!.receipt_json)).toMatchObject({
      status: "committed", operation: "navigation.reconcile", execution_status: "pending",
      gaps: [admissionGap],
      catalog_rebuild_certificate_ref: expect.stringContaining("/navigation/catalog-rebuild/finalizations/")
    });
    expect(await new ExecutionJournal(runtime, projectId, "document", request.request_id).status())
      .toMatchObject({ status: "finalized", terminal: true });
    expect(await runtime.objects.readText(`${machineDocumentRoot(projectId)}/navigation/REVIEW/head.json`)).toBeNull();
  });

  it("turns a deterministic catalog census gap into a terminal conflict receipt", async () => {
    const created = await createProject("TXN-CATALOG-REBUILD-GAP-9101");
    const projectId = created.project_id;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const materialization = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const runtime = createProductionPersistence(testEnv, projectId);
    const sources = new ZoneNavigationSources(runtime);
    const sourceBudget = createSliceBudget(() => Date.now(), new AbortController().signal);
    expect(await sources.beginAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-GAP-SETUP", 0, sourceBudget)).toBe(true);
    expect(await sources.finishAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-GAP-SETUP", 0, sourceBudget)).toBe(true);
    const manifestPath = `${zoneNavigationCompactCatalogRoot(projectId, "REVIEW")}/ready.json`;
    const manifest = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone: "REVIEW",
      ready_generation: 0, shards: [], completed_generations: [], coalesced_dirty: [] });
    await runtime.objects.createText(manifestPath, manifest);
    const metadata = await runtime.objects.getMetadata(manifestPath);
    expect(metadata).not.toBeNull();
    vi.spyOn(ZoneNavigationEngine.prototype, "prepareCompactCatalogRebuild")
      .mockResolvedValue({ status: "conflict", code: "active_version_provider_mismatch" });
    vi.spyOn(ZoneNavigationEngine.prototype, "publishPreparedCompactCatalogRebuild")
      .mockResolvedValue({ status: "conflict", code: "active_version_provider_mismatch" });
    const token = "catalog-gap-operator-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      INGRESS_TOKEN: token,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${token}` } });
    const { context }: any = await contextResponse.json();
    await runInDurableObject(guard, instance => {
      const target = instance as any;
      const admit = target.admitRules.bind(target);
      vi.spyOn(target, "admitRules").mockImplementation(async (...args: any[]) => ({ ...await admit(...args), gaps: [admissionGap] }));
    });
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-CATALOG-GAP-0001", project_id: projectId,
      zone: "REVIEW", expected_project_revision: created.new_revision, expected_generation: 0,
      expected_source_generation: 0, expected_index: null, purpose: "compact_catalog_rebuild",
      expected_catalog_manifest: { object_id: metadata!.objectId, revision_token: metadata!.revisionToken,
        content_sha256: await sha256Text(manifest) }, created_at: at
    });
    const response = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ request_id: request.request_id, status: "pending" });
    for (let attempt = 0; attempt < 6; attempt += 1) await runDurableObjectAlarm(materialization);
    const receipt = await new ManagedDocumentRequestLedger(runtime.objects).readReceipt(projectId, request.request_id);
    expect(receipt).not.toBeNull();
    expect(JSON.parse(receipt!.receipt_json)).toMatchObject({ status: "conflict", code: "active_version_provider_mismatch", gaps: [admissionGap] });
    expect(await new ExecutionJournal(runtime, projectId, "document", request.request_id).status())
      .toMatchObject({ status: "conflict", terminal: true });
  });

  it("settles an already-stopped catalog rebuild only from its bound conflict progress", async () => {
    const created = await createProject("TXN-CATALOG-STOPPED-GAP-9102");
    const projectId = created.project_id;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const runtime = createProductionPersistence(testEnv, projectId);
    const sources = new ZoneNavigationSources(runtime);
    const sourceBudget = createSliceBudget(() => Date.now(), new AbortController().signal);
    expect(await sources.beginAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-STOPPED-SETUP", 0, sourceBudget)).toBe(true);
    expect(await sources.finishAdoption(projectId, "REVIEW", "DOCREQ-CATALOG-STOPPED-SETUP", 0, sourceBudget)).toBe(true);
    const manifestPath = `${zoneNavigationCompactCatalogRoot(projectId, "REVIEW")}/ready.json`;
    const manifest = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone: "REVIEW",
      ready_generation: 0, shards: [], completed_generations: [], coalesced_dirty: [] });
    await runtime.objects.createText(manifestPath, manifest);
    const metadata = await runtime.objects.getMetadata(manifestPath);
    expect(metadata).not.toBeNull();
    vi.spyOn(ZoneNavigationEngine.prototype, "publishPreparedCompactCatalogRebuild")
      .mockResolvedValue({ status: "conflict", code: "active_version_provider_mismatch" });
    const token = "catalog-stopped-operator-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      INGRESS_TOKEN: token,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${token}` } });
    const { context }: any = await contextResponse.json();
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-CATALOG-STOPPED-0001", project_id: projectId,
      zone: "REVIEW", expected_project_revision: created.new_revision, expected_generation: 0,
      expected_source_generation: 0, expected_index: null, purpose: "compact_catalog_rebuild",
      expected_catalog_manifest: { object_id: metadata!.objectId, revision_token: metadata!.revisionToken,
        content_sha256: await sha256Text(manifest) }, created_at: at
    });
    const envelope = JSON.stringify(encodeAdmission(request, context));
    expect(await (await guard.fetch("https://internal/document", { method: "POST", body: envelope })).json())
      .toMatchObject({ status: "pending" });
    const journal = new ExecutionJournal(runtime, projectId, "document", request.request_id);
    const progress = navigationCatalogRebuildProgressSchema.parse({
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: projectId,
      request_id: request.request_id, request_hash: await executionHash(request), zone: "REVIEW",
      source_generation: 0, source_snapshot_id: "source:0", cursor: null, page_count: 0,
      source_count: 0, shard_cursor: 0, shard_count: 0, status: "conflict", finalization_ref: null,
      coverage_gaps: [{ resource_id: "head:DOC-0123456789ABCDEF01234567", code: "active_version_provider_mismatch" }]
    });
    await runtime.objects.createText(`${await journal.root()}/navigation-catalog-rebuild-progress.json`, canonicalJson(progress));
    await runInDurableObject(guard, (instance) => (instance as any).ctx.storage.sql.exec(
      "INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES (?, ?, ?, ?, ?, ?)",
      "document", request.request_id, "old-failure", 6, 1, JSON.stringify({ code: "identical_internal_failure_limit" })
    ));
    const navigationWorker = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    await runInDurableObject(navigationWorker, async (_instance, state) => {
      await state.storage.put(`navigation-work:${request.request_id}`, "queued");
      await state.storage.put(`navigation-retry:${request.request_id}`, JSON.stringify({ stopped: true, next_attempt_at: null }));
    });
    const status = await guard.fetch(`https://internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(await status.json()).toMatchObject({ navigation_worker: { queued: true, stopped: true, next_attempt_at: null } });
    let originalMaterializationGuard!: DurableObjectNamespace;
    await runInDurableObject(guard, (instance) => {
      originalMaterializationGuard = (instance as any).env.MATERIALIZATION_GUARD;
      (instance as any).env.MATERIALIZATION_GUARD = { getByName: () => ({ fetch: () => new Promise(() => {}) }) };
    });
    const started = Date.now();
    const statusWithSlowDiagnostic = await guard.fetch(`https://internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await statusWithSlowDiagnostic.json()).toMatchObject({ status: "recovery_blocked" });
    await runInDurableObject(guard, (instance) => { (instance as any).env.MATERIALIZATION_GUARD = originalMaterializationGuard; });
    const replay = await guard.fetch("https://internal/document", { method: "POST", body: envelope });
    expect(await replay.json()).toMatchObject({ status: "conflict", code: "active_version_provider_mismatch" });
    const receipt = await new ManagedDocumentRequestLedger(runtime.objects).readReceipt(projectId, request.request_id);
    expect(JSON.parse(receipt!.receipt_json)).toMatchObject({ status: "conflict", code: "active_version_provider_mismatch" });
  });

  it("rejects instance repair from a fresh signed generic ingress actor", async () => {
    const created = await createProject("TXN-DOCUMENT-REPAIR-AUTH-01");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const signingKey = "project-document-governance";
    const ingressToken = "generic-ingress-repair-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey,
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      INGRESS_TOKEN: ingressToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } });
    const { context }: any = await contextResponse.json();
    const request = {
      operation: "document.instance.repair",
      request_id: "DOCREQ-INSTANCE-REPAIR-AUTH-0001",
      project_id: created.project_id,
      document_id: "DOC-0123456789ABCDEF01234567",
      version_id: "VER-EXT-111111111111111111111111",
      logical_path: "strategies/current.md",
      expected_project_revision: created.new_revision,
      expected_source_generation: 0,
      expected_version_record_sha256: "a".repeat(64),
      content_sha256: "b".repeat(64),
      historical_provider: { object_id: "id:history", revision_token: "rev-history", path: "/PROJECT/WORKING/strategies/current.md", size: 9 },
      current_provider: { object_id: "id:current", revision_token: "rev-current", path: "/PROJECT/WORKING/strategies/current.md", size: 9 },
      created_at: at
    };
    const response = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "DOCUMENT_INSTANCE_REPAIR_AUTHORITY_REQUIRED" });
  });

  it("rejects published instance quarantine from a signed generic ingress actor", async () => {
    const created = await createProject(`TXN-DOCUMENT-QUARANTINE-AUTH-${Date.now().toString(36).toUpperCase()}`);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const ingressToken = "generic-ingress-quarantine-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      INGRESS_TOKEN: ingressToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } });
    const { context }: any = await contextResponse.json();
    const request = {
      operation: "document.quarantine_instance",
      request_id: "DOCREQ-QUARANTINE-AUTH-0001",
      project_id: created.project_id,
      document_id: "DOC-0123456789ABCDEF01234567",
      version_id: "VER-EXT-111111111111111111111111",
      logical_path: "strategies/current.md",
      expected_project_revision: created.new_revision,
      expected_source_generation: 0,
      observed_provider: { object_id: "id:current", revision_token: "rev-current", path: "/PROJECT/DELIVERABLES/strategies/current.md", size: 9, provider_hash: "a".repeat(64) },
      content_sha256: "b".repeat(64),
      created_at: at
    };
    const response = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "DOCUMENT_QUARANTINE_AUTHORITY_REQUIRED" });
  });

  it("commits quarantine only through a signed Control Tower operator admission", async () => {
    const created = await createProject(`TXN-DOCUMENT-QUARANTINE-OK-${Date.now().toString(36).toUpperCase()}`);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const mock = installDropboxMock();
    const runtime = createProductionPersistence(testEnv, created.project_id);
    const signingKey = governanceSigningKey;
    const ingressToken = `quarantine-ingress-${Date.now()}`;
    const operatorToken = `quarantine-operator-${Date.now()}`;
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey,
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      INGRESS_TOKEN: ingressToken,
      CONTROL_TOWER_OPERATOR_TOKEN: operatorToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, created.project_id);
    await runInDurableObject(guard, (instance) => {
      const persistence = (instance as any).persistence;
      persistence.serverSideCopy.copyObjectVersion = async (from: string, to: string, expected: { objectId: string; revisionToken: string; contentSha256: string }) => {
        const source = await persistence.objects.getMetadata(from);
        const bytes = await persistence.objects.readBytes(from, 10 * 1024 * 1024);
        if (!source || source.objectId !== expected.objectId || source.revisionToken !== expected.revisionToken || !bytes) throw new Error("test_exact_copy_source_changed");
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (digest !== expected.contentSha256) throw new Error("test_exact_copy_hash_changed");
        await persistence.objects.createText(to, new TextDecoder().decode(bytes));
        const destination = await persistence.objects.getMetadata(to);
        if (!destination) throw new Error("test_exact_copy_destination_missing");
        return { source: { objectId: expected.objectId, revisionToken: expected.revisionToken, contentSha256: digest }, destination };
      };
    });
    const setupResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } });
    const { context: setupContext }: any = await setupResponse.json();
    const content = "# Drift quarantine fixture\n";
    const writeRequest = { operation: "working.write", request_id: "DOCREQ-QUARANTINE-GUARD-WRITE-0001", project_id: created.project_id,
      logical_path: "strategies/quarantine.md", content, content_sha256: await sha256Text(content), created_at: at };
    const written: any = await (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(writeRequest, setupContext)) })).json();
    expect(written).toMatchObject({ status: "committed", stage: "working" });
    const reviewRequest = { operation: "review.promote", request_id: "DOCREQ-QUARANTINE-GUARD-REVIEW-0001", project_id: created.project_id,
      document_id: written.document_id, expected_version_id: written.version_id, created_at: at };
    const reviewed: any = await (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(reviewRequest, setupContext)) })).json();
    expect(reviewed).toMatchObject({ status: "committed", stage: "review" });
    const publishRequest = { operation: "publish", request_id: "DOCREQ-QUARANTINE-GUARD-PUBLISH-0001", project_id: created.project_id,
      document_id: written.document_id, expected_version_id: reviewed.version_id, created_at: at };
    const published: any = await (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(publishRequest, setupContext)) })).json();
    expect(published).toMatchObject({ status: "committed", stage: "published" });

    const head = await new DocumentLedgerRepository(runtime).readHead(created.project_id, written.document_id);
    const sourcePath = head!.provider!.published!.path;
    const driftedBytes = "external edit requiring operator review";
    const metadataBefore = await runtime.objects.getMetadata(sourcePath);
    expect(metadataBefore).not.toBeNull();
    // The test's installed provider mock exposes external writes through its shared backing store.
    const external = await mock.writeExternal(sourcePath, driftedBytes);
    expect(external).not.toBeNull();
    const current = await runtime.objects.getMetadata(sourcePath);
    const sourceState = await new ZoneNavigationSources(runtime).readState(created.project_id, "DELIVERABLES");
    const operatorResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } });
    const { context: operatorContext }: any = await operatorResponse.json();
    const request = { operation: "document.quarantine_instance", request_id: "DOCREQ-QUARANTINE-GUARD-0001", project_id: created.project_id,
      document_id: written.document_id, version_id: published.version_id, logical_path: head!.logical_path,
      expected_project_revision: created.new_revision, expected_source_generation: sourceState.generation,
      observed_provider: { object_id: current!.objectId!, revision_token: current!.revisionToken!, path: sourcePath,
        size: current!.size, provider_hash: current!.integrityHash!.value },
      content_sha256: await sha256Text(driftedBytes), created_at: at };
    const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, operatorContext)) });
    const quarantineReceipt: any = await response.json();
    expect(quarantineReceipt, JSON.stringify(quarantineReceipt)).toMatchObject({ operation: "document.quarantine_instance", status: "committed", accepted: false,
      actor: { actor_id: "control_tower", authority: "control_tower_operator" }, archive_path: expect.stringContaining("/ARCHIVES/QUARANTINED-PUBLISHED/") });
  });

  it("rejects external archive reconciliation from a generic ingress actor", async () => {
    const created = await createProject("TXN-DOCUMENT-ARCHIVE-AUTH-9103");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const ingressToken = "generic-ingress-external-archive";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      INGRESS_TOKEN: ingressToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const contextResponse = await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } });
    const { context }: any = await contextResponse.json();
    const request = {
      operation: "document.archive", request_id: "DOCREQ-EXTERNAL-ARCHIVE-AUTH-0001", project_id: created.project_id,
      document_id: "DOC-0123456789ABCDEF01234567", expected_version_id: "VER-EXT-111111111111111111111111",
      stage: "review", expected_project_revision: created.new_revision,
      observed_archive: { path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-document-0001/ARCHIVES/example.md`,
        object_id: "id:archive", revision_token: "rev-archive", content_hash: "a".repeat(64), size: 9 },
      created_at: at
    };
    const response = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "DOCUMENT_EXTERNAL_ARCHIVE_AUTHORITY_REQUIRED" });
  });

  it("commits exact Control Tower repair evidence and lets navigation admit only that current instance", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCUMENT-REPAIR-REAL-01");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const signingKey = "project-document-governance";
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, created.project_id);
    const ingressToken = "generic-ingress-setup-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey, RULE_ADMISSION_SIGNING_KEY: signingKey, INGRESS_TOKEN: ingressToken
    }));
    const setupContext: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } })).json();
    let content = "# Stable working document\n";
    const writeRequest = {
      operation: "working.write", request_id: "DOCREQ-REPAIR-WRITE-0001", project_id: created.project_id,
      logical_path: "strategies/current.md", content, content_sha256: await sha256Text(content), created_at: at
    };
    const write = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(writeRequest, setupContext.context)) });
    const written: any = await write.json();
    expect(written).toMatchObject({ status: "committed" });
    const runtime = createProductionPersistence(testEnv);
    const repository = new DocumentLedgerRepository(runtime);
    const originalHead = await repository.readHead(created.project_id, written.document_id);
    const originalVersion = await repository.readVersion(created.project_id, written.document_id, written.version_id);
    expect(originalHead?.working_version_id).toBe(written.version_id);
    content = (await runtime.objects.readText(originalVersion!.immutable_payload_path))!;
    const visiblePath = originalHead!.provider!.working!.path;
    const changedMetadata = await mock.writeExternal(visiblePath, content);
    const changedObservation = toManagedProviderObservation({
      path: visiblePath, objectId: changedMetadata!.id, revisionToken: changedMetadata!.rev,
      integrityHash: { algorithm: "dropbox-content-hash", value: changedMetadata!.content_hash },
      size: changedMetadata!.size
    });
    await repository.writeHead({ ...originalHead!, provider: { ...originalHead!.provider, working: changedObservation } });
    const rawVersion = await runtime.objects.readText(machineDocumentVersionPath(created.project_id, written.document_id, written.version_id));
    const source = new ZoneNavigationSources(runtime);
    const sourceState = await source.readState(created.project_id, "WORKING");
    const operatorToken = "authorized-control-tower-repair-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey,
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      CONTROL_TOWER_OPERATOR_TOKEN: operatorToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const { context }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    const request = {
      operation: "document.instance.repair",
      request_id: "DOCREQ-INSTANCE-REPAIR-REAL-0001",
      project_id: created.project_id,
      document_id: written.document_id,
      version_id: written.version_id,
      logical_path: originalHead!.logical_path,
      expected_project_revision: created.new_revision,
      expected_source_generation: sourceState.generation,
      expected_version_record_sha256: await sha256Text(rawVersion!),
      content_sha256: await sha256Text(content),
      historical_provider: {
        object_id: originalVersion!.provider_evidence!.object_id,
        revision_token: originalVersion!.provider_evidence!.revision_token,
        path: originalVersion!.provider_evidence!.path,
        size: originalVersion!.provider_evidence!.size
      },
      current_provider: {
        object_id: changedObservation.file_id, revision_token: changedObservation.rev,
        path: changedObservation.path, size: changedObservation.size
      },
      created_at: at
    };
    let proofWritten = false;
    let repairProofPath: string | null = null;
    let restoreCreateText!: () => void;
    await runInDurableObject(guard, (instance) => {
      const objects = (instance as any).persistence.objects;
      const createText = objects.createText.bind(objects);
      objects.createText = async (path: string, text: string) => {
        if (path.endsWith(`/requests/${request.request_id}/receipt.json`) && proofWritten) throw new Error("injected interruption after repair proof");
        const result = await createText(path, text);
        if (path.includes("/instance-repairs/") && !path.includes("/instance-repairs/requests/")) { proofWritten = true; repairProofPath = path; }
        return result;
      };
      restoreCreateText = () => { objects.createText = createText; };
    });
    const interruptedResponse = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) });
    expect(interruptedResponse.status).toBe(503);
    expect(proofWritten).toBe(true);
    expect(repairProofPath && await runtime.objects.readText(repairProofPath)).not.toBeNull();
    expect(await runtime.objects.readText(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBeNull();
    restoreCreateText();

    // Advance both project revision and WORKING source generation on an
    // unrelated document after the repair proof, but before its receipt.
    const unrelatedContent = "# Unrelated successor write\n";
    const unrelatedWrite = {
      operation: "working.write", request_id: "DOCREQ-REPAIR-UNRELATED-0001", project_id: created.project_id,
      logical_path: "strategies/unrelated.md", content: unrelatedContent,
      content_sha256: await sha256Text(unrelatedContent), created_at: at
    };
    expect(await source.beginAdoption(created.project_id, "WORKING", "DOCREQ-REPAIR-INTERLEAVE-0001", sourceState.generation + 1)).toBe(true);
    expect(await (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(unrelatedWrite, setupContext.context)) })).json()).toMatchObject({ status: "committed" });
    const interleavedTx = { schema_version: "1.0", transaction_id: "TXN-REPAIR-INTERLEAVE-0001", project_id: created.project_id,
      base_revision: created.new_revision, operation: "project.framing.update", created_at: at,
      payload: { success_criteria: ["Unrelated interleaved revision"] } };
    const { context: interleaveContext }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    const interleavedTransaction = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(interleavedTx, interleaveContext))
    });
    const interleavedReceipt: any = await interleavedTransaction.json();
    expect(interleavedReceipt).toMatchObject({ status: "committed", new_revision: created.new_revision + 1 });
    expect(interleavedReceipt.new_revision).toBeGreaterThan(request.expected_project_revision);
    const { context: resumedContext }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, resumedContext)) });
    const receipt: any = await response.json();
    expect(response.status).toBe(200);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ operation: "document.instance.repair", status: "committed", document_id: written.document_id, version_id: written.version_id, proof_ref: expect.any(String), proof_sha256: expect.any(String), actor: { actor_id: "control_tower", authority: "control_tower_operator" } });
    expect(await source.readState(created.project_id, "WORKING")).toMatchObject({ generation: sourceState.generation + 2, in_flight_resource_ids: [] });
    expect(await new ExecutionJournal(runtime, created.project_id, "document", request.request_id).status()).toMatchObject({ status: "finalized", terminal: true, finalization_ref: expect.any(String) });
    const replayResponse = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, resumedContext)) });
    expect(await replayResponse.json()).toEqual(receipt);
    expect(await source.readState(created.project_id, "WORKING")).toMatchObject({ generation: sourceState.generation + 2, in_flight_resource_ids: [] });
    expect(await repository.readVersion(created.project_id, written.document_id, written.version_id)).toEqual(originalVersion);
    const inventory = new ZoneNavigationInventory(runtime, source);
    const validEntry: any = {
      project_id: created.project_id, zone: "WORKING", resource_id: `head:${written.document_id}`,
      version: written.version_id, logical_path: originalHead!.logical_path, path: visiblePath,
      expected: { object_id: changedObservation.file_id, revision_token: changedObservation.rev, content_sha256: await sha256Text(content), size: changedObservation.size }
    };
    expect(await inventory.verifyEntry(validEntry, createSliceBudget(() => Date.now(), new AbortController().signal))).toBe(true);
    for (const invalidEntry of [
      { ...validEntry, version: "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA" },
      { ...validEntry, expected: { ...validEntry.expected, object_id: "id:unbound-instance" } },
      { ...validEntry, expected: { ...validEntry.expected, content_sha256: "0".repeat(64) } }
    ]) {
      expect(await inventory.verifyEntry(invalidEntry, createSliceBudget(() => Date.now(), new AbortController().signal))).toBe(false);
    }
  });

  it.skipIf(testEnv.PROJECT_OS_SCHEMA_WRITER_STAGE !== "provider_v2")("repairs four V2 external identities without raw SHA and finalizes one successor in bounded 32-call slices", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCUMENT-REPAIR-CENSUS-01");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const signingKey = "project-document-governance";
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, created.project_id);
    const ingressToken = "repair-census-ingress-test";
    const operatorToken = "repair-census-operator-test";
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey, RULE_ADMISSION_SIGNING_KEY: signingKey,
      INGRESS_TOKEN: ingressToken, CONTROL_TOWER_OPERATOR_TOKEN: operatorToken,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const runtime = createProductionPersistence(testEnv);
    const repository = new DocumentLedgerRepository(runtime);
    const sources = new ZoneNavigationSources(runtime);
    const logicalPaths = ["strategies/repair-1.md", "strategies/repair-2.md", "strategies/repair-3.md", "strategies/repair-4.md", "strategies/matching.md"];
    const fixtures: { document_id: string; version_id: string; logical_path: string; path: string; content: string; old: any; current: any; raw_version: string }[] = [];
    for (let index = 0; index < logicalPaths.length; index += 1) {
      const logical_path = logicalPaths[index];
      const document_id = await documentIdFor(created.project_id, logical_path);
      const version_id = `VER-EXT-${String(index + 1).padStart(24, "0")}`;
      const content = `# External version ${index + 1}\nStable immutable bytes.\n`;
      const path = `${workspaceProjectRoot(created.project_id, `document-${created.project_id.slice(-4).toLowerCase()}`)}/WORKING/${logical_path}`;
      const oldMetadata = await mock.writeExternal(path, content);
      const provider_evidence = { provider_id: "dropbox" as const, object_id: oldMetadata!.id!, revision_token: oldMetadata!.rev!, path,
        integrity_hash: { algorithm: "dropbox-content-hash" as const, value: oldMetadata!.content_hash! }, size: oldMetadata!.size! };
      const payloadHash = await sha256Text(content);
      const immutable_payload_path = await repository.storeTextPayload(created.project_id, payloadHash, content);
      await runtime.objects.createText(machineDocumentVersionPath(created.project_id, document_id, version_id), JSON.stringify({
        schema_version: "2.0", project_id: created.project_id, document_id, version_id, kind: "work_product",
        stage: "working", logical_path, source: "external_human", created_at: at, immutable_payload_path, provider_evidence
      }));
      const old = toManagedProviderObservation({ path, objectId: oldMetadata!.id!, revisionToken: oldMetadata!.rev!,
        integrityHash: { algorithm: "dropbox-content-hash", value: oldMetadata!.content_hash! }, size: oldMetadata!.size! });
      const toV2Provider = (observation: typeof old) => ({ provider_id: "dropbox", object_id: observation.file_id,
        revision_token: observation.rev, path: observation.path,
        integrity_hash: { algorithm: "dropbox-content-hash", value: observation.content_hash }, size: observation.size });
      const head = { schema_version: "2.0" as const, project_id: created.project_id, document_id, kind: "work_product" as const, logical_path,
        working_version_id: version_id, provider: { working: toV2Provider(old) }, reconciliation_status: "clean" as const };
      await runtime.objects.createText(machineDocumentHeadPath(created.project_id, document_id), JSON.stringify(head));
      const currentMetadata = index < 4 ? await mock.replaceExternal(path, content) : oldMetadata;
      const current = toManagedProviderObservation({ path, objectId: currentMetadata!.id!, revisionToken: currentMetadata!.rev!,
        integrityHash: { algorithm: "dropbox-content-hash", value: currentMetadata!.content_hash! }, size: currentMetadata!.size! });
      if (index < 4) await runtime.objects.upsertText(machineDocumentHeadPath(created.project_id, document_id), JSON.stringify({ ...head, provider: { working: toV2Provider(current) } }));
      const raw_version = await runtime.objects.readText(machineDocumentVersionPath(created.project_id, document_id, version_id));
      expect(JSON.parse(raw_version!)).not.toHaveProperty("content_sha256");
      fixtures.push({ document_id, version_id, logical_path, path, content, old, current, raw_version: raw_version! });
    }
    const { context: ingressContext }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${ingressToken}` } })).json();
    const { context: initialOperatorContext }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    expect(initialOperatorContext.actor).toMatchObject({ actor_id: "control_tower", authority: "control_tower_operator" });
    let sourceState = await sources.readState(created.project_id, "WORKING");
    const firstMismatch = fixtures[0];
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const unprovedEntry = { project_id: created.project_id, zone: "WORKING" as const, resource_id: `head:${firstMismatch.document_id}`,
      version: firstMismatch.version_id, logical_path: firstMismatch.logical_path, path: firstMismatch.path,
      expected: { object_id: firstMismatch.current.file_id, revision_token: firstMismatch.current.rev,
        content_sha256: await sha256Text(firstMismatch.content), size: firstMismatch.current.size } };
    expect(await inventory.verifyEntry(unprovedEntry, createSliceBudget(() => Date.now(), new AbortController().signal))).toBe(false);
    for (let index = 0; index < 4; index += 1) {
      const fixture = fixtures[index];
      const { context }: any = await (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${operatorToken}` } })).json();
      const request = { operation: "document.instance.repair", request_id: `DOCREQ-REPAIR-CENSUS-${index + 1}-0001`,
        project_id: created.project_id, document_id: fixture.document_id, version_id: fixture.version_id, logical_path: fixture.logical_path,
        expected_project_revision: created.new_revision, expected_source_generation: sourceState.generation,
        expected_version_record_sha256: await sha256Text(fixture.raw_version), content_sha256: await sha256Text(fixture.content),
        historical_provider: { object_id: fixture.old.file_id, revision_token: fixture.old.rev, path: fixture.path, size: fixture.old.size },
        current_provider: { object_id: fixture.current.file_id, revision_token: fixture.current.rev, path: fixture.path, size: fixture.current.size }, created_at: at };
      const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) });
      const repairResponse = await response.json();
      expect(repairResponse, JSON.stringify(repairResponse)).toMatchObject({ operation: "document.instance.repair", status: "committed", document_id: fixture.document_id });
      sourceState = await sources.readState(created.project_id, "WORKING");
    }
    const matching = fixtures[4];
    expect(matching.current.file_id).toBe(matching.old.file_id);
    const matchingHeadRaw = await runtime.objects.readText(machineDocumentHeadPath(created.project_id, matching.document_id));
    const matchingTicket = await sources.beginHeadWrite(created.project_id, "WORKING", `head:${matching.document_id}`, undefined,
      matchingHeadRaw ? await sha256Text(matchingHeadRaw) : null, true);
    expect(matchingTicket).not.toBeNull();
    await sources.completeHeadWrites([matchingTicket!]);
    expect(await sources.hasDirtyMarker(created.project_id, "WORKING", `head:${matching.document_id}`)).toBe(true);
    sourceState = await sources.readState(created.project_id, "WORKING");
    const state = emptyProjectState(created.project_id, "Repair census", `document-${created.project_id.slice(-4).toLowerCase()}`);
    state.revision = created.new_revision;
    const request = navigationReconcileSchema.parse({ operation: "navigation.reconcile", request_id: "DOCREQ-REPAIR-CENSUS-NAV-0001",
      project_id: created.project_id, zone: "WORKING", expected_project_revision: state.revision, expected_generation: 0,
      expected_index: null, created_at: at });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(created.project_id, state.slug)}/WORKING/00-CURRENT.md`;
    const admission = { project_id: created.project_id, request_id: request.request_id, kind: "document" as const, operation: request.operation,
      request_hash: requestHash, actor: { actor_id: "control_tower", authority: "control_tower_operator" },
      resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:WORKING", resource_version: "0", provider_id: runtime.providerId,
        sources: [], destinations: [{ path: indexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: state.revision }, verdict: "allow" as const, results: [], gaps: [], deferred_rules: [] };
    const callsPerSlice: number[] = [];
    const budgetCallsPerSlice: number[] = [];
    let result: any;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const before = mock.providerCalls.length;
      const sliceBudget = createSliceBudget(() => Date.now(), new AbortController().signal);
      result = await new ZoneNavigationEngine(runtime, new ZoneNavigationInventory(runtime, sources)).reconcile(request, state, admission as never, sliceBudget);
      callsPerSlice.push(mock.providerCalls.length - before);
      budgetCallsPerSlice.push(32 - sliceBudget.calls_left);
      if (result.status !== "pending") break;
    }
    const navProgressRoot = await new ExecutionJournal(runtime, created.project_id, "document", request.request_id).root();
    const navProgressDebug = await runtime.objects.readText(`${navProgressRoot}/navigation-progress.json`);
    expect(result, JSON.stringify({ result, callsPerSlice, recentProviderCalls: mock.providerCalls.slice(-32), progress: navProgressDebug })).toMatchObject({ status: "finalized", receipt: { status: "committed", source_snapshot_id: `source:${sourceState.generation}` } });
    expect(callsPerSlice.length).toBeLessThanOrEqual(60);
    expect(budgetCallsPerSlice.every((count) => count <= 32), JSON.stringify({ budgetCallsPerSlice, observedHttpRequestsPerSlice: callsPerSlice })).toBe(true);
    const nav = JSON.parse(mock.files.get(`${machineDocumentRoot(created.project_id)}/navigation/WORKING/head.json`) ?? "null");
    expect(nav.source_count).toBe(5);
    expect(nav.coverage_gaps).toEqual([]);
    for (const fixture of fixtures) {
      expect(await runtime.objects.readText(machineDocumentVersionPath(created.project_id, fixture.document_id, fixture.version_id))).toBe(fixture.raw_version);
    }
  });

  it("freezes a referenced document and resumes governed package effects through the existing document boundary", async () => {
    installDropboxMock({ immutableRevisions: true });
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-PACKAGE-PROJECT-0092");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const write = async (request_id: string, logical_path: string, content: string) => {
      const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify({ operation: "working.write", request_id, project_id: created.project_id, logical_path, content, content_sha256: await sha256Text(content), created_at: at }) });
      const receipt: any = await response.json(); expect(receipt.status).toBe("committed"); return receipt;
    };
    const member = await write("DOCREQ-PACKAGE-MEMBER-0092", "member.md", "# Member");
    const repository = new DocumentLedgerRepository(createProductionPersistence(testEnv));
    const version = (await repository.readVersion(created.project_id, member.document_id, member.version_id))!;
    const manifest = { schema_version: "1.0", project_id: created.project_id, creation_request_id: "DOCREQ-PACKAGE-CREATE-0092", version: 1, members: [{ relative_path: "member.md", document_id: member.document_id, document_version_id: member.version_id, immutable_payload_path: version.immutable_payload_path, content_sha256: version.content_sha256, size: version.size }], links: [], source_refs: ["accepted:fixture"], created_by: "operator", created_at: at };
    const content = JSON.stringify(manifest);
    const descriptor = await write("DOCREQ-PACKAGE-MANIFEST-0092", "manifest.json", content);
    const key = governanceSigningKey;
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, { MUTATION_CONTEXT_SIGNING_KEY: key, RULE_ADMISSION_SIGNING_KEY: key, PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }) }));
    const { context }: any = await (await guard.fetch("https://internal/mutation-context")).json();
    await runInDurableObject(guard, instance => {
      const target = instance as any;
      const admit = target.admitRules.bind(target);
      vi.spyOn(target, "admitRules").mockImplementation(async (...args: any[]) => ({ ...await admit(...args), gaps: [admissionGap] }));
    });
    const submit = async (request: unknown) => (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) })).json<any>();
    const freezeRequest = { operation: "package.freeze" as const, request_id: "DOCREQ-PACKAGE-FREEZE-0092", project_id: created.project_id, document_id: descriptor.document_id, expected_version_id: descriptor.version_id, content_sha256: await sha256Text(content), expected_project_revision: 1, created_at: at };
    let restoreFreeze!: () => void;
    await runInDurableObject(guard, (instance) => {
      const service = (instance as any).managedDocumentService;
      const freeze = vi.spyOn(service, "freezePackageDocument").mockRejectedValueOnce(new Error("temporary_provider_failure"));
      restoreFreeze = () => freeze.mockRestore();
    });
    const freezeInterrupted = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(freezeRequest, context))
    });
    expect(freezeInterrupted.status).toBe(503);
    await expect(freezeInterrupted.json()).resolves.toMatchObject({
      status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED", request_id: freezeRequest.request_id
    });
    restoreFreeze();
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const frozen = await submit(freezeRequest);
    expect(frozen).toMatchObject({ status: "committed", candidate: { version: 1 }, gaps: [admissionGap] });
    const freezeAdmission = await new ExecutionJournal(createProductionPersistence(testEnv), created.project_id, "document", freezeRequest.request_id).readAdmission();
    expect(freezeAdmission?.admission).toMatchObject({ operation: "package.freeze", request_id: freezeRequest.request_id, verdict: "allow" });
    const freezeJournal = new ExecutionJournal(createProductionPersistence(testEnv), created.project_id, "document", freezeRequest.request_id);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO admission_proofs (kind, request_id, proof_json) VALUES (?, ?, ?)",
        "package", freezeRequest.request_id, JSON.stringify(freezeAdmission!.admission));
    });
    await createProductionPersistence(testEnv).objects.delete(`${await freezeJournal.root()}/admission.json`);
    await createProductionPersistence(testEnv).objects.delete(`${await freezeJournal.root()}/progress.json`);
    await runInDurableObject(guard, async (instance) => {
      await (instance as any).readPackageAdmissionProof(freezeRequest);
    });
    expect((await freezeJournal.readAdmission())?.admission.request_id).toBe(freezeRequest.request_id);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests WHERE request_id = ?", freezeRequest.request_id);
    });
    const mismatchedFreeze = await submit({ ...freezeRequest, content_sha256: "f".repeat(64) });
    expect(mismatchedFreeze).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    const request = { operation: "package.replace", request_id: "DOCREQ-PACKAGE-REPLACE-0092", project_id: created.project_id, candidate: frozen.candidate, zone: "WORKING", expected_navigation_generation: 0, expected_project_revision: 1, created_at: at };
    let restorePackage!: () => void;
    await runInDurableObject(guard, (instance) => {
      const service = (instance as any).managedDocumentService;
      const replace = vi.spyOn(service, "replacePackage").mockRejectedValueOnce(new Error("temporary_provider_failure"));
      restorePackage = () => replace.mockRestore();
    });
    const interrupted = await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(interrupted.status).toBe(503);
    await expect(interrupted.json()).resolves.toMatchObject({
      status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED", request_id: request.request_id
    });
    restorePackage();
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    let result = await submit(request);
    for (let count = 0; count < 5 && result.status === "finalizing"; count++) result = await submit(request);
    expect(result).toMatchObject({ status: "committed", execution_status: "finalized", gaps: [admissionGap] });
    expect((await repository.readPackageNavigation(created.project_id)).WORKING?.packages[0].ref).toEqual(frozen.candidate);
    expect(await submit(request)).toEqual(result);
    const legacyResult = { ...result };
    delete legacyResult.gaps;
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE document_requests SET receipt_json = ? WHERE request_id = ?",
        JSON.stringify(legacyResult), request.request_id
      );
    });
    expect(await submit(request)).toMatchObject({ status: "committed", gaps: [admissionGap] });
    const packageRead = await guard.fetch(`https://project-guard.internal/receipt?kind=document&request_id=${request.request_id}`);
    await expect(packageRead.json()).resolves.toMatchObject({ status: "committed", gaps: [admissionGap] });

    const terminalRequest = { ...request, request_id: "DOCREQ-PACKAGE-CONFLICT-0092", expected_navigation_generation: 1 };
    await runInDurableObject(guard, (instance) => {
      vi.spyOn((instance as any).managedDocumentService, "replacePackage").mockResolvedValueOnce({
        status: "conflict", terminal: true, code: "EXECUTION_RESOURCE_CHANGED"
      });
    });
    const terminal = await submit(terminalRequest);
    expect(terminal).toMatchObject({ status: "conflict", code: "EXECUTION_RESOURCE_CHANGED", gaps: [admissionGap] });
    const terminalStatus = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${terminalRequest.request_id}`);
    await expect(terminalStatus.json()).resolves.toMatchObject({ status: "conflict" });
  });

  it("withdraws a governed package from verified navigation after ProjectGuard observes an external Dropbox move", async () => {
    const mock = installDropboxMock({ immutableRevisions: true });
    const created = await createProject("TXN-PACKAGE-DRIFT-GUARD-8882");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const runtime = createProductionPersistence(testEnv, created.project_id);
    const repository = new DocumentLedgerRepository(runtime);
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey, created.project_id);
    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
    expect(baseline.status, await baseline.clone().text()).toBe(200);
    await runInDurableObject(guard, async (_instance, state) => await state.storage.deleteAlarm());

    const write = async (request_id: string, logical_path: string, content: string) => {
      const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify({
        operation: "working.write", request_id, project_id: created.project_id, logical_path,
        content, content_sha256: await sha256Text(content), created_at: at
      }) });
      const receipt = await response.json<any>();
      expect(receipt.status).toBe("committed");
      return receipt;
    };
    const member = await write("DOCREQ-PACKAGE-DRIFT-MEMBER-0001", "member.md", "# Governed package member\n");
    const version = (await repository.readVersion(created.project_id, member.document_id, member.version_id))!;
    const manifest = { schema_version: "1.0", project_id: created.project_id,
      creation_request_id: "DOCREQ-PACKAGE-DRIFT-CREATE-0001", version: 1,
      members: [{ relative_path: "member.md", document_id: member.document_id, document_version_id: member.version_id,
        immutable_payload_path: version.immutable_payload_path, content_sha256: version.content_sha256, size: version.size }],
      links: [], source_refs: ["accepted:fixture"], created_by: "operator", created_at: at };
    const manifestContent = JSON.stringify(manifest);
    const descriptor = await write("DOCREQ-PACKAGE-DRIFT-MANIFEST-0001", "manifest.json", manifestContent);
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey, RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const { context }: any = await (await guard.fetch("https://internal/mutation-context")).json();
    const submit = async (request: unknown) => (await guard.fetch("https://internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    })).json<any>();
    const frozen = await submit({ operation: "package.freeze", request_id: "DOCREQ-PACKAGE-DRIFT-FREEZE-0001",
      project_id: created.project_id, document_id: descriptor.document_id, expected_version_id: descriptor.version_id,
      content_sha256: await sha256Text(manifestContent), expected_project_revision: created.new_revision, created_at: at });
    expect(frozen).toMatchObject({ status: "committed", candidate: { version: 1 } });
    const replace = { operation: "package.replace", request_id: "DOCREQ-PACKAGE-DRIFT-REPLACE-0001",
      project_id: created.project_id, candidate: frozen.candidate, zone: "WORKING",
      expected_navigation_generation: 0, expected_project_revision: created.new_revision, created_at: at };
    let replaced = await submit(replace);
    for (let attempt = 0; attempt < 5 && replaced.status === "finalizing"; attempt += 1) replaced = await submit(replace);
    expect(replaced, JSON.stringify(replaced)).toMatchObject({ status: "committed", execution_status: "finalized" });
    await runInDurableObject(guard, async (_instance, state) => await state.storage.deleteAlarm());

    const sources = new ZoneNavigationSources(runtime);
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const readWorkingInventory = async () => {
      let page = await inventory.listPage({ project_id: created.project_id, zone: "WORKING", cursor: null, limit: 8,
        budget: createSliceBudget(() => Date.now(), new AbortController().signal) });
      const entries = [...page.entries], gaps = [...page.gaps];
      for (let count = 0; page.next_cursor !== null && count < 12; count += 1) {
        page = await inventory.listPage({ project_id: created.project_id, zone: "WORKING", cursor: page.next_cursor, limit: 8,
          budget: createSliceBudget(() => Date.now(), new AbortController().signal) });
        entries.push(...page.entries); gaps.push(...page.gaps);
      }
      expect(page.next_cursor).toBeNull();
      return { entries, gaps };
    };
    const resourceId = `package:${frozen.candidate.package_id}`;
    const before = await readWorkingInventory();
    const governedEntry = before.entries.find((entry) => entry.resource_id === resourceId);
    expect(governedEntry).toBeDefined();
    expect(await inventory.verifyEntry(governedEntry!, createSliceBudget(() => Date.now(), new AbortController().signal))).toBe(true);
    const sourceState = await sources.readState(created.project_id, "WORKING");
    expect(await sources.beginAdoption(created.project_id, "WORKING", "DOCREQ-PACKAGE-DRIFT-ADOPT-0001", sourceState.generation)).toBe(true);
    expect(await sources.finishAdoption(created.project_id, "WORKING", "DOCREQ-PACKAGE-DRIFT-ADOPT-0001", sourceState.generation)).toBe(true);

    // Discard package-publication events from the test fixture baseline; the next provider page contains only the external move.
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("UPDATE managed_document_change_control SET cursor = ? WHERE singleton = 1", mock.currentCursor());
      new ManagedDocumentChangeJobStore(state.storage).completeScheduledVerification("2026-09-30T00:00:00.000Z");
    });
    const root = workspaceProjectRoot(created.project_id, "document-8882");
    const original = `${root}/WORKING/PACKAGES/${frozen.candidate.package_id}/1/member.md`;
    const moved = `/PROJECT_OS/EXTERNAL-ARCHIVE/${frozen.candidate.package_id}-member.md`;
    const move = await fetch("https://api.dropboxapi.com/2/files/move_v2", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ from_path: original, to_path: moved }) });
    expect(move.ok).toBe(true);
    for (let attempt = 0; attempt < 4 && !await sources.hasDirtyMarker(created.project_id, "WORKING", resourceId); attempt += 1) {
      const observed = await guard.fetch("https://project-guard.internal/reconcile-documents?scheduled=1", { method: "POST" });
      expect(observed.status, await observed.clone().text()).toBe(200);
      await runInDurableObject(guard, async (_instance, state) => await state.storage.deleteAlarm());
    }
    const after = await readWorkingInventory();
    expect(await sources.hasDirtyMarker(created.project_id, "WORKING", resourceId)).toBe(true);
    expect(after.entries).not.toContainEqual(governedEntry);
    expect(after.gaps).toContainEqual(expect.objectContaining({ resource_id: resourceId }));
    expect(mock.files.has(original)).toBe(false);
    expect(mock.files.has(moved)).toBe(true);
    await runInDurableObject(guard, async (_instance, state) => {
      new ManagedDocumentChangeJobStore(state.storage).completeScheduledVerification(new Date().toISOString());
      await state.storage.deleteAlarm();
    });
  });

  it.each(["superseded", "retired"] as const)("resumes committed package effects with the exact %s global rule version from its admission", async (historicalStatus) => {
    const suffix = historicalStatus === "retired" ? "RETR" : "SUPR";
    installDropboxMock({ immutableRevisions: true });
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject(`TXN-PACKAGE-HISTORICAL-${suffix}`);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const write = async (request_id: string, logical_path: string, content: string) => {
      const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify({ operation: "working.write", request_id, project_id: created.project_id, logical_path, content, content_sha256: await sha256Text(content), created_at: at }) });
      const receipt: any = await response.json(); expect(receipt.status).toBe("committed"); return receipt;
    };
    const member = await write(`DOCREQ-PACKAGE-HISTORICAL-${suffix}-MEMBER-01`, "member.md", "# Member");
    const repository = new DocumentLedgerRepository(createProductionPersistence(testEnv));
    const version = (await repository.readVersion(created.project_id, member.document_id, member.version_id))!;
    const manifest = { schema_version: "1.0", project_id: created.project_id, creation_request_id: `DOCREQ-PACKAGE-HISTORICAL-${suffix}-CREATE-01`, version: 1, members: [{ relative_path: "member.md", document_id: member.document_id, document_version_id: member.version_id, immutable_payload_path: version.immutable_payload_path, content_sha256: version.content_sha256, size: version.size }], links: [], source_refs: ["accepted:fixture"], created_by: "operator", created_at: at };
    const content = JSON.stringify(manifest);
    const descriptor = await write(`DOCREQ-PACKAGE-HISTORICAL-${suffix}-MANIFEST-01`, "manifest.json", content);
    await runInDurableObject(guard, instance => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: governanceSigningKey,
      RULE_ADMISSION_SIGNING_KEY: governanceSigningKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const { context }: any = await (await guard.fetch("https://internal/mutation-context")).json();
    const submit = async (request: unknown) => (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) })).json<any>();
    const freezeRequest = { operation: "package.freeze" as const, request_id: `DOCREQ-PACKAGE-HISTORICAL-${suffix}-FREEZE-01`, project_id: created.project_id, document_id: descriptor.document_id, expected_version_id: descriptor.version_id, content_sha256: await sha256Text(content), expected_project_revision: created.new_revision, created_at: at };
    const frozen = await submit(freezeRequest);
    expect(frozen).toMatchObject({ status: "committed" });

    const request = { operation: "package.replace" as const, request_id: `DOCREQ-PACKAGE-HISTORICAL-${suffix}-REPLACE-01`, project_id: created.project_id, candidate: frozen.candidate, zone: "WORKING" as const, expected_navigation_generation: 0, expected_project_revision: created.new_revision, created_at: at };
    const oldRule: any = ruleFixture("GLOBAL", { rule_id: `RULE-PACKAGE-HISTORICAL-${suffix}`, operations: ["package.replace"], resource_scope: { resource_types: ["package"], zones: ["WORKING"] }, check_id: "verified_presence", parameters: {}, check_stage: "post_execution", status: "active", activation_evidence: ["server:qualified"] });
    const successorRule: any = { ...oldRule, version: 2, supersedes: 1, status: "active" };
    const reference = { rule_id: oldRule.rule_id, version: oldRule.version, scope: oldRule.scope };
    const newerGovernance = {
      revision: 11,
      rules: {
        [`${oldRule.rule_id}@1`]: { ...oldRule, status: historicalStatus },
        [`${successorRule.rule_id}@2`]: successorRule
      },
      exceptions: {}
    };
    let governance: any = { revision: 10, rules: { [`${oldRule.rule_id}@1`]: oldRule }, exceptions: {} };
    let governanceReader: any;
    await runInDurableObject(guard, async instance => {
      const normalized = await normalizeDocumentAdmission(request);
      const proof = {
        project_id: request.project_id, operation: request.operation, resources: normalized.resources,
        request_hash: normalized.request_hash, actor: context.actor,
        global_revision: 10, project_revision: request.expected_project_revision,
        ruleset: { digest: "a".repeat(64), rules: [reference], global_revision: 10, project_revision: request.expected_project_revision },
        verdict: "allow", results: [{ verdict: "allow", code: "RULE_ADMITTED", rule: reference, expected: "Initial active rule", observed: "admitted", required_action: "None", resource_id: request.candidate.package_id, evidence_refs: ["canonical:initial-admission"] }],
        gaps: [], deferred_rules: [reference]
      };
      vi.spyOn(instance as any, "readPackageAdmissionProof").mockResolvedValue(proof);
      const service = (instance as any).managedDocumentService;
      const replace = service.replacePackage.bind(service);
      vi.spyOn(service, "replacePackage").mockImplementationOnce((operation: any, state: any, admission: any, options: any) => replace(operation, state, admission, { ...options, effectBudget: 2 }));
      governanceReader = vi.spyOn(instance as any, "readGlobalGovernance").mockImplementation(async () => governance);
    });

    const first = await submit(request);
    expect(first).toMatchObject({ status: "finalizing" });
    const committedJournal = new ExecutionJournal(createProductionPersistence(testEnv), created.project_id, "document", request.request_id);
    expect(await committedJournal.readAdmission()).not.toBeNull();
    expect((await committedJournal.status())?.status).toBe("finalizing");

    governance = newerGovernance;
    governanceReader.mockImplementation(async () => governance);
    const resumed = await submit(request);
    expect(resumed).toMatchObject({ status: "committed", execution_status: "finalized", candidate: frozen.candidate });
    const progress = await committedJournal.status();
    expect(progress?.status).toBe("finalized");
    expect(progress?.postchecks).toContainEqual({
      check_id: `rule:${canonicalJson(reference)}`,
      verdict: "allow",
      evidence_refs: expect.arrayContaining([expect.any(String)])
    });
    expect(await runInDurableObject(guard, async instance => (await (instance as any).loadOrRecoverState()).revision)).toBe(created.new_revision);
    expect((await repository.readPackageNavigation(created.project_id)).WORKING?.packages[0].ref).toEqual(frozen.candidate);
  });

  it("package transport refuses legacy ungoverned execution even with a well-formed manifest reference", async () => {
    const created = await createProject("TXN-PACKAGE-PROJECT-0091");
    const response = await testEnv.PROJECT_GUARD.getByName(created.project_id).fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "package.replace", request_id: "DOCREQ-PACKAGE-GUARD-0091", project_id: created.project_id, candidate: { project_id: created.project_id, package_id: `PKG-${"A".repeat(64)}`, version: 1, manifest_sha256: "b".repeat(64) }, zone: "WORKING", expected_navigation_generation: 0, expected_project_revision: 1, created_at: at })
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "PACKAGE_GOVERNANCE_REQUIRED" });
  });

  it("writes a working document and exposes compact logical status", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const signing = "document-execution-finalization";
    await bootstrapRuleAdmissionGovernance(testEnv, signing, created.project_id);
    await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signing,
      RULE_ADMISSION_SIGNING_KEY: signing,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const content = "# Commercial strategy";
    const write = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36010001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content,
        content_sha256: await sha256Text(content),
        created_at: at
      }, context))
    });
    expect(write.status).toBe(200);
    const receipt = await write.json<{ status: string; document_id: string; version_id: string; stage: string }>();
    expect(receipt).toMatchObject({ status: "committed", stage: "working" });

    const execution = await guard.fetch(
      "https://project-guard.internal/execution-status?kind=document&request_id=DOCREQ-WORK-36010001"
    );
    expect(await execution.json()).toMatchObject({
      status: "finalized",
      terminal: true,
      code: null,
      finalization_ref: expect.any(String)
    });

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(receipt.document_id)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    const body = await status.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      project_id: created.project_id,
      document_id: receipt.document_id,
      kind: "work_product",
      logical_path: "strategy/commercial.md",
      working_version_id: receipt.version_id,
      reconciliation_status: "clean"
    });
    expect(JSON.stringify(body)).not.toContain(content);
    expect(body).not.toHaveProperty("provider");
  });

  it("archives one exact active working version without a caller-selected path or later restoration", async () => {
    const mock = installDropboxMock({ immutableRevisions: true });
    const created = await createProject("TXN-DOCUMENT-ARCHIVE-9051");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const signing = "document-archive-governance";
    await bootstrapRuleAdmissionGovernance(testEnv, signing, created.project_id);
    await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signing,
      RULE_ADMISSION_SIGNING_KEY: signing,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
    }));
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const content = "# Preserve this working version";
    const writeRequest = {
      operation: "working.write" as const,
      request_id: "DOCREQ-ARCHIVE-WRITE-0001",
      project_id: created.project_id,
      logical_path: "passage/brief.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    };
    const written = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(writeRequest, context))
    })).json<any>();
    expect(written).toMatchObject({ status: "committed", stage: "working" });

    const request = {
      operation: "document.archive" as const,
      request_id: "DOCREQ-ARCHIVE-WORK-0001",
      project_id: created.project_id,
      document_id: written.document_id,
      stage: "working" as const,
      expected_version_id: written.version_id,
      created_at: at
    };
    const stale = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission({
        ...request,
        request_id: "DOCREQ-ARCHIVE-WORK-STALE-0001",
        expected_version_id: "VER-REQ-FFFFFFFFFFFFFFFFFFFFFFFF"
      }, context))
    })).json<any>();
    expect(stale).toMatchObject({ status: "conflict", code: "STALE_DOCUMENT_VERSION" });
    const archived = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(request, context))
    })).json<any>();

    expect(archived).toMatchObject({
      status: "committed",
      document_id: written.document_id,
      version_id: written.version_id,
      archived_stage: "working",
      archive_path: expect.stringContaining(`/ARCHIVES/MANAGED-DOCUMENTS/${written.document_id}/${written.version_id}/working/`)
    });
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-document-9051/WORKING/passage/brief.md`;
    expect(mock.files.has(visiblePath)).toBe(false);
    expect(mock.files.get(archived.archive_path)).toContain(content);
    const execution = await guard.fetch(
      "https://project-guard.internal/execution-status?kind=document&request_id=DOCREQ-ARCHIVE-WORK-0001"
    );
    expect(await execution.json()).toMatchObject({ status: "finalized", terminal: true, finalization_ref: expect.any(String) });

    const status = await (await guard.fetch(`https://project-guard.internal/document-status?document_id=${written.document_id}`)).json<any>();
    expect(status.working_version_id).toBeUndefined();
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(mock.files.has(visiblePath)).toBe(false);

    const replay = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(request, context))
    })).json<any>();
    expect(replay).toEqual(archived);
    const secondRequest = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission({
        ...request,
        request_id: "DOCREQ-ARCHIVE-WORK-SECOND-0001"
      }, context))
    })).json<any>();
    expect(secondRequest).toMatchObject({ status: "conflict", code: "DOCUMENT_STAGE_NOT_ACTIVE" });
    expect([...mock.files.keys()].filter((path) => path.includes(`/ARCHIVES/MANAGED-DOCUMENTS/${written.document_id}/${written.version_id}/working/`))).toHaveLength(1);

    const recoveryContent = "# Preserve this interrupted archive";
    const recoveryWrite = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission({
        operation: "working.write",
        request_id: "DOCREQ-ARCHIVE-RECOVERY-WRITE-0001",
        project_id: created.project_id,
        logical_path: "passage/recovery.md",
        content: recoveryContent,
        content_sha256: await sha256Text(recoveryContent),
        created_at: at
      }, context))
    })).json<any>();
    expect(recoveryWrite).toMatchObject({ status: "committed", stage: "working" });
    const recoveryRequest = {
      operation: "document.archive" as const,
      request_id: "DOCREQ-ARCHIVE-RECOVERY-0001",
      project_id: created.project_id,
      document_id: recoveryWrite.document_id,
      stage: "working" as const,
      archive_group: "RESET-AGENCY-OS-2026-09/DEPUIS-WORKING",
      expected_version_id: recoveryWrite.version_id,
      created_at: at
    };
    let restoreReceiptWrite!: () => void;
    await runInDurableObject(guard, (instance) => {
      const writeReceipt = vi.spyOn((instance as any).managedDocumentRequests, "writeReceipt")
        .mockRejectedValueOnce(new Error("receipt_store_interrupted"));
      restoreReceiptWrite = () => writeReceipt.mockRestore();
    });
    const interrupted = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(recoveryRequest, context))
    });
    expect(interrupted.status).toBe(503);
    await expect(interrupted.json()).resolves.toMatchObject({ status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED" });
    restoreReceiptWrite();
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const recovered = await (await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(recoveryRequest, context))
    })).json<any>();
    expect(recovered).toMatchObject({
      status: "committed", archived_stage: "working", version_id: recoveryWrite.version_id,
      archive_path: expect.stringContaining("/ARCHIVES/RESET-AGENCY-OS-2026-09/DEPUIS-WORKING/")
    });
  });

  it("resumes an interrupted working write from its durable intent without a client replay", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-0042");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Resume without re-review";
    let failure: ReturnType<typeof vi.spyOn>;
    await runInDurableObject(guard, (instance) => {
      failure = vi.spyOn((instance as any).managedDocumentService, "writeWorking")
        .mockRejectedValueOnce(new Error("temporary_provider_unavailable"));
    });

    const request = {
      operation: "working.write",
      request_id: "DOCREQ-RECOVERY-36010001",
      project_id: created.project_id,
      logical_path: "strategy/resumed.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    } as const;
    const interrupted = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(interrupted.status).toBe(503);
    await expect(interrupted.json()).resolves.toMatchObject({
      status: "pending",
      code: "DOCUMENT_RECOVERY_SCHEDULED",
      request_id: request.request_id
    });

    const changed = { ...request, content: "# Different bytes", content_sha256: await sha256Text("# Different bytes") };
    const mismatch = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changed)
    });
    await expect(mismatch.json()).resolves.toMatchObject({
      status: "rejected",
      code: "IDEMPOTENCY_PAYLOAD_MISMATCH"
    });
    const statusBeforeRecovery = await guard.fetch(
      `https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`
    );
    await expect(statusBeforeRecovery.json()).resolves.toMatchObject({
      status: "recovery_scheduled",
      recovery: { durable_intent: true, recoverable: true }
    });
    failure!.mockRestore();

    await expect(runInDurableObject(guard, async (_instance, state) => state.storage.getAlarm()))
      .resolves.toEqual(expect.any(Number));
    expect(await runDurableObjectAlarm(guard)).toBe(true);

    const recovered = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    await expect(recovered.json()).resolves.toMatchObject({
      status: "committed",
      request_id: request.request_id,
      logical_path: request.logical_path
    });
  });

  it("recovers a request interrupted before its canonical intent was written", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-GAP-0047");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Staged before provider intent";
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-GAP-0047", project_id: created.project_id,
      logical_path: "strategy/staged.md", content, content_sha256: await sha256Text(content), created_at: at };
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const spy = vi.spyOn((instance as any).managedDocumentRequests, "ensureIntent").mockRejectedValueOnce(new Error("temporary_intent_write_failure"));
      restore = () => spy.mockRestore();
    });
    const interrupted = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(request) });
    expect(interrupted.status).toBe(503);
    await expect(interrupted.json()).resolves.toMatchObject({ status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED" });
    restore();
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "committed", receipt: { request_id: request.request_id } });
  });

  it("continues a matching legacy hash-only intent using the server-staged request", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-LEGACY-0051");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Legacy intent";
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-LEGACY-0051", project_id: created.project_id,
      logical_path: "strategy/legacy.md", content, content_sha256: await sha256Text(content), created_at: at };
    await createProductionPersistence(testEnv).objects.createText(
      `${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`,
      JSON.stringify({ schema_version: "1.0", project_id: created.project_id, request_id: request.request_id,
        request_sha256: await sha256Text(JSON.stringify(request)) })
    );
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const spy = vi.spyOn((instance as any).managedDocumentService, "writeWorking").mockRejectedValueOnce(new Error("temporary_provider_unavailable"));
      restore = () => spy.mockRestore();
    });
    const interrupted = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(request) });
    expect(interrupted.status).toBe(503);
    restore();
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "committed", receipt: { request_id: request.request_id } });
  });

  it("never executes a canonical intent that differs from the admitted staged request", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-BIND-0052");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-BIND-0052", project_id: created.project_id,
      logical_path: "strategy/bound.md", content: "admitted", content_sha256: await sha256Text("admitted"), created_at: at };
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const spy = vi.spyOn((instance as any).managedDocumentRequests, "ensureIntent").mockRejectedValueOnce(new Error("temporary_intent_write_failure"));
      restore = () => spy.mockRestore();
    });
    const interrupted = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(request) });
    expect(interrupted.status).toBe(503);
    restore();
    const different = { ...request, content: "different", content_sha256: await sha256Text("different") };
    await new ManagedDocumentRequestLedger(createProductionPersistence(testEnv))
      .ensureIntent(created.project_id, request.request_id, JSON.stringify(different));
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "recovery_blocked", recovery: { code: "document_intent_binding_mismatch" } });
    expect(await new ManagedDocumentRequestLedger(createProductionPersistence(testEnv)).readReceipt(created.project_id, request.request_id)).toBeNull();
  });

  it("does not call an unqueued intent scheduled for recovery", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-STATUS-0048");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Intentionally unqueued";
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-STATUS-0048", project_id: created.project_id,
      logical_path: "strategy/unqueued.md", content, content_sha256: await sha256Text(content), created_at: at };
    await new ManagedDocumentRequestLedger(createProductionPersistence(testEnv))
      .ensureIntent(created.project_id, request.request_id, JSON.stringify(request));
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "recovery_unavailable" });
  });

  it("does not advertise a queued request without an alarm as scheduled", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-WAKE-0050");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Wake missing";
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-WAKE-0050", project_id: created.project_id,
      logical_path: "strategy/wake.md", content, content_sha256: await sha256Text(content), created_at: at };
    await runInDurableObject(guard, (instance) => {
      vi.spyOn((instance as any).managedDocumentService, "writeWorking").mockRejectedValueOnce(new Error("temporary_provider_unavailable"));
    });
    await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(request) });
    await runInDurableObject(guard, async (_instance, state) => state.storage.deleteAlarm());
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "recovery_unavailable", recovery: { scheduled: false } });
  });

  it("bounds identical recovery failures and exposes the stalled request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const created = await createProject("TXN-DOCUMENT-RECOVERY-FAIL-0049");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Repeated failure";
    const request = { operation: "working.write" as const, request_id: "DOCREQ-RECOVERY-FAIL-0049", project_id: created.project_id,
      logical_path: "strategy/stalled.md", content, content_sha256: await sha256Text(content), created_at: at };
    await runInDurableObject(guard, (instance) => {
      vi.spyOn((instance as any).managedDocumentService, "writeWorking").mockRejectedValue(new Error("persistent_internal_failure"));
    });
    await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(request) });
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number
      }>("SELECT count, stopped FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id).toArray()[0]);
      expect(failure).toEqual({ count: attempt + 1, stopped: attempt === 5 ? 1 : 0 });
      if (attempt < 5) vi.setSystemTime(Date.now() + 30_001);
    }
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    await expect(status.json()).resolves.toMatchObject({ status: "recovery_blocked", recovery: { code: "identical_internal_failure_limit" } });
    expect(await runDurableObjectAlarm(guard)).toBe(false);
  });

  it("recovers one project without delaying an independent project", async () => {
    const blocked = await createProject("TXN-DOCUMENT-RECOVERY-0043");
    const independent = await createProject("TXN-DOCUMENT-RECOVERY-0044");
    const blockedGuard = testEnv.PROJECT_GUARD.getByName(blocked.project_id);
    const independentGuard = testEnv.PROJECT_GUARD.getByName(independent.project_id);
    let failure: ReturnType<typeof vi.spyOn>;
    await runInDurableObject(blockedGuard, (instance) => {
      failure = vi.spyOn((instance as any).managedDocumentService, "writeWorking")
        .mockRejectedValueOnce(new Error("temporary_provider_unavailable"));
    });
    const blockedContent = "blocked temporarily";
    const blockedRequest = {
      operation: "working.write", request_id: "DOCREQ-RECOVERY-36010043", project_id: blocked.project_id,
      logical_path: "strategy/blocked.md", content: blockedContent,
      content_sha256: await sha256Text(blockedContent), created_at: at
    } as const;
    const pending = await blockedGuard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blockedRequest)
    });
    expect(pending.status).toBe(503);

    const readyContent = "continues independently";
    const independentRequest = {
      operation: "working.write", request_id: "DOCREQ-RECOVERY-36010044", project_id: independent.project_id,
      logical_path: "strategy/ready.md", content: readyContent,
      content_sha256: await sha256Text(readyContent), created_at: at
    } as const;
    const unaffected = await independentGuard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(independentRequest)
    });
    await expect(unaffected.json()).resolves.toMatchObject({ status: "committed", request_id: independentRequest.request_id });

    failure!.mockRestore();
    expect(await runDurableObjectAlarm(blockedGuard)).toBe(true);
    const recovered = await blockedGuard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blockedRequest)
    });
    await expect(recovered.json()).resolves.toMatchObject({ status: "committed", request_id: blockedRequest.request_id });
  });

  it("rotates recoverable work so repeated failures cannot starve a later request", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-FAIR-0045");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const seen: string[] = [];
    await runInDurableObject(guard, (instance) => {
      vi.spyOn((instance as any).managedDocumentService, "writeWorking").mockImplementation(async (...args: unknown[]) => {
        const request = args[0] as { request_id: string };
        seen.push(request.request_id);
        throw new Error("temporary_provider_unavailable");
      });
    });
    const requests = await Promise.all([1, 2, 3, 4, 5].map(async (number) => {
      const content = `retry ${number}`;
      return {
        operation: "working.write" as const,
        request_id: `DOCREQ-RECOVERY-FAIR-000${number}`,
        project_id: created.project_id,
        logical_path: `strategy/retry-${number}.md`,
        content,
        content_sha256: await sha256Text(content),
        created_at: at
      };
    }));
    for (const request of requests) {
      const response = await guard.fetch("https://project-guard.internal/document", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
      });
      expect(response.status).toBe(503);
    }
    expect(seen).toHaveLength(5);

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(seen.slice(5)).toEqual(requests.slice(0, 4).map((request) => request.request_id));
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(seen.slice(9)).toContain(requests[4]!.request_id);
  });

  it("does not advertise malformed durable intent as automatically recoverable", async () => {
    const created = await createProject("TXN-DOCUMENT-RECOVERY-CORRUPT-0046");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await runInDurableObject(guard, (instance) => {
      vi.spyOn((instance as any).managedDocumentService, "writeWorking")
        .mockRejectedValueOnce(new Error("temporary_provider_unavailable"));
    });
    const content = "corrupt recovery status";
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-RECOVERY-CORRUPT-0046",
      project_id: created.project_id,
      logical_path: "strategy/corrupt.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    };
    const pending = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    });
    expect(pending.status).toBe(503);
    const runtime = createProductionPersistence(testEnv);
    const intentPath = `${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`;
    const stored = JSON.parse((await runtime.objects.readText(intentPath))!);
    stored.request_json = "{not-valid-json";
    stored.request_sha256 = await sha256Text(stored.request_json);
    await runtime.objects.upsertText(intentPath, JSON.stringify(stored));

    const status = await guard.fetch(
      `https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`
    );
    await expect(status.json()).resolves.toMatchObject({
      status: "recovery_unavailable",
      recovery: { durable_intent: true, recoverable: false, code: "intent_payload_invalid" }
    });
  });

  it("does not trust an uncommitted local expected-version rule injected into the mutable snapshot", async () => {
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-DOCUMENT-PROJECT-0008");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const initialContent = "first";
    const initial = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        operation: "working.write", request_id: "DOCREQ-WORK-36080001", project_id: created.project_id,
        logical_path: "strategy/rule-evidence.md", content: initialContent,
        content_sha256: await sha256Text(initialContent), created_at: at
      })
    });
    const first = await initial.json<{ document_id: string; version_id: string }>();
    const signing = "document-rule-observation-signing";
    await bootstrapRuleAdmissionGovernance(testEnv, signing, created.project_id);
    let modifiedState = "";
    await runInDurableObject(guard, (instance, state) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        MUTATION_CONTEXT_SIGNING_KEY: signing,
        RULE_ADMISSION_SIGNING_KEY: signing,
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
      });
      const row = state.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM project_state WHERE singleton = 1").toArray()[0]!;
      const project = JSON.parse(row.state_json);
      const active = ruleFixture(created.project_id, {
        rule_id: "RULE-DOCUMENT-VERSION-0008", status: "active", activation_evidence: ["server:qualified"],
        operations: ["working.write"], resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
        check_id: "expected_version", parameters: { required: true }
      });
      project.local_rules = { [`${active.rule_id}@${active.version}`]: active };
      modifiedState = JSON.stringify(project);
      state.storage.sql.exec("UPDATE project_state SET state_json = ? WHERE singleton = 1", modifiedState);
    });
    mock.files.set(machineStatePath(created.project_id), `${modifiedState}\n`);
    const { context }: any = await (await guard.fetch("https://project-guard.internal/mutation-context")).json();
    const nextContent = "second";

    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission({
        operation: "working.write", request_id: "DOCREQ-WORK-36080002", project_id: created.project_id,
        logical_path: "strategy/rule-evidence.md", content: nextContent,
        content_sha256: await sha256Text(nextContent), expected_version_id: first.version_id, created_at: at
      }, context))
    });

    // The cache and state view above are not a commit record. Reading a fresh
    // mutation context reconstructs the state from the immutable revision-1
    // commit, so this uncommitted local rule is not authority for the write.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "committed", request_id: "DOCREQ-WORK-36080002" });
  });

  it("rejects a head changed during observation and re-reads independent durable head/version evidence", async () => {
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-DOCUMENT-PROJECT-0009");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const initialContent = "first";
    const initial = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        operation: "working.write", request_id: "DOCREQ-WORK-36090001", project_id: created.project_id,
        logical_path: "strategy/stable-evidence.md", content: initialContent,
        content_sha256: await sha256Text(initialContent), created_at: at
      })
    });
    expect(initial.status).toBe(200);
    await initial.json();
    const documentId = await documentIdFor(created.project_id, "strategy/stable-evidence.md");
    const first = await new DocumentLedgerRepository(createProductionPersistence(testEnv)).readHead(created.project_id, documentId);
    expect(first?.working_version_id).toBeDefined();
    const request = {
      operation: "working.write", request_id: "DOCREQ-WORK-36090002", project_id: created.project_id,
      logical_path: "strategy/stable-evidence.md", content: "second",
      content_sha256: await sha256Text("second"), expected_version_id: first!.working_version_id!, created_at: at
    } as const;
    const normalized = await normalizeDocumentAdmission(request);
    const headPath = machineDocumentHeadPath(created.project_id, documentId);
    let metadataSpy: ReturnType<typeof vi.spyOn>;
    await runInDurableObject(guard, (instance) => {
      const runtime = (instance as unknown as { persistence: ReturnType<typeof createProductionPersistence> }).persistence;
      const original = runtime.objects.getMetadata.bind(runtime.objects);
      let changed = false;
      metadataSpy = vi.spyOn(runtime.objects, "getMetadata").mockImplementation(async (path) => {
        const metadata = await original(path);
        if (!changed && path === headPath) {
          changed = true;
          await mock.writeExternal(headPath, mock.files.get(headPath)!);
        }
        return metadata;
      });
    });

    const unstable = await runInDurableObject(guard, async (instance) => {
      const project = await (instance as any).loadOrRecoverState();
      return (instance as any).resolveServerObservations(project, normalized);
    });

    expect(unstable).toEqual([]);
    metadataSpy!.mockRestore();
    const runtime = createProductionPersistence(testEnv);
    const versionPath = machineDocumentVersionPath(created.project_id, documentId, first!.working_version_id!);
    const headBeforeRetry = await runtime.objects.getMetadata(headPath);
    const versionBeforeRetry = await runtime.objects.getMetadata(versionPath);
    expect(headBeforeRetry).toMatchObject({ path: headPath, objectId: expect.any(String), revisionToken: expect.any(String), integrityHash: expect.any(Object) });
    expect(versionBeforeRetry).toMatchObject({ path: versionPath, objectId: expect.any(String), revisionToken: expect.any(String), integrityHash: expect.any(Object) });

    const observations = await runInDurableObject(guard, async (instance) => {
      const project = await (instance as any).loadOrRecoverState();
      return (instance as any).resolveServerObservations(project, normalized);
    });

    const ref = (metadata: NonNullable<typeof headBeforeRetry>) =>
      `${metadata.path}#object_id=${encodeURIComponent(metadata.objectId!)}&revision_token=${encodeURIComponent(metadata.revisionToken!)}&integrity_hash_algorithm=${encodeURIComponent(metadata.integrityHash!.algorithm)}&integrity_hash=${encodeURIComponent(metadata.integrityHash!.value)}`;
    expect(observations).toMatchObject([{ current_version: first!.working_version_id, evidence_refs: [ref(headBeforeRetry!), ref(versionBeforeRetry!)] }]);
  });

  it("rejects request-id reuse with a different document payload", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0002");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const base = {
      operation: "working.write",
      request_id: "DOCREQ-WORK-36020001",
      project_id: created.project_id,
      logical_path: "strategy/commercial.md",
      content: "one",
      content_sha256: await sha256Text("one"),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    expect((await first.json<{ status: string }>()).status).toBe("committed");

    const changed = { ...base, content: "two", content_sha256: await sha256Text("two") };
    const second = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });
    expect(await second.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("keeps request-id binding durable when the local document request cache is lost", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0004");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const base = {
      operation: "working.write",
      request_id: "DOCREQ-WORK-36040001",
      project_id: created.project_id,
      logical_path: "strategy/original.md",
      content: "durable original",
      content_sha256: await sha256Text("durable original"),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    const committed = await first.json<Record<string, unknown>>();
    expect(committed).toMatchObject({ status: "committed", request_id: base.request_id });

    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests");
    });

    const exactReplay = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    expect(await exactReplay.json()).toEqual(committed);

    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests");
    });

    const changed = {
      ...base,
      logical_path: "strategy/other.md",
      content: "different effect",
      content_sha256: await sha256Text("different effect")
    };
    const mismatch = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });
    expect(await mismatch.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("fails closed when the Durable Object project binding differs", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0003");
    const guard = testEnv.PROJECT_GUARD.getByName("PRJ-9999");
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36030001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content: "x",
        content_sha256: await sha256Text("x"),
        created_at: at
      })
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "PROJECT_BINDING_MISMATCH" });
  });
});
