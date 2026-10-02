import { describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import {
  navigationCatalogRebuildProgressSchema,
  navigationReconcileSchema,
  zoneNavigationHeadSchema,
  type NavigationCatalogRebuildRequest,
  type NavigationReconcileRequest,
  type NavigationInventoryEntry,
  type NavigationInventoryPort,
  type NavigationIndexIdentity
} from "../src/domain/zone-navigation";
import { ZoneNavigationEngine, zoneNavigationHeadPath } from "../src/documents/zone-navigation";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCatalogShardForResource } from "../src/documents/zone-navigation-sources";
import { executionHash, ExecutionJournal, requiredRulePostchecks } from "../src/execution/journal";
import type { ExecutionAdmission } from "../src/execution/contract";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";
import { machineArtifactReceiptPath, machineDocumentRoot, machineMutationIntentPath, workspaceProjectRoot } from "../src/persistence/layout";
import { sha256Text } from "../src/documents/hash";
import type { SliceBudget } from "../src/convergence/contract";
import { mutationIntentIdFor } from "../src/domain/mutation-gate";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { canonicalJson } from "../src/rules/contract";

const state = () => emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
const at = "2026-09-25T09:00:00.000Z";

function request(zone: "WORKING" | "REVIEW" | "DELIVERABLES" = "WORKING", expected_index: NavigationReconcileRequest["expected_index"] = null): NavigationReconcileRequest {
  return navigationReconcileSchema.parse({
    operation: "navigation.reconcile",
    request_id: `DOCREQ-NAVIGATION-${zone}-0001`,
    project_id: "PRJ-0002",
    zone,
    expected_project_revision: 0,
    expected_generation: 0,
    expected_index,
    created_at: at
  });
}

function admissionFor(input: NavigationReconcileRequest): Promise<ExecutionAdmission> {
  const zonePath = `${workspaceProjectRoot(input.project_id, "project-os")}/${input.zone}/${input.expected_index?.basename ?? "00-CURRENT.md"}`;
  const archivePath = input.expected_index
    ? `${workspaceProjectRoot(input.project_id, "project-os")}/ARCHIVES/NAVIGATION/${input.zone}/${input.expected_generation + 1}-${input.expected_index.content_sha256}.md`
    : null;
  return executionHash(input).then((request_hash) => ({
    project_id: input.project_id,
    request_id: input.request_id,
    kind: "document",
    operation: "navigation.reconcile",
    request_hash,
    actor: { actor_id: "operator:test", authority: "project_guard" },
    resources: [{ resource_id: `navigation:${input.zone}`, resource_type: "navigation", zone: input.zone, version: String(input.expected_generation) }],
    resource_effect_scopes: [{
      resource_id: `navigation:${input.zone}`, resource_version: String(input.expected_generation), provider_id: "test-provider",
      sources: input.expected_index ? [{ path: zonePath, logical_path: `${input.zone}/${input.expected_index.basename}` }] : [],
      destinations: [{ path: zonePath, logical_path: `${input.zone}/${input.expected_index?.basename ?? "00-CURRENT.md"}` }],
      preservation_copies: archivePath ? [{ path: archivePath, logical_path: archivePath.slice(`${workspaceProjectRoot(input.project_id, "project-os")}/`.length) }] : []
    }],
    global_revision: 0,
    project_revision: input.expected_project_revision,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: input.expected_project_revision },
    verdict: "allow",
    results: [],
    gaps: [],
    deferred_rules: []
  } as unknown as ExecutionAdmission));
}

function withDeferredValidLinks(admission: ExecutionAdmission): { admission: ExecutionAdmission; rule: import("../src/domain/rule-governance").RuleVersion } {
  const reference = { rule_id: "RULE-NAV-LINKS-01", version: 1, scope: { kind: "global" as const } };
  admission.deferred_rules = [reference];
  admission.ruleset.rules = [reference];
  const rule = {
    ...reference,
    source_refs: ["server:qualified"],
    title: "Navigation links resolve to verified targets",
    operations: ["navigation.reconcile"],
    resource_scope: { resource_types: ["navigation"], zones: ["WORKING"] },
    check_id: "valid_links",
    parameters: {},
    enforcement: "automatic",
    check_stage: "post_execution",
    exception_allowed: false,
    status: "active",
    activation_evidence: ["server:qualified"],
    created_by: "test",
    created_at: at
  } as import("../src/domain/rule-governance").RuleVersion;
  return { admission, rule };
}

function runtimeHarness() {
  const files = new Map<string, { content: string; objectId: string; revisionToken: string }>();
  const binaryFiles = new Map<string, { bytes: Uint8Array; objectId: string; revisionToken: string }>();
  let sequence = 0;
  const listingCalls: Array<{ path: string; cursor: string | null; limit: number }> = [];
  const readPaths: string[] = [];
  let failCreatePathOnce: ((path: string) => boolean) | null = null;
  const metadata = (path: string): ProviderObjectMetadata | null => {
    const file = files.get(path);
    const binary = binaryFiles.get(path);
    return file ? {
      path,
      size: new TextEncoder().encode(file.content).byteLength,
      objectId: file.objectId,
      revisionToken: file.revisionToken,
    } : binary ? { path, size: binary.bytes.length, objectId: binary.objectId, revisionToken: binary.revisionToken } : null;
  };
  const put = (path: string, content: string, objectId?: string): ProviderObjectMetadata => {
    sequence += 1;
    binaryFiles.delete(path);
    files.set(path, { content, objectId: objectId ?? `id:${sequence}`, revisionToken: `rev-${sequence}` });
    return metadata(path)!;
  };
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test-provider",
    objects: {
      readText: async (path) => { readPaths.push(path); return files.get(path)?.content ?? null; },
      readBytes: async (path, maxBytes) => {
        const binary = binaryFiles.get(path);
        const bytes = binary?.bytes ?? (files.has(path) ? new TextEncoder().encode(files.get(path)!.content) : null);
        if (!bytes) return null;
        if (bytes.length > maxBytes) throw new Error("byte_limit");
        return bytes.slice();
      },
      createText: async (path, content) => {
        if (failCreatePathOnce?.(path)) {
          failCreatePathOnce = null;
          throw new Error("injected create interruption");
        }
        if (files.has(path)) throw new ProviderConflictError("exists");
        put(path, content);
      },
      upsertText: async (path, content) => { put(path, content, files.get(path)?.objectId); },
      getMetadata: async (path) => metadata(path),
      listChildren: async () => [],
      move: async (from, to) => {
        const source = files.get(from);
        if (!source || files.has(to)) throw new ProviderConflictError("move_conflict");
        files.delete(from);
        put(to, source.content, source.objectId);
      },
      delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: {
      writeTextConditional: async (path, content, expectedRevisionToken) => {
        const current = files.get(path) ?? binaryFiles.get(path);
        if (!current || current.revisionToken !== expectedRevisionToken) throw new ProviderPreconditionFailedError("stale");
        return put(path, content, current.objectId);
      }
    },
    serverSideCopy: { copyObject: async () => { throw new Error("unused"); } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "test" }) },
    pagedListing: { listPage: async ({ path, cursor, limit }) => {
      listingCalls.push({ path, cursor, limit });
      const matching = [...files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  const putBytes = (path: string, bytes: Uint8Array, objectId?: string): ProviderObjectMetadata => {
    sequence += 1;
    binaryFiles.set(path, { bytes: bytes.slice(), objectId: objectId ?? `id:${sequence}`, revisionToken: `rev-${sequence}` });
    return metadata(path)!;
  };
  return { runtime, files, binaryFiles, listingCalls, readPaths, put, putBytes, failNextCreate: (match: (path: string) => boolean) => { failCreatePathOnce = match; } };
}

async function inventoryHarness(inputState = state(), zone: "WORKING" | "REVIEW" | "DELIVERABLES" = "WORKING", options: { missing?: boolean; snapshotChanged?: boolean; pages?: NavigationInventoryEntry[][] } = {}) {
  const projectRoot = workspaceProjectRoot(inputState.project_id, inputState.slug);
  const logical_path = "plans/roadmap.md";
  const targetPath = `${projectRoot}/${zone}/${logical_path}`;
  const targetContent = "Canonical content\n";
  const entry: NavigationInventoryEntry = {
    project_id: inputState.project_id,
    zone,
    resource_id: "DOC-0123456789ABCDEF01234567",
    version: "VER-REQ-0123456789ABCDEF01234567",
    logical_path,
    path: targetPath,
    expected: { object_id: "id:target", revision_token: "rev-target", content_sha256: await sha256Text(targetContent), size: new TextEncoder().encode(targetContent).byteLength }
  };
  const pages = options.pages ?? [[entry]];
  const port: NavigationInventoryPort = {
    listPage: async ({ cursor, budget: slice }) => {
      const pageNumber = cursor === null ? 0 : Number(cursor);
      slice.beforeHttp();
      return { entries: pages[pageNumber] ?? [], gaps: [], snapshot_id: "snapshot-1", next_cursor: pageNumber + 1 < pages.length ? String(pageNumber + 1) : null };
    },
    verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return !options.snapshotChanged; },
    verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return !options.missing; }
  };
  return { port, entry, targetPath, targetContent };
}

async function seedAdoptingProgress(
  harness: ReturnType<typeof runtimeHarness>,
  input: NavigationReconcileRequest,
  pageCount: number,
  cursor: string,
  sourceEntry?: NavigationInventoryEntry
) {
  const root = await new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id).root();
  const requestHash = await executionHash(input);
  const progress = {
    schema_version: "1.0",
    project_id: input.project_id,
    request_id: input.request_id,
    request_hash: requestHash,
    target_generation: 1,
    index_basename: "00-CURRENT.md" as const,
    expected_index: null,
    head_revision_token: null,
    cursor,
    page_count: pageCount,
    inventory_complete: false,
    snapshot_id: "snapshot-empty-prefix",
    verify_page: 0,
    verify_entry: 0,
    source_count: sourceEntry ? 1 : 0,
    source_ids: sourceEntry ? [sourceEntry.resource_id] : [],
    published_index: null,
    coverage_gaps: [],
    rendered_links: [],
    generated_sha256: null,
    legacy_archive_ref: null,
    status: "adopting" as const,
    receipt: null,
    postchecks: []
  };
  harness.put(`${root}/navigation-intention.json`, JSON.stringify({ schema_version: "1.0", request: input, request_hash: requestHash, target_generation: 1, initial_progress: progress }));
  harness.put(`${root}/navigation-progress.json`, JSON.stringify(progress));
  for (let page = 0; page < pageCount; page++) {
    harness.put(`${root}/navigation/snapshot/${page.toString().padStart(8, "0")}.json`, JSON.stringify({
      schema_version: "1.0", page, project_id: input.project_id, request_id: input.request_id,
      snapshot_id: "snapshot-empty-prefix", entries: page === 0 && sourceEntry ? [sourceEntry] : [], gaps: []
    }));
  }
  return { root, progress };
}

function budget(calls = 32): SliceBudget {
  return {
    deadline_ms: Number.MAX_SAFE_INTEGER,
    calls_left: calls,
    now: () => 0,
    signal: new AbortController().signal,
    beforeHttp() { this.calls_left -= 1; if (this.calls_left < 0) throw new Error("slice_budget_exhausted"); },
    canStartEffect(required) { return this.calls_left >= required; }
  };
}

