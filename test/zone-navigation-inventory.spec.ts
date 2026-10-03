import { describe, expect, it, vi } from "vitest";
import type { SliceBudget } from "../src/convergence/contract";
import type { ExecutionAdmission } from "../src/execution/contract";
import { navigationReconcileSchema, type NavigationInventoryEntry, type NavigationInventoryPort } from "../src/domain/zone-navigation";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCatalogRoot, zoneNavigationCatalogShardForResource } from "../src/documents/zone-navigation-sources";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentTextPayloadPath, machineDocumentVersionPath, machineStatePath, workspaceProjectRoot } from "../src/persistence/layout";
import { documentIdFor } from "../src/domain/managed-document";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { canonicalJson } from "../src/rules/contract";
import { packageRuntime } from "./helpers/package-runtime";
import { packageNavigationPath } from "../src/domain/document-package";
import { machineArtifactReceiptPath, machineMutationIntentPath } from "../src/persistence/layout";
import { mutationIntentIdFor } from "../src/domain/mutation-gate";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { enforceManagedMarkdownIdentity } from "../src/documents/identity-frontmatter";

const projectId = "PRJ-0002";
const documentId = "DOC-0123456789ABCDEF01234567";
const versionId = "VER-REQ-0123456789ABCDEF01234567";
const slug = "project-os";

describe("compact catalog adoption gate", () => {
  it("does not resume a saved compact cursor from an unadopted source state", async () => {
    const h = harness();
    const staleCompactEntry: NavigationInventoryEntry = {
      project_id: projectId, zone: "WORKING", resource_id: "head:DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      version: "VER-STALE-COMPACT", logical_path: "stale.md", path: "/stale.md",
      expected: { object_id: "id:stale", revision_token: "rev:stale", content_sha256: "a".repeat(64), size: 5 }
    };
    await h.sources.recordVerifiedCatalogEntry(staleCompactEntry, "source:0", budget(2000));
    await h.sources.markCatalogReady(projectId, "WORKING", 0, budget(2000));

    const page = await h.inventory.listPage({
      project_id: projectId, zone: "WORKING", cursor: "catalog-compact:0", limit: 8, budget: budget(2000)
    });

    expect(page.entries).toEqual([]);
    expect(typeof page.next_cursor === "string" && page.next_cursor.startsWith("catalog-compact:")).toBe(false);
    expect(h.pagePaths).toContain(zoneNavigationCatalogRoot(projectId, "WORKING"));
  });
});

describe("saved initial listing deadline behavior", () => {
  it("honors a one-entry limit and carries the unprocessed saved-head suffix forward", async () => {
    const h = harness();
    const ids = [0, 1, 2].map((index) => `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`);
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `limit body ${index}`, `rev-limit-${index}`, id,
        `VER-REQ-${index.toString(16).toUpperCase().padStart(24, "0")}`, `limit-${index}.md`);
    }
    const cursor = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: ids.map((id) => ({ kind: "file" as const, name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) })),
      provider_cursor: null,
      listing_limit: 512
    }))}`;

    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 1,
      mode: "canonical_catalog_rebuild", budget: budget(256) });
    expect(first.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[0]}`]);
    expect(first.next_cursor).toContain(ids[1]);
    expect(first.next_cursor).toContain(ids[2]);

    const second = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 1,
      mode: "canonical_catalog_rebuild", budget: budget(256) });
    expect(second.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
    expect(second.next_cursor).toContain(ids[2]);
  });

  it("does not use a two-head pair when a saved page has only one entry slot left", async () => {
    const h = harness();
    const ids = [0, 1, 2].map((index) => `DOC-${(index + 10).toString(16).toUpperCase().padStart(24, "0")}`);
    h.put(machineDocumentHeadPath(projectId, ids[0]), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: ids[0], kind: "work_product",
      logical_path: "inactive-prefix.md", reconciliation_status: "clean"
    }));
    for (const [index, id] of ids.slice(1).entries()) {
      await addWorkingHead(h, `pair limit body ${index}`, `rev-pair-limit-${index}`, id,
        `VER-REQ-${(index + 10).toString(16).toUpperCase().padStart(24, "0")}`, `pair-limit-${index}.md`);
    }
    const cursor = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: ids.map((id) => ({ kind: "file" as const, name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) })),
      provider_cursor: null,
      listing_limit: 512
    }))}`;

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 1, budget: budget(256) });

    expect(page.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
    expect(page.next_cursor).toContain(ids[2]);
  });

  it("leaves checkpoint budget after compact-cache head updates on a saved active-head page", async () => {
    const h = harness();
    const ids = ["DOC-05620E091406A4614730CCDE", "DOC-BB8C797FFF67374EF24A4CF4"];
    const entries: NavigationInventoryEntry[] = [];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `compact baseline head ${index}`, `rev-compact-${index}`, id,
        `VER-REQ-${id.slice(4)}`, `compact-${index}.md`);
    }
    const initial = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(2000) });
    entries.push(...initial.entries);
    expect(entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));

    const owner = "DOCREQ-NAV-COMPACT-BASELINE-OWNER-0001";
    expect(await h.sources.beginAdoption(projectId, "WORKING", owner, 0, budget(2000))).toBe(true);
    const firstTicket = await h.sources.beginHeadWrite(projectId, "WORKING", entries[0].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(firstTicket, entries[0], budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[0], "source:1", budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[1], "source:1", budget(2000));
    expect(await h.sources.finishDirty(projectId, "WORKING", entries[0].resource_id, entries[0], budget(2000))).toBe(true);
    expect(await h.sources.markCatalogReady(projectId, "WORKING", 1, budget(2000))).toBe(true);

    const secondTicket = await h.sources.beginHeadWrite(projectId, "WORKING", entries[1].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(secondTicket, entries[1], budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[0], "source:2", budget(2000));
    expect(await h.sources.readState(projectId, "WORKING", budget(2000))).toMatchObject({ generation: 2, adopted: false });
    expect((await h.sources.compactCatalogManifest(projectId, "WORKING", budget(2000)))?.ready_generation).toBe(1);
    for (const entry of entries) {
      const shard = zoneNavigationCatalogShardForResource(entry.resource_id);
      const savedChunk = await h.sources.readCompactCatalogShard(projectId, "WORKING", shard, 2, budget(2000));
      const chunkPath = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/compact/${shard.toString(16).padStart(2, "0")}.json`;
      expect(JSON.parse(h.files.get(chunkPath)!.content).entries.find((saved: { resource_id: string }) => saved.resource_id === entry.resource_id))
        .toMatchObject({ resource_id: entry.resource_id, source_generation: entry === entries[0] ? 2 : 1, entry });
      expect(savedChunk.map((saved) => saved.resource_id)).toContain(entry.resource_id);
    }

    const savedCursor = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: ids.map((id) => ({ kind: "file" as const, name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) })),
      provider_cursor: null,
      listing_limit: 512
    }))}`;
    const slice = budget(32);
    // Four calls have already been spent on the engine's owner/context prefix;
    // this listPage's state identity/read is the remaining two of that six-call prefix.
    for (let index = 0; index < 4; index += 1) slice.beforeHttp();
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: savedCursor, limit: 8, budget: slice });

    expect(page.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[0]}`]);
    expect(page.next_cursor).not.toBe(savedCursor);
    expect(page.next_cursor).toContain(ids[1]);
    // The real engine's immutable-page/progress write is a bounded three-call checkpoint.
    expect(slice.calls_left).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < 3; index += 1) slice.beforeHttp();
    expect(slice.calls_left).toBeGreaterThanOrEqual(1);

    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: page.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
    const refreshedChunk = await h.sources.readCompactCatalogShard(projectId, "WORKING",
      zoneNavigationCatalogShardForResource(`head:${ids[1]}`), 2, budget(2000));
    expect(refreshedChunk.find((entry) => entry.resource_id === `head:${ids[1]}`)?.version).toBe(entries[1].version);
    const refreshedChunkPath = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/compact/${zoneNavigationCatalogShardForResource(`head:${ids[1]}`).toString(16).padStart(2, "0")}.json`;
    expect(JSON.parse(h.files.get(refreshedChunkPath)!.content).entries.find((saved: { resource_id: string }) => saved.resource_id === `head:${ids[1]}`))
      .toMatchObject({ source_generation: 2, entry: entries[1] });

    const navState = emptyProjectState(projectId, "Project OS", slug);
    const navRequest = navigationReconcileSchema.parse({ operation: "navigation.reconcile", request_id: "DOCREQ-NAV-READY-ORPHAN-0001",
      project_id: projectId, zone: "WORKING", expected_project_revision: navState.revision, expected_generation: 0,
      expected_index: null, created_at: "2026-10-03T00:00:00.000Z" });
    const navRequestHash = await executionHash(navRequest);
    const navIndexPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/00-CURRENT.md`;
    const navAdmission = { project_id: projectId, request_id: navRequest.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: navRequestHash, actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:WORKING", resource_version: "0", provider_id: h.runtime.providerId,
        sources: [], destinations: [{ path: navIndexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: navState.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: navState.revision },
      verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    const originalPage = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: savedCursor, limit: 8, budget: budget(2000) });
    expect(originalPage.entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));
    const journal = new ExecutionJournal(h.runtime, projectId, "document", navRequest.request_id);
    const journalRoot = await journal.root();
    await journal.commit(navAdmission as never, null);
    const progress = { schema_version: "1.0", project_id: projectId, request_id: navRequest.request_id,
      request_hash: navRequestHash, target_generation: 1, index_basename: "00-CURRENT.md", expected_index: null,
      head_revision_token: null, cursor: savedCursor, page_count: 0, inventory_complete: false,
      snapshot_id: originalPage.snapshot_id, verify_page: 0, verify_entry: 0, verify_cursor: null, completion_cursor: null,
      source_count: 0, source_ids: [], published_index: null, coverage_gaps: [], rendered_links: [], generated_sha256: null,
      legacy_archive_ref: null, valid_links_work: null, status: "adopting", receipt: null, postchecks: [] };
    h.put(`${journalRoot}/navigation-intention.json`, canonicalJson({ schema_version: "1.0", request: navRequest,
      request_hash: navRequestHash, target_generation: 1, initial_progress: progress }));
    h.put(`${journalRoot}/navigation-progress.json`, canonicalJson(progress));
    const legacyOrphan = { schema_version: "1.0", page: 0, project_id: projectId, request_id: navRequest.request_id,
      snapshot_id: originalPage.snapshot_id, entries: originalPage.entries,
      ...(originalPage.verified_entries ? { verified_entries: originalPage.verified_entries } : {}), gaps: originalPage.gaps };
    const orphanPath = `${journalRoot}/navigation/snapshot/00000000.json`;
    h.put(orphanPath, canonicalJson(legacyOrphan));
    const engine = new ZoneNavigationEngine(h.runtime, h.inventory);
    const sharedSlice = budget(32);
    await h.sources.readState(projectId, "WORKING", sharedSlice);
    expect(sharedSlice.calls_left).toBe(30);
    const inventoryTrace: unknown[] = [];
    const originalListPage = h.inventory.listPage.bind(h.inventory);
    vi.spyOn(h.inventory, "listPage").mockImplementation(async (input) => {
      const before = input.budget.calls_left;
      try {
        const page = await originalListPage(input);
        inventoryTrace.push({ before, after: input.budget.calls_left, entries: page.entries.map((entry) => entry.resource_id), next_cursor: page.next_cursor });
        return page;
      } catch (error) {
        inventoryTrace.push({ before, after: input.budget.calls_left, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
    let navigationResult = await engine.reconcile(navRequest, navState, navAdmission as never, sharedSlice, { deferPublication: true });
    let slices = 1;
    let savedProgress = JSON.parse(h.files.get(`${journalRoot}/navigation-progress.json`)!.content);
    expect(savedProgress.source_count).toBe(0);
    expect(savedProgress.page_count).toBe(0);
    expect(savedProgress.cursor, JSON.stringify({ navigationResult, calls_left: sharedSlice.calls_left,
      provider_calls: h.providerCalls, inventoryTrace, savedProgress })).toContain("@navigation-orphan-replay:v1:");
    for (; navigationResult.status === "pending" && slices < 20; slices += 1) {
      navigationResult = await engine.reconcile(navRequest, navState, navAdmission as never, budget(32), { deferPublication: true });
      savedProgress = JSON.parse(h.files.get(`${journalRoot}/navigation-progress.json`)!.content);
    }
    expect(navigationResult.status, JSON.stringify(navigationResult)).toBe("prepared");
    expect(savedProgress).toMatchObject({ inventory_complete: true, source_count: 2, source_ids: ids.map((id) => `head:${id}`) });
    expect(new Set(savedProgress.source_ids).size).toBe(2);
    expect(h.files.get(orphanPath)!.content).toBe(canonicalJson(legacyOrphan));
    expect(slices).toBeGreaterThan(1);
  });

  it("checkpoints a completed prefix instead of repeatedly pairing heads against an older ready compact cache", async () => {
    const h = harness();
    const ids = ["DOC-05620E091406A4614730CCDE", "DOC-BB8C797FFF67374EF24A4CF4"];
    const entries: NavigationInventoryEntry[] = [];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `pair compact head ${index}`, `rev-pair-${index}`, id,
        `VER-REQ-${id.slice(4)}`, `pair-compact-${index}.md`);
    }
    entries.push(...(await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(2000) })).entries);
    expect(entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));

    const owner = "DOCREQ-NAV-COMPACT-PAIR-OWNER-0001";
    expect(await h.sources.beginAdoption(projectId, "WORKING", owner, 0, budget(2000))).toBe(true);
    const firstTicket = await h.sources.beginHeadWrite(projectId, "WORKING", entries[0].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(firstTicket, entries[0], budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[0], "source:1", budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[1], "source:1", budget(2000));
    expect(await h.sources.finishDirty(projectId, "WORKING", entries[0].resource_id, entries[0], budget(2000))).toBe(true);
    expect(await h.sources.markCatalogReady(projectId, "WORKING", 1, budget(2000))).toBe(true);
    const secondTicket = await h.sources.beginHeadWrite(projectId, "WORKING", entries[1].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(secondTicket, entries[1], budget(2000));
    await h.sources.recordVerifiedCatalogEntry(entries[0], "source:2", budget(2000));

    const firstSlice = budget(32);
    const firstPage = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: firstSlice });
    expect(firstPage.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[0]}`]);
    expect(firstPage.next_cursor).not.toBeNull();
    expect(firstPage.next_cursor).toContain(ids[1]);
    expect(firstSlice.calls_left).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < 3; index += 1) firstSlice.beforeHttp();

    const secondPage = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: firstPage.next_cursor, limit: 8, budget: budget(32) });
    expect(secondPage.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
    expect(secondPage.next_cursor).not.toBe(firstPage.next_cursor);
  });

  it("keeps the checkpoint reserve while clearing an inactive head's prior catalog entry", async () => {
    const h = harness();
    await addWorkingHead(h, "inactive stale catalog body");
    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(2000) });
    expect(first.entries).toHaveLength(1);
    const owner = "DOCREQ-NAV-INACTIVE-CATALOG-OWNER-0001";
    expect(await h.sources.beginAdoption(projectId, "WORKING", owner, 0, budget(2000))).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", first.entries[0].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(ticket, first.entries[0], budget(2000));
    await h.sources.recordVerifiedCatalogEntry(first.entries[0], "source:1", budget(2000));
    expect(await h.sources.finishDirty(projectId, "WORKING", first.entries[0].resource_id, first.entries[0], budget(2000))).toBe(true);
    expect(await h.sources.markCatalogReady(projectId, "WORKING", 1, budget(2000))).toBe(true);

    const headPath = machineDocumentHeadPath(projectId, documentId);
    const head = JSON.parse(h.files.get(headPath)!.content);
    delete head.working_version_id;
    delete head.provider.working;
    h.put(headPath, JSON.stringify(head), "id:inactive-head");
    const catalogPath = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(`head:${documentId}`)}.json`;
    const savedCursor = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [{ kind: "file" as const, name: `${documentId}.json`, path: headPath }],
      provider_cursor: null,
      listing_limit: 512
    }))}`;
    const slice = budget(32);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: savedCursor, limit: 8, budget: slice });
    expect(page.entries).toEqual([]);
    expect(page.next_cursor).not.toBe(savedCursor);
    expect(JSON.parse(h.files.get(catalogPath)!.content).entry).toBeNull();
    expect(slice.calls_left).toBeGreaterThanOrEqual(4);
  });

  it("advances a saved active head when its following head preflight reaches the deadline", async () => {
    const activeId = "DOC-000000000000000000000005";
    const inactiveId = "DOC-000000000000000000000006";
    const tailIds = Array.from({ length: 4 }, (_, index) => `DOC-${(7 + index).toString(16).toUpperCase().padStart(24, "0")}`);
    const activePath = machineDocumentHeadPath(projectId, activeId);
    const inactivePath = machineDocumentHeadPath(projectId, inactiveId);
    const makeCursor = (ids: string[]) => `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: ids.map((id) => ({ kind: "file" as const, name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) })),
      provider_cursor: null,
      listing_limit: 512
    }))}`;
    const makeTimedBudget = (now: () => number): SliceBudget => {
      const value: SliceBudget = {
        deadline_ms: now() + 25_000,
        calls_left: 32,
        now,
        signal: new AbortController().signal,
        beforeHttp() {
          if (this.now() >= this.deadline_ms || this.calls_left <= 0) throw new Error("slice_budget_exhausted");
          this.calls_left -= 1;
        },
        canStartEffect(requiredCalls) {
          return this.calls_left >= requiredCalls + 4 && this.now() < this.deadline_ms - 3_000;
        }
      };
      return value;
    };

    const stalled = harness();
    await addWorkingHead(stalled, "active body", "rev-active", activeId, `VER-REQ-${activeId.slice(4)}`, "active.md");
    stalled.put(inactivePath, JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: inactiveId,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    for (const id of tailIds) stalled.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: id,
      kind: "work_product", logical_path: `${id}.md`, reconciliation_status: "clean"
    }));
    let stalledNow = 0;
    let slowHeadReads = 0;
    const stalledRead = stalled.runtime.objects.readText.bind(stalled.runtime.objects);
    stalled.runtime.objects.readText = async (path) => {
      if (path === activePath || path === inactivePath) {
        slowHeadReads += 1;
        const startedAt = stalledNow;
        const raw = await stalledRead(path);
        // ordinaryInitialPair starts these reads concurrently: model elapsed
        // wall time as the slowest overlapping call, not their sum. The
        // inactive second head reaches the provider deadline; the active first
        // head itself is fast and remains available from the pair's cache.
        stalledNow = Math.max(stalledNow, startedAt + (path === activePath ? 100 : 22_100));
        if (path === inactivePath) throw new Error("simulated_provider_deadline");
        return raw;
      }
      return stalledRead(path);
    };
    const savedPair = makeCursor([activeId, inactiveId, ...tailIds]);

    const attempts: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        const page = await stalled.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: savedPair, limit: 8, budget: makeTimedBudget(() => stalledNow) });
        attempts.push(page.next_cursor === savedPair ? "unchanged" : "advanced");
      } catch (error) {
        attempts.push(error instanceof Error ? error.message : "unknown");
      }
    }
    expect(slowHeadReads).toBe(4);

    const solo = harness();
    await addWorkingHead(solo, "active body", "rev-active", activeId, `VER-REQ-${activeId.slice(4)}`, "active.md");
    let soloNow = 0;
    const soloRead = solo.runtime.objects.readText.bind(solo.runtime.objects);
    solo.runtime.objects.readText = async (path) => {
      if (path === activePath) soloNow += 100;
      return soloRead(path);
    };
    const soloPage = await solo.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: makeCursor([activeId]), limit: 8, budget: makeTimedBudget(() => soloNow) });

    expect(soloPage.entries.map((entry) => entry.resource_id)).toContain(`head:${activeId}`);
    expect(soloPage.next_cursor).not.toBe(makeCursor([activeId]));
    expect(attempts).toEqual(["advanced", "advanced"]);
  });
});

function budget(calls = 32): SliceBudget {
  return {
    deadline_ms: 25_000,
    calls_left: calls,
    now: () => 0,
    signal: new AbortController().signal,
    beforeHttp() { this.calls_left -= 1; if (this.calls_left < 0) throw new Error("slice_budget_exhausted"); },
    canStartEffect(requiredCalls) { return this.calls_left >= requiredCalls + 4; }
  };
}

function harness() {
  const files = new Map<string, { content: string; object_id: string; revision_token: string }>();
  const pageLimits: number[] = [];
  const pagePaths: string[] = [];
  let providerCalls = 0;
  const missingOnRead = new Set<string>();
  const readErrors = new Map<string, Error>();
  let nextIdentity = 0;
  const metadata = (path: string): ProviderObjectMetadata | null => {
    const file = files.get(path);
    return file ? { path, objectId: file.object_id, revisionToken: file.revision_token, size: new TextEncoder().encode(file.content).length } : null;
  };
  const put = (path: string, content: string, objectId?: string) => {
    nextIdentity += 1;
    files.set(path, { content, object_id: objectId ?? `id:${nextIdentity}`, revision_token: `rev:${nextIdentity}` });
  };
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => {
        providerCalls += 1;
        const error = readErrors.get(path);
        if (error) throw error;
        if (missingOnRead.has(path)) return null;
        return files.get(path)?.content ?? null;
      },
      readBytes: async (path, maxBytes) => {
        providerCalls += 1;
        const file = files.get(path);
        if (!file) return null;
        const bytes = new TextEncoder().encode(file.content);
        return bytes.length > maxBytes ? null : bytes;
      },
      createText: async (path, content) => { providerCalls += 1; if (files.has(path)) throw new Error("exists"); put(path, content); },
      upsertText: async (path, content) => { providerCalls += 1; put(path, content); },
      getMetadata: async (path) => { providerCalls += 1; return metadata(path); },
      listChildren: async () => { providerCalls += 1; return []; },
      move: async () => { providerCalls += 1; },
      delete: async (path) => { providerCalls += 1; files.delete(path); },
      deleteIfUnchanged: async (path, expected) => {
        providerCalls += 1;
        const current = metadata(path);
        if (!current) return "missing";
        if (current.objectId !== expected.objectId || current.revisionToken !== expected.revisionToken) return "changed";
        files.delete(path);
        return "deleted";
      }
    },
    conditionalWrite: { writeTextConditional: async (path, content) => { providerCalls += 1; put(path, content); return metadata(path)!; } },
    serverSideCopy: { copyObject: async () => { providerCalls += 1; return { path: "", objectId: "", revisionToken: "", size: 0 }; } },
    changeFeed: { listChanges: async () => { providerCalls += 1; return { entries: [], cursor: "" }; } },
    pagedListing: { listPage: async ({ path, cursor, limit }) => {
      providerCalls += 1;
      pageLimits.push(limit);
      pagePaths.push(path);
      if (path === `${machineDocumentRoot(projectId)}/quarantines`) {
        const names = [...new Set([...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1).split("/")[0]))].sort();
        const start = cursor ? Math.max(0, names.findIndex((name) => name > cursor)) : 0;
        const page = names.slice(start, start + limit);
        return { entries: page.map((name) => ({ kind: "folder" as const, name, path: `${path}/${name}` })), cursor: start + page.length < names.length ? page.at(-1) ?? null : null };
      }
      const matching = [...files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } },
    directoryProvisioning: { ensureDirectory: async () => { providerCalls += 1; } },
    evidence: { stableObjectId: { semantics: "stable-through-move" }, revisionToken: { semantics: "opaque-object-revision" }, integrityHash: { semantics: "identified-algorithm" } }
  };
  const sources = new ZoneNavigationSources(runtime);
  return { runtime, files, pageLimits, pagePaths, missingOnRead, readErrors, put, sources, inventory: new ZoneNavigationInventory(runtime, sources), get providerCalls() { return providerCalls; } };
}

async function seedCommittedArtifact(h: ReturnType<typeof harness>, requestId: string, destinationPath: string, content: string, recordedAt = "2026-09-25T00:00:00Z") {
  const contentHash = await sha256Text(content);
  const request = { request_id: requestId, project_id: projectId, relative_path: "report.md", content, content_sha256: contentHash, mode: "create" as const };
  const requestJson = JSON.stringify(request);
  const intent = {
    schema_version: "1.0" as const, intent_id: await mutationIntentIdFor(projectId, requestId), project_id: projectId,
    kind: "artifact" as const, request_id: requestId, request_sha256: await sha256Text(requestJson), request_json: requestJson,
    base_project_revision: 0, destination_path: destinationPath, provider_precondition: { kind: "absent" as const, provider_id: "test" },
    expected_content_sha256: contentHash, mode: "create" as const, recorded_at: recordedAt
  };
  await new MutationGateRepository(h.runtime, "provider_v2").ensureArtifactIntent(intent);
  h.put(destinationPath, content, "id:artifact");
  h.put(machineArtifactReceiptPath(requestId), JSON.stringify({ request_id: requestId, project_id: projectId, relative_path: "report.md", content_sha256: contentHash, status: "committed" }));
  return intent;
}

async function addWorkingHead(h: ReturnType<typeof harness>, content: string, revision = "rev-visible", id = documentId, version = versionId, logicalPath = "draft.md") {
  const sha = await sha256Text(content);
  const path = `${workspaceProjectRoot(projectId, slug)}/WORKING/${logicalPath}`;
  h.put(path, content, "id:visible");
  const observed = h.files.get(path)!;
  h.files.set(path, { ...observed, revision_token: revision });
  const head = {
    schema_version: "1.0", project_id: projectId, document_id: id, kind: "work_product", logical_path: logicalPath,
    working_version_id: version,
    provider: { working: { path, file_id: "id:visible", rev: revision, content_hash: sha, size: new TextEncoder().encode(content).length } },
    reconciliation_status: "clean"
  };
  const versionRecord = {
    schema_version: "1.0", project_id: projectId, document_id: id, version_id: version, kind: "work_product", stage: "working",
    logical_path: logicalPath, source: "project_os", created_at: "2026-09-25T00:00:00.000Z",
    immutable_payload_path: machineDocumentTextPayloadPath(projectId, sha), content_sha256: sha, provider_file_id: "id:visible",
    provider_rev: revision, provider_path: path, size: new TextEncoder().encode(content).length
  };
  h.put(machineDocumentHeadPath(projectId, id), JSON.stringify(head));
  h.put(machineDocumentVersionPath(projectId, id, version), JSON.stringify(versionRecord));
  return path;
}

async function seedHistoricalPublishedHead(
  h: ReturnType<typeof harness>,
  options: { currentObjectId?: string; receiptRevision?: string; providerSlug?: string; legacyEnvelope?: boolean } = {}
) {
  const requestId = "DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1";
  const parentVersionId = "VER-REQ-1123456789ABCDEF01234567";
  const publishedVersionId = `VER-REQ-${(await sha256Text(`${requestId}\npublished`)).slice(0, 24).toUpperCase()}`;
  const content = "historically published body";
  const contentHash = await sha256Text(content);
  const size = new TextEncoder().encode(content).byteLength;
  const workingPath = `${workspaceProjectRoot(projectId, options.providerSlug ?? slug)}/WORKING/draft.md`;
  const deliverablesPath = `${workspaceProjectRoot(projectId, options.providerSlug ?? slug)}/DELIVERABLES/draft.md`;
  const request = {
    operation: "publish", request_id: requestId, project_id: projectId, document_id: documentId,
    expected_version_id: parentVersionId, created_at: "2026-09-29T10:00:00.000Z"
  };
  const requestJson = JSON.stringify(request);
  const requestHash = await executionHash(request);

  h.put(machineStatePath(projectId), JSON.stringify(emptyProjectState(projectId, "Project OS", slug)));
  h.put(deliverablesPath, content, options.currentObjectId ?? "id:shared-published-object");
  h.files.set(deliverablesPath, { ...h.files.get(deliverablesPath)!, revision_token: "rev-published" });
  h.put(machineDocumentTextPayloadPath(projectId, contentHash), content);
  h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
    schema_version: "1.0", project_id: projectId, document_id: documentId, kind: "work_product", logical_path: "draft.md",
    published_version_id: publishedVersionId,
    provider: { published: { path: deliverablesPath, file_id: options.currentObjectId ?? "id:shared-published-object", rev: "rev-published", content_hash: contentHash, size } },
    reconciliation_status: "clean"
  }));
  h.put(machineDocumentVersionPath(projectId, documentId, parentVersionId), JSON.stringify({
    schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: parentVersionId,
    kind: "work_product", stage: "review", logical_path: "draft.md", source: "project_os",
    created_at: "2026-09-29T09:00:00.000Z", immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
    content_sha256: contentHash, provider_evidence: {
      provider_id: "test", object_id: "id:shared-published-object", revision_token: "rev-working",
      path: workingPath, integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size
    }
  }));
  h.put(machineDocumentVersionPath(projectId, documentId, publishedVersionId), JSON.stringify({
    schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: publishedVersionId,
    parent_version_id: parentVersionId, kind: "work_product", stage: "published", logical_path: "draft.md", source: "project_os",
    created_at: request.created_at, request_id: requestId, immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
    content_sha256: contentHash, provider_evidence: {
      provider_id: "test", object_id: "id:shared-published-object", revision_token: "rev-working", path: workingPath,
      integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size
    }
  }));
  await new ExecutionJournal(h.runtime, projectId, "document", requestId).commit({
    project_id: projectId, request_id: requestId, kind: "document", operation: "document.publish", request_hash: requestHash,
    actor: { actor_id: "operator:test", authority: "project_guard" },
    resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: parentVersionId, expected_version: parentVersionId }],
    global_revision: 0, project_revision: 0,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 },
    verdict: "allow", results: [], gaps: [], deferred_rules: []
  } as unknown as ExecutionAdmission, null);
  h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`, JSON.stringify({
    schema_version: "1.0", project_id: projectId, request_id: requestId,
    request_sha256: await sha256Text(requestJson), ...(!options.legacyEnvelope ? { request_json: requestJson } : {})
  }));
  h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`, JSON.stringify({
    schema_version: "1.0", project_id: projectId, request_id: requestId,
    request_sha256: await sha256Text(requestJson), ...(!options.legacyEnvelope ? { request_json: requestJson } : {}),
    receipt_json: JSON.stringify({
      request_id: requestId, project_id: projectId, document_id: documentId, version_id: publishedVersionId,
      stage: "published", logical_path: "draft.md", status: "committed", provider_rev: options.receiptRevision ?? "rev-published"
    })
  }));
  return {
    entry: {
      project_id: projectId, zone: "DELIVERABLES" as const, resource_id: `head:${documentId}`, version: publishedVersionId,
      logical_path: "draft.md", path: deliverablesPath,
      expected: { object_id: options.currentObjectId ?? "id:shared-published-object", revision_token: "rev-published", content_sha256: contentHash, size }
    } satisfies NavigationInventoryEntry
  };
}

describe("ZoneNavigationInventory", () => {
  it("keeps snapshot completion pending when an empty dirty page has a continuation", async () => {
    const h = harness();
    const listDirtyPage = vi.spyOn(h.sources, "listDirtyPage").mockResolvedValue({ resource_ids: [], next_cursor: "opaque-next" });
    const markReady = vi.spyOn(h.sources, "markCatalogReady").mockResolvedValue(false);

    const result = await h.inventory.completeSnapshot({ project_id: projectId, zone: "REVIEW", snapshot_id: "source:0", budget: budget() });

    expect(result).toMatchObject({ status: "pending", cursor: "dirty:opaque-next" });
    expect(listDirtyPage).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
  });

  it("resolves an adopted dirty artifact across persisted completion cursors", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/REVIEW/report.md`;
    const intent = await seedCommittedArtifact(h, "ART-NAVIGATION-DIRTY-001", destination, "adopted artifact");
    const resourceId = `artifact:${await sha256Text(destination)}`;
    const ticket = await h.sources.beginHeadWrite(projectId, "REVIEW", resourceId, budget(), null, true);
    await h.sources.completeHeadWrite(ticket, null, budget());

    let cursor: string | null = null;
    let result: Awaited<ReturnType<typeof h.inventory.completeSnapshot>> = "pending";
    for (let attempt = 0; attempt < 20 && result !== true && (result === "pending" || (typeof result === "object" && result !== null && result.status === "pending")); attempt += 1) {
      result = await h.inventory.completeSnapshot({ project_id: projectId, zone: "REVIEW", snapshot_id: "source:1", cursor, budget: budget() });
      if (typeof result === "object" && result.status === "pending") cursor = result.cursor;
      else if (result === "pending") cursor = null;
    }

    expect(intent.expected_content_sha256).toBe(await sha256Text("adopted artifact"));
    expect(result).toBe(true);
    expect(await h.sources.listDirtyPage(projectId, "REVIEW", null, 1, budget())).toMatchObject({ resource_ids: [], next_cursor: null });
  });

  it("enumerates only current canonical zone heads from a bounded provider page", async () => {
    const h = harness();
    const visiblePath = await addWorkingHead(h, "current body");

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(1);
    expect(page.snapshot_id).toBe("source:0");
    expect(page.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject<Partial<NavigationInventoryEntry>>({
      project_id: projectId, zone: "WORKING", resource_id: `head:${documentId}`, version: versionId,
      logical_path: "draft.md", path: visiblePath,
      expected: { object_id: "id:visible", revision_token: "rev-visible", content_sha256: await sha256Text("current body"), size: 12 }
    });
    expect(page.entries[0].expected.content_sha256).toBe(await sha256Text("current body"));
  });

  it("accepts a REVIEW head whose exact committed promotion proves the WORKING-to-REVIEW provider move", async () => {
    const h = harness();
    const content = "promoted review body";
    const contentHash = await sha256Text(content);
    const requestId = "DOCREQ-NAV-AUTO-REVIEW-S27-R439-G1";
    const request = {
      operation: "review.promote",
      request_id: requestId,
      project_id: projectId,
      document_id: documentId,
      expected_version_id: versionId,
      created_at: "2026-09-29T10:00:00.000Z"
    };
    const requestJson = JSON.stringify(request);
    const promotedVersionId = `VER-REQ-${(await sha256Text(`${requestId}\nreview`)).slice(0, 24).toUpperCase()}`;
    const workingPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/draft.md`;
    const reviewPath = `${workspaceProjectRoot(projectId, slug)}/REVIEW/draft.md`;
    h.put(reviewPath, content, "id:shared-review-object");
    h.files.set(reviewPath, { ...h.files.get(reviewPath)!, revision_token: "rev-review" });
    h.put(machineDocumentTextPayloadPath(projectId, contentHash), content);
    const size = new TextEncoder().encode(content).byteLength;
    h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: documentId, kind: "work_product", logical_path: "draft.md",
      review_version_id: promotedVersionId,
      provider: { review: { path: reviewPath, file_id: "id:shared-review-object", rev: "rev-review", content_hash: contentHash, size } },
      reconciliation_status: "clean"
    }));
    const rawVersion = JSON.stringify({
      schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: promotedVersionId,
      parent_version_id: versionId, kind: "work_product", stage: "review", logical_path: "draft.md", source: "project_os",
      created_at: request.created_at, request_id: requestId, immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
      content_sha256: contentHash, provider_evidence: {
        provider_id: "test", object_id: "id:shared-review-object", revision_token: "rev-working", path: workingPath,
        integrity_hash: { algorithm: "sha256", value: contentHash }, size
      }
    });
    h.put(machineDocumentVersionPath(projectId, documentId, promotedVersionId), rawVersion);
    const requestHash = await executionHash(request);
    const admission = {
      project_id: projectId, request_id: requestId, kind: "document", operation: "review.promote", request_hash: requestHash,
      actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: versionId, expected_version: versionId }],
      global_revision: 0, project_revision: 0,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    await new ExecutionJournal(h.runtime, projectId, "document", requestId).commit(admission as unknown as ExecutionAdmission, null);
    h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`, JSON.stringify({
      schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: await sha256Text(requestJson), request_json: requestJson
    }));
    h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`, JSON.stringify({
      schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: await sha256Text(requestJson), request_json: requestJson,
      receipt_json: JSON.stringify({
        request_id: requestId, project_id: projectId, document_id: documentId, version_id: promotedVersionId,
        stage: "review", logical_path: "draft.md", status: "committed", provider_rev: "rev-review"
      })
    }));
    const savedAdmission = await new ExecutionJournal(h.runtime, projectId, "document", requestId).readAdmission();
    expect(savedAdmission?.admission).toMatchObject({ operation: "review.promote", request_hash: requestHash, verdict: "allow" });
    expect(savedAdmission?.admission.resources).toContainEqual(expect.objectContaining({
      resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: versionId, expected_version: versionId
    }));

    const entry: NavigationInventoryEntry = {
      project_id: projectId, zone: "REVIEW", resource_id: `head:${documentId}`, version: promotedVersionId,
      logical_path: "draft.md", path: reviewPath,
      expected: { object_id: "id:shared-review-object", revision_token: "rev-review", content_sha256: contentHash, size }
    };

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
    const savedReceipt = JSON.parse(h.files.get(receiptPath)!.content);
    const forgedReceipt = JSON.parse(savedReceipt.receipt_json);
    forgedReceipt.provider_rev = "rev-unrelated";
    h.put(receiptPath, JSON.stringify({ ...savedReceipt, receipt_json: JSON.stringify(forgedReceipt) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);

    // Earlier committed promotions retained the exact request digest but not
    // its JSON envelope. They remain provable from the immutable version.
    const intentPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`;
    const legacyIntent = JSON.parse(h.files.get(intentPath)!.content);
    delete legacyIntent.request_json;
    h.put(intentPath, JSON.stringify(legacyIntent));
    const legacyReceipt = { ...savedReceipt };
    delete legacyReceipt.request_json;
    h.put(receiptPath, JSON.stringify(legacyReceipt));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    h.put(receiptPath, JSON.stringify({ ...legacyReceipt, request_sha256: "0".repeat(64) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);

    // Older promotions also omitted the optional expected_version_id. Their
    // admission resource was bound to the request ID rather than the parent.
    const olderRequest = { operation: "review.promote", request_id: requestId, project_id: projectId,
      document_id: documentId, created_at: request.created_at };
    const olderJson = JSON.stringify(olderRequest);
    const olderDigest = await sha256Text(olderJson);
    h.put(intentPath, JSON.stringify({ ...legacyIntent, request_sha256: olderDigest }));
    h.put(receiptPath, JSON.stringify({ ...legacyReceipt, request_sha256: olderDigest }));
    const journal = new ExecutionJournal(h.runtime, projectId, "document", requestId);
    const olderAdmission = await journal.readAdmission();
    expect(olderAdmission).not.toBeNull();
    h.put(`${await journal.root()}/admission.json`, JSON.stringify({ ...olderAdmission,
      admission: { ...olderAdmission!.admission, request_hash: await executionHash(olderRequest),
        resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: requestId }] } }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    h.put(receiptPath, JSON.stringify({ ...legacyReceipt, request_sha256: "0".repeat(64) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a legacy REVIEW write with stale WORKING evidence only when its exact write and immutable bytes are proven", async () => {
    const h = harness();
    const requestId = "DOCREQ-NAV-LEGACY-REVIEW-WRITE-001";
    const parentId = "VER-REQ-1123456789ABCDEF01234567";
    const reviewId = `VER-REQ-${(await sha256Text(`${requestId}\nreview`)).slice(0, 24).toUpperCase()}`;
    const content = "# Revised review body\n";
    const managed = enforceManagedMarkdownIdentity(content, { projectId, documentId, logicalPath: "draft.md" });
    const contentHash = await sha256Text(managed);
    const workingPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/draft.md`;
    const reviewPath = `${workspaceProjectRoot(projectId, slug)}/REVIEW/draft.md`;
    const oldEvidence = { provider_id: "test", object_id: "id:review-write", revision_token: "rev-working",
      path: workingPath, integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size: 12 };
    const request = { operation: "review.write", request_id: requestId, project_id: projectId, document_id: documentId,
      expected_version_id: parentId, content, content_sha256: await sha256Text(content), created_at: "2026-09-29T10:00:00.000Z" };
    const requestJson = JSON.stringify(request);
    const requestDigest = await sha256Text(requestJson);
    h.put(machineStatePath(projectId), JSON.stringify(emptyProjectState(projectId, "Project OS", slug)));
    h.put(reviewPath, managed, "id:review-write");
    h.files.set(reviewPath, { ...h.files.get(reviewPath)!, revision_token: "rev-review-write" });
    h.put(machineDocumentTextPayloadPath(projectId, contentHash), managed);
    h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({ schema_version: "1.0", project_id: projectId,
      document_id: documentId, kind: "work_product", logical_path: "draft.md", review_version_id: reviewId,
      provider: { review: { path: reviewPath, file_id: "id:review-write", rev: "rev-review-write", content_hash: contentHash, size: new TextEncoder().encode(managed).byteLength } },
      reconciliation_status: "clean" }));
    h.put(machineDocumentVersionPath(projectId, documentId, parentId), JSON.stringify({ schema_version: "2.0", project_id: projectId,
      document_id: documentId, version_id: parentId, kind: "work_product", stage: "review", logical_path: "draft.md",
      source: "project_os", created_at: "2026-09-29T09:00:00.000Z", immutable_payload_path: machineDocumentTextPayloadPath(projectId, await sha256Text("old content")),
      content_sha256: await sha256Text("old content"), provider_evidence: oldEvidence }));
    h.put(machineDocumentVersionPath(projectId, documentId, reviewId), JSON.stringify({ schema_version: "2.0", project_id: projectId,
      document_id: documentId, version_id: reviewId, parent_version_id: parentId, kind: "work_product", stage: "review", logical_path: "draft.md",
      source: "project_os", created_at: request.created_at, request_id: requestId, immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
      content_sha256: contentHash, provider_evidence: oldEvidence }));
    await new ExecutionJournal(h.runtime, projectId, "document", requestId).commit({ project_id: projectId, request_id: requestId,
      kind: "document", operation: "review.write", request_hash: await executionHash(request),
      actor: { actor_id: "operator:test", authority: "project_guard" }, resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: parentId, expected_version: parentId }],
      global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 },
      verdict: "allow", results: [], gaps: [], deferred_rules: [] } as unknown as ExecutionAdmission, null);
    const intentPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`;
    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
    h.put(intentPath, JSON.stringify({ schema_version: "1.0", project_id: projectId, request_id: requestId, request_sha256: requestDigest, request_json: requestJson }));
    const receipt = { request_id: requestId, project_id: projectId, document_id: documentId, version_id: reviewId,
      stage: "review", logical_path: "draft.md", status: "committed", provider_rev: "rev-review-write" };
    h.put(receiptPath, JSON.stringify({ schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: requestDigest, request_json: requestJson, receipt_json: JSON.stringify(receipt) }));
    const entry: NavigationInventoryEntry = { project_id: projectId, zone: "REVIEW", resource_id: `head:${documentId}`,
      version: reviewId, logical_path: "draft.md", path: reviewPath,
      expected: { object_id: "id:review-write", revision_token: "rev-review-write", content_sha256: contentHash, size: new TextEncoder().encode(managed).byteLength } };

    const slice = budget();
    const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor: null, limit: 8, budget: slice });
    expect(page.entries).toEqual([entry]);
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
    h.put(machineDocumentTextPayloadPath(projectId, contentHash), "corrupted immutable review payload");
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
    h.put(machineDocumentTextPayloadPath(projectId, contentHash), managed);
    h.put(receiptPath, JSON.stringify({ schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: requestDigest, request_json: requestJson, receipt_json: JSON.stringify({ ...receipt, provider_rev: "wrong-rev" }) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a DELIVERABLES head only when its exact committed publication proves the provider move", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    const version = JSON.parse(h.files.get(machineDocumentVersionPath(projectId, documentId, entry.version))!.content);
    const intentPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/intent.json`;
    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/receipt.json`;
    const intent = JSON.parse(h.files.get(intentPath)!.content);
    const receipt = JSON.parse(h.files.get(receiptPath)!.content);
    delete intent.request_json;
    delete receipt.request_json;
    h.put(intentPath, JSON.stringify(intent));
    h.put(receiptPath, JSON.stringify(receipt));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    h.put(receiptPath, JSON.stringify({ ...receipt, request_sha256: "0".repeat(64) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a published payload whose historical WORKING evidence has an older size only with immutable byte proof", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const path = machineDocumentVersionPath(projectId, documentId, entry.version);
    const published = JSON.parse(h.files.get(path)!.content);
    const parentPath = machineDocumentVersionPath(projectId, documentId, published.parent_version_id);
    const parent = JSON.parse(h.files.get(parentPath)!.content);
    published.provider_evidence.size -= 4;
    parent.provider_evidence.size -= 4;
    h.put(path, JSON.stringify(published));
    h.put(parentPath, JSON.stringify(parent));

    const slice = budget();
    const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor: null, limit: 8, budget: slice });
    expect(page.entries).toEqual([entry]);
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    h.put(published.immutable_payload_path, "corrupted immutable payload");
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a legacy external published head only while its visible bytes equal the immutable payload", async () => {
    const h = harness();
    const content = "external import index";
    const hash = await sha256Text(content);
    const externalVersionId = "VER-EXT-0123456789ABCDEF01234567";
    const path = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/import-index.md`;
    const payloadPath = machineDocumentTextPayloadPath(projectId, hash);
    h.put(path, content, "id:current-import");
    h.files.set(path, { ...h.files.get(path)!, revision_token: "rev-current-import" });
    h.put(payloadPath, content);
    h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: documentId, kind: "work_product", logical_path: "import-index.md",
      published_version_id: externalVersionId,
      provider: { published: { path, file_id: "id:current-import", rev: "rev-current-import", content_hash: hash, size: content.length } },
      reconciliation_status: "clean"
    }));
    h.put(machineDocumentVersionPath(projectId, documentId, externalVersionId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: documentId, version_id: externalVersionId,
      kind: "work_product", stage: "published", logical_path: "import-index.md", source: "external_human",
      created_at: "2026-09-01T00:00:00Z", immutable_payload_path: payloadPath,
      provider_content_hash: hash, provider_file_id: "id:historical-import", provider_rev: "rev-historical-import",
      provider_path: path, size: content.length
    }));
    const entry: NavigationInventoryEntry = {
      project_id: projectId, zone: "DELIVERABLES", resource_id: `head:${documentId}`, version: externalVersionId,
      logical_path: "import-index.md", path,
      expected: { object_id: "id:current-import", revision_token: "rev-current-import", content_sha256: hash, size: content.length }
    };

    await expect(h.inventory.verifyEntry(entry, budget(100))).resolves.toBe(true);
    h.put(path, "different import data", "id:current-import");
    h.files.set(path, { ...h.files.get(path)!, revision_token: "rev-current-import" });
    await expect(h.inventory.verifyEntry(entry, budget(100))).resolves.toBe(false);
  });

  it("rejects a published version whose immutable bytes differ from its REVIEW parent", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const parentPath = machineDocumentVersionPath(projectId, documentId, "VER-REQ-1123456789ABCDEF01234567");
    const parent = JSON.parse(h.files.get(parentPath)!.content) as Record<string, unknown>;
    const unrelated = "different reviewed bytes";
    const unrelatedHash = await sha256Text(unrelated);
    h.put(machineDocumentTextPayloadPath(projectId, unrelatedHash), unrelated);
    h.put(parentPath, JSON.stringify({ ...parent,
      content_sha256: unrelatedHash,
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, unrelatedHash)
    }));

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("rejects a published move when both provider paths are outside the canonical project workspace root", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h, { providerSlug: "another-project" });

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("rejects a published move when its committed receipt binds a different provider revision", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const savedReceipt = JSON.parse(h.files.get(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1/receipt.json`)!.content);
    const receipt = JSON.parse(savedReceipt.receipt_json);
    receipt.provider_rev = "rev-unrelated";
    h.put(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1/receipt.json`, JSON.stringify({ ...savedReceipt, receipt_json: JSON.stringify(receipt) }));

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("does not accept a published move from its receipt when the execution admission is absent", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const journal = new ExecutionJournal(h.runtime, projectId, "document", "DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1");
    h.files.delete(`${await journal.root()}/admission.json`);

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a governed replacement publication with a new destination object and the exact receipt revision", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h, { currentObjectId: "id:replacement-destination", legacyEnvelope: true });

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
  });

  it("rejects a replacement publication when its receipt does not bind the destination revision", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h, { currentObjectId: "id:replacement-destination", receiptRevision: "rev-unrelated" });

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("advances past a dirty head that cannot be proven instead of emitting the same gap cursor forever", async () => {
    const h = harness();
    const firstId = documentId;
    h.put(machineDocumentHeadPath(projectId, firstId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: firstId, kind: "work_product", logical_path: "draft.md",
      review_version_id: "VER-REQ-1123456789ABCDEF01234567", provider: {}, reconciliation_status: "clean"
    }));
    vi.spyOn(h.sources, "listDirtyPage").mockResolvedValue({ resource_ids: [`head:${firstId}`], next_cursor: null });

    const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor: "dirty:", limit: 8, budget: budget() });

    expect(page.gaps).toEqual([{ resource_id: `head:${firstId}`, code: "active_provider_binding_missing" }]);
    expect(page.next_cursor).toBe("catalog:");
  });

  it("persists head-page cursors and does not skip entries after a provider batch", async () => {
    const h = harness();
    await addWorkingHead(h, "first body");
    const secondId = "DOC-1123456789ABCDEF01234567";
    const secondVersion = "VER-REQ-1123456789ABCDEF01234567";
    await addWorkingHead(h, "second body", "rev-second", secondId, secondVersion, "second.md");
    const thirdId = "DOC-2123456789ABCDEF01234567";
    const thirdVersion = "VER-REQ-2123456789ABCDEF01234567";
    await addWorkingHead(h, "third body", "rev-third", thirdId, thirdVersion, "third.md");

    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    const second = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget() });

    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    expect(second.entries).toHaveLength(1);
    expect(second.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(1);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.resource_id)).size).toBe(3);
  });

  it("resumes an older persisted empty batch cursor from its provider continuation", async () => {
    const h = harness();
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [],
      provider_cursor: "provider-cursor-27",
      listing_limit: 512
    }))}`;
    let received: { cursor: string | null; limit: number } | null = null;
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received = { cursor, limit };
      return { entries: [], cursor: "provider-cursor-28" };
    };

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() });

    expect(received).toEqual({ cursor: "provider-cursor-27", limit: 512 });
    expect(page.next_cursor).not.toBe(saved);
    expect(page.next_cursor?.startsWith("initial:")).toBe(true);
  });

  it("rejects a provider continuation cursor that does not advance", async () => {
    const h = harness();
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [],
      provider_cursor: "provider-cursor-stuck",
      listing_limit: 512
    }))}`;
    h.runtime.pagedListing!.listPage = async ({ cursor }) => ({ entries: [], cursor });

    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() }))
      .rejects.toThrow("navigation_listing_stalled");
  });

  it("fetches the continuation after all saved batch entries have been consumed", async () => {
    const h = harness();
    const id = "DOC-3123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: id,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [{ kind: "file", name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) }],
      provider_cursor: "provider-cursor-41",
      listing_limit: 512
    }))}`;
    let received: { cursor: string | null; limit: number } | null = null;
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received = { cursor, limit };
      return { entries: [], cursor: null };
    };

    const consumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() });
    expect(consumed.next_cursor?.startsWith("initial:")).toBe(true);
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: consumed.next_cursor, limit: 8, budget: budget() });

    expect(received).toEqual({ cursor: "provider-cursor-41", limit: 512 });
    expect(resumed.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
  });

  it("batches managed-head scanning within each 32-call slice without losing cursor entries", async () => {
    const h = harness();
    const expected: string[] = [];
    for (let index = 0; index < 5; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      const version = `VER-REQ-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, version, `doc-${index}.md`);
      expected.push(`head:${id}`);
    }

    const pages = [];
    let cursor: string | null = null;
    do {
      const slice = budget(32);
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: slice });
      expect(slice.calls_left).toBeGreaterThanOrEqual(0);
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    const actual = pages.flatMap((page) => page.entries.map((entry) => entry.resource_id));
    expect(pages[0].entries.length).toBeGreaterThan(1);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(expected.length);
    const headPageCount = h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`).length;
    expect(headPageCount).toBeLessThan(expected.length);
    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
  });

  it("catches up a legacy limit-one artifact cursor within one bounded inventory slice", async () => {
    const h = harness();
    const cursors = ["legacy-artifact-cursor-2", "legacy-artifact-cursor-3", "legacy-artifact-cursor-4", null];
    const received: Array<{ cursor: string | null; limit: number }> = [];
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received.push({ cursor, limit });
      return { entries: [], cursor: cursors.shift() ?? null };
    };

    const slice = budget(32);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "artifacts:legacy-artifact-cursor-1", limit: 8, budget: slice });

    expect(received.length).toBeGreaterThan(1);
    expect(received[0]).toEqual({ cursor: "legacy-artifact-cursor-1", limit: 1 });
    expect(received.slice(1).every((call) => call.limit === 1)).toBe(true);
    expect(page.entries).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("stops a batched legacy cursor before a gap so an orphaned snapshot replays identically", async () => {
    const h = harness();
    const firstId = "ART-NAVIGATION-GAP-0001";
    const firstPath = machineMutationIntentPath(projectId, firstId);
    await seedCommittedArtifact(h, firstId, `${workspaceProjectRoot(projectId, slug)}/REVIEW/other-zone.md`, "other zone");
    h.put(`${firstPath.slice(0, firstPath.lastIndexOf("/"))}/ZZZ-BROKEN.json`, "{}");

    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "artifacts:", limit: 8, budget: budget() });
    const replay = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget() });

    expect(first.entries).toEqual([]);
    expect(first.gaps).toEqual([]);
    expect(first.next_cursor).toBe(`artifacts:${encodeURIComponent(firstPath)}`);
    expect(replay.gaps).toContainEqual({ resource_id: "ZZZ-BROKEN.json", code: "artifact_intent_listing_invalid" });
  });

  it("fails closed when Dropbox repeats the same listing cursor", async () => {
    const h = harness();
    h.runtime.pagedListing!.listPage = async ({ cursor }) => ({ entries: [], cursor });
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "initial:opaque", limit: 8, budget: budget() }))
      .rejects.toThrow("navigation_listing_stalled");
  });

  it("captures a sub-512-head initial listing without a fragile continuation cursor", async () => {
    const h = harness();
    for (let index = 0; index < 9; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(40) });
    expect(h.pageLimits[0]).toBe(512);
    expect(page.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
  });

  it("uses the cheap path for inactive heads so a bounded slice does not stall on them", async () => {
    const h = harness();
    for (let index = 0; index < 8; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const slice = budget(25);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor: null, limit: 8, budget: slice });
    expect(page.entries).toEqual([]);
    expect(page.gaps).toEqual([]);
    expect(page.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("consumes a bounded batch of irrelevant heads before checkpointing the initial inventory", async () => {
    const h = harness();
    const originalRead = h.runtime.objects.readText.bind(h.runtime.objects);
    let concurrentHeadReads = 0;
    let peakHeadReads = 0;
    h.runtime.objects.readText = async (path) => {
      if (!path.includes("/documents/heads/")) return originalRead(path);
      concurrentHeadReads += 1;
      peakHeadReads = Math.max(peakHeadReads, concurrentHeadReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await originalRead(path); }
      finally { concurrentHeadReads -= 1; }
    };
    for (let index = 0; index < 24; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `other-zone-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const slice = budget(32);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor: null, limit: 8, budget: slice });
    expect(page.entries).toEqual([]);
    expect(page.gaps).toEqual([]);
    expect(page.next_cursor?.startsWith("initial:")).toBe(true);
    const pending = JSON.parse(decodeURIComponent(page.next_cursor!.slice("initial:".length))) as { entries: unknown[] };
    expect(pending.entries.length).toBeLessThanOrEqual(12);
    expect(peakHeadReads).toBeGreaterThanOrEqual(4);
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("does not skip an active head mixed into a batch of irrelevant heads", async () => {
    const h = harness();
    const activeId = "DOC-000000000000000000000005";
    for (let index = 0; index < 12; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      if (id === activeId) {
        await addWorkingHead(h, "active body", "rev-active", id, `VER-REQ-${id.slice(4)}`, "active.md");
      } else {
        h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
          schema_version: "1.0", project_id: projectId, document_id: id,
          kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
        }));
      }
    }
    let cursor: string | null = null;
    const found: string[] = [];
    for (let slice = 0; slice < 8; slice++) {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });
      found.push(...page.entries.map((entry) => entry.resource_id));
      expect(page.gaps).toEqual([]);
      cursor = page.next_cursor;
      if (cursor?.startsWith("packages:")) break;
    }
    expect(cursor?.startsWith("packages:")).toBe(true);
    expect(found).toEqual([`head:${activeId}`]);
  });

  it("does not exhaust a resumed slice by reading five irrelevant heads after an active first head", async () => {
    const h = harness();
    const ids = Array.from({ length: 6 }, (_, index) => `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`);
    await addWorkingHead(h, "active body", "rev-active", ids[0], `VER-REQ-${ids[0].slice(4)}`, "active.md");
    for (const id of ids.slice(1)) h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: id,
      kind: "work_product", logical_path: `${id}.md`, reconciliation_status: "clean"
    }));
    const cursor = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: ids.map((id) => ({ kind: "file", name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) })),
      provider_cursor: null,
      listing_limit: 512
    }))}`;

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(20) });

    expect(page.entries.map((entry) => entry.resource_id)).toContain(`head:${ids[0]}`);
    expect(page.next_cursor).not.toBe(cursor);
  });

  it("checks the inactive prefix together even when the next head is active", async () => {
    const h = harness();
    const activeId = "DOC-000000000000000000000005";
    for (let index = 0; index < 12; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      if (id === activeId) await addWorkingHead(h, "active body", "rev-active", id, `VER-REQ-${id.slice(4)}`, "active.md");
      else h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const originalRead = h.sources.readCatalogEntry.bind(h.sources);
    let concurrentCatalogReads = 0;
    let peakCatalogReads = 0;
    vi.spyOn(h.sources, "readCatalogEntry").mockImplementation(async (...args) => {
      concurrentCatalogReads += 1;
      peakCatalogReads = Math.max(peakCatalogReads, concurrentCatalogReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await originalRead(...args); }
      finally { concurrentCatalogReads -= 1; }
    });
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    expect(page.gaps).toEqual([]);
    expect(peakCatalogReads).toBeGreaterThanOrEqual(4);
  });

  it("keeps the initial cursor at a failed batch and resumes without losing the active head", async () => {
    const h = harness();
    const activeId = "DOC-000000000000000000000005";
    for (let index = 0; index < 12; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      if (id === activeId) await addWorkingHead(h, "active body", "rev-active", id, `VER-REQ-${id.slice(4)}`, "active.md");
      else h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const failedPath = machineDocumentHeadPath(projectId, "DOC-000000000000000000000004");
    h.readErrors.set(failedPath, new Error("temporary provider read failure"));
    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    expect(first.next_cursor?.startsWith("initial:")).toBe(true);
    h.readErrors.delete(failedPath);
    let cursor = first.next_cursor;
    const found = [...first.entries.map((entry) => entry.resource_id)];
    for (let slice = 0; slice < 8 && cursor?.startsWith("initial:"); slice++) {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });
      found.push(...page.entries.map((entry) => entry.resource_id));
      cursor = page.next_cursor;
    }
    expect(cursor?.startsWith("packages:")).toBe(true);
    expect(found).toEqual([`head:${activeId}`]);
  });

  it("defers an active head when its proof budget is short, then resumes the exact source", async () => {
    const h = harness();
    await addWorkingHead(h, "active body");
    const short = budget(15);
    const deferred = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: short });
    expect(deferred.entries).toEqual([]);
    expect(deferred.next_cursor?.startsWith("initial:")).toBe(true);
    expect(short.calls_left).toBeGreaterThanOrEqual(0);
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: deferred.next_cursor, limit: 8, budget: budget(15) })).rejects.toThrow("slice_budget_exhausted");
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: deferred.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries.map((entry) => entry.resource_id)).toEqual([`head:${documentId}`]);
    expect(resumed.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(await h.inventory.verifyEntry(resumed.entries[0], budget(12))).toBe(true);
  });

  it("adopts two independent ordinary active heads in one bounded slice", async () => {
    const h = harness();
    const originalMetadata = h.runtime.objects.getMetadata.bind(h.runtime.objects);
    let active = 0;
    let peak = 0;
    h.runtime.objects.getMetadata = async (path) => {
      if (!path.includes("/WORKING/")) return originalMetadata(path);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await originalMetadata(path); }
      finally { active -= 1; }
    };
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const slice = budget(32);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: slice });
    expect(page.entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));
    expect(page.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(peak).toBe(2);
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("resumes the saved active-head suffix without listing the provider page again", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222", "DOC-333333333333333333333333"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    expect(first.entries.map((entry) => entry.resource_id)).toEqual(ids.slice(0, 2).map((id) => `head:${id}`));
    const originalList = h.runtime.pagedListing!.listPage;
    h.runtime.pagedListing!.listPage = async (input) => {
      if (input.path === `${machineDocumentRoot(projectId)}/heads`) throw new Error("saved_page_relisted");
      return originalList(input);
    };
    const second = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget(32) });
    expect(second.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[2]}`]);
    expect(second.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
  });

  it("pipelines a saved provider suffix with the guard's remaining 28-call budget", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const deferred = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(8) });
    expect(deferred.entries).toEqual([]);
    const originalList = h.runtime.pagedListing!.listPage;
    h.runtime.pagedListing!.listPage = async (input) => {
      if (input.path === `${machineDocumentRoot(projectId)}/heads`) throw new Error("saved_page_relisted");
      return originalList(input);
    };
    const slice = budget(28);
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: deferred.next_cursor, limit: 8, budget: slice });
    expect(resumed.entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));
    expect(slice.calls_left).toBeGreaterThanOrEqual(4);
  });

  it("keeps the first unfinished head in the cursor after a transient second-sidecar failure", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const secondSidecar = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(`head:${ids[1]}`)}.json`;
    const originalWrite = h.runtime.objects.createText.bind(h.runtime.objects);
    let injected = false;
    h.runtime.objects.createText = async (path, content) => {
      if (path === secondSidecar && !injected) {
        injected = true;
        throw new ProviderOperationError("temporary Dropbox failure", true);
      }
      return originalWrite(path, content);
    };
    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    expect(injected).toBe(true);
    expect(first.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[0]}`]);
    const second = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget(32) });
    expect(second.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
  });

  it("preserves checkpoint budget after a late nonretryable second-sidecar conflict", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const baseline = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(2000) });
    expect(baseline.entries.map((entry) => entry.resource_id)).toEqual(ids.map((id) => `head:${id}`));
    const owner = "DOCREQ-NAV-SIDECAR-CONFLICT-OWNER-0001";
    expect(await h.sources.beginAdoption(projectId, "WORKING", owner, 0, budget(2000))).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", baseline.entries[0].resource_id, budget(2000), null, true);
    await h.sources.completeHeadWrite(ticket, baseline.entries[0], budget(2000));
    for (const entry of baseline.entries) await h.sources.recordVerifiedCatalogEntry(entry, "source:1", budget(2000));
    expect(await h.sources.finishDirty(projectId, "WORKING", baseline.entries[0].resource_id, baseline.entries[0], budget(2000))).toBe(true);
    expect(await h.sources.markCatalogReady(projectId, "WORKING", 1, budget(2000))).toBe(true);

    const secondSidecar = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(`head:${ids[1]}`)}.json`;
    const short = budget(29);
    const firstPage = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: short });
    expect(firstPage.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[0]}`]);
    expect(firstPage.next_cursor).toContain(ids[1]);
    expect(short.calls_left).toBeGreaterThanOrEqual(4);

    const originalConditionalWrite = h.runtime.conditionalWrite.writeTextConditional.bind(h.runtime.conditionalWrite);
    let injected = 0;
    h.runtime.conditionalWrite.writeTextConditional = async (path, content, revisionToken) => {
      if (path === secondSidecar) {
        injected += 1;
        throw new ProviderOperationError("sidecar conflict", false);
      }
      return originalConditionalWrite(path, content, revisionToken);
    };
    const retry = budget(32);
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: firstPage.next_cursor, limit: 8, budget: retry }))
      .rejects.toThrow("sidecar conflict");
    expect(injected).toBeGreaterThan(0);
    expect(retry.calls_left).toBeGreaterThanOrEqual(4);
    h.runtime.conditionalWrite.writeTextConditional = originalConditionalWrite;
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: firstPage.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
  });

  it("classifies a malformed first observation without stalling its following head", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const headPath = machineDocumentHeadPath(projectId, ids[0]);
    const head = JSON.parse(h.files.get(headPath)!.content);
    delete head.provider.working.rev;
    h.put(headPath, JSON.stringify(head));
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    expect(page.gaps.some((gap) => gap.resource_id === `head:${ids[0]}`)).toBe(true);
    expect(page.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
  });

  it("does not create a new tombstone for an unverified visible file", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    const paths = [];
    for (const [index, id] of ids.entries()) {
      paths.push(await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`));
    }
    h.put(paths[0], "wrong bytes", "id:visible");
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(32) });
    const sidecar = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(`head:${ids[0]}`)}.json`;
    expect(page.gaps).toContainEqual({ resource_id: `head:${ids[0]}`, code: "active_provider_content_unverified" });
    expect(h.files.has(sidecar)).toBe(false);
    expect(page.entries.map((entry) => entry.resource_id)).toEqual([`head:${ids[1]}`]);
  });

  it("keeps legacy immutable-payload proofs on the sequential path", async () => {
    const h = harness();
    const ids = ["DOC-111111111111111111111111", "DOC-222222222222222222222222"];
    for (const [index, id] of ids.entries()) {
      await addWorkingHead(h, `body ${index}`, `rev-${index}`, id, `VER-REQ-${id.slice(4)}`, `draft-${index}.md`);
    }
    const versionPath = machineDocumentVersionPath(projectId, ids[0], `VER-REQ-${ids[0].slice(4)}`);
    const version = JSON.parse(h.files.get(versionPath)!.content);
    version.schema_version = "2.0";
    delete version.content_sha256;
    delete version.provider_file_id;
    delete version.provider_rev;
    delete version.provider_path;
    delete version.size;
    version.provider_evidence = {
      provider_id: "test", object_id: "id:visible", revision_token: "rev-0",
      path: `${workspaceProjectRoot(projectId, slug)}/WORKING/draft-0.md`,
      integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size: 6
    };
    h.put(version.immutable_payload_path, "body 0");
    h.put(versionPath, JSON.stringify(version));
    const originalMetadata = h.runtime.objects.getMetadata.bind(h.runtime.objects);
    let active = 0;
    let peak = 0;
    h.runtime.objects.getMetadata = async (path) => {
      if (!path.includes("/WORKING/")) return originalMetadata(path);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await originalMetadata(path); }
      finally { active -= 1; }
    };
    const slice = budget(50);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: slice });
    expect(page.entries).toHaveLength(2);
    expect(peak).toBe(1);
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("avoids a null catalog write for a clean inactive head but clears a stale catalog row", async () => {
    const h = harness();
    const visiblePath = await addWorkingHead(h, "current body");
    const headPath = machineDocumentHeadPath(projectId, documentId);
    const head = JSON.parse(h.files.get(headPath)!.content);
    delete head.working_version_id;
    delete head.provider.working;
    h.put(headPath, JSON.stringify(head), "id:head");
    const catalogPath = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(`head:${documentId}`)}.json`;
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    expect(page.entries).toHaveLength(0);
    expect(h.files.has(catalogPath)).toBe(false);

    const stale = await addWorkingHead(h, "restored body", "rev-restored");
    const active = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    expect(active.entries).toHaveLength(1);
    const activeHead = JSON.parse(h.files.get(headPath)!.content);
    delete activeHead.working_version_id;
    delete activeHead.provider.working;
    h.put(headPath, JSON.stringify(activeHead), "id:head");
    for (let index = 0; index < 6; index++) {
      const id = `DOC-${(index + 1).toString(16).toUpperCase().padStart(24, "0")}`;
      h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `unrelated-${index}.md`, reconciliation_status: "clean"
      }));
    }
    await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    expect(JSON.parse(h.files.get(catalogPath)!.content).entry).toBeNull();
    expect(stale).toBe(visiblePath);
  });

  it("includes only a finalized current package index as a bounded canonical source", async () => {
    const store = packageRuntime();
    const runtime = store.runtime;
    const repository = new DocumentLedgerRepository(runtime);
    const state = emptyProjectState("PRJ-9300", "Packages", "packages");
    const members = [] as { relative_path: string; document_id: string; document_version_id: string; immutable_payload_path: string; content_sha256: string; size: number }[];
    for (let index = 1; index <= 4; index += 1) {
      const suffix = index.toString(16).padStart(24, "0").toUpperCase();
      const body = `package member ${index}`;
      const content_sha256 = await sha256Text(body);
      const document_id = `DOC-${suffix}`;
      const document_version_id = `VER-REQ-${suffix}`;
      const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, body);
      const relative_path = `member-${index}.md`;
      await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: relative_path, source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: body.length });
      members.push({ relative_path, document_id, document_version_id, immutable_payload_path, content_sha256, size: body.length });
    }
    const manifest = { schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members,
      links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
    const ref = await repository.freezePackage(manifest);
    const request = { operation: "package.replace" as const, request_id: "DOCREQ-REPLACE-0001", project_id: state.project_id, candidate: ref, zone: "WORKING" as const, expected_navigation_generation: 0, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
    const admission = { project_id: state.project_id, operation: "package.replace", kind: "document", request_id: request.request_id, request_hash: await sha256Text(canonicalJson(request)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: ref.package_id, resource_type: "package", zone: "WORKING", version: `${ref.version}:${ref.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    const result = await new ManagedDocumentService(runtime).replacePackage(request, state, admission as never);
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    runtime.pagedListing = { listPage: async ({ path, cursor, limit }) => {
      const matching = [...store.files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/" )).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } };
    runtime.objects.listChildren = async () => { throw new Error("unbounded listChildren forbidden"); };
    const sources = new ZoneNavigationSources(runtime);
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor, limit: 8, budget: budget(25) });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    const entries = pages.flatMap((page) => page.entries);
    expect(pages).toHaveLength(6);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `package:${ref.package_id}`, logical_path: `PACKAGES/${ref.package_id}/1/INDEX.md`, version: `1:${ref.manifest_sha256}` });
    expect(await inventory.verifyEntry(entries[0], budget())).toBe(true);
    expect(pages.flatMap((page) => page.gaps)).not.toContainEqual(expect.objectContaining({ resource_id: "packages" }));

    const resourceId = `package:${ref.package_id}`;
    const ticket = await sources.beginHeadWrite(state.project_id, "WORKING", resourceId, budget());
    const nextBody = "replacement package member";
    const nextHash = await sha256Text(nextBody);
    const nextDocumentId = `DOC-${"3".repeat(24)}`;
    const nextVersionId = `VER-REQ-${"3".repeat(24)}`;
    const nextPayload = await repository.storeTextPayload(state.project_id, nextHash, nextBody);
    await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id: nextDocumentId, version_id: nextVersionId, kind: "work_product", stage: "working", logical_path: "replacement.md", source: "project_os", created_at: "2026-09-13T12:00:00Z", immutable_payload_path: nextPayload, content_sha256: nextHash, size: nextBody.length });
    const nextManifest = { schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 2, predecessor: ref, members: [{ relative_path: "replacement.md", document_id: nextDocumentId, document_version_id: nextVersionId, immutable_payload_path: nextPayload, content_sha256: nextHash, size: nextBody.length }], links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-13T12:00:00Z" };
    const nextRef = await repository.freezePackage(nextManifest);
    expect(nextRef.package_id).toBe(ref.package_id);
    const nextRequest = { operation: "package.replace" as const, request_id: "DOCREQ-REPLACE-0002", project_id: state.project_id, candidate: nextRef, zone: "WORKING" as const, expected_navigation_generation: 1, expected_project_revision: 0, created_at: "2026-09-13T12:00:00Z" };
    const nextAdmission = { project_id: state.project_id, operation: "package.replace", kind: "document", request_id: nextRequest.request_id, request_hash: await sha256Text(canonicalJson(nextRequest)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: nextRef.package_id, resource_type: "package", zone: "WORKING", version: `${nextRef.version}:${nextRef.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "b".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    expect((await new ManagedDocumentService(runtime).replacePackage(nextRequest, state, nextAdmission as never)).status).toBe("finalized");
    await sources.completeHeadWrite(ticket, null, budget());

    const refreshedPages = [];
    let refreshedCursor: string | null = null;
    do {
      const page = await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: refreshedCursor, limit: 8, budget: budget(25) });
      refreshedPages.push(page);
      refreshedCursor = page.next_cursor;
    } while (refreshedCursor !== null);
    const refreshedEntries = refreshedPages.flatMap((page) => page.entries).filter((entry) => entry.resource_id === resourceId);
    expect(refreshedEntries).toHaveLength(1);
    expect(refreshedEntries[0].version).toBe(`2:${nextRef.manifest_sha256}`);
    expect(await inventory.verifyEntry(refreshedEntries[0], budget())).toBe(true);
    expect(await inventory.verifyEntry(entries[0], budget())).toBe(false);
    expect(await inventory.verifySnapshot({ project_id: state.project_id, zone: "WORKING", snapshot_id: refreshedPages[0].snapshot_id, budget: budget() })).toBe(true);

    const transientTicket = await sources.beginHeadWrite(state.project_id, "WORKING", resourceId, budget());
    await sources.completeHeadWrite(transientTicket, null, budget());
    const transientStart = await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: null, limit: 8, budget: budget(25) });
    expect(transientStart.next_cursor).not.toBeNull();
    const transientReadBytes = runtime.objects.readBytes;
    let failOnce = true;
    runtime.objects.readBytes = async (...args) => {
      if (failOnce && args[0] === packageNavigationPath(state.project_id)) {
        failOnce = false;
        throw new ProviderOperationError("temporary package ledger read failure", true);
      }
      return transientReadBytes!(...args);
    };
    await expect(inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: transientStart.next_cursor, limit: 8, budget: budget(25) }))
      .rejects.toThrow("temporary package ledger read failure");
    runtime.objects.readBytes = transientReadBytes;
    let retryCursor = transientStart.next_cursor;
    for (let attempt = 0; retryCursor !== null && attempt < 8; attempt += 1) {
      retryCursor = (await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: retryCursor, limit: 8, budget: budget(25) })).next_cursor;
    }
    expect(retryCursor).toBeNull();

    const permanentTicket = await sources.beginHeadWrite(state.project_id, "WORKING", resourceId, budget());
    await sources.completeHeadWrite(permanentTicket, null, budget());
    const memberPath = `${workspaceProjectRoot(state.project_id, state.slug)}/WORKING/PACKAGES/${nextRef.package_id}/2/replacement.md`;
    await runtime.objects.upsertText(memberPath, "bytes no longer match finalized package evidence");
    const permanentStart = await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: null, limit: 8, budget: budget(25) });
    expect(permanentStart.next_cursor).not.toBeNull();
    const permanentResult = await inventory.listPage({ project_id: state.project_id, zone: "WORKING", cursor: permanentStart.next_cursor, limit: 8, budget: budget(25) });
    expect(permanentResult.gaps).toContainEqual(expect.objectContaining({ resource_id: resourceId, code: "finalized_package_source_unavailable" }));
    expect(permanentResult.next_cursor).toBe("artifacts:");
    expect(await inventory.verifyEntry(refreshedEntries[0], budget())).toBe(false);
  });

  it("finishes legacy-page package verification for 40 members in resumable 32-call slices", async () => {
    const store = packageRuntime();
    const runtime = store.runtime;
    const repository = new DocumentLedgerRepository(runtime);
    const state = emptyProjectState("PRJ-9300", "Packages", "packages");
    const members = [] as { relative_path: string; document_id: string; document_version_id: string; immutable_payload_path: string; content_sha256: string; size: number }[];
    for (let index = 1; index <= 40; index += 1) {
      const suffix = index.toString(16).padStart(24, "0").toUpperCase();
      const body = `package member ${index}`;
      const content_sha256 = await sha256Text(body);
      const document_id = `DOC-${suffix}`;
      const document_version_id = `VER-REQ-${suffix}`;
      const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, body);
      const relative_path = `member-${index}.md`;
      await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: relative_path, source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: body.length });
      members.push({ relative_path, document_id, document_version_id, immutable_payload_path, content_sha256, size: body.length });
    }
    const ref = await repository.freezePackage({ schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members, links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" });
    const packageRequest = { operation: "package.replace" as const, request_id: "DOCREQ-REPLACE-0001", project_id: state.project_id, candidate: ref, zone: "WORKING" as const, expected_navigation_generation: 0, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
    const packageAdmission = { project_id: state.project_id, operation: "package.replace", kind: "document", request_id: packageRequest.request_id, request_hash: await sha256Text(canonicalJson(packageRequest)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: ref.package_id, resource_type: "package", zone: "WORKING", version: `${ref.version}:${ref.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    expect((await new ManagedDocumentService(runtime).replacePackage(packageRequest, state, packageAdmission as never)).status).toBe("finalized");
    runtime.pagedListing = { listPage: async ({ path, cursor, limit }) => {
      const matching = [...store.files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/" )).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } };
    runtime.objects.listChildren = async () => { throw new Error("unbounded listChildren forbidden"); };
    const sources = new ZoneNavigationSources(runtime);
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const request = navigationReconcileSchema.parse({ operation: "navigation.reconcile", request_id: "DOCREQ-NAVIGATION-PACKAGE-0001", project_id: state.project_id, zone: "WORKING", expected_project_revision: 0, expected_generation: 0, expected_index: null, created_at: "2026-09-26T18:00:00.000Z" });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(state.project_id, state.slug)}/WORKING/00-CURRENT.md`;
    const resourceId = "navigation:WORKING";
    const admission = { project_id: state.project_id, request_id: request.request_id, kind: "document", operation: "navigation.reconcile", request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" }, resources: [{ resource_id: resourceId, resource_type: "navigation", zone: "WORKING", version: "0" }], resource_effect_scopes: [{ resource_id: resourceId, resource_version: "0", provider_id: runtime.providerId, sources: [], destinations: [{ path: indexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    const completionCursors: Array<string | null> = [];
    let holdCompletionOnce = true;
    const navigationProgressPath = `${await new ExecutionJournal(runtime, state.project_id, "document", request.request_id).root()}/navigation-progress.json`;
    const legacyPort: NavigationInventoryPort = {
      listPage: async (input) => { const page = await inventory.listPage(input); const { verified_entries: _proof, ...withoutProof } = page; return withoutProof; },
      verifySnapshot: inventory.verifySnapshot.bind(inventory), verifyEntry: inventory.verifyEntry.bind(inventory), verifyEntryPage: inventory.verifyEntryPage.bind(inventory),
      verificationIncludesPhysicalIntegrity: true, recordVerifiedEntry: inventory.recordVerifiedEntry.bind(inventory),
      completeSnapshot: async (input) => {
        completionCursors.push(input.cursor ?? null);
        if (completionCursors.length > 1) {
          const saved = store.files.get(navigationProgressPath)?.content;
          expect(saved && (JSON.parse(saved) as { completion_cursor?: string | null }).completion_cursor).toBe(input.cursor ?? null);
        }
        if (holdCompletionOnce) {
          holdCompletionOnce = false;
          return { status: "pending", cursor: "catalog:" };
        }
        return inventory.completeSnapshot(input);
      }
    };
    let result = await new ZoneNavigationEngine(runtime, legacyPort).reconcile(request, state, admission as never, budget(32));
    const savedCompletionCursors: Array<string | null> = [];
    const saveCursor = () => {
      const raw = store.files.get(navigationProgressPath)?.content;
      if (raw) savedCompletionCursors.push((JSON.parse(raw) as { completion_cursor?: string | null }).completion_cursor ?? null);
    };
    saveCursor();
    for (let attempt = 0; result.status === "pending" && attempt < 160; attempt += 1) {
      result = await new ZoneNavigationEngine(runtime, legacyPort).reconcile(request, state, admission as never, budget(32));
      saveCursor();
    }
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    expect(completionCursors[0]).toBeNull();
    expect(completionCursors.slice(0, 2)).toEqual([null, "catalog:"]);
    expect(savedCompletionCursors).toContain(completionCursors[1]);
    expect(await sources.listDirtyPage(state.project_id, "WORKING", null, 1, budget(32))).toMatchObject({ resource_ids: [], next_cursor: null });
  });

  it("clears a pre-existing dirty REVIEW head only after the census proves its zone tombstone", async () => {
    const h = harness();
    const state = emptyProjectState(projectId, "Project OS", slug);
    await addWorkingHead(h, "working-only canonical head");
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-NAV-INITIAL-DIRTY-PRJ0002", project_id: projectId,
      zone: "REVIEW", expected_project_revision: state.revision, expected_generation: 0,
      expected_index: null, created_at: "2026-09-27T12:00:00.000Z"
    });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(projectId, slug)}/REVIEW/00-CURRENT.md`;
    const admission = {
      project_id: projectId, request_id: request.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: "navigation:REVIEW", resource_type: "navigation", zone: "REVIEW", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:REVIEW", resource_version: "0", provider_id: h.runtime.providerId,
        sources: [], destinations: [{ path: indexPath, logical_path: "REVIEW/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: state.revision },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    expect(await h.sources.beginAdoption(projectId, "REVIEW", "DOCREQ-NAV-PRIOR-PRJ0002", 0, budget())).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "REVIEW", `head:${documentId}`, budget());
    await h.sources.completeHeadWrite(ticket, null, budget());
    expect(await h.sources.readState(projectId, "REVIEW", budget())).toMatchObject({ generation: 1, adopted: false, adoption_request_id: "DOCREQ-NAV-PRIOR-PRJ0002" });
    expect((await h.sources.listDirtyPage(projectId, "REVIEW", null, 1, budget())).resource_ids).toEqual([`head:${documentId}`]);
    expect(await h.sources.beginAdoption(projectId, "REVIEW", request.request_id, 1, budget())).toBe(true);
    const progressPath = `${await new ExecutionJournal(h.runtime, projectId, "document", request.request_id).root()}/navigation-progress.json`;
    let result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });
    let afterCensus: { inventory_complete: boolean; verify_page: number; page_count: number; snapshot_id: string; source_ids: string[] } | undefined;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const rawProgress = h.files.get(progressPath)?.content;
      if (rawProgress) {
        const candidate = JSON.parse(rawProgress) as typeof afterCensus;
        if (candidate?.inventory_complete && candidate.verify_page === candidate.page_count) {
          afterCensus = candidate;
          break;
        }
      }
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });
    }
    expect(afterCensus).toMatchObject({ inventory_complete: true, verify_page: afterCensus?.page_count, snapshot_id: "source:1", source_ids: [] });
    const completedPageCount = afterCensus!.page_count;
    for (let attempt = 0; result.status === "pending" && attempt < 24; attempt += 1) result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });

    expect(result.status, JSON.stringify(result)).toBe("prepared");
    const finalProgress = JSON.parse(h.files.get(progressPath)!.content) as { inventory_complete: boolean; verify_page: number; page_count: number; snapshot_id: string };
    expect(finalProgress).toMatchObject({ inventory_complete: true, verify_page: completedPageCount, page_count: completedPageCount, snapshot_id: "source:1" });
    expect(await h.sources.listDirtyPage(projectId, "REVIEW", null, 1, budget())).toMatchObject({ resource_ids: [], next_cursor: null });
    expect(await h.sources.readState(projectId, "REVIEW", budget())).toMatchObject({ generation: 1, adoption_request_id: request.request_id });
  });

  it("clears a pre-existing active WORKING head and finalizes in bounded 32-call slices", async () => {
    const h = harness();
    const state = emptyProjectState(projectId, "Project OS", slug);
    const content = "# active dirty working head\n";
    await addWorkingHead(h, content);
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-NAV-INITIAL-ACTIVE-PRJ0002", project_id: projectId,
      zone: "WORKING", expected_project_revision: state.revision, expected_generation: 0,
      expected_index: null, created_at: "2026-09-27T12:00:00.000Z"
    });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/00-CURRENT.md`;
    const admission = {
      project_id: projectId, request_id: request.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:WORKING", resource_version: "0", provider_id: h.runtime.providerId,
        sources: [], destinations: [{ path: indexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: state.revision },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    expect(await h.sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAV-PRIOR-WORKING-PRJ0002", 0, budget())).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", `head:${documentId}`, budget());
    await h.sources.completeHeadWrite(ticket, null, budget());
    expect(await h.sources.beginAdoption(projectId, "WORKING", request.request_id, 1, budget())).toBe(true);

    const progressPath = `${await new ExecutionJournal(h.runtime, projectId, "document", request.request_id).root()}/navigation-progress.json`;
    const sliceCalls: number[] = [];
    let sliceBudget = budget(32);
    let before = h.providerCalls;
    let result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, sliceBudget, { deferPublication: true });
    sliceCalls.push(h.providerCalls - before);
    for (let attempt = 0; result.status === "pending" && attempt < 24; attempt += 1) {
      sliceBudget = budget(32);
      before = h.providerCalls;
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, sliceBudget, { deferPublication: true });
      sliceCalls.push(h.providerCalls - before);
    }

    expect(result.status, JSON.stringify(result)).toBe("prepared");
    expect(sliceCalls.length).toBeLessThanOrEqual(24);
    expect(sliceCalls.every((count) => count <= 32)).toBe(true);
    const preparationSlices = sliceCalls.length;
    const legacyProgressFile = h.files.get(progressPath)!;
    const legacyProgress = JSON.parse(legacyProgressFile.content) as Record<string, unknown>;
    delete legacyProgress.completion_cursor;
    h.files.set(progressPath, { ...legacyProgressFile, content: canonicalJson(legacyProgress) });
    const publicationCalls: number[] = [];
    for (let attempt = 0; result.status !== "finalized" && attempt < 24; attempt += 1) {
      sliceBudget = budget(32);
      before = h.providerCalls;
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).publishPrepared(request, state, admission as never, sliceBudget, "source:1");
      publicationCalls.push(h.providerCalls - before);
    }
    expect(result.status, JSON.stringify({ result, preparationSlices, sliceCalls, publicationCalls })).toBe("finalized");
    expect(result).toMatchObject({ status: "finalized", receipt: { status: "committed", project_id: projectId,
      request_id: request.request_id, zone: "WORKING", generation: 1, source_snapshot_id: "source:1" } });
    expect(publicationCalls.length).toBeLessThanOrEqual(24);
    expect(publicationCalls.every((count) => count <= 32)).toBe(true);
    const progress = JSON.parse(h.files.get(progressPath)!.content) as { snapshot_id: string; inventory_complete: boolean; verify_page: number; page_count: number };
    expect(progress).toMatchObject({ snapshot_id: "source:1", inventory_complete: true, verify_page: progress.page_count });
    expect(progress).toMatchObject({ status: "finalized" });
    const catalog = await h.sources.readCatalogEntry(projectId, "WORKING", `head:${documentId}`, budget());
    expect(catalog?.expected.content_sha256).toBe(await sha256Text(content));
    expect(await h.sources.listDirtyPage(projectId, "WORKING", null, 1, budget())).toMatchObject({ resource_ids: [], next_cursor: null });
    expect(await h.sources.readState(projectId, "WORKING", budget())).toMatchObject({ generation: 1, adoption_request_id: request.request_id });
    const headPath = `${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`;
    expect(JSON.parse(h.files.get(headPath)!.content)).toMatchObject({ generation: 1, source_request_id: request.request_id });
    expect(h.files.get(indexPath)?.content).toContain("](./draft.md)");
  });

  it("includes a committed artifact only from its exact current destination and receipt", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-001", destination, "approved artifact");

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, budget: budget() });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    const entries = pages.flatMap((page) => page.entries);
    const proofs = pages.flatMap((page) => page.verified_entries ?? []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `artifact:${await sha256Text(destination)}`, version: `ART-NAVIGATION-001:${await sha256Text("approved artifact")}`, logical_path: "report.md", path: destination });
    expect(proofs).toEqual([{ resource_id: entries[0].resource_id, entry_hash: await sha256Text(canonicalJson(entries[0])), persisted: false }]);
    expect(await h.inventory.verifyEntry(entries[0], budget())).toBe(true);
  });

  it("omits a removed artifact only when its exact governed quarantine is committed", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-001", destination, "old report");
    h.files.delete(destination);
    const docId = await documentIdFor(projectId, "report.md");
    const quarantineId = "DOCREQ-NAVIGATION-QUARANTINE-001";
    const root = `${machineDocumentRoot(projectId)}/quarantines/${quarantineId}`;
    const archivePath = `${workspaceProjectRoot(projectId, slug)}/ARCHIVES/QUARANTINED-PUBLISHED/${docId}/VER-REQ-0123456789ABCDEF01234567/${quarantineId}/report.md`;
    h.put(machineDocumentHeadPath(projectId, docId), JSON.stringify({ schema_version: "2.0", project_id: projectId, document_id: docId, kind: "work_product", logical_path: "report.md", provider: {}, reconciliation_status: "clean" }));
    h.put(archivePath, "old report");
    const proof = { schema_version: "1.0", operation: "document.quarantine_instance", request_id: quarantineId, project_id: projectId, document_id: docId, version_id: "VER-REQ-0123456789ABCDEF01234567", logical_path: "report.md", archive_path: archivePath, provider: { path: destination, object_id: "id:artifact", revision_token: "rev:original", size: 10 }, content_sha256: await sha256Text("old report") };
    const proofText = canonicalJson(proof);
    h.put(`${root}/receipt.json`, proofText);
    const quarantineRequest = canonicalJson({ operation: "document.quarantine_instance", request_id: quarantineId, project_id: projectId, document_id: docId, created_at: "2026-09-30T00:00:00Z", expected_project_revision: 1, observed_provider: proof.provider });
    const quarantineRequestHash = await sha256Text(quarantineRequest);
    h.put(`${machineDocumentRoot(projectId)}/requests/${quarantineId}/receipt.json`, canonicalJson({ schema_version: "1.0", project_id: projectId, request_id: quarantineId, request_sha256: quarantineRequestHash, request_json: quarantineRequest, receipt_json: canonicalJson({ status: "committed", operation: "document.quarantine_instance", request_id: quarantineId, project_id: projectId, document_id: docId, archive_path: archivePath, proof_ref: `${root}/receipt.json`, proof_sha256: await sha256Text(proofText), content_sha256: proof.content_sha256, provider_rev: "rev:original", request_payload_sha256: quarantineRequestHash }) }));
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, mode: "canonical_catalog_rebuild", budget: budget() });
      pages.push(page); cursor = page.next_cursor;
    } while (cursor !== null);
    expect(pages.flatMap((page) => page.gaps)).toEqual([]);
    expect(pages.flatMap((page) => page.entries)).toEqual([]);
    h.files.delete(`${root}/receipt.json`);
    const unproved = [];
    cursor = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, mode: "canonical_catalog_rebuild", budget: budget() });
      unproved.push(page); cursor = page.next_cursor;
    } while (cursor !== null);
    expect(unproved.flatMap((page) => page.gaps)).toContainEqual({ resource_id: `artifact:${await sha256Text(destination)}`, code: "committed_artifact_source_out_of_bounds" });
    h.put(`${root}/receipt.json`, proofText);
    await seedCommittedArtifact(h, "ART-NAVIGATION-NEW-001", destination, "new report", "2026-10-01T00:00:00Z");
    h.files.delete(destination);
    const newer = [];
    cursor = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, mode: "canonical_catalog_rebuild", budget: budget() });
      newer.push(page); cursor = page.next_cursor;
    } while (cursor !== null);
    expect(newer.flatMap((page) => page.gaps)).toContainEqual({ resource_id: `artifact:${await sha256Text(destination)}`, code: "committed_artifact_source_out_of_bounds" });
  });

  it("ignores a committed artifact in the same project's ARTIFACTS folder when rebuilding REVIEW", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/ARTIFACTS/roadmap.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-OUTSIDE-001", destination, "roadmap");

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor, limit: 8, budget: budget() });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(pages.flatMap((page) => page.entries)).toEqual([]);
    expect(pages.flatMap((page) => page.gaps)).toEqual([]);
  });

  it("uses one deterministic receipt witness when multiple committed receipts prove identical destination bytes", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-001", destination, "same bytes", "2026-09-25T00:00:00Z");
    await seedCommittedArtifact(h, "ART-NAVIGATION-002", destination, "same bytes", "2026-09-26T00:00:00Z");

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, budget: budget() });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    const entries = pages.flatMap((page) => page.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resource_id: `artifact:${await sha256Text(destination)}`,
      version: `ART-NAVIGATION-001:${await sha256Text("same bytes")}`
    });
    expect(pages.flatMap((page) => page.gaps)).toEqual([]);
    expect(await h.inventory.verifyEntry(entries[0], budget())).toBe(true);
  });

  it("ignores a superseded committed artifact while the newer visible file still exists", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-OLD-001", destination, "old report");
    await seedCommittedArtifact(h, "ART-NAVIGATION-NEW-001", destination, "new report");
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, mode: "canonical_catalog_rebuild", budget: budget() });
      pages.push(page); cursor = page.next_cursor;
    } while (cursor !== null);
    expect(pages.flatMap((page) => page.gaps)).toEqual([]);
    expect(pages.flatMap((page) => page.entries)).toHaveLength(1);
    expect(pages.flatMap((page) => page.entries)[0].version).toBe(`ART-NAVIGATION-NEW-001:${await sha256Text("new report")}`);
  });

  it("does not silently omit a changed artifact with no current receipt or managed head", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-OLD-001", destination, "old report");
    h.put(destination, "unreceived change");
    const gaps = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, mode: "canonical_catalog_rebuild", budget: budget() });
      gaps.push(...page.gaps); cursor = page.next_cursor;
    } while (cursor !== null);
    expect(gaps).toContainEqual({ resource_id: `artifact:${await sha256Text(destination)}`, code: "committed_artifact_source_unverified" });
  });

  it("refreshes the stable artifact catalog entry after a committed same-destination replacement", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/DELIVERABLES/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-101", destination, "old committed artifact");
    const firstPages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, budget: budget() });
      firstPages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);
    const original = firstPages.flatMap((page) => page.entries)[0];
    expect(original?.version).toBe(`ART-NAVIGATION-101:${await sha256Text("old committed artifact")}`);

    await h.sources.beginAdoption(projectId, "DELIVERABLES", "NAV-ADOPT-ARTIFACT-1", 0, budget());
    expect(await h.sources.finishAdoption(projectId, "DELIVERABLES", "NAV-ADOPT-ARTIFACT-1", 0, budget())).toBe(true);
    const resourceId = `artifact:${await sha256Text(destination)}`;
    const ticket = await h.sources.beginHeadWrite(projectId, "DELIVERABLES", resourceId, budget());
    await seedCommittedArtifact(h, "ART-NAVIGATION-102", destination, "new committed artifact");
    await h.sources.completeHeadWrite(ticket, null, budget());

    const refreshedPages = [];
    let refreshedCursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor: refreshedCursor, limit: 8, budget: budget(25) });
      refreshedPages.push(page);
      refreshedCursor = page.next_cursor;
    } while (refreshedCursor !== null);
    const refreshedEntries = refreshedPages.flatMap((page) => page.entries);
    expect(refreshedEntries).toContainEqual(expect.objectContaining({
      resource_id: resourceId,
      version: `ART-NAVIGATION-102:${await sha256Text("new committed artifact")}`,
      path: destination
    }));
    expect(await h.inventory.verifyEntry(original!, budget())).toBe(false);
    expect(refreshedPages.flatMap((page) => page.gaps)).not.toContainEqual(expect.objectContaining({ resource_id: resourceId, code: "committed_artifact_resolver_unavailable" }));
    expect(await h.inventory.verifySnapshot({ project_id: projectId, zone: "DELIVERABLES", snapshot_id: refreshedPages[0].snapshot_id, budget: budget() })).toBe(true);
  });

  it("refuses a stale entry when its active canonical pointer changes", async () => {
    const h = harness();
    await addWorkingHead(h, "current body");
    const original = (await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() })).entries[0];
    const headPath = machineDocumentHeadPath(projectId, documentId);
    const raw = JSON.parse(h.files.get(headPath)!.content);
    raw.working_version_id = "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA";
    h.put(headPath, JSON.stringify(raw));

    await expect(h.inventory.verifyEntry(original, budget())).resolves.toBe(false);
  });

  it("propagates budget exhaustion during the second visible metadata check", async () => {
    const h = harness();
    await addWorkingHead(h, "current body");
    const original = (await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() })).entries[0];

    await expect(h.inventory.verifyEntry(original, budget(4))).rejects.toThrow("slice_budget_exhausted");
  });

  it("propagates a transient provider read error instead of treating it as a stale head", async () => {
    const h = harness();
    await addWorkingHead(h, "current body");
    const original = (await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() })).entries[0];
    h.readErrors.set(machineDocumentHeadPath(projectId, documentId), new Error("provider_temporarily_unavailable"));

    await expect(h.inventory.verifyEntry(original, budget())).rejects.toThrow("provider_temporarily_unavailable");
  });

  it("refreshes an adopted catalog from the exact dirty head without rescanning all heads", async () => {
    const h = harness();
    await addWorkingHead(h, "old body");
    const original = (await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() })).entries[0];
    const b = budget();
    await h.sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await h.sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", original.resource_id, b);
    const visiblePath = await addWorkingHead(h, "new body", "rev-new");
    const current: NavigationInventoryEntry = {
      ...original,
      expected: { ...original.expected, revision_token: "rev-new", content_sha256: await sha256Text("new body"), size: 8 }
    };
    expect(visiblePath).toBe(original.path);
    await h.sources.completeHeadWrite(ticket, current, b);
    const headListingPath = `${machineDocumentRoot(projectId)}/heads`;
    const pathsBeforeDelta = h.pagePaths.length;

    const updates = [];
    let updateCursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: updateCursor, limit: 8, budget: budget() });
      updates.push(page);
      updateCursor = page.next_cursor;
    } while (updateCursor !== null);
    expect(h.pagePaths.slice(pathsBeforeDelta)).not.toContain(headListingPath);
    expect(updates.flatMap((page) => page.entries)).toHaveLength(1);
    expect(updates.flatMap((page) => page.entries)[0].expected.content_sha256).toBe(await sha256Text("new body"));
    expect(updates.flatMap((page) => page.entries)[0].expected.content_sha256).not.toBe(original.expected.content_sha256);
    expect(await h.inventory.verifySnapshot({ project_id: projectId, zone: "WORKING", snapshot_id: "source:1", budget: budget() })).toBe(true);
  });

  it("keeps provider calls for one dirty source delta bounded as unchanged catalog references grow", async () => {
    const measure = async (count: number) => {
      const h = harness();
      const entries: NavigationInventoryEntry[] = [];
      for (let index = 0; index < count; index += 1) {
        const suffix = index === 0 ? documentId.slice("DOC-".length) : index.toString(16).padStart(24, "0").toUpperCase();
        const id = `DOC-${suffix}`;
        const version = `VER-REQ-${suffix}`;
        const content = index === 0 ? "before delta" : `unchanged ${index}`;
        const visiblePath = await addWorkingHead(h, content, "rev-visible", id, version, `draft-${index}.md`);
        const entry: NavigationInventoryEntry = {
          project_id: projectId, zone: "WORKING", resource_id: `head:${id}`, version,
          logical_path: `draft-${index}.md`, path: visiblePath,
          expected: { object_id: "id:visible", revision_token: "rev-visible", content_sha256: await sha256Text(content), size: new TextEncoder().encode(content).byteLength }
        };
        expect(await h.inventory.verifyEntry(entry, budget())).toBe(true);
        await h.sources.writeCatalogEntry(entry, projectId, "WORKING", entry.resource_id, budget(), 0);
        await h.sources.recordVerifiedCatalogEntry(entry, "source:0", budget());
        entries.push(entry);
      }
      const firstEntry = entries[0];
      const firstId = firstEntry.resource_id;
      const requestId = "DOCREQ-NAVIGATION-WORKING-0001";
      await h.sources.beginAdoption(projectId, "WORKING", requestId, 0, budget());
      await h.sources.finishAdoption(projectId, "WORKING", requestId, 0, budget());
      await h.sources.markCatalogReady(projectId, "WORKING", 0, budget());
      const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", firstId, budget());
      const changedPath = await addWorkingHead(h, "after delta", "rev-after", documentId, versionId, "draft-0.md");
      const changedEntry: NavigationInventoryEntry = {
        ...firstEntry, path: changedPath,
        expected: { ...firstEntry.expected, revision_token: "rev-after", content_sha256: await sha256Text("after delta"), size: 11 }
      };
      await h.sources.completeHeadWrite(ticket, changedEntry, budget());
      const before = h.providerCalls;
      let cursor: string | null = null;
      let steps = 0;
      const listedEntries: NavigationInventoryEntry[] = [];
      const proofs: { resource_id: string; entry_hash: string; persisted: boolean }[] = [];
      do {
        const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget() });
        listedEntries.push(...page.entries);
        proofs.push(...(page.verified_entries ?? []));
        cursor = page.next_cursor;
        steps += 1;
        if (steps > count + 20) throw new Error("navigation_catalog_scan_unbounded");
      } while (cursor !== null);
      expect(listedEntries).toHaveLength(count);
      expect(proofs).toHaveLength(count);
      expect(proofs.every((proof) => proof.persisted)).toBe(true);
      return h.providerCalls - before;
    };

    const calls100 = await measure(100);
    const calls1000 = await measure(1000);
    expect(calls1000).toBeLessThanOrEqual(calls100 + 100);
  });

  it("keeps generic ARTIFACTS destinations outside the three navigation zones", async () => {
    const h = harness();
    const destination = `${workspaceProjectRoot(projectId, slug)}/ARTIFACTS/report.md`;
    await seedCommittedArtifact(h, "ART-NAVIGATION-OUTSIDE-001", destination, "out of zone artifact");

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor, limit: 8, budget: budget() });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(pages.flatMap((page) => page.entries)).toEqual([]);
    expect(pages.flatMap((page) => page.gaps)).toEqual([]);
  });

  it("batches outside-zone artifact gaps and replays the same bounded page", async () => {
    const h = harness();
    await addWorkingHead(h, "current valid head", "rev-valid", "DOC-1123456789ABCDEF01234567", "VER-REQ-1123456789ABCDEF01234567", "valid.md");
    const inactiveId = "DOC-2123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, inactiveId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: inactiveId,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const mismatchedPath = await addWorkingHead(h, "recorded mismatch", "rev-mismatch", "DOC-3123456789ABCDEF01234567", "VER-REQ-3123456789ABCDEF01234567", "mismatch.md");
    h.put(mismatchedPath, "physical bytes changed after the head", "id:physical-mismatch");
    const expected: Array<{ resource_id: string; code: string }> = [];
    for (let index = 1; index <= 4; index += 1) {
      const requestId = `ART-NAVIGATION-BATCH-${String(index).padStart(4, "0")}`;
      const destination = `${workspaceProjectRoot(projectId, slug)}/ARCHIVE/${index}.md`;
      await seedCommittedArtifact(h, requestId, destination, `archived artifact ${index}`);
      expected.push({ resource_id: `artifact:${await sha256Text(destination)}`, code: "artifact_destination_outside_navigation_zones" });
    }

    const cursor = "artifacts:";
    const before = h.providerCalls;
    const pages = [];
    let nextCursor: string | null = cursor;
    do {
      const slice = budget(32);
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: nextCursor, limit: 8, budget: slice });
      expect(slice.calls_left).toBeGreaterThanOrEqual(0);
      pages.push(page);
      nextCursor = page.next_cursor;
    } while (nextCursor !== null);
    const callsUsed = h.providerCalls - before;
    const first = pages[0]!;
    const replay = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });

    expect(first).toEqual(replay);
    expect(first.entries).toEqual([]);
    expect(pages.flatMap((page) => page.gaps)).toEqual(expected);
    expect(callsUsed).toBe(10);
    expect(first.next_cursor).toBeNull();
    expect(pages).toHaveLength(1);

    const interruptedPrefix = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(24) });
    expect(interruptedPrefix.gaps).toHaveLength(2);
    expect(interruptedPrefix.next_cursor).not.toBeNull();
    const listPage = h.runtime.pagedListing!.listPage;
    let faulted = false;
    h.runtime.pagedListing!.listPage = async (input) => {
      if (!faulted) { faulted = true; throw new Error("injected provider interruption after acknowledged prefix"); }
      return listPage(input);
    };
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: interruptedPrefix.next_cursor, limit: 8, budget: budget(32) }))
      .rejects.toThrow("injected provider interruption after acknowledged prefix");
    h.runtime.pagedListing!.listPage = listPage;
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: interruptedPrefix.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries).toEqual([]);
    const recoveredGaps = [...interruptedPrefix.gaps, ...resumed.gaps];
    let recoveredCursor = resumed.next_cursor;
    let recoveryPages = 0;
    while (recoveredCursor !== null) {
      const recovery = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: recoveredCursor, limit: 8, budget: budget(32) });
      recoveredGaps.push(...recovery.gaps);
      recoveredCursor = recovery.next_cursor;
      if (++recoveryPages > 4) throw new Error("artifact_gap_recovery_unbounded");
    }
    expect(recoveredGaps).toEqual(expected);

    const fullBefore = h.providerCalls;
    const fullPages = [];
    let fullCursor: string | null = null;
    let fullSteps = 0;
    let fullFaultInjected = false;
    do {
      const isArtifactPhase = fullCursor?.startsWith("artifacts:") ?? false;
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: fullCursor, limit: 8, budget: budget(isArtifactPhase ? 24 : 32) });
      fullPages.push(page);
      fullCursor = page.next_cursor;
      if (isArtifactPhase && page.gaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones").length === 2 && fullCursor !== null) {
        const acknowledgedCursor = fullCursor;
        const providerListPage = h.runtime.pagedListing!.listPage;
        h.runtime.pagedListing!.listPage = async () => { throw new Error("injected full-traversal provider interruption"); };
        await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: acknowledgedCursor, limit: 8, budget: budget(32) }))
          .rejects.toThrow("injected full-traversal provider interruption");
        h.runtime.pagedListing!.listPage = providerListPage;
        const retry = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: acknowledgedCursor, limit: 8, budget: budget(32) });
        fullPages.push(retry);
        fullCursor = retry.next_cursor;
        fullFaultInjected = true;
      }
      fullSteps += 1;
      if (fullSteps > 20) throw new Error("mixed_initial_navigation_unbounded");
    } while (fullCursor !== null);
    const fullCallsUsed = h.providerCalls - fullBefore;
    const fullEntries = fullPages.flatMap((page) => page.entries);
    const fullGaps = fullPages.flatMap((page) => page.gaps);
    expect(fullFaultInjected).toBe(true);
    expect(fullEntries.map((entry) => entry.resource_id)).toContain("head:DOC-1123456789ABCDEF01234567");
    expect(fullEntries.map((entry) => entry.resource_id)).not.toContain(`head:${inactiveId}`);
    expect(fullGaps.some((gap) => gap.resource_id === "head:DOC-3123456789ABCDEF01234567")).toBe(true);
    expect(fullGaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones")).toHaveLength(4);
    expect({ calls: fullCallsUsed, tranches: fullPages.length }).toEqual({ calls: 37, tranches: 4 });
  });

  it("measures the full initial traversal for mixed heads and outside-zone artifacts", async () => {
    const h = harness();
    await addWorkingHead(h, "current valid head", "rev-valid", "DOC-1123456789ABCDEF01234567", "VER-REQ-1123456789ABCDEF01234567", "valid.md");
    const inactiveId = "DOC-2123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, inactiveId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: inactiveId,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const mismatchedPath = await addWorkingHead(h, "recorded mismatch", "rev-mismatch", "DOC-3123456789ABCDEF01234567", "VER-REQ-3123456789ABCDEF01234567", "mismatch.md");
    h.put(mismatchedPath, "physical bytes changed after the head", "id:physical-mismatch");
    const expectedArtifacts: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const requestId = `ART-NAVIGATION-FULL-${String(index).padStart(4, "0")}`;
      const destination = `${workspaceProjectRoot(projectId, slug)}/ARCHIVE/${index}.md`;
      await seedCommittedArtifact(h, requestId, destination, `archived artifact ${index}`);
      expectedArtifacts.push(`artifact:${await sha256Text(destination)}`);
    }

    const before = h.providerCalls;
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });
      pages.push(page);
      cursor = page.next_cursor;
      if (pages.length > 20) throw new Error("mixed_full_traversal_unbounded");
    } while (cursor !== null);
    const calls = h.providerCalls - before;
    const entries = pages.flatMap((page) => page.entries);
    const gaps = pages.flatMap((page) => page.gaps);
    expect(entries.map((entry) => entry.resource_id)).toContain("head:DOC-1123456789ABCDEF01234567");
    expect(entries.map((entry) => entry.resource_id)).not.toContain(`head:${inactiveId}`);
    expect(gaps.some((gap) => gap.resource_id === "head:DOC-3123456789ABCDEF01234567")).toBe(true);
    expect(gaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones").map((gap) => gap.resource_id)).toEqual(expectedArtifacts);
    expect({ calls, tranches: pages.length }).toEqual({ calls: 33, tranches: 3 });
  });

  it.each([
    ["missing catalog record", null, true, "canonical_catalog_entry_unavailable"],
    ["invalid schema version", JSON.stringify({ schema_version: "9.0", resource_id: `head:${documentId}`, entry: {} }), false, "canonical_catalog_entry_invalid"],
    ["catalog record without entry", JSON.stringify({ schema_version: "1.0", resource_id: `head:${documentId}` }), false, "canonical_catalog_entry_invalid"],
    ["unbound null tombstone", JSON.stringify({ schema_version: "1.0", entry: null }), false, "canonical_catalog_entry_invalid"],
    ["null tombstone with another resource id", JSON.stringify({ schema_version: "1.0", resource_id: "head:DOC-1123456789ABCDEF01234567", entry: null }), false, "canonical_catalog_entry_invalid"],
    ["valid null tombstone", JSON.stringify({ schema_version: "1.0", resource_id: `head:${documentId}`, entry: null }), false, null]
  ])("handles a %s catalog record", async (_name, raw, missing, expectedCode) => {
    const h = harness();
    await h.sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, budget());
    await h.sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, budget());
    const resourceId = `head:${documentId}`;
    const path = `${zoneNavigationCatalogRoot(projectId, "WORKING")}/${await sha256Text(resourceId)}.json`;
    h.put(path, raw ?? JSON.stringify({ schema_version: "1.0", entry: {} }));
    if (missing) h.missingOnRead.add(path);

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    const catalogResource = `${await sha256Text(resourceId)}.json`;
    if (expectedCode === null) {
      expect(page.entries).toEqual([]);
      expect(page.gaps).not.toContainEqual(expect.objectContaining({ resource_id: catalogResource }));
    } else expect(page.gaps).toContainEqual({ resource_id: catalogResource, code: expectedCode });
  });

  it("rejects a catalog listing path that escapes the configured catalog root", async () => {
    const h = harness();
    await h.sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, budget());
    await h.sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, budget());
    const resourceId = `head:${documentId}`;
    const name = `${await sha256Text(resourceId)}.json`;
    h.runtime.pagedListing!.listPage = async () => ({ entries: [{ kind: "file", name, path: `/outside/${name}` }], cursor: null });

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    expect(page.entries).toEqual([]);
    expect(page.gaps).toContainEqual({ resource_id: name, code: "canonical_catalog_path_mismatch" });
  });

  it("does not start a dirty refresh without reserving the page, resolution, catalog, and checkpoint calls", async () => {
    const h = harness();
    await addWorkingHead(h, "current body");
    const original = (await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() })).entries[0];
    const b = budget();
    const requestId = "DOCREQ-NAVIGATION-WORKING-0001";
    await h.sources.beginAdoption(projectId, "WORKING", requestId, 0, b);
    await h.sources.finishAdoption(projectId, "WORKING", requestId, 0, b);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", original.resource_id, b);
    const path = await addWorkingHead(h, "new body", "rev-new");
    await h.sources.completeHeadWrite(ticket, {
      ...original,
      expected: { ...original.expected, revision_token: "rev-new", content_sha256: await sha256Text("new body") }
    }, b);
    const pagesBefore = h.pagePaths.length;

    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(20) })).rejects.toThrow("slice_budget_exhausted");

    expect(h.pagePaths).toHaveLength(pagesBefore);
    expect(path).toBe(original.path);
  });
});