async function seedIndex(runtimeHarnessValue: ReturnType<typeof runtimeHarness>, path: string, content: string) {
  const metadata = runtimeHarnessValue.put(path, content, "id:index");
  return {
    basename: path.split("/").at(-1)! as NavigationIndexIdentity["basename"],
    object_id: metadata.objectId!,
    revision_token: metadata.revisionToken!,
    content_sha256: await sha256Text(content)
  } satisfies NavigationIndexIdentity;
}

function seedTarget(runtimeHarnessValue: ReturnType<typeof runtimeHarness>, inventory: Awaited<ReturnType<typeof inventoryHarness>>) {
  const metadata = runtimeHarnessValue.put(inventory.targetPath, inventory.targetContent, "id:target");
  inventory.entry.expected.object_id = metadata.objectId!;
  inventory.entry.expected.revision_token = metadata.revisionToken!;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reconcileUntilTerminal(engine: ZoneNavigationEngine, input: NavigationReconcileRequest, project: ReturnType<typeof state>, admission: ExecutionAdmission, firstBudget = 32) {
  let result = await engine.reconcile(input, project, admission, budget(firstBudget));
  for (let attempt = 0; result.status === "pending" && attempt < 12; attempt++) result = await engine.reconcile(input, project, admission, budget());
  return result;
}

async function missingProgressPublicationFixture(requestId = "DOCREQ-NAVIGATION-WORKING-ABSENT-PROGRESS-0001") {
  const harness = runtimeHarness();
  const project = state();
  const inv = await inventoryHarness(project);
  const priorIndex = { basename: "00-CURRENT.md" as const, object_id: "id:prior-index", revision_token: "rev-prior-index", content_sha256: "a".repeat(64) };
  const input = navigationReconcileSchema.parse({ ...request(), request_id: requestId, expected_generation: 1, expected_index: priorIndex });
  const admission = await admissionFor(input);
  await new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id).commit(admission, null);
  const sources = new ZoneNavigationSources(harness.runtime);
  expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
  const ticket = await sources.beginHeadWrite(project.project_id, "WORKING", "head:DOC-0123456789ABCDEF01234567", undefined, null, true);
  expect(ticket?.generation).toBe(1);
  await sources.completeHeadWrite(ticket!, null);
  expect(await sources.readState(project.project_id, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [] });
  const headPath = zoneNavigationHeadPath(project.project_id, "WORKING");
  const head = zoneNavigationHeadSchema.parse({
    schema_version: "1.0", project_id: project.project_id, zone: "WORKING", generation: 1,
    source_request_id: "DOCREQ-NAVIGATION-WORKING-PRIOR-0001", index: priorIndex,
    finalization_ref: "prior:publication-certificate", source_snapshot_id: "source:0", source_count: 0, coverage_gaps: []
  });
  harness.put(headPath, canonicalJson(head));
  return { harness, project, inv, input, admission, headPath, head };
}

async function runSparseCatalogRebuildWithLegacyProgress(includeOmittedSourceId = false) {
  const harness = runtimeHarness();
  const project = state();
  const manifest = { object_id: "manifest-object", revision_token: "manifest-rev", content_sha256: "a".repeat(64) };
  const input = navigationReconcileSchema.parse({
    ...request("REVIEW"), request_id: includeOmittedSourceId ? "DOCREQ-NAV-CATALOG-REBUILD-0003" : "DOCREQ-NAV-CATALOG-REBUILD-0002",
    purpose: "compact_catalog_rebuild", expected_source_generation: 0, expected_catalog_manifest: manifest
  }) as NavigationCatalogRebuildRequest;
  const requestHash = await executionHash(input);
  const journal = new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id);
  const root = await journal.root();
  const manifestPath = `${machineDocumentRoot(input.project_id)}/navigation-sources/${input.zone}/catalog/compact/ready.json`;
  const scope = {
    resource_id: `navigation:${input.zone}`, resource_version: String(input.expected_generation), provider_id: "test-provider",
    sources: [{ path: manifestPath, logical_path: manifestPath }], destinations: [{ path: manifestPath, logical_path: manifestPath }], preservation_copies: []
  };
  const admission = {
    ...(await admissionFor(input)),
    resources: [{ resource_id: `navigation:${input.zone}`, resource_type: "navigation", zone: input.zone, version: String(input.expected_generation) }],
    resource_effect_scopes: [scope]
  } as unknown as ExecutionAdmission;

  const inv = await inventoryHarness(project, "REVIEW");
  const entries: NavigationInventoryEntry[] = [];
  const byShard = new Map<number, NavigationInventoryEntry>();
  for (let candidate = 1; byShard.size < 2 && candidate < 1000; candidate++) {
    const resource_id = `DOC-${candidate.toString(16).toUpperCase().padStart(24, "0")}`;
    const shard = zoneNavigationCatalogShardForResource(resource_id);
    if (byShard.has(shard)) continue;
    const entry = { ...inv.entry, resource_id, logical_path: `plans/${resource_id}.md`, path: `${workspaceProjectRoot(project.project_id, project.slug)}/REVIEW/plans/${resource_id}.md` };
    byShard.set(shard, entry);
    entries.push(entry);
  }
  const orderedShards = [...byShard.keys()].sort((left, right) => left - right);
  const sourceIds = entries.map((entry) => entry.resource_id);
  if (includeOmittedSourceId) {
    for (let candidate = 1000; candidate < 2000; candidate++) {
      const resource_id = `DOC-${candidate.toString(16).toUpperCase().padStart(24, "0")}`;
      if (zoneNavigationCatalogShardForResource(resource_id) === orderedShards[0]) {
        sourceIds.push(resource_id);
        break;
      }
    }
  }
  expect(sourceIds.length).toBe(includeOmittedSourceId ? 3 : 2);

  for (let page = 0; page < 4; page++) {
    const entry = page === 0 ? byShard.get(orderedShards[0]) : page === 3 ? byShard.get(orderedShards[1]) : undefined;
    harness.put(`${root}/navigation/catalog-rebuild/snapshot/${page.toString().padStart(8, "0")}.json`, JSON.stringify({
      schema_version: "1.0", page, project_id: input.project_id, request_id: input.request_id, snapshot_id: "source:0",
      entries: entry ? [entry] : [], gaps: []
    }));
  }
  // This is the persisted pre-index shape: the schema supplies the new index
  // defaults when the execution resumes.
  harness.put(`${root}/navigation-catalog-rebuild-progress.json`, JSON.stringify({
    schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: input.project_id,
    request_id: input.request_id, request_hash: requestHash, zone: input.zone, source_generation: 0,
    source_snapshot_id: "source:0", cursor: null, page_count: 4, source_count: sourceIds.length,
    source_ids: sourceIds, shard_cursor: 0, shard_count: 2,
    stage_page: 0, staging_entries: [], staged_shards: [], invalidated_manifest: null, chunk_evidence: [],
    status: "staging", finalization_ref: null, coverage_gaps: []
  }));
  const stageSpy = vi.spyOn(ZoneNavigationSources.prototype, "stageCompactCatalogRebuildShard").mockResolvedValue(undefined);
  const manifestSpy = vi.spyOn(ZoneNavigationSources.prototype, "compactCatalogManifestIdentity").mockResolvedValue(manifest);
  const inventoryPort: NavigationInventoryPort = {
    ...inv.port,
    verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; }
  };
  const engine = new ZoneNavigationEngine(harness.runtime, inventoryPort);
  const initial = await engine.prepareCompactCatalogRebuild(input, project, admission, budget(4));
  const checkpoint = JSON.parse(harness.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content);
  const result = initial.status === "pending"
    ? await engine.prepareCompactCatalogRebuild(input, project, admission, budget(512))
    : initial;
  const snapshotReads = harness.readPaths.filter((path) => path.includes("/navigation/catalog-rebuild/snapshot/"));
  const stagedShards = stageSpy.mock.calls.map(([call]) => call.shard);
  stageSpy.mockRestore();
  manifestSpy.mockRestore();
  return { result, initial, checkpoint, root, snapshotReads, stagedShards };
}

describe("zone navigation identity and resumable reconciliation", () => {
  it.each(["publish", "verify", "post-publish"] as const)("advances two independent catalog shards in one bounded %s slice", async (phase) => {
    const h = runtimeHarness();
    const project = state();
    const input = navigationReconcileSchema.parse({
      ...request("REVIEW"), request_id: `DOCREQ-NAV-BATCH-${phase.toUpperCase()}-0001`,
      purpose: "compact_catalog_rebuild", expected_source_generation: 0,
      expected_catalog_manifest: { object_id: "manifest-object", revision_token: "manifest-rev", content_sha256: "a".repeat(64) }
    }) as NavigationCatalogRebuildRequest;
    const root = await new ExecutionJournal(h.runtime, input.project_id, "document", input.request_id).root();
    const identity = { object_id: "unready-object", revision_token: "unready-rev", content_sha256: "c".repeat(64) };
    const evidence = [1, 2].map((shard) => ({ shard, object_id: `chunk-${shard}`, revision_token: `chunk-rev-${shard}`, content_sha256: "b".repeat(64) }));
    h.put(`${root}/navigation-catalog-rebuild-progress.json`, JSON.stringify({
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: input.project_id, request_id: input.request_id,
      request_hash: await executionHash(input), zone: input.zone, source_generation: 0, source_snapshot_id: "source:0",
      cursor: null, page_count: 2, source_count: 2, source_ids: ["head:one", "head:two"],
      shard_cursor: 2, shard_count: 2, staged_shards: [1, 2], invalidated_manifest: identity,
      chunk_evidence: phase === "publish" ? [] : evidence,
      publish_cursor: phase === "publish" ? 0 : 2,
      verify_shard_cursor: phase === "post-publish" ? 2 : 0,
      post_publish_verify_cursor: 0,
      status: "publishing", finalization_ref: null, coverage_gaps: []
    }));
    const manifestPath = `${machineDocumentRoot(input.project_id)}/navigation-sources/REVIEW/catalog/compact/ready.json`;
    const admission = { ...(await admissionFor(input)), resource_effect_scopes: [{
      resource_id: "navigation:REVIEW", resource_version: "0", provider_id: "test-provider",
      sources: [{ path: manifestPath, logical_path: manifestPath }], destinations: [{ path: manifestPath, logical_path: manifestPath }], preservation_copies: []
    }] } as ExecutionAdmission;
    const seen: number[] = [];
    let activeVerifications = 0;
    let peakVerifications = 0;
    let interruptSecondVerification = phase === "verify";
    const charge = (slice: SliceBudget | undefined) => { for (let index = 0; index < 9; index += 1) slice!.beforeHttp(); };
    const publish = vi.spyOn(ZoneNavigationSources.prototype, "publishCompactCatalogRebuildShard").mockImplementation(async (call, slice) => {
      seen.push(call.shard); charge(slice); return evidence.find((item) => item.shard === call.shard)!;
    });
    const verify = vi.spyOn(ZoneNavigationSources.prototype, "verifyCompactCatalogRebuildShard").mockImplementation(async (call, slice) => {
      seen.push(call.shard); charge(slice);
      activeVerifications += 1;
      peakVerifications = Math.max(peakVerifications, activeVerifications);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeVerifications -= 1;
      if (call.shard === 2 && interruptSecondVerification) {
        interruptSecondVerification = false;
        throw new Error("slice_budget_exhausted");
      }
    });
    const manifest = vi.spyOn(ZoneNavigationSources.prototype, "publishCompactCatalogRebuildManifest").mockImplementation(async (call) => ({
      ready_generation: 0, shards: call.shards, identity, chunk_evidence: call.chunk_evidence
    }));
    const post = vi.spyOn(ZoneNavigationSources.prototype, "verifyPublishedCompactCatalogRebuildShard").mockImplementation(async (call, slice) => {
      seen.push(call.shard); charge(slice);
    });
    const identityRead = phase === "post-publish"
      ? vi.spyOn(ZoneNavigationSources.prototype, "compactCatalogManifestIdentity").mockResolvedValue(identity)
      : null;
    const release = vi.spyOn(ZoneNavigationSources.prototype, "releaseCompactCatalogRebuildFence").mockResolvedValue(true);
    try {
      const engine = new ZoneNavigationEngine(h.runtime, { listPage: async () => { throw new Error("unused"); }, verifyEntry: async () => true, verifySnapshot: async () => true });
      if (phase === "verify") {
        expect((await engine.publishPreparedCompactCatalogRebuild(input, project, admission, "source:0", budget(32))).status).toBe("pending");
        expect(JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content).verify_shard_cursor).toBe(0);
        seen.length = 0;
        peakVerifications = 0;
      }
      if (phase === "post-publish") {
        expect((await engine.publishPreparedCompactCatalogRebuild(input, project, admission, "source:0", budget(13))).status).toBe("pending");
        expect(JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content).published_manifest).toEqual(identity);
      }
      let result = await engine.publishPreparedCompactCatalogRebuild(input, project, admission, "source:0", budget(32));
      if (phase === "post-publish" && result.status === "pending") {
        result = await engine.publishPreparedCompactCatalogRebuild(input, project, admission, "source:0", budget(32));
      }
      const progress = JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content);
      expect(seen).toEqual([1, 2]);
      expect(progress[phase === "publish" ? "publish_cursor" : phase === "verify" ? "verify_shard_cursor" : "post_publish_verify_cursor"]).toBe(2);
      if (phase === "verify") expect(peakVerifications).toBe(2);
      if (phase === "post-publish") {
        expect(manifest).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("finalized");
      }
    } finally {
      publish.mockRestore(); verify.mockRestore(); manifest.mockRestore(); post.mockRestore(); identityRead?.mockRestore(); release.mockRestore();
    }
  });
  it("verifies independent catalog rebuild pages concurrently before advancing their cursor", async () => {
    const h = runtimeHarness();
    const project = state();
    const input = navigationReconcileSchema.parse({
      ...request("REVIEW"), request_id: "DOCREQ-NAV-CATALOG-VERIFY-BATCH-0001",
      purpose: "compact_catalog_rebuild", expected_source_generation: 0,
      expected_catalog_manifest: { object_id: "manifest-object", revision_token: "manifest-rev", content_sha256: "a".repeat(64) }
    }) as NavigationCatalogRebuildRequest;
    const root = await new ExecutionJournal(h.runtime, input.project_id, "document", input.request_id).root();
    const entries = [0, 1].map((index) => ({
      project_id: input.project_id, zone: input.zone, resource_id: `head:DOC-${String(index + 1).padStart(24, "0")}`,
      version: `VER-${index + 1}`, logical_path: `plans/${index + 1}.md`,
      path: `${workspaceProjectRoot(input.project_id, project.slug)}/REVIEW/plans/${index + 1}.md`,
      expected: { object_id: `id:${index + 1}`, revision_token: `rev:${index + 1}`, content_sha256: "b".repeat(64), size: 1 }
    })) as NavigationInventoryEntry[];
    for (const [page, entry] of entries.entries()) h.put(`${root}/navigation/catalog-rebuild/snapshot/${String(page).padStart(8, "0")}.json`, JSON.stringify({
      schema_version: "1.0", page, project_id: input.project_id, request_id: input.request_id,
      snapshot_id: "source:0", entries: [entry], gaps: []
    }));
    const verifyingProgress = {
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: input.project_id, request_id: input.request_id,
      request_hash: await executionHash(input), zone: input.zone, source_generation: 0, source_snapshot_id: "source:0",
      cursor: null, page_count: 2, source_count: 2, source_ids: entries.map((entry) => entry.resource_id),
      shard_cursor: 0, shard_count: 0, stage_page: 0, staging_entries: [], staged_shards: [],
      invalidated_manifest: null, chunk_evidence: [], status: "verifying", finalization_ref: null, coverage_gaps: []
    };
    h.put(`${root}/navigation-catalog-rebuild-progress.json`, JSON.stringify(verifyingProgress));
    const manifestPath = `${machineDocumentRoot(input.project_id)}/navigation-sources/REVIEW/catalog/compact/ready.json`;
    const admission = { ...(await admissionFor(input)), resource_effect_scopes: [{
      resource_id: "navigation:REVIEW", resource_version: "0", provider_id: "test-provider",
      sources: [{ path: manifestPath, logical_path: manifestPath }], destinations: [{ path: manifestPath, logical_path: manifestPath }], preservation_copies: []
    }] } as ExecutionAdmission;
    let active = 0;
    let peak = 0;
    const port: NavigationInventoryPort = {
      listPage: async () => { throw new Error("scan already complete"); },
      verifySnapshot: async () => true,
      verifyEntry: async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1; return true;
      }
    };
    // The fixture intentionally omits the later staging intent: this test
    // stops at the persisted verification cursor, before publication.
    await new ZoneNavigationEngine(h.runtime, port).prepareCompactCatalogRebuild(input, project, admission, budget(64))
      .catch((error) => expect((error as Error).message).toBe("navigation_catalog_rebuild_intent_missing"));
    expect(peak).toBe(2);
    expect(JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content)).toMatchObject({ verify_page: 2, verify_entry: 0 });

    // A pair that cannot fit in one slice must switch durably to the
    // sequential path; otherwise every wake repeats the same pair forever.
    h.put(`${root}/navigation-catalog-rebuild-progress.json`, JSON.stringify(verifyingProgress));
    const expensivePort: NavigationInventoryPort = {
      ...port,
      verifyEntry: async (_entry, slice) => {
        for (let index = 0; index < 20; index += 1) slice.beforeHttp();
        return true;
      }
    };
    const expensiveEngine = new ZoneNavigationEngine(h.runtime, expensivePort);
    await expensiveEngine.prepareCompactCatalogRebuild(input, project, admission, budget(32));
    expect(JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content)).toMatchObject({ verify_page: 0, verify_cursor: "single-head" });
    await expensiveEngine.prepareCompactCatalogRebuild(input, project, admission, budget(32));
    expect(JSON.parse(h.files.get(`${root}/navigation-catalog-rebuild-progress.json`)!.content)).toMatchObject({ verify_page: 1, verify_cursor: null });
  });
  it("keeps legacy reconcile requests compatible and binds catalog rebuild purpose to the exact manifest", () => {
    const normal = request();
    expect(normal.purpose).toBeUndefined();
    const rebuildBase = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAV-CATALOG-REBUILD-0001",
      project_id: "PRJ-0002",
      zone: "REVIEW" as const,
      expected_project_revision: 42,
      expected_generation: 2,
      expected_index: null,
      purpose: "compact_catalog_rebuild" as const,
      expected_source_generation: 27,
      expected_catalog_manifest: { object_id: "manifest-object", revision_token: "manifest-rev", content_sha256: "a".repeat(64) },
      created_at: at
    };
    expect(navigationReconcileSchema.parse(rebuildBase)).toMatchObject({ purpose: "compact_catalog_rebuild", expected_generation: 2, expected_source_generation: 27 });
    expect(() => navigationReconcileSchema.parse({ ...rebuildBase, expected_catalog_manifest: undefined })).toThrow();
    expect(() => navigationReconcileSchema.parse({ ...rebuildBase, expected_index: { basename: "00-CURRENT.md", object_id: "index-object", revision_token: "index-rev", content_sha256: "b".repeat(64) } })).toThrow();
    expect(() => navigationReconcileSchema.parse({ ...rebuildBase, untrusted_chunks: [] })).toThrow();
  });

  it("removes stale gap duplicates only after a resumed head is physically verified", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request("REVIEW");
    const inv = await inventoryHarness(project, "REVIEW");
    inv.entry.resource_id = `head:${inv.entry.resource_id}`;
    const staleGap = { resource_id: inv.entry.resource_id, code: "active_version_provider_mismatch" };
    const seeded = await seedAdoptingProgress(harness, input, 9, "dirty:");
    const progress = seeded.progress as Omit<typeof seeded.progress, "coverage_gaps"> & {
      coverage_gaps: { resource_id: string; code: string }[];
    };
    progress.snapshot_id = "snapshot-empty-prefix";
    progress.coverage_gaps = Array.from({ length: 9 }, () => staleGap);
    harness.put(`${seeded.root}/navigation-progress.json`, JSON.stringify(progress));
    for (let page = 0; page < 9; page++) {
      harness.put(`${seeded.root}/navigation/snapshot/${page.toString().padStart(8, "0")}.json`, JSON.stringify({
        schema_version: "1.0", page, project_id: input.project_id, request_id: input.request_id,
        snapshot_id: "snapshot-empty-prefix", entries: [], gaps: [staleGap]
      }));
    }
    const port: NavigationInventoryPort = { ...inv.port, verificationIncludesPhysicalIntegrity: true };
    let freshVerifyCalls = 0;
    port.verifyEntry = async (_entry, slice) => { freshVerifyCalls += 1; slice.beforeHttp(); return true; };
    port.listPage = async ({ budget: slice }) => {
      slice.beforeHttp();
      return {
        entries: [inv.entry],
        verified_entries: [{ resource_id: inv.entry.resource_id, entry_hash: await executionHash(inv.entry), persisted: true }],
        gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null
      };
    };
    const engine = new ZoneNavigationEngine(harness.runtime, port);
    const result = await engine.reconcile(input, project, await admissionFor(input), budget(512));

    expect(result.status).toBe("finalized");
    expect(freshVerifyCalls).toBe(1);
    const saved = JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content);
    expect(saved.coverage_gaps).toEqual([]);
    expect(harness.files.get(`${seeded.root}/navigation/generated-index.md`)?.content).not.toContain("## Coverage gaps");
    expect(JSON.parse(harness.files.get(`${seeded.root}/navigation/snapshot/00000000.json`)!.content).gaps).toEqual([staleGap]);
  });

  it("does not let an old persisted catalog proof clear a gap when fresh verification fails", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request("REVIEW");
    const inv = await inventoryHarness(project, "REVIEW");
    inv.entry.resource_id = `head:${inv.entry.resource_id}`;
    const staleGap = { resource_id: inv.entry.resource_id, code: "active_version_provider_mismatch" };
    const seeded = await seedAdoptingProgress(harness, input, 1, "dirty:");
    const progress = seeded.progress as Omit<typeof seeded.progress, "coverage_gaps"> & {
      coverage_gaps: { resource_id: string; code: string }[];
    };
    progress.coverage_gaps = [staleGap];
    harness.put(`${seeded.root}/navigation-progress.json`, JSON.stringify(progress));
    harness.put(`${seeded.root}/navigation/snapshot/00000000.json`, JSON.stringify({
      schema_version: "1.0", page: 0, project_id: input.project_id, request_id: input.request_id,
      snapshot_id: "snapshot-empty-prefix", entries: [], gaps: [staleGap]
    }));
    const port: NavigationInventoryPort = { ...inv.port, verificationIncludesPhysicalIntegrity: true };
    let freshVerifyCalls = 0;
    port.verifyEntry = async (_entry, slice) => { freshVerifyCalls += 1; slice.beforeHttp(); return false; };
    port.listPage = async ({ budget: slice }) => {
      slice.beforeHttp();
      return {
        entries: [inv.entry],
        verified_entries: [{ resource_id: inv.entry.resource_id, entry_hash: await executionHash(inv.entry), persisted: true }],
        gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null
      };
    };

    const result = await new ZoneNavigationEngine(harness.runtime, port)
      .reconcile(input, project, await admissionFor(input), budget(512));

    expect(freshVerifyCalls).toBe(1);
    expect(result).toEqual({ status: "conflict", code: "navigation_source_changed" });
    expect(JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content).coverage_gaps).toEqual([staleGap]);
    expect(harness.files.has(`${seeded.root}/navigation/generated-index.md`)).toBe(false);
  });

  it("checkpoints a verified singleton page only once when advancing to the next page", async () => {
    const h = runtimeHarness();
    const project = state();
    const input = request();
    const inv = await inventoryHarness(project);
    seedTarget(h, inv);
    const seeded = await seedAdoptingProgress(h, input, 1, "next", inv.entry);
    const progressPath = `${seeded.root}/navigation-progress.json`;
    const progress = JSON.parse(h.files.get(progressPath)!.content);
    progress.inventory_complete = true;
    progress.cursor = null;
    h.put(progressPath, JSON.stringify(progress));
    const pagePath = `${seeded.root}/navigation/snapshot/00000000.json`;
    const page = JSON.parse(h.files.get(pagePath)!.content);
    page.verified_entries = [{ resource_id: inv.entry.resource_id, entry_hash: await executionHash(inv.entry), persisted: true }];
    h.put(pagePath, JSON.stringify(page));
    const port: NavigationInventoryPort = { ...inv.port, verificationIncludesPhysicalIntegrity: true };
    let progressWrites = 0;
    const originalWrite = h.runtime.conditionalWrite.writeTextConditional.bind(h.runtime.conditionalWrite);
    h.runtime.conditionalWrite.writeTextConditional = async (path, content, token) => {
      if (path === progressPath && JSON.parse(content).status === "adopting") progressWrites += 1;
      return originalWrite(path, content, token);
    };
    await new ZoneNavigationEngine(h.runtime, port).reconcile(input, project, await admissionFor(input), budget(20));
    const saved = JSON.parse(h.files.get(progressPath)!.content);
    expect(saved).toMatchObject({ verify_page: 1, verify_entry: 0 });
    expect(progressWrites).toBe(1);
  });

  it("verifies two proven singleton pages within a realistic compact-catalog slice", async () => {
    const h = runtimeHarness();
    const project = state();
    const input = request();
    const inv = await inventoryHarness(project);
    const second = { ...inv.entry, resource_id: "head:DOC-222222222222222222222222" };
    const seeded = await seedAdoptingProgress(h, input, 2, "next", inv.entry);
    const progressPath = `${seeded.root}/navigation-progress.json`;
    const progress = JSON.parse(h.files.get(progressPath)!.content);
    progress.inventory_complete = true;
    progress.cursor = null;
    progress.source_count = 2;
    progress.source_ids = [inv.entry.resource_id, second.resource_id];
    h.put(progressPath, JSON.stringify(progress));
    for (const [index, entry] of [inv.entry, second].entries()) {
      const pagePath = `${seeded.root}/navigation/snapshot/${index.toString().padStart(8, "0")}.json`;
      const page = JSON.parse(h.files.get(pagePath)!.content);
      page.entries = [entry];
      page.verified_entries = [{ resource_id: entry.resource_id, entry_hash: await executionHash(entry), persisted: false }];
      h.put(pagePath, JSON.stringify(page));
    }
    const port: NavigationInventoryPort = { ...inv.port, verificationIncludesPhysicalIntegrity: true };
    port.recordVerifiedEntry = async (_entry, _snapshot, slice) => {
      for (let call = 0; call < 8; call++) slice.beforeHttp();
    };
    await new ZoneNavigationEngine(h.runtime, port).reconcile(input, project, await admissionFor(input), budget(28));
    expect(JSON.parse(h.files.get(progressPath)!.content)).toMatchObject({ verify_page: 2, verify_entry: 0 });
  });

  it("advances a persisted legacy artifact cursor across several provider entries in one engine slice", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request();
    const admission = await admissionFor(input);
    const journal = new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id);
    await journal.commit(admission, null);

    const artifactsRoot = machineMutationIntentPath(input.project_id, "ART-NAV-LEGACY-0000").replace(/\/[^/]+$/, "");
    const artifactIds = Array.from({ length: 20 }, (_, index) => `ART-NAV-LEGACY-${String(index).padStart(4, "0")}`);
    for (const requestId of artifactIds) {
      const content = `artifact ${requestId}`;
      const contentHash = await sha256Text(content);
      const requestBody = { request_id: requestId, project_id: input.project_id, relative_path: "report.md", content,
        content_sha256: contentHash, mode: "create" as const };
      const requestJson = JSON.stringify(requestBody);
      await new MutationGateRepository(harness.runtime).ensureArtifactIntent({
        schema_version: "1.0", intent_id: await mutationIntentIdFor(input.project_id, requestId), project_id: input.project_id,
        kind: "artifact", request_id: requestId, request_sha256: await sha256Text(requestJson), request_json: requestJson,
        base_project_revision: 0, destination_path: `${workspaceProjectRoot(input.project_id, project.slug)}/REVIEW/${requestId}.md`,
        provider_precondition: { kind: "absent", provider_id: "dropbox" }, expected_content_sha256: contentHash,
        mode: "create", recorded_at: at
      });
    }
    const firstProviderEntry = `${artifactsRoot}/${artifactIds[0]}.json`;
    const { root, progress } = await seedAdoptingProgress(harness, input, 0, `artifacts:${encodeURIComponent(firstProviderEntry)}`);
    progress.snapshot_id = "source:0";
    harness.put(`${root}/navigation-progress.json`, JSON.stringify(progress));
    const initialArtifactPageCount = harness.listingCalls.filter((call) => call.path === artifactsRoot).length;

    const result = await new ZoneNavigationEngine(harness.runtime,
      new ZoneNavigationInventory(harness.runtime, new ZoneNavigationSources(harness.runtime)))
      .reconcile(input, project, admission, budget(32));
    const saved = JSON.parse(harness.files.get(`${root}/navigation-progress.json`)!.content) as { cursor: string | null; page_count: number };
    const artifactPageCalls = harness.listingCalls.filter((call) => call.path === artifactsRoot).length - initialArtifactPageCount;
    expect(result.status).toBe("pending");
    expect(artifactPageCalls, JSON.stringify({ result, saved, listing: harness.listingCalls })).toBe(7);
    expect(saved.cursor).not.toBe(`artifacts:${encodeURIComponent(firstProviderEntry)}`);
    expect(saved.page_count).toBe(1);
    expect(saved.page_count).toBeLessThan(artifactPageCalls);
  });

  it("uses final artifact byte-integrity proof instead of a third physical reread", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request();
    const admission = await admissionFor(input);
    const journal = new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id);
    await journal.commit(admission, null);
    const requestId = "ART-NAV-ENGINE-IN-ZONE-0001";
    const content = "approved current artifact";
    const contentHash = await sha256Text(content);
    const artifactRequest = { request_id: requestId, project_id: input.project_id, relative_path: "current.md", content,
      content_sha256: contentHash, mode: "create" as const };
    const requestJson = JSON.stringify(artifactRequest);
    const destination = `${workspaceProjectRoot(input.project_id, project.slug)}/WORKING/current.md`;
    await new MutationGateRepository(harness.runtime).ensureArtifactIntent({
      schema_version: "1.0", intent_id: await mutationIntentIdFor(input.project_id, requestId), project_id: input.project_id,
      kind: "artifact", request_id: requestId, request_sha256: await sha256Text(requestJson), request_json: requestJson,
      base_project_revision: 0, destination_path: destination, provider_precondition: { kind: "absent", provider_id: "dropbox" },
      expected_content_sha256: contentHash, mode: "create", recorded_at: at
    });
    harness.put(destination, content);
    harness.put(machineArtifactReceiptPath(requestId), JSON.stringify({ request_id: requestId, project_id: input.project_id,
      relative_path: "current.md", content_sha256: contentHash, status: "committed" }));
    const artifactByteReads = vi.spyOn(harness.runtime.objects, "readBytes");
    const { root, progress } = await seedAdoptingProgress(harness, input, 0, "artifacts:");
    progress.snapshot_id = "source:0";
    harness.put(`${root}/navigation-progress.json`, JSON.stringify(progress));
    const inventory = new ZoneNavigationInventory(harness.runtime, new ZoneNavigationSources(harness.runtime));
    const verifyEntry = vi.spyOn(inventory, "verifyEntry");

    const result = await new ZoneNavigationEngine(harness.runtime, inventory)
      .reconcile(input, project, admission, budget(256), { deferPublication: true });

    expect(result.status).toBe("prepared");
    expect(verifyEntry).not.toHaveBeenCalled();
    expect(artifactByteReads.mock.calls.filter(([path]) => path === destination)).toHaveLength(1);
    const artifactPage = [...harness.files.entries()]
      .filter(([path]) => path.startsWith(`${root}/navigation/snapshot/`))
      .map(([, file]) => JSON.parse(file.content) as { entries?: NavigationInventoryEntry[]; verified_entries?: unknown[] })
      .find((page) => page.entries?.some((entry) => entry.resource_id.startsWith("artifact:")));
    expect(artifactPage?.verified_entries).toHaveLength(1);
  });

  it("replays an exact orphan snapshot without retroactively adding its new integrity proof", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request();
    const admission = await admissionFor(input);
    await new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id).commit(admission, null);
    const requestId = "ART-NAV-ENGINE-ORPHAN-0001";
    const content = "approved current artifact";
    const contentHash = await sha256Text(content);
    const artifactRequest = { request_id: requestId, project_id: input.project_id, relative_path: "orphan.md", content,
      content_sha256: contentHash, mode: "create" as const };
    const requestJson = JSON.stringify(artifactRequest);
    const destination = `${workspaceProjectRoot(input.project_id, project.slug)}/WORKING/orphan.md`;
    await new MutationGateRepository(harness.runtime).ensureArtifactIntent({
      schema_version: "1.0", intent_id: await mutationIntentIdFor(input.project_id, requestId), project_id: input.project_id,
      kind: "artifact", request_id: requestId, request_sha256: await sha256Text(requestJson), request_json: requestJson,
      base_project_revision: 0, destination_path: destination, provider_precondition: { kind: "absent", provider_id: "dropbox" },
      expected_content_sha256: contentHash, mode: "create", recorded_at: at
    });
    harness.put(destination, content);
    harness.put(machineArtifactReceiptPath(requestId), JSON.stringify({ request_id: requestId, project_id: input.project_id,
      relative_path: "orphan.md", content_sha256: contentHash, status: "committed" }));
    const inventory = new ZoneNavigationInventory(harness.runtime, new ZoneNavigationSources(harness.runtime));
    let orphanCursor = "artifacts:";
    let orphan = await inventory.listPage({ project_id: input.project_id, zone: "WORKING", cursor: orphanCursor, limit: 24, budget: budget(256) });
    for (let page = 0; orphan.entries.length === 0 && orphan.next_cursor !== null && page < 8; page++) {
      orphanCursor = orphan.next_cursor;
      orphan = await inventory.listPage({ project_id: input.project_id, zone: "WORKING", cursor: orphanCursor, limit: 24, budget: budget(256) });
    }
    expect(orphan.verified_entries, JSON.stringify(orphan)).toHaveLength(1);
    const { root, progress } = await seedAdoptingProgress(harness, input, 0, orphanCursor);
    progress.snapshot_id = "source:0";
    harness.put(`${root}/navigation-progress.json`, JSON.stringify(progress));
    harness.put(`${root}/navigation/snapshot/00000000.json`, JSON.stringify({ schema_version: "1.0", page: 0,
      project_id: input.project_id, request_id: input.request_id, snapshot_id: orphan.snapshot_id,
      entries: orphan.entries, gaps: orphan.gaps }));
    const verifyEntryPage = vi.spyOn(inventory, "verifyEntryPage");

    const result = await new ZoneNavigationEngine(harness.runtime, inventory)
      .reconcile(input, project, admission, budget(256), { deferPublication: true });

    expect(result.status, JSON.stringify(result)).toBe("prepared");
    expect(verifyEntryPage).toHaveBeenCalledTimes(1);
    const replayed = JSON.parse(harness.files.get(`${root}/navigation/snapshot/00000000.json`)!.content) as { verified_entries?: unknown[] };
    expect(replayed.verified_entries).toBeUndefined();
  });

  it("prepares a verified generation without publishing any visible index or head", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = request();
    const inventory = await inventoryHarness(project);
    seedTarget(harness, inventory);
    const admission = await admissionFor(input);
    await new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id).commit(admission, null);

    const result = await new ZoneNavigationEngine(harness.runtime, inventory.port)
      .reconcile(input, project, admission, budget(), { deferPublication: true });

    expect(result).toMatchObject({ status: "prepared", source_snapshot_id: "snapshot-1" });
    expect(harness.files.has(`${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`)).toBe(false);
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
  });

  it("finalizes an immutable historical receipt after a newer navigation generation replaces the head", async () => {
    const harness = runtimeHarness();
    const project = state();
    const firstInput = request();
    const firstInventory = await inventoryHarness(project);
    seedTarget(harness, firstInventory);
    const firstAdmission = await admissionFor(firstInput);
    const firstJournal = new ExecutionJournal(harness.runtime, project.project_id, "document", firstInput.request_id);
    await firstJournal.commit(firstAdmission, null);
    const firstResult = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, firstInventory.port), firstInput, project, firstAdmission);
    expect(firstResult.status).toBe("finalized");
    if (firstResult.status !== "finalized") throw new Error("first_navigation_not_finalized");

    const secondInput = navigationReconcileSchema.parse({ ...firstInput, request_id: "DOCREQ-NAVIGATION-WORKING-0002", expected_generation: 1, expected_index: firstResult.receipt.index });
    const secondInventory = await inventoryHarness(project);
    seedTarget(harness, secondInventory);
    const secondAdmission = await admissionFor(secondInput);
    const secondJournal = new ExecutionJournal(harness.runtime, project.project_id, "document", secondInput.request_id);
    await secondJournal.commit(secondAdmission, null);
    const secondResult = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, secondInventory.port), secondInput, project, secondAdmission);
    expect(secondResult.status).toBe("finalized");
    if (secondResult.status !== "finalized") throw new Error("second_navigation_not_finalized");

    const receiptRef = `${machineDocumentRoot(project.project_id)}/requests/${firstInput.request_id}/receipt.json`;
    await firstJournal.recordReceipt("committed", receiptRef);
    const finalized = await firstJournal.finalizeVerifiedNavigation({ receipt_ref: receiptRef, receipt: firstResult.receipt });
    expect(finalized).toMatchObject({ status: "finalized", terminal: true });
    const currentHead = JSON.parse(harness.files.get(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)!.content);
    expect(currentHead).toMatchObject({ generation: 2, source_request_id: secondInput.request_id });
    await harness.runtime.objects.delete(`${await firstJournal.root()}/progress.json`);
    await expect(firstJournal.commit(firstAdmission, null)).rejects.toThrow("execution_progress_unavailable");
  });

  it("does not certify a catalog rebuild from a receipt and certificate alone", async () => {
    const harness = runtimeHarness();
    const project = state();
    const input = navigationReconcileSchema.parse({
      ...request("REVIEW"), purpose: "compact_catalog_rebuild",
      expected_source_generation: 0,
      expected_catalog_manifest: { object_id: "id:old", revision_token: "rev-old", content_sha256: "a".repeat(64) }
    });
    const journal = new ExecutionJournal(harness.runtime, project.project_id, "document", input.request_id);
    const admission = await admissionFor(input);
    await journal.commit(admission, null);
    const receiptRef = `${machineDocumentRoot(project.project_id)}/requests/${input.request_id}/receipt.json`;
    await journal.recordReceipt("committed", receiptRef);
    const certificateRef = `${await journal.root()}/navigation/catalog-rebuild/finalizations/${admission.request_hash}.json`;
    const certificate = {
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: project.project_id,
      request_id: input.request_id, request_hash: admission.request_hash, zone: "REVIEW",
      source_generation: 0, source_snapshot_id: "source:0", source_count: 0,
      shards: [], expected_manifest: input.expected_catalog_manifest,
      published_manifest: { object_id: "id:new", revision_token: "rev-new", content_sha256: "b".repeat(64) },
      chunk_evidence: [], coverage_gaps: []
    };
    harness.put(certificateRef, canonicalJson(certificate));

    await expect(journal.finalizeVerifiedCatalogRebuild({ receipt_ref: receiptRef, certificate_ref: certificateRef }))
      .rejects.toThrow("execution_catalog_rebuild_progress_unavailable");
    expect((await journal.status())?.terminal).toBe(false);

    const engineProgress = {
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: project.project_id,
      request_id: input.request_id, request_hash: admission.request_hash, zone: "REVIEW",
      source_generation: 0, source_snapshot_id: "source:0", cursor: null, page_count: 0,
      source_count: 0, shard_cursor: 0, shard_count: 0, status: "finalized",
      finalization_ref: certificateRef, coverage_gaps: []
    };
    harness.put(`${await journal.root()}/navigation-catalog-rebuild-progress.json`, canonicalJson(navigationCatalogRebuildProgressSchema.parse(engineProgress)));
    const finalized = await journal.finalizeVerifiedCatalogRebuild({ receipt_ref: receiptRef, certificate_ref: certificateRef });
    expect(finalized).toMatchObject({ status: "finalized", terminal: true });
  });

  it("keeps legacy rebuild progress resumable while validating the sparse staging page index", () => {
    const legacy = {
      schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: "PRJ-0002",
      request_id: "DOCREQ-NAV-CATALOG-REBUILD-0001", request_hash: "a".repeat(64), zone: "REVIEW",
      source_generation: 0, source_snapshot_id: "source:0", cursor: null, page_count: 3,
      source_count: 1, source_ids: ["DOC-0123456789ABCDEF01234567"], shard_cursor: 0, shard_count: 1,
      stage_page: 1, staging_entries: [], staged_shards: [], status: "staging", finalization_ref: null, coverage_gaps: []
    };

    const parsedLegacy = navigationCatalogRebuildProgressSchema.parse(legacy);
    expect(parsedLegacy).toMatchObject({ staging_index_page: null, staging_page_index: [], staging_index_complete: false });
    expect(navigationCatalogRebuildProgressSchema.safeParse({
      ...legacy, staging_index_page: null, staging_page_index: [{ shard: 8, pages: [0, 2] }], staging_index_complete: true
    }).success).toBe(true);
    expect(navigationCatalogRebuildProgressSchema.safeParse({
      ...legacy, staging_index_page: null, staging_page_index: [{ shard: 8, pages: [2, 0] }], staging_index_complete: true
    }).success).toBe(false);
  });

  it("builds and resumes the sparse staging index from legacy progress before staging shards", async () => {
    const { result, initial, checkpoint, snapshotReads, stagedShards } = await runSparseCatalogRebuildWithLegacyProgress();

    expect(initial).toMatchObject({ status: "pending", cursor: "stage-index:1" });
    expect(checkpoint).toMatchObject({ staging_index_page: 1, staging_index_complete: false, staging_page_index: [{ shard: expect.any(Number), pages: [0] }] });
    expect(result).toMatchObject({ status: "prepared", source_count: 2, shard_count: 2 });
    expect(stagedShards).toHaveLength(2);
    expect(snapshotReads).toHaveLength(6);
  });

  it("rejects a sparse index that omits a source ID before writing its shard", async () => {
    const { result, stagedShards } = await runSparseCatalogRebuildWithLegacyProgress(true);

    expect(result).toMatchObject({ status: "conflict", code: "navigation_catalog_rebuild_staging_source_set_mismatch" });
    expect(stagedShards).toEqual([]);
  });

  it("rejects unknown public fields and non-exact index identities", () => {
    const input = { ...request(), renderer: "client-controlled" };
    expect(navigationReconcileSchema.safeParse(input).success).toBe(false);
    expect(navigationReconcileSchema.safeParse({ ...request(), expected_index: { basename: "../STATE.md", object_id: "id:x", revision_token: "rev", content_sha256: "a".repeat(64) } }).success).toBe(false);
  });

  it("preserves exact legacy index bytes before adopting the zone index", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT-INDEX.md`;
    const legacy = "# Human-maintained index\r\nKeep the original bytes.\r\n";
    const identity = await seedIndex(harness, indexPath, legacy);
    const input = request("WORKING", identity);
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    const archived = [...harness.files.entries()].find(([path]) => path.includes("/ARCHIVES/NAVIGATION/WORKING/") && path.endsWith(".md"));
    expect(archived?.[1].content).toBe(legacy);
    expect(harness.files.get(indexPath)?.content).not.toBe(legacy);
  });

  it("recovers when intention creation succeeds but progress creation is interrupted", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    harness.failNextCreate((path) => path.endsWith("/navigation-progress.json"));
    await expect(engine.reconcile(input, project, await admissionFor(input), budget())).rejects.toThrow("injected create interruption");

    const resumed = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(resumed.status, JSON.stringify(resumed)).toBe("finalized");
  });

  it("journals a post-execution denial after index publication without finalizing the head", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const input = request();
    const admission = await admissionFor(input);
    admission.deferred_rules = [{ rule_id: "RULE-NAV-001", version: 1, scope: { kind: "project", project_id: project.project_id } }];
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port, {
      run: async ({ budget: slice }) => { slice.beforeHttp(); return { verdict: "deny", evidence_refs: [] }; }
    });
    const result = await reconcileUntilTerminal(engine, input, project, admission);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_postcheck_denied" });
    expect(harness.files.get(indexPath)?.content).toContain("# WORKING navigation");
    expect([...harness.files.keys()].some((path) => path.endsWith("/documents/navigation/WORKING/head.json"))).toBe(false);
    const progress = [...harness.files.entries()].find(([path]) => path.endsWith("/navigation-progress.json"))?.[1].content;
    expect(progress).toBeDefined();
    expect(JSON.parse(progress!)).toMatchObject({ status: "conflict", published_index: { basename: "00-CURRENT.md" }, postchecks: [{ verdict: "deny" }] });
  });

  it("does not publish the navigation head when a source changes after the first snapshot check", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    let snapshotChecks = 0;
    const port: NavigationInventoryPort = {
      ...inv.port,
      verifySnapshot: async ({ budget: slice }) => {
        slice.beforeHttp();
        snapshotChecks += 1;
        return snapshotChecks === 1;
      }
    };
    const input = request();
    const result = await new ZoneNavigationEngine(harness.runtime, port).reconcile(input, project, await admissionFor(input), budget(128));
    expect(result).toMatchObject({ status: "conflict", code: "navigation_snapshot_changed" });
    expect(snapshotChecks).toBe(2);
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
  });

  it("resumes an unavailable postcheck against the already-published index", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const admission = await admissionFor(input);
    admission.deferred_rules = [{ rule_id: "RULE-NAV-002", version: 1, scope: { kind: "project", project_id: project.project_id } }];
    let attempts = 0;
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port, {
      run: async ({ budget: slice }) => {
        slice.beforeHttp();
        attempts++;
        return attempts === 1 ? { verdict: "unavailable", evidence_refs: [] } : { verdict: "allow", evidence_refs: ["server-check:evidence-1"] };
      }
    });
    const first = await engine.reconcile(input, project, admission, budget(128));
    expect(first).toMatchObject({ status: "conflict", code: "navigation_postcheck_unavailable" });
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const firstIndex = harness.files.get(indexPath);
    expect(firstIndex?.content).toContain("# WORKING navigation");
    const progress = [...harness.files.entries()].find(([path]) => path.endsWith("/navigation-progress.json"))?.[1].content;
    expect(JSON.parse(progress!)).toMatchObject({ status: "conflict", published_index: { basename: "00-CURRENT.md" }, postchecks: [{ verdict: "unavailable" }] });

    const resumed = await reconcileUntilTerminal(engine, input, project, admission);
    expect(resumed.status).toBe("finalized");
    expect(attempts).toBe(2);
    expect(harness.files.get(indexPath)?.objectId).toBe(firstIndex?.objectId);
    expect(harness.files.get(indexPath)?.revisionToken).toBe(firstIndex?.revisionToken);
  });

  it("finalizes valid_links only with provider evidence for the published index and every target", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const { admission, rule } = withDeferredValidLinks(await admissionFor(input));

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port, undefined, [rule]), input, project, admission);

    expect(result.status).toBe("finalized");
    const progressPath = [...harness.files.keys()].find((path) => path.endsWith("/navigation-progress.json"))!;
    const progress = JSON.parse(harness.files.get(progressPath)!.content);
    expect(progress.postchecks).toEqual([expect.objectContaining({
      check_id: requiredRulePostchecks(admission)[0],
      verdict: "allow",
      evidence_refs: [expect.stringContaining("/observations/")]
    })]);
    const evidence = JSON.parse(harness.files.get(progress.postchecks[0].evidence_refs[0])!.content);
    expect(evidence).toMatchObject({
      check_id: "valid_links",
      index: { object_id: expect.any(String), revision_token: expect.any(String), content_sha256: expect.any(String) },
      target_evidence_refs: [expect.stringContaining("/observations/navigation-valid-links-target-")]
    });
    const targetEvidence = JSON.parse(harness.files.get(evidence.target_evidence_refs[0])!.content);
    expect(targetEvidence.target).toMatchObject({ resource_id: inv.entry.resource_id, object_id: inv.entry.expected.object_id, revision_token: inv.entry.expected.revision_token, content_sha256: inv.entry.expected.content_sha256 });
  });

  it("does not finalize valid_links when a generated target is physically missing", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const { admission, rule } = withDeferredValidLinks(await admissionFor(input));
    const createText = harness.runtime.objects.createText;
    harness.runtime.objects.createText = async (path, content) => {
      await createText(path, content);
      if (path.endsWith("/WORKING/00-CURRENT.md")) harness.files.delete(inv.targetPath);
    };

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port, undefined, [rule]), input, project, admission);

    expect(result).toMatchObject({ status: "conflict", code: "navigation_postcheck_denied" });
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
    const progressPath = [...harness.files.keys()].find((path) => path.endsWith("/navigation-progress.json"))!;
    expect(JSON.parse(harness.files.get(progressPath)!.content).postchecks).toEqual([
      expect.objectContaining({ check_id: requiredRulePostchecks(admission)[0], verdict: "deny" })
    ]);
  });

  it("denies valid_links when a target identity changes after the index is published", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const { admission, rule } = withDeferredValidLinks(await admissionFor(input));
    const createText = harness.runtime.objects.createText;
    harness.runtime.objects.createText = async (path, content) => {
      await createText(path, content);
      if (path.endsWith("/WORKING/00-CURRENT.md")) harness.put(inv.targetPath, "Changed after publication\n", "id:target");
    };

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port, undefined, [rule]), input, project, admission);

    expect(result).toMatchObject({ status: "conflict", code: "navigation_postcheck_denied" });
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
  });

  it("leaves navigation unfinalized when a target provider read is unavailable", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const { admission, rule } = withDeferredValidLinks(await admissionFor(input));
    const createText = harness.runtime.objects.createText;
    const getMetadata = harness.runtime.objects.getMetadata;
    let indexPublished = false;
    harness.runtime.objects.createText = async (path, content) => {
      await createText(path, content);
      if (path.endsWith("/WORKING/00-CURRENT.md")) indexPublished = true;
    };
    harness.runtime.objects.getMetadata = async (path) => {
      if (indexPublished && path === inv.targetPath) throw new Error("provider temporarily unavailable");
      return getMetadata(path);
    };

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port, undefined, [rule]), input, project, admission);

    expect(result).toMatchObject({ status: "conflict", code: "navigation_postcheck_unavailable" });
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
  });

  it("creates no navigation intent for an unsupported deferred check", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    const input = request();
    const admission = await admissionFor(input);
    admission.deferred_rules = [{ rule_id: "RULE-NAV-UNSUPPORTED-01", version: 1, scope: { kind: "global" } }];

    const result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, admission, budget());

    expect(result).toMatchObject({ status: "conflict", code: "navigation_postchecks_unavailable" });
    expect([...harness.files.keys()].some((path) => path.endsWith("/navigation-intention.json"))).toBe(false);
    expect([...harness.files.keys()].some((path) => path.endsWith("/admission.json"))).toBe(false);
  });

  it("allows preparation to defer the qualified navigation postcheck until ProjectGuard publication", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const { admission } = withDeferredValidLinks(await admissionFor(input));

    const result = await new ZoneNavigationEngine(harness.runtime, inv.port)
      .reconcile(input, project, admission, budget(128), { deferPublication: true });

    expect(result).toMatchObject({ status: "prepared", source_snapshot_id: "snapshot-1" });
    const progress = [...harness.files.entries()].find(([path]) => path.endsWith("/navigation-progress.json"))?.[1].content;
    expect(JSON.parse(progress!).postchecks).toEqual([]);
  });

  it.each([
    { mutate: false },
    { mutate: true }
  ])("never reuses a target proof persisted by an earlier valid_links slice: mutate=$mutate", async ({ mutate }) => {
    const harness = runtimeHarness();
    const project = state();
    const input = request();
    const contents = ["Target 0\n"];
    const entries: NavigationInventoryEntry[] = await Promise.all(contents.map(async (content, index) => ({
      project_id: project.project_id,
      zone: "WORKING",
      resource_id: `DOC-${String(index).padStart(24, "0")}`,
      version: `VER-${String(index).padStart(24, "0")}`,
      logical_path: `plans/target-${index}.md`,
      path: `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/plans/target-${index}.md`,
      expected: { object_id: `id:target-${index}`, revision_token: `rev-target-${index}`, content_sha256: await sha256Text(content), size: new TextEncoder().encode(content).byteLength }
    })));
    const inv = await inventoryHarness(project, "WORKING", { pages: [entries] });
    inv.port.listPage = async ({ budget: slice }) => { slice.beforeHttp(); return { entries, gaps: [], snapshot_id: "snapshot-1", next_cursor: null }; };
    inv.port.verifyEntry = async (_entry, slice) => { slice.beforeHttp(); return true; };
    for (const [index, entry] of entries.entries()) {
      const identity = harness.put(entry.path, contents[index], entry.expected.object_id);
      entry.expected.object_id = identity.objectId!;
      entry.expected.revision_token = identity.revisionToken!;
    }
    const { admission, rule } = withDeferredValidLinks(await admissionFor(input));
    const metadata = harness.runtime.objects.getMetadata;
    const readBytes = harness.runtime.objects.readBytes!;
    const originalCreate = harness.runtime.objects.createText;
    const originalConditionalWrite = harness.runtime.conditionalWrite.writeTextConditional;
    let indexPublished = false;
    let interrupted = false;
    const postcheckMetadataReads = new Map<string, number>();
    const postcheckByteReads = new Map<string, number>();
    harness.runtime.objects.createText = async (path, content) => {
      await originalCreate(path, content);
      if (path.endsWith("/WORKING/00-CURRENT.md")) indexPublished = true;
    };
    harness.runtime.objects.getMetadata = async (path) => {
      if (indexPublished && entries.some((entry) => entry.path === path)) postcheckMetadataReads.set(path, (postcheckMetadataReads.get(path) ?? 0) + 1);
      return metadata(path);
    };
    harness.runtime.objects.readBytes = async (path, maxBytes) => {
      if (indexPublished && entries.some((entry) => entry.path === path)) postcheckByteReads.set(path, (postcheckByteReads.get(path) ?? 0) + 1);
      return readBytes(path, maxBytes);
    };
    harness.runtime.conditionalWrite.writeTextConditional = async (path, content, expectedToken) => {
      if (!interrupted && path.endsWith("/navigation-progress.json")
        && JSON.parse(content).valid_links_work?.verified_count === 1) {
        interrupted = true;
        throw new Error("slice_budget_exhausted");
      }
      return originalConditionalWrite(path, content, expectedToken);
    };

    const engine = new ZoneNavigationEngine(harness.runtime, inv.port, undefined, [rule]);
    let result = await engine.reconcile(input, project, admission, budget(32));
    for (let attempt = 0; result.status === "pending" && !interrupted && attempt < 12; attempt++) {
      result = await engine.reconcile(input, project, admission, budget(32));
    }
    expect(interrupted).toBe(true);
    expect(result.status).toBe("pending");
    if (mutate) harness.put(entries[0].path, "Changed after the persisted target proof\n", entries[0].expected.object_id);
    result = await reconcileUntilTerminal(engine, input, project, admission, 32);

    expect(result, JSON.stringify({ result, postcheckMetadataReads: [...postcheckMetadataReads], postcheckByteReads: [...postcheckByteReads] }))
      .toMatchObject({ status: "conflict", code: "navigation_postcheck_unavailable" });
    expect(harness.files.has(`${machineDocumentRoot(project.project_id)}/navigation/WORKING/head.json`)).toBe(false);
  });

  it("rejects an overlapping inventory page instead of duplicating a source", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const duplicate = { ...inv.entry, version: "VER-OTHER" };
    const port: NavigationInventoryPort = {
      listPage: async ({ cursor, budget: slice }) => {
        slice.beforeHttp();
        return cursor === null
          ? { entries: [inv.entry], gaps: [], snapshot_id: "overlap-snapshot", next_cursor: "next" }
          : { entries: [duplicate], gaps: [], snapshot_id: "overlap-snapshot", next_cursor: null };
      },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return true; }
    };
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, port), input, project, await admissionFor(input));
    expect(result).toMatchObject({ status: "conflict", code: "navigation_duplicate_source" });
    expect(harness.files.has(`${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`)).toBe(false);
  });

  it("makes a stalled provider listing a terminal navigation conflict without publishing an index", async () => {
    const h = runtimeHarness();
    const input = request();
    const inv = await inventoryHarness();
    inv.port.listPage = async () => { throw new Error("navigation_listing_stalled"); };
    const result = await new ZoneNavigationEngine(h.runtime, inv.port).reconcile(input, state(), await admissionFor(input), budget());
    expect(result).toMatchObject({ status: "conflict", code: "navigation_listing_stalled" });
    expect(h.files.has(`${workspaceProjectRoot(input.project_id, "project-os")}/WORKING/00-CURRENT.md`)).toBe(false);
  });

  it("archives a BOM-prefixed legacy index byte-for-byte", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT-INDEX.md`;
    const legacyBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# Legacy index\r\nPreserve exact bytes.\r\n")]);
    const metadata = harness.putBytes(indexPath, legacyBytes, "id:index");
    const input = request("WORKING", {
      basename: "00-CURRENT-INDEX.md",
      object_id: metadata.objectId!,
      revision_token: metadata.revisionToken!,
      content_sha256: await sha256Bytes(legacyBytes)
    });
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, await admissionFor(input));
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    const archivedPath = [...harness.files.keys()].find((path) => path.includes("/ARCHIVES/NAVIGATION/WORKING/") && path.endsWith(".md"));
    expect(archivedPath).toBeDefined();
    expect(harness.files.get(archivedPath!)?.content).toBe("\uFEFF# Legacy index\r\nPreserve exact bytes.\r\n");
  });

  it("stores independent navigation identity and generation for each zone", async () => {
    const harness = runtimeHarness();
    const project = state();
    const paths: string[] = [];
    for (const zone of ["WORKING", "REVIEW", "DELIVERABLES"] as const) {
      const inv = await inventoryHarness(project, zone);
      seedTarget(harness, inv);
      const input = request(zone);
      const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
      const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
      expect(result.status, JSON.stringify(result)).toBe("finalized");
      if (result.status !== "finalized") throw new Error("expected finalized navigation");
      paths.push(result.receipt.head_ref);
    }
    expect(new Set(paths).size).toBe(3);
  });

  it("does not overwrite an index changed after its observed identity", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const identity = await seedIndex(harness, indexPath, "# Original\n");
    const input = request("WORKING", identity);
    const originalConditionalWrite = harness.runtime.conditionalWrite.writeTextConditional;
    harness.runtime.conditionalWrite.writeTextConditional = async () => {
      harness.put(indexPath, "# External edit\n", "id:index");
      return originalConditionalWrite(indexPath, "# Generated\n", identity.revision_token);
    };
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status).toBe("conflict");
    expect(harness.files.get(indexPath)?.content).toBe("# External edit\n");
  });

  it("refuses ambiguous legacy and current index names", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const root = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING`;
    const identity = await seedIndex(harness, `${root}/00-CURRENT-INDEX.md`, "# Legacy\n");
    harness.put(`${root}/00-CURRENT.md`, "# Current\n", "id:other-index");
    const input = request("WORKING", identity);
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status).toBe("conflict");
    expect(harness.files.get(`${root}/00-CURRENT-INDEX.md`)?.content).toBe("# Legacy\n");
    expect(harness.files.get(`${root}/00-CURRENT.md`)?.content).toBe("# Current\n");
  });

  it("does not finalize when a canonical target is missing or snapshot changed", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project, "WORKING", { missing: true });
    const input = request();
    const result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, await admissionFor(input), budget());
    expect(result.status).toBe("conflict");
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    expect(harness.files.has(indexPath)).toBe(false);
  });

  it("verifies binary targets from bytes without decoding them as text", async () => {
    const harness = runtimeHarness();
    const project = state();
    const zone = "WORKING" as const;
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const targetPath = `${workspaceProjectRoot(project.project_id, project.slug)}/${zone}/assets/diagram.bin`;
    const metadata = harness.putBytes(targetPath, bytes, "id:binary");
    const entry: NavigationInventoryEntry = {
      project_id: project.project_id, zone, resource_id: "ART-BINARY-00000001", version: "a".repeat(64),
      logical_path: "assets/diagram.bin", path: targetPath,
      expected: { object_id: metadata.objectId!, revision_token: metadata.revisionToken!, content_sha256: await sha256Bytes(bytes), size: bytes.length }
    };
    const port: NavigationInventoryPort = {
      listPage: async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [entry], gaps: [], snapshot_id: "binary-snapshot", next_cursor: null }; },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_value, slice) => { slice.beforeHttp(); return true; }
    };
    const input = request(zone);
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, port), input, project, await admissionFor(input));
    expect(result.status).toBe("finalized");
    if (result.status === "finalized") expect(harness.files.get(`${workspaceProjectRoot(project.project_id, project.slug)}/${zone}/00-CURRENT.md`)?.content).toContain("assets/diagram.bin");
  });

  it("does not finalize deferred admission rules without their server postchecks", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const admission = await admissionFor(input);
    admission.deferred_rules = [{ rule_id: "RULE-NAV-001", version: 1, scope: { kind: "project", project_id: project.project_id } }];
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, admission);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_postchecks_unavailable" });
    expect([...harness.files.keys()].some((path) => path.endsWith("/WORKING/00-CURRENT.md"))).toBe(false);
  });

  it("requires the admission to bind the observed index source and exact preservation target", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const sourcePath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT-INDEX.md`;
    const expected = await seedIndex(harness, sourcePath, "old index\n");
    const input = request("WORKING", expected);
    const admission = await admissionFor(input);
    admission.resource_effect_scopes![0].preservation_copies = [];
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, admission);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_admission_binding_mismatch" });
    expect(harness.files.get(sourcePath)?.content).toBe("old index\n");
  });

  it("finishes inventory larger than one page across bounded slices without restarting cursors", async () => {
    const harness = runtimeHarness();
    const project = state();
    const entries: NavigationInventoryEntry[] = [];
    const content = "canonical\n";
    const hash = await sha256Text(content);
    for (let index = 0; index < 17; index++) {
      const logical_path = `records/item-${index}.md`;
      const path = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/${logical_path}`;
      const meta = harness.put(path, content, `id:source-${index}`);
      entries.push({ project_id: project.project_id, zone: "WORKING", resource_id: `DOC-${index.toString().padStart(24, "0")}`, version: `VER-${index}`, logical_path, path, expected: { object_id: meta.objectId!, revision_token: meta.revisionToken!, content_sha256: hash, size: new TextEncoder().encode(content).byteLength } });
    }
    const pages = [entries.slice(0, 8), entries.slice(8, 16), entries.slice(16)];
    const cursors: (string | null)[] = [];
    const port: NavigationInventoryPort = {
      listPage: async ({ cursor, budget: slice }) => {
        slice.beforeHttp();
        cursors.push(cursor);
        const page = cursor === null ? 0 : Number(cursor);
        return { entries: pages[page], gaps: [], snapshot_id: "large-snapshot", next_cursor: page < 2 ? String(page + 1) : null };
      },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return true; }
    };
    const input = request();
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, port), input, project, await admissionFor(input), 20);
    expect(result.status).toBe("finalized");
    expect(cursors).toEqual([null, "1", "2"]);
  });

  it("checkpoints a 1000-page empty adoption prefix and resumes verification at the next source", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 1000, "1000");
    let listCalls = 0;
    const verified: string[] = [];
    inv.port.listPage = async ({ budget: slice }) => {
      slice.beforeHttp();
      listCalls += 1;
      if (listCalls === 1) throw new Error("slice_budget_exhausted");
      return { entries: [inv.entry], gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null };
    };
    inv.port.verifyEntry = async (entry, slice) => { slice.beforeHttp(); verified.push(entry.resource_id); return true; };
    const snapshotReads: string[] = [];
    const readText = harness.runtime.objects.readText;
    harness.runtime.objects.readText = async (path) => {
      if (path.includes("/navigation/snapshot/")) snapshotReads.push(path);
      return readText(path);
    };
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const admission = await admissionFor(input);

    const interrupted = await engine.reconcile(input, project, admission, budget());
    expect(interrupted.status).toBe("pending");
    const checkpoint = JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content);
    expect(checkpoint).toMatchObject({ verify_page: 1000, page_count: 1000, cursor: "1000", snapshot_id: "snapshot-empty-prefix" });

    const resumed = await reconcileUntilTerminal(engine, input, project, admission);
    expect(resumed.status, JSON.stringify(resumed)).toBe("finalized");
    expect(snapshotReads).toEqual([`${seeded.root}/navigation/snapshot/00001000.json`]);
    expect(verified).toEqual([inv.entry.resource_id]);
  });

  it("verifies a bounded run of empty snapshot pages with one checkpoint", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 16, "done");
    harness.put(`${seeded.root}/navigation-progress.json`, JSON.stringify({
      ...seeded.progress, inventory_complete: true, cursor: null
    }));
    const write = harness.runtime.conditionalWrite.writeTextConditional;
    let checkpoints = 0;
    harness.runtime.conditionalWrite.writeTextConditional = async (path, content, token) => {
      if (path === `${seeded.root}/navigation-progress.json` && JSON.parse(content).status === "adopting") checkpoints += 1;
      return write(path, content, token);
    };
    const result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, await admissionFor(input), budget(24));
    const progress = JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content);
    expect(progress.verify_page).toBe(16);
    expect(checkpoints).toBe(1);
    expect(result.status).not.toBe("conflict");
  });

  it("stops the empty-page batch before a populated snapshot page", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 4, "done");
    harness.put(`${seeded.root}/navigation/snapshot/00000002.json`, JSON.stringify({
      schema_version: "1.0", page: 2, project_id: input.project_id, request_id: input.request_id,
      snapshot_id: "snapshot-empty-prefix", entries: [inv.entry], gaps: []
    }));
    harness.put(`${seeded.root}/navigation-progress.json`, JSON.stringify({
      ...seeded.progress, inventory_complete: true, cursor: null,
      source_count: 1, source_ids: [inv.entry.resource_id]
    }));
    const verified: string[] = [];
    inv.port.verifyEntry = async (entry, slice) => { slice.beforeHttp(); verified.push(entry.resource_id); return true; };

    await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, await admissionFor(input), budget(32));

    expect(verified).toEqual([inv.entry.resource_id]);
  });

  it("does not checkpoint across a malformed empty snapshot page", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 4, "done");
    harness.put(`${seeded.root}/navigation/snapshot/00000002.json`, JSON.stringify({
      schema_version: "0.9", page: 2, project_id: input.project_id, request_id: input.request_id,
      snapshot_id: "snapshot-empty-prefix", entries: [], gaps: []
    }));
    harness.put(`${seeded.root}/navigation-progress.json`, JSON.stringify({
      ...seeded.progress, inventory_complete: true, cursor: null
    }));

    const result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, await admissionFor(input), budget(24));

    expect(result).toMatchObject({ status: "conflict", code: "navigation_snapshot_page_invalid" });
    const progress = JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content);
    expect(progress.verify_page).toBe(0);
  });

  it("does not skip persisted pages when adoption progress already contains a source", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 1, "next", inv.entry);
    inv.port.listPage = async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [], gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null }; };
    const verified: string[] = [];
    inv.port.verifyEntry = async (entry, slice) => { slice.beforeHttp(); verified.push(entry.resource_id); return true; };
    const snapshotReads: string[] = [];
    const readText = harness.runtime.objects.readText;
    harness.runtime.objects.readText = async (path) => {
      if (path.includes("/navigation/snapshot/")) snapshotReads.push(path);
      return readText(path);
    };

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, await admissionFor(input));

    expect(result.status).toBe("finalized");
    expect(snapshotReads).toContain(`${seeded.root}/navigation/snapshot/00000000.json`);
    expect(verified).toEqual([inv.entry.resource_id]);
  });

  it("does not trust a verified-entry marker from an adapter without the integrity capability", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 1, "next", inv.entry);
    inv.port.listPage = async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [], gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null }; };
    const pagePath = `${seeded.root}/navigation/snapshot/00000000.json`;
    const savedPage = JSON.parse(harness.files.get(pagePath)!.content);
    savedPage.verified_entries = [{ resource_id: inv.entry.resource_id, entry_hash: await executionHash(inv.entry), persisted: true }];
    harness.put(pagePath, JSON.stringify(savedPage));
    harness.files.delete(inv.targetPath);
    let verifyCalls = 0;
    inv.port.verifyEntry = async (_entry, slice) => { slice.beforeHttp(); verifyCalls += 1; return true; };

    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, await admissionFor(input));

    expect(verifyCalls).toBe(1);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_target_missing_or_changed" });
  });

  it("resumes a long legacy source proof with a bound cursor across 40 budgeted slices", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    inv.entry.resource_id = "package:PKG-NAVIGATION-0001";
    const input = request();
    const seeded = await seedAdoptingProgress(harness, input, 1, "next", inv.entry);
    inv.port.listPage = async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [], gaps: [], snapshot_id: "snapshot-empty-prefix", next_cursor: null }; };
    const visited: number[] = [];
    inv.port.verifyEntryPage = async (_entry, cursor, slice) => {
      slice.beforeHttp();
      const memberIndex = cursor === null ? 0 : Number(cursor);
      visited.push(memberIndex);
      return memberIndex === 39 ? { status: "verified" } : { status: "pending", cursor: String(memberIndex + 1) };
    };
    const admission = await admissionFor(input);
    let result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, admission, budget(32));
    for (let attempt = 0; result.status === "pending" && attempt < 60; attempt++) {
      result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, admission, budget(32));
    }

    expect(result.status).toBe("finalized");
    expect(visited).toEqual(Array.from({ length: 40 }, (_value, index) => index));
    const savedProgress = JSON.parse(harness.files.get(`${seeded.root}/navigation-progress.json`)!.content);
    expect(savedProgress.verify_cursor).toBeNull();
  });

  it("verifies an already published generation without inventory and rejects a forged certificate", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const admission = await admissionFor(input);
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const published = await reconcileUntilTerminal(engine, input, project, admission);
    expect(published.status).toBe("finalized");
    if (published.status !== "finalized") throw new Error("expected publication");
    inv.port.verifySnapshot = async () => { throw new Error("must not reevaluate a historical publication"); };
    inv.port.listPage = async () => { throw new Error("must not rescan publication"); };
    expect(await engine.readVerifiedPublication(input, project, admission, budget(), published.receipt.source_snapshot_id)).toEqual(published.receipt);
    const progressPath = `${await new ExecutionJournal(harness.runtime, input.project_id, "document", input.request_id).root()}/navigation-progress.json`;
    const progress = harness.files.get(progressPath)!;
    const readBytes = vi.spyOn(harness.runtime.objects, "readBytes");
    harness.put(progressPath, " ".repeat(2_000_001));
    readBytes.mockClear();
    await expect(engine.readVerifiedPublication(input, project, admission, budget(), published.receipt.source_snapshot_id)).rejects.toThrow("navigation_publication_proof_unavailable");
    expect(readBytes).not.toHaveBeenCalled();
    harness.put(progressPath, progress.content);
    const originalMetadata = harness.runtime.objects.getMetadata.bind(harness.runtime.objects);
    let proofMetadataReads = 0;
    const metadataRace = vi.spyOn(harness.runtime.objects, "getMetadata").mockImplementation(async path => {
      const metadata = await originalMetadata(path);
      return path === progressPath && ++proofMetadataReads === 2 && metadata
        ? { ...metadata, revisionToken: "concurrent-proof-write" } : metadata;
    });
    await expect(engine.readVerifiedPublication(input, project, admission, budget(), published.receipt.source_snapshot_id)).rejects.toThrow("navigation_publication_proof_unavailable");
    metadataRace.mockRestore();
    const certificate = harness.files.get(published.receipt.finalization_ref)!;
    harness.put(published.receipt.finalization_ref, certificate.content.replace('"source_count":1', '"source_count":2'));
    expect(await engine.readVerifiedPublication(input, project, admission, budget(), published.receipt.source_snapshot_id)).toBeNull();
    harness.put(published.receipt.finalization_ref, certificate.content);
    expect(await engine.readVerifiedPublication(input, project, admission, budget(), "source:999")).toBeNull();
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const index = harness.files.get(indexPath)!;
    harness.put(indexPath, `${index.content}\nexternal change`, index.objectId);
    expect(await engine.readVerifiedPublication(input, project, admission, budget(), published.receipt.source_snapshot_id)).toBeNull();
  });

  it("returns no publication when progress is absent and a stable prior head proves the target generation was never published", async () => {
    const { harness, project, inv, input, admission } = await missingProgressPublicationFixture();

    const result = await new ZoneNavigationEngine(harness.runtime, inv.port)
      .readVerifiedPublication(input, project, admission, budget(), "source:0");

    expect(result).toBeNull();
  });

  it.each(["missing-head", "newer-head", "own-request-head", "malformed-head", "oversized-head", "unstable-head", "metadata-error"] as const)(
    "keeps missing progress unavailable for %s instead of inferring conflict",
    async (failure) => {
      const { harness, project, inv, input, admission, headPath, head } = await missingProgressPublicationFixture(
        `DOCREQ-NAVIGATION-WORKING-NO-PROOF-${failure.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`
      );
      if (failure === "missing-head") harness.files.delete(headPath);
      if (failure === "newer-head") harness.put(headPath, canonicalJson({ ...head, generation: 2 }));
      if (failure === "own-request-head") harness.put(headPath, canonicalJson({ ...head, source_request_id: input.request_id }));
      if (failure === "malformed-head") harness.put(headPath, "not-json");
      if (failure === "oversized-head") harness.put(headPath, `${canonicalJson(head)}${" ".repeat(128_001)}`);
      if (failure === "unstable-head") {
        const originalMetadata = harness.runtime.objects.getMetadata.bind(harness.runtime.objects);
        let reads = 0;
        vi.spyOn(harness.runtime.objects, "getMetadata").mockImplementation(async (path) => {
          const metadata = await originalMetadata(path);
          return path === headPath && ++reads === 2 && metadata
            ? { ...metadata, revisionToken: "head-changed-during-proof" } : metadata;
        });
      }
      if (failure === "metadata-error") {
        const originalMetadata = harness.runtime.objects.getMetadata.bind(harness.runtime.objects);
        vi.spyOn(harness.runtime.objects, "getMetadata").mockImplementation(async (path) => {
          if (path.endsWith("/navigation-progress.json")) throw new Error("provider unavailable");
          return originalMetadata(path);
        });
      }

      await expect(new ZoneNavigationEngine(harness.runtime, inv.port)
        .readVerifiedPublication(input, project, admission, budget(), "source:0"))
        .rejects.toThrow();
    }
  );

  it("returns an old finalized receipt without restoring its index over a newer generation", async () => {
    const harness = runtimeHarness();
    const project = state();
    const originalInventory = await inventoryHarness(project);
    seedTarget(harness, originalInventory);
    const oldRequest = request();
    const oldEngine = new ZoneNavigationEngine(harness.runtime, originalInventory.port);
    const oldAdmission = await admissionFor(oldRequest);
    const original = await reconcileUntilTerminal(oldEngine, oldRequest, project, oldAdmission);
    expect(original.status).toBe("finalized");
    if (original.status !== "finalized") throw new Error("expected first generation to finalize");

    const newPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/plans/new-roadmap.md`;
    const newContent = "new canonical content\n";
    const newMeta = harness.put(newPath, newContent, "id:new-source");
    const newEntry: NavigationInventoryEntry = {
      ...originalInventory.entry,
      resource_id: "DOC-1123456789ABCDEF01234567",
      version: "VER-REQ-1123456789ABCDEF01234567",
      logical_path: "plans/new-roadmap.md",
      path: newPath,
      expected: { object_id: newMeta.objectId!, revision_token: newMeta.revisionToken!, content_sha256: await sha256Text(newContent), size: new TextEncoder().encode(newContent).byteLength }
    };
    const newPort: NavigationInventoryPort = {
      listPage: async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [newEntry], gaps: [], snapshot_id: "snapshot-2", next_cursor: null }; },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return true; }
    };
    const nextRequest = navigationReconcileSchema.parse({ ...oldRequest, request_id: "DOCREQ-NAVIGATION-WORKING-0002", expected_generation: 1, expected_index: original.receipt.index });
    const next = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, newPort), nextRequest, project, await admissionFor(nextRequest));
    expect(next.status).toBe("finalized");
    if (next.status !== "finalized") throw new Error("expected second generation to finalize");
    const currentIndexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const currentBeforeRetry = harness.files.get(currentIndexPath)!.content;
    expect(currentBeforeRetry).toContain("plans/new-roadmap.md");

    const replay = await oldEngine.reconcile(oldRequest, project, oldAdmission, budget());
    expect(replay).toEqual(original);
    expect(harness.files.get(currentIndexPath)?.content).toBe(currentBeforeRetry);
    expect(JSON.parse(harness.files.get(original.receipt.head_ref)!.content).generation).toBe(2);
  });

  it("resumes the frozen request after interruption and rejects changed payload under the same id", async () => {
    const harness = runtimeHarness();
    const project = state();
    const base = await inventoryHarness(project);
    const inv = await inventoryHarness(project, "WORKING", { pages: [[], [{
      project_id: project.project_id,
      zone: "WORKING",
      resource_id: "DOC-0123456789ABCDEF01234567",
      version: "VER-REQ-0123456789ABCDEF01234567",
      logical_path: "plans/roadmap.md",
      path: `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/plans/roadmap.md`,
      expected: base.entry.expected
    }]] });
    seedTarget(harness, base);
    inv.entry.expected = base.entry.expected;
    const input = request();
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const first = await engine.reconcile(input, project, await admissionFor(input), budget(5));
    expect(first.status).toBe("pending");
    const resumed = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(resumed.status, JSON.stringify(resumed)).toBe("finalized");
    const altered = { ...input, expected_generation: 1 };
    const changedAdmission = await admissionFor(navigationReconcileSchema.parse(altered));
    const changed = await engine.reconcile(navigationReconcileSchema.parse(altered), project, changedAdmission, budget());
    expect(changed.status).toBe("conflict");
  });
});
