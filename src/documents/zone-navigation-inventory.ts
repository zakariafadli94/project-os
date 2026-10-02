import {
  navigationInventoryEntrySchema,
  type NavigationCoverageGap,
  type NavigationInventoryEntry,
  type NavigationInventoryPort,
  type NavigationZone
} from "../domain/zone-navigation";
import type { SliceBudget } from "../convergence/contract";
import { readDocumentVersionRecord, readManagedDocumentHead } from "../schema/managed-document";
import type { CurrentManagedDocumentHead, CurrentDocumentVersionRecord } from "../schema/managed-document";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderOperationError } from "../persistence/provider/errors";
import { machineDocumentHeadPath, machineDocumentInstanceRepairPath, machineDocumentRoot, machineDocumentTextPayloadPath, machineDocumentVersionPath, machineMutationGateRoot, machineMutationIntentDestinationBindingRoot, machineStatePath, workspaceArtifactPath, workspaceProjectRoot } from "../persistence/layout";
import { sha256Text } from "./hash";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "./zone-navigation-sources";
import { packageIdFor, packageManifestPath, packageNavigationLedgerSchema, packageNavigationPath, packageRefSchema, packageResourceVersion, parsePackageManifest, type PackageNavigationHead, type PackageRef } from "../domain/document-package";
import { DocumentLedgerRepository } from "./repository";
import { canonicalJson } from "../rules/contract";
import { MutationGateRepository } from "../mutation-gate/repository";
import { MutationGateService } from "../mutation-gate/service";
import { machineConvergenceRoot } from "../persistence/layout";
import { ExecutionJournal, executionHash } from "../execution/journal";
import { sha256Canonical } from "../materialization/hash";
import { parseManagedDocumentRequest } from "../domain/managed-document-request";
import { readProjectState } from "../schema/project-state";
import { enforceManagedMarkdownIdentity } from "./identity-frontmatter";
import { documentIdFor } from "../domain/managed-document";
import type { CurrentMutationIntentRecord } from "../schema/mutation-gate";

type PagePhase = "initial" | "packages" | "artifacts" | "artifact-bindings" | "artifact-finalize" | "dirty" | "dirty-package" | "dirty-artifacts" | "dirty-finish" | "catalog" | "catalog-compact";
interface PageCursor { phase: PagePhase; cursor: string | null }

const MAX_PACKAGE_LEDGER_BYTES = 128_000;
const MAX_PACKAGE_MANIFEST_BYTES = 256_000;
const MAX_VISIBLE_SOURCE_BYTES = 2_000_000;
// Initial adoption freezes one bounded provider page in the durable cursor.
// PRJ-0003 has fewer than 512 heads, so this avoids a Dropbox continuation
// cursor that can return the same page indefinitely without losing resumability.
const MAX_INITIAL_HEADS_PER_PAGE = 512;
// A mismatched provider identity needs the head/version records, its repair
// proof, receipt wrapper, admitted execution, visible bytes and stable metadata.
// Keep an additional checkpoint window after that bounded per-head proof so a
// saved provider page can advance under the shared 32-call slice.
const MAX_INITIAL_HEAD_PROVIDER_CALLS = 10;
const MAX_INITIAL_MISMATCHED_HEAD_PROVIDER_CALLS = 20;
const MIN_INACTIVE_HEAD_PROVIDER_CALLS = 2;
const INITIAL_PAGE_CHECKPOINT_CALLS = 4;

interface InitialHeadPageCursor {
  kind: "zone-navigation-head-batch-v1";
  entries: ProviderEntry[];
  provider_cursor: string | null;
  listing_limit: number;
}
interface InitialHeadReadCache { head?: string | null; version?: { id: string; raw: string | null } }

/** Canonical, bounded source adapter used by ZoneNavigationEngine. */
export class ZoneNavigationInventory implements NavigationInventoryPort {
  readonly verificationIncludesPhysicalIntegrity = true;

  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly sources: ZoneNavigationSources
  ) {}

  async listPage(input: {
    project_id: string;
    zone: NavigationZone;
    cursor: string | null;
    limit: number;
    mode?: "canonical_catalog_rebuild";
    budget: SliceBudget;
  }): Promise<{ entries: NavigationInventoryEntry[]; verified_entries?: { resource_id: string; entry_hash: string; persisted: boolean }[]; gaps: NavigationCoverageGap[]; snapshot_id: string; next_cursor: string | null }> {
    const { project_id: projectId, zone, budget } = input;
    const state = await this.sources.readState(projectId, zone, budget);
    const snapshot_id = `source:${state.generation}`;
    if (state.in_flight_resource_ids.length) {
      return { entries: [], gaps: [{ resource_id: "in_flight", code: "canonical_source_write_in_progress" }], snapshot_id, next_cursor: null };
    }

    const saved = input.cursor === null ? null : decodeCursor(input.cursor);
    const rebuild = input.mode === "canonical_catalog_rebuild";
    let phase: PagePhase = saved?.phase ?? (rebuild ? "initial" : state.adopted ? "dirty" : "initial");
    let providerCursor = saved?.cursor ?? null;
    if (!rebuild && state.adopted && saved && (saved.phase === "initial" || saved.phase === "packages" || saved.phase === "artifacts")) {
      // Adoption can complete while an older full-scan cursor is in flight.
      // Resume through dirty/compact state rather than returning a partial
      // pre-adoption enumeration as if it were current.
      phase = "dirty";
      providerCursor = null;
    }
    if (phase === "initial") return this.initialPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget, !rebuild);
    if (phase === "packages") return this.packagePage(projectId, zone, providerCursor, snapshot_id, budget, !rebuild);
    if (phase === "artifacts") return this.artifactPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget, !rebuild);
    if (phase === "artifact-bindings") return this.artifactBindingsPage(projectId, zone, providerCursor, snapshot_id, budget);
    if (phase === "artifact-finalize") return this.finalizeArtifactBindings(projectId, zone, providerCursor, snapshot_id, budget, !rebuild);
    if (phase === "dirty") return this.dirtyAndCatalogPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget, state.adopted);
    if (phase === "dirty-package") return this.dirtyPackagePage(projectId, zone, providerCursor, input.limit, snapshot_id, budget);
    if (phase === "dirty-artifacts") return this.dirtyArtifactPage(projectId, zone, providerCursor, snapshot_id, budget);
    if (phase === "dirty-finish") return this.dirtyFinishPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget);
    if (phase === "catalog-compact") {
      // A saved compact cursor is not proof that the canonical source was
      // adopted. Restart from sidecars if adoption was revoked/reset.
      if (state.adopted) return this.compactCatalogPage(projectId, zone, providerCursor, snapshot_id, budget, false);
      return this.catalogPage(projectId, zone, null, input.limit, snapshot_id, budget, false, false);
    }
    return this.catalogPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget, input.cursor === null, state.adopted);
  }

  async verifySnapshot(input: { project_id: string; zone: NavigationZone; snapshot_id: string; budget: SliceBudget }): Promise<boolean> {
    return this.sources.verifySnapshot(input.project_id, input.zone, input.snapshot_id, input.budget);
  }

  async completeSnapshot(input: { project_id: string; zone: NavigationZone; snapshot_id: string; cursor?: string | null; budget: SliceBudget }): Promise<boolean | "pending" | { status: "pending"; cursor: string | null } | { status: "conflict"; code: string }> {
    const generation = generationFromSnapshot(input.snapshot_id);
    let cursor = input.cursor ?? null;
    if (cursor !== null) {
      const phase = decodeCursor(cursor).phase;
      if (phase === "catalog") {
        const ready = await this.sources.markCatalogReady(input.project_id, input.zone, generation, input.budget);
        return ready ? true : { status: "pending", cursor: null };
      }
      if (phase !== "dirty" && phase !== "dirty-package" && phase !== "dirty-artifacts" && phase !== "artifacts" && phase !== "artifact-bindings" && phase !== "artifact-finalize" && phase !== "dirty-finish") {
        return { status: "conflict", code: "navigation_dirty_cursor_invalid" };
      }
    } else {
      const dirty = await this.sources.listDirtyPage(input.project_id, input.zone, null, 1, input.budget);
      const resourceId = dirty.resource_ids[0];
      if (!resourceId && dirty.next_cursor !== null) return { status: "pending", cursor: encodeCursor("dirty", dirty.next_cursor) };
      if (!resourceId) {
        const ready = await this.sources.markCatalogReady(input.project_id, input.zone, generation, input.budget);
        return ready ? true : { status: "pending", cursor: null };
      }
      // Adoption already enumerated and verified the entire canonical source
      // snapshot. Re-resolve one dirty head at a time and clear only its exact
      // CAS marker; this also proves a current zone tombstone (e.g. a working-
      // only head during REVIEW adoption).
      if (resourceId.startsWith("package:")) {
        cursor = encodeCursor("dirty-package", JSON.stringify({ resource_id: resourceId, dirty_cursor: dirty.next_cursor, member_index: 0 }));
      } else if (resourceId.startsWith("artifact:")) {
        cursor = encodeCursor("dirty-artifacts", JSON.stringify({ resource_id: resourceId, dirty_cursor: dirty.next_cursor, intent_cursor: null, destination_path: null, binding_cursor: null, eligible_request_ids: [], gaps: [] }));
      } else if (!resourceId.startsWith("head:DOC-")) {
        return { status: "conflict", code: "navigation_dirty_resource_unresolved" };
      } else {
        // Resolve and clear this marker through the resumable page flow. In
        // particular, head resolution may consume most of a provider slice;
        // persist the phase before attempting the separate CAS clear.
        return { status: "pending", cursor: encodeCursor("dirty", "") };
      }
    }
    const page = await this.listPage({ project_id: input.project_id, zone: input.zone, cursor, limit: 1, budget: input.budget });
    if (page.snapshot_id !== input.snapshot_id) return { status: "conflict", code: "navigation_snapshot_changed" };
    if (page.gaps.length) return { status: "conflict", code: `navigation_dirty_${page.gaps[0].code}` };
    if (page.next_cursor === null) return { status: "conflict", code: "navigation_dirty_resolution_incomplete" };
    if (decodeCursor(page.next_cursor).phase === "catalog") {
      const ready = await this.sources.markCatalogReady(input.project_id, input.zone, generation, input.budget);
      return ready ? true : { status: "pending", cursor: null };
    }
    return { status: "pending", cursor: page.next_cursor };
  }

  async recordVerifiedEntry(entry: NavigationInventoryEntry, snapshot_id: string, budget: SliceBudget): Promise<void> {
    await this.sources.recordVerifiedCatalogEntry(entry, snapshot_id, budget);
  }

  async verifyEntry(entry: NavigationInventoryEntry, budget: SliceBudget): Promise<boolean> {
    if (entry.resource_id.startsWith("head:")) {
      const resolved = await this.resolveHead(entry.project_id, entry.zone, entry.resource_id, budget);
      return resolved.entry !== null && sameEntry(resolved.entry, entry);
    }
    if (entry.resource_id.startsWith("package:")) {
      try {
        const source = await readCurrentPackageNavigation(this.runtime, entry.project_id, entry.zone, budget);
        const selected = source?.head?.packages.find((item) => `package:${item.ref.package_id}` === entry.resource_id);
        if (!source || !selected) return false;
        const resolved = await resolvePackageIndex(this.runtime, entry.project_id, entry.zone, selected, source, 0, budget, true);
        return resolved.entry !== null && sameEntry(resolved.entry, entry);
      } catch (error) {
        if (isBudgetError(error) || isRetryableProviderError(error)) throw error;
        return false;
      }
    }
    if (entry.resource_id.startsWith("artifact:")) return this.verifyArtifactEntry(entry, budget);
    return false;
  }

  async verifyEntryPage(entry: NavigationInventoryEntry, cursor: string | null, budget: SliceBudget): Promise<{ status: "pending"; cursor: string } | { status: "verified" } | { status: "conflict" }> {
    if (!entry.resource_id.startsWith("package:")) return await this.verifyEntry(entry, budget) ? { status: "verified" } : { status: "conflict" };
    const source = await readCurrentPackageNavigation(this.runtime, entry.project_id, entry.zone, budget);
    const selected = source?.head?.packages.find((item) => `package:${item.ref.package_id}` === entry.resource_id);
    if (!source || !selected || packageResourceVersion(selected.ref) !== entry.version) return { status: "conflict" };
    const memberIndex = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(memberIndex) || memberIndex < 0) throw new Error("navigation_inventory_cursor_invalid");
    const resolved = await resolvePackageIndex(this.runtime, entry.project_id, entry.zone, selected, source, memberIndex, budget);
    if (resolved.pending) return { status: "pending", cursor: String(memberIndex + 1) };
    return resolved.entry && sameEntry(resolved.entry, entry) ? { status: "verified" } : { status: "conflict" };
  }

  private async verifyArtifactEntry(entry: NavigationInventoryEntry, budget: SliceBudget): Promise<boolean> {
    const match = /^(ART-[A-Z0-9-]{10,}):([a-f0-9]{64})$/.exec(entry.version);
    if (!match || `artifact:${await sha256Text(entry.path)}` !== entry.resource_id) return false;
    const target = artifactNavigationTarget(entry.project_id, entry.path);
    if (target.kind !== "zone" || target.zone !== entry.zone || target.logical_path !== entry.logical_path) return false;
    const bounded = budgetedRuntime(this.runtime, budget);
    const repository = new MutationGateRepository(bounded);
    const intent = await repository.readArtifactIntent(entry.project_id, match[1]);
    if (!intent || intent.destination_path !== entry.path || intent.expected_content_sha256 !== match[2]) return false;
    const status = await new MutationGateService(bounded, "observe").artifactStatus(entry.project_id, match[1]);
    if (status?.verification_state !== "canonical_verified" || status.receipt_status !== "committed" || status.operation === "REVIEW_CANDIDATE") return false;
    const resolved = await resolveArtifactEntry(this.runtime, entry.project_id, entry.zone, intent, target.logical_path, budget);
    return resolved !== null && sameEntry(resolved, entry);
  }

  private async initialPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    _requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget,
    persistCatalog = true
  ) {
    if (!this.runtime.pagedListing) return {
      entries: [], gaps: [{ resource_id: "heads", code: "paged_listing_unavailable" }, ...unresolvedSourceFamilyGaps()], snapshot_id: snapshotId, next_cursor: null
    };
    const savedPage = cursor === null ? null : parseInitialHeadPageCursor(cursor);
    const reusingSavedListing = savedPage?.entries.length ? true : false;
    let listedEntries: ProviderEntry[];
    let providerCursor: string | null;
    let listingLimit: number;
    if (savedPage && savedPage.entries.length > 0) {
      listedEntries = savedPage.entries;
      providerCursor = savedPage.provider_cursor;
      listingLimit = savedPage.listing_limit;
    } else if (savedPage?.provider_cursor === null) {
      listedEntries = [];
      providerCursor = null;
      listingLimit = savedPage.listing_limit;
    } else {
      // New listings request a full engine-sized provider page. Any suffix
      // that cannot be processed this slice is carried in the opaque engine
      // cursor, so the provider cursor never advances past unprocessed heads.
      // A legacy opaque cursor was created with limit=1; preserve its page
      // size rather than changing pagination semantics mid-request.
      const listingCursor = savedPage?.provider_cursor ?? cursor;
      listingLimit = savedPage?.listing_limit ?? (cursor === null ? MAX_INITIAL_HEADS_PER_PAGE : 1);
      requireBudget(budget, 1);
      charge(budget);
      const page = await this.runtime.pagedListing.listPage({
        path: `${machineDocumentRoot(projectId)}/heads`, cursor: listingCursor, limit: listingLimit
      });
      if (listingCursor !== null && page.cursor === listingCursor) throw new Error("navigation_listing_stalled");
      listedEntries = page.entries;
      providerCursor = page.cursor;
    }
    // Initial adoption may update a ready compact cache while walking the
    // provider page. Keep a small independent window for the engine's durable
    // page/progress checkpoint so a costly shard repair cannot repeat the same
    // saved cursor indefinitely.
    const compactManifest = persistCatalog
      ? await this.sources.compactCatalogManifest(projectId, zone, budget)
      : null;
    const protectCheckpoint = compactManifest?.ready_generation !== null && compactManifest?.ready_generation !== undefined;
    const pageBudget = protectCheckpoint ? withCheckpointReserve(budget, INITIAL_PAGE_CHECKPOINT_CALLS) : budget;
    const entries: NavigationInventoryEntry[] = [];
    const gaps: NavigationCoverageGap[] = [];
    const headCache = new Map<string, InitialHeadReadCache>();
    let offset = 0;
    while (offset < listedEntries.length) {
      const item = listedEntries[offset];
      // Only ordinary, identity-matching active heads can share a slice. The
      // preflight spends four calls and the two unchanged proof/CAS chains
      // need at most eighteen more, including a conditional stale tombstone;
      // canStartEffect preserves the checkpoint
      // reserve before either chain begins. Mismatches retain the solo path.
      // On the first item of a saved listing, let the solo path establish its
      // active-head reservation before speculatively reading a second head.
      // A slow/non-ordinary second head can consume the shared deadline even
      // though the first head is independently verifiable; retrying the same
      // saved cursor would otherwise repeat that preflight forever.
      if (persistCatalog && !protectCheckpoint && !(offset === 0 && reusingSavedListing)
        && offset + 1 < listedEntries.length && pageBudget.canStartEffect(22)) {
        const pair = await this.ordinaryInitialPair(projectId, zone, listedEntries.slice(offset, offset + 2), snapshotId, pageBudget, headCache);
        if (pair) {
          let failed = false;
          for (const result of pair) {
            if (result.status === "rejected") {
              if (isBudgetError(result.reason) || isRetryableProviderError(result.reason)) { failed = true; break; }
              // A late CAS rejection can leave too little budget for both a
              // compensating tombstone and the engine checkpoint. Preserve
              // the prior cursor and surface the original conflict instead.
              if (!pageBudget.canStartEffect(5)) throw result.reason;
              const id = listedEntries[offset].name.slice(0, -5);
              const resourceId = `head:${id}`;
              await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, pageBudget,
                generationFromSnapshot(snapshotId));
              gaps.push({ resource_id: resourceId, code: classifyGap(result.reason) });
            } else if (result.value.entry) {
              entries.push(result.value.entry);
            } else if (result.value.gap) gaps.push(result.value.gap);
            offset += 1;
          }
          if (failed) break;
          continue;
        }
      }
      // The active-head pair keeps its original reservation. Batch only the
      // proven inactive prefix; an active/stale/error entry stays at the next
      // cursor, rather than serializing every irrelevant head before it.
      if (persistCatalog && offset + 6 <= listedEntries.length && pageBudget.canStartEffect(13)) {
        const inactiveCount = await this.inactiveInitialBatch(projectId, zone, listedEntries.slice(offset, offset + 6), pageBudget, headCache);
        if (inactiveCount > 0) {
          offset += inactiveCount;
          continue;
        }
      }
      if (item.kind !== "file" || !item.path) {
        if (!persistCatalog) gaps.push({ resource_id: item.name || "head-listing-entry", code: "head_listing_entry_invalid" });
        offset += 1;
        continue;
      }
      const match = /^(DOC-[A-F0-9]{24})\.json$/.exec(item.name);
      if (!match) {
        if (!persistCatalog) gaps.push({ resource_id: item.name, code: "head_listing_entry_unrecognized" });
        offset += 1;
        continue;
      }
      const resourceId = `head:${match[1]}`;
      if (item.path !== machineDocumentHeadPath(projectId, match[1])) {
        gaps.push({ resource_id: resourceId, code: "head_listing_path_mismatch" });
        offset += 1;
        continue;
      }
      // Inactive heads only need a head read and catalog check. Reserve the
      // larger proof budget after inspecting an active pointer, so historical
      // inactive heads do not consume a whole recovery slice apiece.
      if (!pageBudget.canStartEffect(MIN_INACTIVE_HEAD_PROVIDER_CALLS)) {
        if (offset === 0 && reusingSavedListing) throw new Error("slice_budget_exhausted");
        break;
      }
      try {
        const resolved = await this.resolveHead(projectId, zone, resourceId, pageBudget, true, headCache.get(match[1]));
        if (resolved.gap) gaps.push(resolved.gap);
        if (resolved.entry) {
          if (persistCatalog) await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resourceId,
            pageBudget, generationFromSnapshot(snapshotId));
          entries.push(resolved.entry);
        } else {
          // Clean inactive heads need no catalog tombstone unless a prior
          // partial adoption left an active row behind. Gaps are retained
          // independently below, and stale rows are still cleared exactly.
          if (persistCatalog) {
            const prior = await this.sources.readCatalogEntry(projectId, zone, resourceId, pageBudget);
            if (prior) await this.sources.writeCatalogEntry(null, projectId, zone, resourceId,
              pageBudget, generationFromSnapshot(snapshotId));
          }
        }
      } catch (error) {
        if (isBudgetError(error) || isRetryableProviderError(error)) {
          if (offset === 0 && reusingSavedListing) throw error;
          break;
        }
        if (persistCatalog) await this.sources.writeCatalogEntry(null, projectId, zone, resourceId,
          pageBudget, generationFromSnapshot(snapshotId));
        gaps.push({ resource_id: resourceId, code: classifyGap(error) });
      }
      offset += 1;
    }
    if (cursor === null) gaps.push(...unresolvedSourceFamilyGaps());
    const nextCursor = offset < listedEntries.length
      ? encodeCursor("initial", JSON.stringify({ kind: "zone-navigation-head-batch-v1", entries: listedEntries.slice(offset), provider_cursor: providerCursor, listing_limit: listingLimit } satisfies InitialHeadPageCursor))
      : providerCursor === null
        ? encodeCursor("packages", JSON.stringify({ package_index: 0, member_index: 0 }))
        : encodeCursor("initial", JSON.stringify({ kind: "zone-navigation-head-batch-v1", entries: [], provider_cursor: providerCursor, listing_limit: listingLimit } satisfies InitialHeadPageCursor));
    return {
      entries,
      verified_entries: await Promise.all(entries.map(async (entry) => ({ resource_id: entry.resource_id, entry_hash: await sha256Text(canonicalJson(entry)), persisted: false }))),
      gaps,
      snapshot_id: snapshotId,
      next_cursor: nextCursor
    };
  }

  private async inactiveInitialBatch(
    projectId: string, zone: NavigationZone, items: ProviderEntry[], budget: SliceBudget,
    headCache: Map<string, InitialHeadReadCache>
  ): Promise<number> {
    const ids = items.map((item) => /^(DOC-[A-F0-9]{24})\.json$/.exec(item.name)?.[1]);
    if (ids.some((id, index) => !id || items[index].kind !== "file" || items[index].path !== machineDocumentHeadPath(projectId, id))) return 0;
    const readHead = async (id: string) => {
      const cached = headCache.get(id!);
      if (cached && "head" in cached) return cached.head!;
      charge(budget);
      const raw = await this.runtime.objects.readText(machineDocumentHeadPath(projectId, id!));
      headCache.set(id!, { head: raw });
      return raw;
    };
    // An active first head cannot form an inactive prefix. Inspect it before
    // spending five provider calls on the rest of a batch; the fallback active
    // proof still needs this slice's remaining budget to advance its cursor.
    let first: string | null;
    try {
      first = await readHead(ids[0]!);
      if (first === null) return 0;
      const head = readManagedDocumentHead(JSON.parse(first)).head;
      const pointer = activePointer(head, zone);
      if (head.project_id !== projectId || head.document_id !== ids[0] || head.reconciliation_status !== "clean"
        || pointer.versionId != null || pointer.observation != null) return 0;
    } catch { return 0; }
    const heads = [{ status: "fulfilled", value: first } as PromiseFulfilledResult<string | null>,
      ...await Promise.allSettled(ids.slice(1).map((id) => readHead(id!)))];
    let inactiveCount = 0;
    for (let index = 0; index < heads.length; index += 1) {
      const result = heads[index];
      if (result.status !== "fulfilled" || result.value === null) break;
      try {
        const head = readManagedDocumentHead(JSON.parse(result.value)).head;
        const pointer = activePointer(head, zone);
        if (head.project_id !== projectId || head.document_id !== ids[index] || head.reconciliation_status !== "clean"
          || pointer.versionId != null || pointer.observation != null) break;
      } catch { break; }
      inactiveCount += 1;
    }
    if (inactiveCount === 0) return 0;
    const catalog = await Promise.allSettled(ids.slice(0, inactiveCount).map((id) => this.sources.readCatalogEntry(projectId, zone, `head:${id}`, budget)));
    let absentCount = 0;
    for (const result of catalog) {
      if (result.status !== "fulfilled" || result.value !== null) break;
      absentCount += 1;
    }
    return absentCount;
  }

  private async ordinaryInitialPair(
    projectId: string, zone: NavigationZone, items: ProviderEntry[], snapshotId: string, budget: SliceBudget,
    headCache: Map<string, InitialHeadReadCache>
  ): Promise<PromiseSettledResult<{ entry: NavigationInventoryEntry | null; gap?: NavigationCoverageGap }> [] | null> {
    const ids = items.map((item) => /^(DOC-[A-F0-9]{24})\.json$/.exec(item.name)?.[1]);
    if (ids.some((id, index) => !id || items[index].kind !== "file" || items[index].path !== machineDocumentHeadPath(projectId, id))) return null;
    const readHead = async (id: string) => {
      const cached = headCache.get(id);
      if (cached && "head" in cached) return cached.head!;
      charge(budget);
      const raw = await this.runtime.objects.readText(machineDocumentHeadPath(projectId, id));
      headCache.set(id, { ...cached, head: raw });
      return raw;
    };
    let rawHeads: (string | null)[];
    try { rawHeads = await Promise.all(ids.map((id) => readHead(id!))); }
    catch { return null; }
    if (rawHeads.some((raw) => raw === null)) return null;
    let heads: CurrentManagedDocumentHead[];
    try { heads = rawHeads.map((raw) => readManagedDocumentHead(JSON.parse(raw!)).head); }
    catch { return null; }
    const pointers = heads.map((head) => activePointer(head, zone));
    if (heads.some((head, index) => head.project_id !== projectId || head.document_id !== ids[index] || head.reconciliation_status !== "clean"
      || !pointers[index].versionId || !pointers[index].observation)) return null;
    const readVersion = async (id: string, versionId: string) => {
      const cached = headCache.get(id);
      if (cached?.version?.id === versionId) return cached.version.raw;
      charge(budget);
      const raw = await this.runtime.objects.readText(machineDocumentVersionPath(projectId, id, versionId));
      headCache.set(id, { ...cached, version: { id: versionId, raw } });
      return raw;
    };
    let rawVersions: (string | null)[];
    try { rawVersions = await Promise.all(ids.map((id, index) => readVersion(id!, pointers[index].versionId!))); }
    catch { return null; }
    if (rawVersions.some((raw) => raw === null)) return null;
    let versions: CurrentDocumentVersionRecord[];
    try { versions = rawVersions.map((raw) => readDocumentVersionRecord(JSON.parse(raw!)).record); }
    catch { return null; }
    let observations: ReturnType<typeof normalizeObservation>[];
    try { observations = pointers.map((pointer) => normalizeObservation(pointer.observation!)); }
    catch { return null; }
    if (versions.some((version, index) => {
      const head = heads[index];
      const pointer = pointers[index];
      const observation = observations[index];
      return version.project_id !== projectId || version.document_id !== ids[index] || version.version_id !== pointer.versionId
        || version.kind !== head.kind || version.stage !== pointer.stage || version.logical_path !== head.logical_path
        || version.provider_file_id !== observation.object_id || version.provider_rev !== observation.revision_token
        || version.provider_path !== observation.path || version.size !== observation.size
        || !observation.path.endsWith(`/${zone}/${version.logical_path}`)
        || !(version.content_sha256 || version.provider_evidence?.integrity_hash.algorithm === "sha256");
    })) return null;
    requireBudget(budget, 18);
    return Promise.allSettled(ids.map(async (id, index) => {
      const observation = observations[index];
      const version = versions[index];
      const resourceId = `head:${id}`;
      const verified = await this.readVisible(observation.path, observation, version, budget);
      if (!verified) {
        const prior = await this.sources.readCatalogEntry(projectId, zone, resourceId, budget);
        if (prior) await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        return { entry: null, gap: { resource_id: resourceId, code: "active_provider_content_unverified" } };
      }
      const entry = navigationInventoryEntrySchema.parse({
        project_id: projectId, zone, resource_id: resourceId, version: pointers[index].versionId,
        logical_path: version.logical_path, path: observation.path,
        expected: { object_id: observation.object_id, revision_token: observation.revision_token, content_sha256: verified.sha256, size: verified.size }
      });
      await this.sources.writeCatalogEntry(entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      return { entry };
    }));
  }

  private async packagePage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget, persistCatalog = true) {
    // Guard/engine already spend calls on admission and source-state checks;
    // package proof is paged one member at a time and may start with 25 calls.
    requireBudget(budget, 17);
    let packageIndex = 0;
    let memberIndex = 0;
    if (cursor !== null) {
      try {
        const parsed = JSON.parse(cursor) as { package_index?: unknown; member_index?: unknown };
        if (typeof parsed.package_index !== "number" || !Number.isSafeInteger(parsed.package_index) || parsed.package_index < 0
          || typeof parsed.member_index !== "number" || !Number.isSafeInteger(parsed.member_index) || parsed.member_index < 0) throw new Error();
        packageIndex = parsed.package_index;
        memberIndex = parsed.member_index;
      } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    }
    const gaps: NavigationCoverageGap[] = [];
    let source: CurrentPackageNavigation | null;
    try { source = await readCurrentPackageNavigation(this.runtime, projectId, zone, budget); }
    catch (error) {
      if (isBudgetError(error) || isRetryableProviderError(error)) throw error;
      gaps.push({ resource_id: "packages", code: classifyPackageGap(error) });
      return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", "") };
    }
    const packages = source?.head?.packages ?? [];
    if (packageIndex >= packages.length) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", "") };
    const selected = packages[packageIndex];
    try {
      const resolved = await resolvePackageIndex(this.runtime, projectId, zone, selected, source!, memberIndex, budget);
      if (resolved.gap) gaps.push(resolved.gap);
      if (resolved.pending) return {
        entries: [], gaps, snapshot_id: snapshotId,
        next_cursor: encodeCursor("packages", JSON.stringify({ package_index: packageIndex, member_index: memberIndex + 1 }))
      };
      if (persistCatalog) {
        if (resolved.entry) await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resolved.entry.resource_id, budget, generationFromSnapshot(snapshotId));
        else await this.sources.writeCatalogEntry(null, projectId, zone, `package:${selected.ref.package_id}`, budget, generationFromSnapshot(snapshotId));
      }
      return {
        entries: resolved.entry ? [resolved.entry] : [],
        ...(resolved.entry ? { verified_entries: [{ resource_id: resolved.entry.resource_id, entry_hash: await sha256Text(canonicalJson(resolved.entry)), persisted: false }] } : {}),
        gaps, snapshot_id: snapshotId,
        next_cursor: packageIndex + 1 < packages.length ? encodeCursor("packages", JSON.stringify({ package_index: packageIndex + 1, member_index: 0 })) : encodeCursor("artifacts", "")
      };
    } catch (error) {
      if (isBudgetError(error) || isRetryableProviderError(error)) throw error;
      gaps.push({ resource_id: `package:${selected.ref.package_id}`, code: classifyPackageGap(error) });
      return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: packageIndex + 1 < packages.length ? encodeCursor("packages", JSON.stringify({ package_index: packageIndex + 1, member_index: 0 })) : encodeCursor("artifacts", "") };
    }
  }

  private async artifactPage(projectId: string, zone: NavigationZone, cursor: string | null, _requestedLimit: number, snapshotId: string, budget: SliceBudget, persistCatalog = true) {
    if (!this.runtime.pagedListing) return { entries: [], gaps: [{ resource_id: "artifacts", code: "paged_listing_unavailable" }], snapshot_id: snapshotId, next_cursor: null };
    const root = `${machineMutationGateRoot(projectId)}/intents/artifacts`;
    let providerCursor = cursor;
    const gaps: NavigationCoverageGap[] = [];
    let fetched = false;
    let lastSkippedCursor: string | null = null;
    while (true) {
      // Keep the old page size for saved Dropbox cursors. Drain unrelated
      // intents within this slice, but leave enough budget for resolving one
      // in-zone intent and its binding proof.
      if (!budget.canStartEffect(16)) {
        if (!fetched) throw new Error("slice_budget_exhausted");
        return { entries: [], gaps, snapshot_id: snapshotId,
          next_cursor: providerCursor === null ? null : encodeCursor("artifacts", providerCursor) };
      }
      requireBudget(budget, 16);
      charge(budget);
      const page = await this.runtime.pagedListing.listPage({ path: root, cursor: providerCursor, limit: 1 });
      if (providerCursor !== null && page.cursor === providerCursor) throw new Error("navigation_listing_stalled");
      fetched = true;
      const item = page.entries[0];
      providerCursor = page.cursor;
      if (!item) {
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(item.name);
      if (item.kind !== "file" || !item.path || item.path !== `${root}/${item.name}` || !match) {
        if (lastSkippedCursor !== null && gaps.length === 0) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", lastSkippedCursor) };
        gaps.push({ resource_id: item.name, code: "artifact_intent_listing_invalid" });
        lastSkippedCursor = null;
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      let intent: Awaited<ReturnType<MutationGateRepository["readArtifactIntent"]>>;
      try {
        intent = await new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, match[1]);
        if (!intent || intent.request_id !== match[1] || intent.project_id !== projectId) throw new Error("artifact_intent_binding");
      } catch (error) {
        if (isBudgetError(error)) throw error;
        if (lastSkippedCursor !== null && gaps.length === 0) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", lastSkippedCursor) };
        gaps.push({ resource_id: `artifact:${match[1]}`, code: "committed_artifact_intent_unavailable" });
        lastSkippedCursor = null;
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      const target = artifactNavigationTarget(projectId, intent.destination_path);
      if (target.kind === "outside" && isGenericArtifactDestination(projectId, intent.destination_path)) {
        // The supported generic artifact route writes to ARTIFACTS, which is
        // not a member of WORKING, REVIEW or DELIVERABLES navigation.
        if (gaps.length === 0) lastSkippedCursor = providerCursor;
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      if (target.kind === "outside") {
        if (lastSkippedCursor !== null && gaps.length === 0) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", lastSkippedCursor) };
        gaps.push({ resource_id: `artifact:${await sha256Text(intent.destination_path)}`, code: "artifact_destination_outside_navigation_zones" });
        lastSkippedCursor = null;
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      if (target.kind === "invalid") {
        if (lastSkippedCursor !== null && gaps.length === 0) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", lastSkippedCursor) };
        gaps.push({ resource_id: `artifact:${await sha256Text(intent.destination_path)}`, code: "artifact_destination_binding_invalid" });
        lastSkippedCursor = null;
        if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
        continue;
      }
      if (target.zone === zone) {
        if (lastSkippedCursor !== null && gaps.length === 0) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifacts", lastSkippedCursor) };
        const state: ArtifactBindingCursor = { next_intent_cursor: providerCursor, request_id: intent.request_id, destination_path: intent.destination_path, binding_cursor: null, eligible_request_ids: [], gaps: [] };
        const result = await this.scanArtifactBindings(projectId, zone, state, snapshotId, budget);
        return { ...result, gaps: [...gaps, ...result.gaps] };
      }
      if (gaps.length === 0) lastSkippedCursor = providerCursor;
      if (providerCursor === null) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: null };
    }
  }

  private async artifactBindingsPage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget) {
    let state: ArtifactBindingCursor;
    try {
      state = JSON.parse(cursor ?? "") as ArtifactBindingCursor;
      if (!state || typeof state.request_id !== "string" || typeof state.destination_path !== "string" || !Array.isArray(state.eligible_request_ids) || !Array.isArray(state.gaps)
        || (state.next_intent_cursor !== null && typeof state.next_intent_cursor !== "string") || (state.binding_cursor !== null && typeof state.binding_cursor !== "string")
        || (state.quarantine_cursor !== undefined && state.quarantine_cursor !== null && typeof state.quarantine_cursor !== "string")
        || (state.committed_unverified !== undefined && typeof state.committed_unverified !== "boolean")) throw new Error("invalid");
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    return this.scanArtifactBindings(projectId, zone, state, snapshotId, budget);
  }

  private async scanArtifactBindings(projectId: string, zone: NavigationZone, state: ArtifactBindingCursor, snapshotId: string, budget: SliceBudget) {
    if (!this.runtime.pagedListing) return { entries: [], gaps: [{ resource_id: `artifact:${await sha256Text(state.destination_path)}`, code: "paged_listing_unavailable" }], snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
    requireBudget(budget, 15);
    const destinationHash = await sha256Text(state.destination_path);
    const root = machineMutationIntentDestinationBindingRoot(projectId, destinationHash);
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({ path: root, cursor: state.binding_cursor, limit: 1 });
    for (const item of page.entries) {
      const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(item.name);
      if (item.kind !== "file" || !item.path || item.path !== `${root}/${item.name}` || !match) {
        state.gaps.push({ resource_id: item.name, code: "artifact_destination_binding_invalid" });
        continue;
      }
      try {
        charge(budget);
        const rawBinding = await this.runtime.objects.readText(item.path);
        if (rawBinding === null) throw new Error("artifact_destination_binding_unavailable");
        const binding = JSON.parse(rawBinding) as Record<string, unknown>;
        if (binding.schema_version !== "1.0" || binding.project_id !== projectId || binding.destination_path !== state.destination_path || binding.request_id !== match[1] || typeof binding.intent_id !== "string") throw new Error("artifact_destination_binding_invalid");
        const repository = new MutationGateRepository(budgetedRuntime(this.runtime, budget));
        const intent = await repository.readArtifactIntent(projectId, match[1]);
        if (!intent || intent.destination_path !== state.destination_path || intent.intent_id !== binding.intent_id) throw new Error("artifact_destination_binding_conflict");
        const target = artifactNavigationTarget(projectId, state.destination_path);
        if (target.kind !== "zone" || target.zone !== zone) throw new Error("artifact_destination_zone_mismatch");
        const status = await new MutationGateService(budgetedRuntime(this.runtime, budget), "observe").artifactStatus(projectId, match[1]);
        if (status?.receipt_status === "committed" && status.operation !== "REVIEW_CANDIDATE") {
          const metadata = await budgetedRuntime(this.runtime, budget).objects.getMetadata(state.destination_path);
          if (!metadata) {
            const quarantine = await this.provenQuarantinedArtifact(projectId, zone, state.destination_path, target.logical_path, intent, state.quarantine_cursor ?? null, budget);
            if (quarantine.next_cursor !== null) {
              state.quarantine_cursor = quarantine.next_cursor;
              return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifact-bindings", JSON.stringify(state)) };
            }
            if (!quarantine.proven) throw new Error("artifact_visible_out_of_bounds");
            delete state.quarantine_cursor;
            continue;
          }
          if (metadata.size > MAX_VISIBLE_SOURCE_BYTES) throw new Error("artifact_visible_out_of_bounds");
          // A committed predecessor can remain in the binding history after
          // a visible replacement. Only absence needs quarantine proof.
          if (status.verification_state !== "canonical_verified") {
            state.committed_unverified = true;
            continue;
          }
          // Finalization below rechecks this status and resolves the visible
          // bytes once. Avoid doing the same physical source verification here
          // and then again in the engine after the final entry is returned.
          state.eligible_request_ids.push(match[1]);
        }
      } catch (error) {
        if (isBudgetError(error)) throw error;
        state.gaps.push({ resource_id: `artifact:${destinationHash}`, code: classifyArtifactGap(error) });
      }
    }
    if (page.cursor !== null) {
      state.binding_cursor = page.cursor;
      return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifact-bindings", JSON.stringify(state)) };
    }
    return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("artifact-finalize", JSON.stringify(state)) };
  }

  private async provenQuarantinedArtifact(projectId: string, zone: NavigationZone, destinationPath: string, logicalPath: string, intent: CurrentMutationIntentRecord, cursor: string | null, budget: SliceBudget): Promise<{ proven: boolean; next_cursor: string | null }> {
    if (zone !== "DELIVERABLES" || !this.runtime.pagedListing) return { proven: false, next_cursor: null };
    // Scan one historical quarantine per durable slice. A missing record or
    // interrupted listing never becomes permission to hide a visible file.
    requireBudget(budget, 12);
    const documentId = await documentIdFor(projectId, logicalPath);
    const headRaw = await budgetedRuntime(this.runtime, budget).objects.readText(machineDocumentHeadPath(projectId, documentId));
    if (!headRaw) return { proven: false, next_cursor: null };
    let head: CurrentManagedDocumentHead;
    try {
      const read = readManagedDocumentHead(JSON.parse(headRaw));
      if (!("head" in read)) return { proven: false, next_cursor: null };
      head = read.head;
    } catch { return { proven: false, next_cursor: null }; }
    if (head.project_id !== projectId || head.document_id !== documentId || head.logical_path !== logicalPath
      || head.reconciliation_status !== "clean" || head.published_version_id || head.provider?.published) return { proven: false, next_cursor: null };
    const root = `${machineDocumentRoot(projectId)}/quarantines`;
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({ path: root, cursor, limit: 1 });
    if (page.cursor !== null && page.cursor === cursor) throw new Error("navigation_listing_stalled");
    for (const item of page.entries) {
      if (item.kind !== "folder" || item.path !== `${root}/${item.name}` || !/^DOCREQ-[A-Z0-9-]+$/.test(item.name)) continue;
      const proofPath = `${item.path}/receipt.json`;
      const proofText = await budgetedRuntime(this.runtime, budget).objects.readText(proofPath);
      if (!proofText) continue;
      let proof: Record<string, unknown>;
      try { proof = JSON.parse(proofText) as Record<string, unknown>; } catch { continue; }
      const provider = proof.provider as Record<string, unknown> | undefined;
      const expectedArchive = `${destinationPath.split("/DELIVERABLES/")[0]}/ARCHIVES/QUARANTINED-PUBLISHED/${documentId}/${proof.version_id}/${item.name}/${logicalPath}`;
      if (proof.operation !== "document.quarantine_instance" || proof.project_id !== projectId || proof.request_id !== item.name
        || proof.document_id !== documentId || proof.logical_path !== logicalPath || provider?.path !== destinationPath
        || (intent.provider_precondition.kind === "existing" && intent.provider_precondition.object_id !== provider.object_id)
        || !/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/.test(String(proof.version_id)) || proof.archive_path !== expectedArchive) continue;
      const wrapperText = await budgetedRuntime(this.runtime, budget).objects.readText(`${machineDocumentRoot(projectId)}/requests/${item.name}/receipt.json`);
      if (!wrapperText) continue;
      let wrapper: Record<string, unknown>, receipt: Record<string, unknown>, quarantineRequest: Record<string, unknown>;
      try {
        wrapper = JSON.parse(wrapperText) as Record<string, unknown>;
        receipt = JSON.parse(String(wrapper.receipt_json)) as Record<string, unknown>;
        quarantineRequest = JSON.parse(String(wrapper.request_json)) as Record<string, unknown>;
      } catch { continue; }
      const recordedAt = Date.parse(intent.recorded_at);
      const quarantinedAt = Date.parse(String(quarantineRequest.created_at));
      const observed = quarantineRequest.observed_provider as Record<string, unknown> | undefined;
      if (wrapper.project_id !== projectId || wrapper.request_id !== item.name || receipt.status !== "committed"
        || typeof wrapper.request_json !== "string" || wrapper.request_sha256 !== await sha256Text(wrapper.request_json)
        || receipt.request_payload_sha256 !== wrapper.request_sha256
        || receipt.operation !== "document.quarantine_instance" || receipt.project_id !== projectId
        || receipt.request_id !== item.name || receipt.document_id !== documentId || receipt.proof_ref !== proofPath
        || receipt.proof_sha256 !== await sha256Text(proofText) || receipt.archive_path !== proof.archive_path
        || receipt.content_sha256 !== proof.content_sha256 || receipt.provider_rev !== provider.revision_token
        || quarantineRequest.operation !== "document.quarantine_instance" || quarantineRequest.project_id !== projectId
        || quarantineRequest.request_id !== item.name || quarantineRequest.document_id !== documentId
        || observed?.path !== destinationPath || observed.object_id !== provider.object_id
        || !Number.isFinite(recordedAt) || !Number.isFinite(quarantinedAt) || quarantinedAt < recordedAt
        || !Number.isSafeInteger(quarantineRequest.expected_project_revision)
        || (quarantineRequest.expected_project_revision as number) < intent.base_project_revision) continue;
      const archive = await budgetedRuntime(this.runtime, budget).objects.getMetadata(proof.archive_path);
      if (archive?.path === proof.archive_path && archive.size === provider.size) return { proven: true, next_cursor: null };
    }
    return { proven: false, next_cursor: page.cursor };
  }

  private async finalizeArtifactBindings(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget, persistCatalog = true) {
    let state: ArtifactBindingCursor;
    try {
      state = JSON.parse(cursor ?? "") as ArtifactBindingCursor;
      if (!state || typeof state.request_id !== "string" || typeof state.destination_path !== "string" || !Array.isArray(state.eligible_request_ids) || !Array.isArray(state.gaps)) throw new Error();
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    requireBudget(budget, 16);
    const resourceId = `artifact:${await sha256Text(state.destination_path)}`;
    const distinct = [...new Set(state.eligible_request_ids)];
    let winningRequestId = distinct.length === 1 ? distinct[0] : null;
    if (distinct.length === 0 && state.committed_unverified) {
      const target = artifactNavigationTarget(projectId, state.destination_path);
      const covered = target.kind === "zone" && target.zone === zone
        && await this.managedHeadCoversVisibleArtifact(projectId, state.destination_path, target.logical_path, budget);
      if (!covered) state.gaps.push({ resource_id: resourceId, code: "committed_artifact_source_unverified" });
    }
    if (distinct.length > 1) {
      // Several committed replacements can prove the *same visible bytes*.
      // An index needs one receipt witness, not a claim about which identical
      // write happened last. Never choose among different content hashes or
      // an unbounded set of historical receipts.
      if (distinct.length <= 8) {
        const intents = await Promise.all(distinct.map((requestId) =>
          new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, requestId)));
        const contentHash = intents[0]?.expected_content_sha256;
        if (contentHash && intents.every((intent) => intent?.destination_path === state.destination_path && intent.expected_content_sha256 === contentHash)) {
          winningRequestId = [...distinct].sort()[0];
        }
      }
      if (!winningRequestId) {
        if (persistCatalog) await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        state.gaps.push({ resource_id: resourceId, code: "artifact_destination_ambiguous" });
        return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.dirty ? null : state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
      }
    }
    if (winningRequestId && (state.dirty || winningRequestId === state.request_id)) {
      const intent = await new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, winningRequestId);
      if (!intent) throw new Error("committed_artifact_intent_unavailable");
      const target = artifactNavigationTarget(projectId, state.destination_path);
      if (target.kind !== "zone" || target.zone !== zone) throw new Error("artifact_destination_zone_mismatch");
      const status = await new MutationGateService(budgetedRuntime(this.runtime, budget), "observe").artifactStatus(projectId, winningRequestId);
      const entry = status?.verification_state === "canonical_verified" && status.receipt_status === "committed" && status.operation !== "REVIEW_CANDIDATE"
        ? await resolveArtifactEntry(this.runtime, projectId, zone, intent, target.logical_path, budget) : null;
      if (entry) {
        if (persistCatalog) await this.sources.writeCatalogEntry(entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        if (state.dirty) {
          return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: resourceId, dirty_cursor: state.dirty.dirty_cursor, entry })) };
        }
        return { entries: [entry], verified_entries: [{ resource_id: entry.resource_id, entry_hash: await sha256Text(canonicalJson(entry)), persisted: false }],
          gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
      }
    }
    if (state.dirty && state.gaps.length === 0) {
      if (persistCatalog) await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      return { entries: [], gaps: [], snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: resourceId, dirty_cursor: state.dirty.dirty_cursor, entry: null })) };
    }
    return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
  }

  private async managedHeadCoversVisibleArtifact(projectId: string, destinationPath: string, logicalPath: string, budget: SliceBudget): Promise<boolean> {
    const documentId = await documentIdFor(projectId, logicalPath);
    const raw = await budgetedRuntime(this.runtime, budget).objects.readText(machineDocumentHeadPath(projectId, documentId));
    if (!raw) return false;
    let head: CurrentManagedDocumentHead;
    try {
      const read = readManagedDocumentHead(JSON.parse(raw));
      if (!("head" in read)) return false;
      head = read.head;
    } catch { return false; }
    const published = head.provider?.published;
    if (head.project_id !== projectId || head.document_id !== documentId || head.logical_path !== logicalPath
      || head.reconciliation_status !== "clean" || !head.published_version_id || published?.path !== destinationPath) return false;
    const visible = await budgetedRuntime(this.runtime, budget).objects.getMetadata(destinationPath);
    try { return metadataMatches(visible, normalizeObservation(published)); }
    catch { return false; }
  }

  private async dirtyAndCatalogPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget,
    adopted: boolean
  ) {
    requireBudget(budget, 15);
    const dirtyPage = await this.sources.listDirtyPage(projectId, zone, cursor, 1, budget);
    const gaps: NavigationCoverageGap[] = [];
    const resourceId = dirtyPage.resource_ids[0];
    if (!resourceId) return await this.catalogPage(projectId, zone, null, requestedLimit, snapshotId, budget, true, adopted);
    const afterCurrentDirtyResource = dirtyPage.next_cursor === null
      ? encodeCursor("catalog", "")
      : encodeCursor("dirty", dirtyPage.next_cursor);
    if (resourceId.startsWith("package:")) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-package", JSON.stringify({ resource_id: resourceId, dirty_cursor: dirtyPage.next_cursor, member_index: 0 })) };
    if (resourceId.startsWith("artifact:")) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-artifacts", JSON.stringify({ resource_id: resourceId, dirty_cursor: dirtyPage.next_cursor, intent_cursor: null, destination_path: null, binding_cursor: null, eligible_request_ids: [], gaps: [] })) };
    if (!resourceId.startsWith("head:DOC-")) {
      await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      return { entries: [], gaps: [{ resource_id: resourceId, code: unsupportedSourceCode(resourceId) }], snapshot_id: snapshotId, next_cursor: afterCurrentDirtyResource };
    }
    requireBudget(budget, 12);
    try {
      const resolved = await this.resolveHead(projectId, zone, resourceId, budget);
      if (resolved.gap) return { entries: [], gaps: [resolved.gap], snapshot_id: snapshotId, next_cursor: afterCurrentDirtyResource };
      await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: resourceId, dirty_cursor: dirtyPage.next_cursor, entry: resolved.entry })) };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      return { entries: [], gaps: [{ resource_id: resourceId, code: classifyGap(error) }], snapshot_id: snapshotId, next_cursor: afterCurrentDirtyResource };
    }
  }

  private async dirtyPackagePage(projectId: string, zone: NavigationZone, cursor: string | null, requestedLimit: number, snapshotId: string, budget: SliceBudget) {
    requireBudget(budget, 12);
    let state: { resource_id: string; dirty_cursor: string | null; member_index: number };
    try {
      state = JSON.parse(cursor ?? "") as typeof state;
      if (!state || !state.resource_id.startsWith("package:") || (state.dirty_cursor !== null && typeof state.dirty_cursor !== "string") || !Number.isSafeInteger(state.member_index) || state.member_index < 0) throw new Error();
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    const gaps: NavigationCoverageGap[] = [];
    try {
      const source = await readCurrentPackageNavigation(this.runtime, projectId, zone, budget);
      const selected = source?.head?.packages.find((item) => `package:${item.ref.package_id}` === state.resource_id);
      if (!selected || !source) {
        await this.sources.writeCatalogEntry(null, projectId, zone, state.resource_id, budget, generationFromSnapshot(snapshotId));
        return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: state.resource_id, dirty_cursor: state.dirty_cursor, entry: null })) };
      }
      const resolved = await resolvePackageIndex(this.runtime, projectId, zone, selected, source, state.member_index, budget);
      if (resolved.gap) return { entries: [], gaps: [resolved.gap], snapshot_id: snapshotId, next_cursor: null };
      if (resolved.pending) return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-package", JSON.stringify({ ...state, member_index: state.member_index + 1 })) };
      await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, state.resource_id, budget, generationFromSnapshot(snapshotId));
      return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: state.resource_id, dirty_cursor: state.dirty_cursor, entry: resolved.entry })) };
    } catch (error) {
      if (isBudgetError(error) || isRetryableProviderError(error)) throw error;
      return { entries: [], gaps: [{ resource_id: state.resource_id, code: classifyPackageGap(error) }], snapshot_id: snapshotId, next_cursor: null };
    }
  }

  private async afterDirtyPage(projectId: string, zone: NavigationZone, dirtyCursor: string | null, requestedLimit: number, snapshotId: string, budget: SliceBudget, priorGaps: NavigationCoverageGap[]) {
    if (dirtyCursor !== null) return { entries: [], gaps: priorGaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty", dirtyCursor) };
    void projectId; void zone; void requestedLimit; void budget;
    return { entries: [], gaps: priorGaps, snapshot_id: snapshotId, next_cursor: encodeCursor("catalog", "") };
  }

  private async dirtyFinishPage(projectId: string, zone: NavigationZone, cursor: string | null, requestedLimit: number, snapshotId: string, budget: SliceBudget) {
    requireBudget(budget, 8);
    let state: { resource_id: string; dirty_cursor: string | null; entry: NavigationInventoryEntry | null };
    try {
      state = JSON.parse(cursor ?? "") as typeof state;
      if (!state || typeof state.resource_id !== "string" || (state.dirty_cursor !== null && typeof state.dirty_cursor !== "string")) throw new Error();
      if (state.entry !== null) state.entry = navigationInventoryEntrySchema.parse(state.entry);
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    if (!await this.sources.finishDirty(projectId, zone, state.resource_id, state.entry, budget)) return { entries: [], gaps: [{ resource_id: state.resource_id, code: "dirty_identity_changed" }], snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify(state)) };
    return this.afterDirtyPage(projectId, zone, state.dirty_cursor, requestedLimit, snapshotId, budget, []);
  }

  private async dirtyArtifactPage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget) {
    if (!this.runtime.pagedListing) return { entries: [], gaps: [{ resource_id: "artifacts", code: "paged_listing_unavailable" }], snapshot_id: snapshotId, next_cursor: cursor === null ? null : encodeCursor("dirty-artifacts", cursor) };
    requireBudget(budget, 12);
    let state: DirtyArtifactCursor;
    try {
      state = JSON.parse(cursor ?? "") as DirtyArtifactCursor;
      if (!state || !/^artifact:[a-f0-9]{64}$/.test(state.resource_id) || (state.dirty_cursor !== null && typeof state.dirty_cursor !== "string") || (state.intent_cursor !== null && typeof state.intent_cursor !== "string") || (state.destination_path !== null && typeof state.destination_path !== "string") || (state.binding_cursor !== null && typeof state.binding_cursor !== "string") || !Array.isArray(state.eligible_request_ids) || !Array.isArray(state.gaps)) throw new Error();
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    if (!state.destination_path) {
      const root = `${machineMutationGateRoot(projectId)}/intents/artifacts`;
      charge(budget);
      const page = await this.runtime.pagedListing.listPage({ path: root, cursor: state.intent_cursor, limit: 1 });
      const item = page.entries[0];
      if (item) {
        const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(item.name);
        if (item.kind === "file" && item.path === `${root}/${item.name}` && match) {
          try {
            const intent = await new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, match[1]);
            if (intent && `artifact:${await sha256Text(intent.destination_path)}` === state.resource_id) {
              const target = artifactNavigationTarget(projectId, intent.destination_path);
              if (target.kind === "zone" && target.zone === zone) {
                const next: ArtifactBindingCursor = { next_intent_cursor: null, request_id: intent.request_id, destination_path: intent.destination_path, binding_cursor: null, eligible_request_ids: [], gaps: [], dirty: { resource_id: state.resource_id, dirty_cursor: state.dirty_cursor } };
                return { entries: [], gaps: [], snapshot_id: snapshotId, next_cursor: encodeCursor("artifact-bindings", JSON.stringify(next)) };
              }
            }
          } catch (error) {
            if (isBudgetError(error)) throw error;
            state.gaps.push({ resource_id: state.resource_id, code: classifyArtifactGap(error) });
          }
        }
      }
      if (page.cursor !== null) return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-artifacts", JSON.stringify({ ...state, intent_cursor: page.cursor })) };
      if (state.gaps.length) return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: null };
      await this.sources.writeCatalogEntry(null, projectId, zone, state.resource_id, budget, generationFromSnapshot(snapshotId));
      return { entries: [], gaps: [], snapshot_id: snapshotId, next_cursor: encodeCursor("dirty-finish", JSON.stringify({ resource_id: state.resource_id, dirty_cursor: state.dirty_cursor, entry: null })) };
    }
    const binding: ArtifactBindingCursor = { next_intent_cursor: null, request_id: state.request_id!, destination_path: state.destination_path, binding_cursor: state.binding_cursor, eligible_request_ids: state.eligible_request_ids, gaps: state.gaps, dirty: { resource_id: state.resource_id, dirty_cursor: state.dirty_cursor } };
    return this.scanArtifactBindings(projectId, zone, binding, snapshotId, budget);
  }

  private async catalogPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    _requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget,
    includeFamilyGaps: boolean,
    adopted: boolean
  ) {
    const compactManifest = adopted ? await this.sources.compactCatalogManifest(projectId, zone, budget) : null;
    if (adopted && compactManifest?.ready_generation === generationFromSnapshot(snapshotId)) {
      return this.compactCatalogPage(projectId, zone, cursor, snapshotId, budget, includeFamilyGaps);
    }
    if (!this.runtime.pagedListing) return {
      entries: [], gaps: [{ resource_id: "catalog", code: "paged_listing_unavailable" }, ...(includeFamilyGaps ? unresolvedSourceFamilyGaps() : [])], snapshot_id: snapshotId, next_cursor: null
    };
    requireBudget(budget, 3);
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({
      path: this.sourcesRoot(projectId, zone), cursor, limit: 1
    });
    const entries: NavigationInventoryEntry[] = [];
    const gaps: NavigationCoverageGap[] = includeFamilyGaps ? unresolvedSourceFamilyGaps() : [];
    const catalogRoot = this.sourcesRoot(projectId, zone);
    for (const item of page.entries) {
      if (item.kind !== "file" || !item.path) continue;
      if (item.path !== `${catalogRoot}/${item.name}`) {
        gaps.push({ resource_id: item.name, code: "canonical_catalog_path_mismatch" });
        continue;
      }
      try {
        charge(budget);
        const raw = await this.runtime.objects.readText(item.path);
        if (raw === null) {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_unavailable" });
          continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          continue;
        }
        const record = parsed as { schema_version?: unknown; resource_id?: unknown; entry?: unknown };
        const keys = Object.keys(record);
        if (record.schema_version !== "1.0" || !Object.hasOwn(record, "entry")
          || keys.some((key) => !["schema_version", "resource_id", "entry"].includes(key))
          || (record.resource_id !== undefined && typeof record.resource_id !== "string")) {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          continue;
        }
        if (record.entry === null) {
          if (typeof record.resource_id !== "string" || item.name !== `${await sha256Text(record.resource_id)}.json`) {
            gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          } else {
            await this.sources.recordVerifiedCatalogTombstone(projectId, zone, record.resource_id, snapshotId, budget);
          }
          // A correctly bound null row is the sidecar's CAS-protected deletion tombstone.
          continue;
        }
        if (typeof record.entry !== "object" || Array.isArray(record.entry)) {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          continue;
        }
        let entry: NavigationInventoryEntry;
        try { entry = navigationInventoryEntrySchema.parse(record.entry); }
        catch {
          gaps.push({ resource_id: item.name, code: "canonical_catalog_entry_invalid" });
          continue;
        }
        if (entry.project_id !== projectId || entry.zone !== zone || (record.resource_id !== undefined && record.resource_id !== entry.resource_id)) throw new Error("navigation_catalog_binding");
        if (item.name !== `${await sha256Text(entry.resource_id)}.json`) throw new Error("navigation_catalog_binding");
        entries.push(entry);
      } catch (error) {
        if (isBudgetError(error)) throw error;
        gaps.push({ resource_id: item.name, code: classifyGap(error) });
      }
    }
    return {
      entries,
      gaps,
      snapshot_id: snapshotId,
      next_cursor: page.cursor === null ? null : encodeCursor("catalog", page.cursor)
    };
  }

  private async compactCatalogPage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget, includeFamilyGaps: boolean) {
    const manifest = await this.sources.compactCatalogManifest(projectId, zone, budget);
    if (!manifest || manifest.ready_generation !== generationFromSnapshot(snapshotId)) throw new Error("navigation_compact_catalog_generation_stale");
    const shards = manifest.shards;
    let offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0 || offset > shards.length) throw new Error("navigation_inventory_cursor_invalid");
    const entries: NavigationInventoryEntry[] = [];
    const gaps: NavigationCoverageGap[] = includeFamilyGaps ? unresolvedSourceFamilyGaps() : [];
    const firstOffset = offset;
    while (offset < shards.length && offset - firstOffset < 8) {
      if (!budget.canStartEffect(1)) {
        if (offset === firstOffset) throw new Error("slice_budget_exhausted");
        break;
      }
      try {
        entries.push(...await this.sources.readCompactCatalogShard(projectId, zone, shards[offset], generationFromSnapshot(snapshotId), budget));
      } catch (error) {
        if (isBudgetError(error)) throw error;
        gaps.push({ resource_id: `catalog-shard:${shards[offset]}`, code: classifyGap(error) });
      }
      offset += 1;
    }
    const next = offset < shards.length ? encodeCursor("catalog-compact", String(offset)) : null;
    return {
      entries,
      verified_entries: await Promise.all(entries.map(async (entry) => ({ resource_id: entry.resource_id, entry_hash: await sha256Text(canonicalJson(entry)), persisted: true }))),
      gaps, snapshot_id: snapshotId, next_cursor: next
    };
  }

  private async resolveHead(projectId: string, zone: NavigationZone, resourceId: string, budget: SliceBudget, reserveActiveProof = false, cached?: InitialHeadReadCache): Promise<{ entry: NavigationInventoryEntry | null; gap?: NavigationCoverageGap }> {
    const match = /^head:(DOC-[A-F0-9]{24})$/.exec(resourceId);
    if (!match) return { entry: null, gap: { resource_id: resourceId, code: "invalid_head_resource_id" } };
    const documentId = match[1];
    if (!cached || !("head" in cached)) charge(budget);
    const rawHead = cached && "head" in cached ? cached.head! : await this.runtime.objects.readText(machineDocumentHeadPath(projectId, documentId));
    if (rawHead === null) return { entry: null };
    const head = readManagedDocumentHead(JSON.parse(rawHead)).head;
    if (head.project_id !== projectId || head.document_id !== documentId) throw new Error("head_binding_mismatch");
    if (head.reconciliation_status !== "clean") return { entry: null, gap: { resource_id: resourceId, code: "head_reconciliation_conflict" } };
    const pointer = activePointer(head, zone);
    if (!pointer.versionId && !pointer.observation) return { entry: null };
    if (!pointer.versionId || !pointer.observation) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_binding_missing" } };
    if (reserveActiveProof) requireBudget(budget, MAX_INITIAL_HEAD_PROVIDER_CALLS - 1);
    const observation = normalizeObservation(pointer.observation);
    if (cached?.version?.id !== pointer.versionId) charge(budget);
    const rawVersion = cached?.version?.id === pointer.versionId ? cached.version.raw : await this.runtime.objects.readText(machineDocumentVersionPath(projectId, documentId, pointer.versionId));
    if (rawVersion === null) return { entry: null, gap: { resource_id: resourceId, code: "active_version_missing" } };
    const version = readDocumentVersionRecord(JSON.parse(rawVersion)).record;
    if (version.project_id !== projectId || version.document_id !== documentId || version.version_id !== pointer.versionId || version.kind !== head.kind || version.stage !== pointer.stage || version.logical_path !== head.logical_path) {
      return { entry: null, gap: { resource_id: resourceId, code: "active_version_binding_mismatch" } };
    }
    const providerMismatch = version.provider_file_id !== observation.object_id || version.provider_rev !== observation.revision_token || version.provider_path !== observation.path || version.size !== observation.size;
    if (!observation.path.endsWith(`/${zone}/${version.logical_path}`)) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_path_mismatch" } };
    // Only a real mismatch can trigger request/receipt/admission lookups. Keep
    // ordinary active heads on their existing reservation; for mismatches,
    // reserve enough of this existing slice for those three records, visible
    // content verification, and the page/checkpoint continuation.
    if (reserveActiveProof && providerMismatch) requireBudget(budget, MAX_INITIAL_MISMATCHED_HEAD_PROVIDER_CALLS - 2);
    // Legacy external publications can retain an older provider identity after
    // an out-of-band move. Accept that identity change only when readVisible
    // proves the current bytes are exactly the immutable version bytes.
    const legacyExternalPublishedContentProof = providerMismatch && zone === "DELIVERABLES" && version.source === "external_human" && version.version_id.startsWith("VER-EXT-");
    const repairProof = providerMismatch && !legacyExternalPublishedContentProof
      ? await this.readCommittedInstanceRepair(projectId, documentId, head.logical_path, pointer.versionId, observation, version, rawVersion, budget)
      : null;
    const reviewPromotionProven = providerMismatch && zone === "REVIEW"
      ? await this.hasCommittedReviewPromotion(projectId, documentId, head.logical_path, pointer.versionId, observation, version, budget)
      : false;
    const reviewWriteProven = providerMismatch && zone === "REVIEW" && !reviewPromotionProven
      ? await this.hasCommittedReviewWrite(projectId, documentId, head.logical_path, pointer.versionId, observation, version, budget)
      : false;
    const publishedMoveProven = providerMismatch && zone === "DELIVERABLES" && !legacyExternalPublishedContentProof
      ? await this.hasCommittedPublishedMove(projectId, documentId, head.logical_path, pointer.versionId, observation, version, budget)
      : false;
    if (providerMismatch && !repairProof && !reviewPromotionProven && !reviewWriteProven && !publishedMoveProven && !legacyExternalPublishedContentProof) return { entry: null, gap: { resource_id: resourceId, code: "active_version_provider_mismatch" } };
    const verified = await this.readVisible(observation.path, observation, version, budget);
    if (!verified) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_content_unverified" } };
    if (repairProof && verified.sha256 !== repairProof.content_sha256) return { entry: null, gap: { resource_id: resourceId, code: "active_instance_repair_content_mismatch" } };
    if ((publishedMoveProven || reviewWriteProven) && version.provider_evidence?.size !== observation.size) {
      // Historical WORKING evidence may describe older bytes. An exact
      // publication or REVIEW write receipt proves the operation, but only
      // immutable payload bytes can justify the changed destination size.
      charge(budget);
      const immutable = this.runtime.objects.readBytes
        ? await this.runtime.objects.readBytes(version.immutable_payload_path, Math.max(1, observation.size))
        : await this.runtime.objects.readText(version.immutable_payload_path).then((text) => text === null ? null : new TextEncoder().encode(text));
      if (!immutable || immutable.byteLength !== verified.size || await sha256Bytes(immutable) !== verified.sha256) {
        return { entry: null, gap: { resource_id: resourceId, code: "active_immutable_payload_mismatch" } };
      }
    }
    return {
      entry: navigationInventoryEntrySchema.parse({
        project_id: projectId,
        zone,
        resource_id: resourceId,
        version: pointer.versionId,
        logical_path: version.logical_path,
        path: observation.path,
        expected: {
          object_id: observation.object_id,
          revision_token: observation.revision_token,
          content_sha256: verified.sha256,
          size: verified.size
        }
      })
    };
  }

  private async hasCommittedReviewWrite(
    projectId: string, documentId: string, logicalPath: string, versionId: string,
    current: { path: string; object_id: string; revision_token: string; size: number },
    version: CurrentDocumentVersionRecord, budget: SliceBudget
  ): Promise<boolean> {
    const historical = version.provider_evidence;
    if (version.source !== "project_os" || !historical || !version.parent_version_id || !version.request_id
      || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(version.request_id)
      || historical.provider_id !== this.runtime.providerId || historical.object_id !== current.object_id) return false;
    const expectedVersionId = `VER-REQ-${(await sha256Text(`${version.request_id}\nreview`)).slice(0, 24).toUpperCase()}`;
    if (version.version_id !== versionId || versionId !== expectedVersionId || !version.content_sha256
      || version.immutable_payload_path !== machineDocumentTextPayloadPath(projectId, version.content_sha256)) return false;
    charge(budget);
    const stateRaw = await this.runtime.objects.readText(machineStatePath(projectId));
    if (!stateRaw) return false;
    let canonicalRoot: string;
    try {
      const state = readProjectState(JSON.parse(stateRaw)).state;
      if (state.project_id !== projectId) return false;
      canonicalRoot = workspaceProjectRoot(projectId, state.slug);
    } catch { return false; }
    if (historical.path !== `${canonicalRoot}/WORKING/${logicalPath}`
      || current.path !== `${canonicalRoot}/REVIEW/${logicalPath}`) return false;

    charge(budget);
    const parentRaw = await this.runtime.objects.readText(machineDocumentVersionPath(projectId, documentId, version.parent_version_id));
    if (!parentRaw) return false;
    let parent: CurrentDocumentVersionRecord;
    try { parent = readDocumentVersionRecord(JSON.parse(parentRaw)).record; }
    catch { return false; }
    const previous = parent.provider_evidence;
    if (parent.project_id !== projectId || parent.document_id !== documentId || parent.version_id !== version.parent_version_id
      || parent.kind !== version.kind || parent.stage !== "review" || parent.logical_path !== logicalPath
      || !previous || previous.provider_id !== historical.provider_id || previous.object_id !== historical.object_id
      || previous.revision_token !== historical.revision_token || previous.path !== historical.path
      || previous.size !== historical.size || previous.integrity_hash.algorithm !== historical.integrity_hash.algorithm
      || previous.integrity_hash.value !== historical.integrity_hash.value) return false;

    charge(budget);
    const intentRaw = await this.runtime.objects.readText(`${machineDocumentRoot(projectId)}/requests/${version.request_id}/intent.json`);
    if (!intentRaw) return false;
    let intent: Record<string, unknown>;
    let request: Record<string, unknown>;
    try {
      intent = JSON.parse(intentRaw) as Record<string, unknown>;
      if (intent.schema_version !== "1.0" || intent.project_id !== projectId || intent.request_id !== version.request_id
        || typeof intent.request_sha256 !== "string" || typeof intent.request_json !== "string"
        || await sha256Text(intent.request_json) !== intent.request_sha256) return false;
      request = parseManagedDocumentRequest(JSON.parse(intent.request_json)) as unknown as Record<string, unknown>;
    } catch { return false; }
    if (request.operation !== "review.write" || request.project_id !== projectId || request.document_id !== documentId
      || request.request_id !== version.request_id || request.expected_version_id !== version.parent_version_id
      || request.created_at !== version.created_at || typeof request.content !== "string"
      || await sha256Text(request.content) !== request.content_sha256
      || await sha256Text(enforceManagedMarkdownIdentity(request.content, { projectId, documentId, logicalPath })) !== version.content_sha256) return false;

    charge(budget);
    const receiptRaw = await this.runtime.objects.readText(`${machineDocumentRoot(projectId)}/requests/${version.request_id}/receipt.json`);
    if (!receiptRaw) return false;
    let wrapper: Record<string, unknown>;
    let receipt: Record<string, unknown>;
    try {
      wrapper = JSON.parse(receiptRaw) as Record<string, unknown>;
      if (wrapper.schema_version !== "1.0" || wrapper.project_id !== projectId || wrapper.request_id !== version.request_id
        || wrapper.request_sha256 !== intent.request_sha256 || wrapper.request_json !== intent.request_json
        || typeof wrapper.receipt_json !== "string") return false;
      receipt = JSON.parse(wrapper.receipt_json) as Record<string, unknown>;
    } catch { return false; }
    if (receipt.status !== "committed" || receipt.request_id !== version.request_id || receipt.project_id !== projectId
      || receipt.document_id !== documentId || receipt.version_id !== versionId || receipt.stage !== "review"
      || receipt.logical_path !== logicalPath || receipt.provider_rev !== current.revision_token) return false;

    charge(budget);
    let admission: Awaited<ReturnType<ExecutionJournal["readAdmission"]>>;
    try { admission = await new ExecutionJournal(this.runtime, projectId, "document", version.request_id).readAdmission(); }
    catch { return false; }
    if (!admission || admission.admission.operation !== "review.write"
      || admission.admission.request_hash !== await executionHash(request) || admission.admission.verdict !== "allow") return false;
    return admission.admission.resources.filter((resource) => resource.resource_id === documentId
      && resource.resource_type === "document" && resource.zone === "DOCUMENTS"
      && resource.version === version.parent_version_id && resource.expected_version === version.parent_version_id).length === 1;
  }

  private async hasCommittedReviewPromotion(
    projectId: string, documentId: string, logicalPath: string, versionId: string,
    current: { path: string; object_id: string; revision_token: string; size: number },
    version: CurrentDocumentVersionRecord, budget: SliceBudget
  ): Promise<boolean> {
    const historical = version.provider_evidence;
    if (!historical || historical.object_id !== current.object_id || historical.size !== current.size
      || historical.provider_id !== this.runtime.providerId || historical.path.replace("/WORKING/", "/REVIEW/") !== current.path
      || historical.path.split("/WORKING/").length !== 2
      || !historical.path.endsWith(`/${logicalPath}`)
      || !current.path.endsWith(`/REVIEW/${logicalPath}`)
      || !version.parent_version_id || !version.request_id
      || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(version.request_id)) return false;
    const expectedVersionId = `VER-REQ-${(await sha256Text(`${version.request_id}\nreview`)).slice(0, 24).toUpperCase()}`;
    if (version.version_id !== versionId || versionId !== expectedVersionId) return false;

    const requestPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/intent.json`;
    charge(budget);
    const intentRaw = await this.runtime.objects.readText(requestPath);
    if (!intentRaw) return false;
    let intent: Record<string, unknown>;
    let request: Record<string, unknown>;
    try {
      intent = JSON.parse(intentRaw) as Record<string, unknown>;
      if (intent.schema_version !== "1.0" || intent.project_id !== projectId || intent.request_id !== version.request_id
        || typeof intent.request_sha256 !== "string") return false;
      // Legacy committed promotions stored only the raw request digest. The
      // optional expected_version_id was absent in some of those requests;
      // reconstruct only these two exact historical shapes and require the
      // persisted digest to select one before consulting the receipt.
      const legacyBase = {
        operation: "review.promote", request_id: version.request_id, project_id: projectId,
        document_id: documentId
      };
      const legacyRequests = [
        JSON.stringify({ ...legacyBase, expected_version_id: version.parent_version_id, created_at: version.created_at }),
        JSON.stringify({ ...legacyBase, created_at: version.created_at })
      ];
      const requestJson = typeof intent.request_json === "string" ? intent.request_json
        : intent.request_json === undefined
          ? (await Promise.all(legacyRequests.map(async (candidate) => ({ candidate, digest: await sha256Text(candidate) })))).find((item) => item.digest === intent.request_sha256)?.candidate ?? null
          : null;
      if (!requestJson || await sha256Text(requestJson) !== intent.request_sha256) return false;
      request = parseManagedDocumentRequest(JSON.parse(requestJson)) as unknown as Record<string, unknown>;
    } catch { return false; }
    if (request.operation !== "review.promote" || request.request_id !== version.request_id
      || request.project_id !== projectId || request.document_id !== documentId
      || (request.expected_version_id !== undefined && request.expected_version_id !== version.parent_version_id)) return false;

    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/receipt.json`;
    charge(budget);
    const receiptRaw = await this.runtime.objects.readText(receiptPath);
    if (!receiptRaw) return false;
    let receiptRecord: Record<string, unknown>;
    let receipt: Record<string, unknown>;
    try {
      receiptRecord = JSON.parse(receiptRaw) as Record<string, unknown>;
      if (receiptRecord.schema_version !== "1.0" || receiptRecord.project_id !== projectId
        || receiptRecord.request_id !== version.request_id || receiptRecord.request_sha256 !== intent.request_sha256
        || receiptRecord.request_json !== intent.request_json || typeof receiptRecord.receipt_json !== "string") return false;
      receipt = JSON.parse(receiptRecord.receipt_json) as Record<string, unknown>;
    } catch { return false; }
    if (receipt.status !== "committed" || receipt.request_id !== version.request_id || receipt.project_id !== projectId
      || receipt.document_id !== documentId || receipt.version_id !== versionId || receipt.stage !== "review"
      || receipt.logical_path !== logicalPath || receipt.provider_rev !== current.revision_token) return false;

    charge(budget);
    let admission: Awaited<ReturnType<ExecutionJournal["readAdmission"]>>;
    try { admission = await new ExecutionJournal(this.runtime, projectId, "document", version.request_id).readAdmission(); }
    catch { return false; }
    if (!admission || admission.admission.operation !== "review.promote"
      || admission.admission.request_hash !== await executionHash(request) || admission.admission.verdict !== "allow") return false;
    const matchingResources = admission.admission.resources.filter((resource) => resource.resource_id === documentId
      && resource.resource_type === "document" && resource.zone === "DOCUMENTS"
      && (request.expected_version_id === undefined
        ? resource.version === version.request_id && resource.expected_version === undefined
        : resource.version === version.parent_version_id && resource.expected_version === version.parent_version_id));
    return matchingResources.length === 1;
  }

  private async hasCommittedPublishedMove(
    projectId: string, documentId: string, logicalPath: string, versionId: string,
    current: { path: string; object_id: string; revision_token: string; size: number },
    version: CurrentDocumentVersionRecord, budget: SliceBudget
  ): Promise<boolean> {
    const historical = version.provider_evidence;
    charge(budget);
    const stateRaw = await this.runtime.objects.readText(machineStatePath(projectId));
    if (!stateRaw) return false;
    let canonicalRoot: string;
    try {
      const state = readProjectState(JSON.parse(stateRaw)).state;
      if (state.project_id !== projectId) return false;
      canonicalRoot = workspaceProjectRoot(projectId, state.slug);
    } catch { return false; }
    // A replacement publication can write a new DELIVERABLES object instead
    // of moving the WORKING object. Its identity is established below by the
    // exact committed publish receipt revision and verified immutable bytes.
    if (!historical || historical.provider_id !== this.runtime.providerId || historical.path !== `${canonicalRoot}/WORKING/${logicalPath}`
      || current.path !== `${canonicalRoot}/DELIVERABLES/${logicalPath}`
      || !historical.path.endsWith(`/${logicalPath}`)
      || !version.parent_version_id || !version.request_id
      || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(version.request_id)) return false;
    const expectedVersionId = `VER-REQ-${(await sha256Text(`${version.request_id}\npublished`)).slice(0, 24).toUpperCase()}`;
    if (version.version_id !== versionId || versionId !== expectedVersionId) return false;

    const parentPath = machineDocumentVersionPath(projectId, documentId, version.parent_version_id);
    charge(budget);
    const parentRaw = await this.runtime.objects.readText(parentPath);
    if (!parentRaw) return false;
    let parent: CurrentDocumentVersionRecord;
    try { parent = readDocumentVersionRecord(JSON.parse(parentRaw)).record; }
    catch { return false; }
    const reviewedEvidence = parent.provider_evidence;
    if (parent.project_id !== projectId || parent.document_id !== documentId || parent.version_id !== version.parent_version_id
      || parent.kind !== version.kind || parent.stage !== "review" || parent.logical_path !== logicalPath
      || typeof parent.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parent.content_sha256)
      || parent.content_sha256 !== version.content_sha256 || parent.immutable_payload_path !== version.immutable_payload_path
      || parent.immutable_payload_path !== machineDocumentTextPayloadPath(projectId, parent.content_sha256)
      || !reviewedEvidence || reviewedEvidence.provider_id !== historical.provider_id
      || reviewedEvidence.object_id !== historical.object_id || reviewedEvidence.revision_token !== historical.revision_token
      || reviewedEvidence.path !== historical.path || reviewedEvidence.integrity_hash.algorithm !== historical.integrity_hash.algorithm
      || reviewedEvidence.integrity_hash.value !== historical.integrity_hash.value || reviewedEvidence.size !== historical.size
      || reviewedEvidence.path !== `${canonicalRoot}/WORKING/${logicalPath}`) return false;

    const requestPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/intent.json`;
    charge(budget);
    const intentRaw = await this.runtime.objects.readText(requestPath);
    if (!intentRaw) return false;
    let intent: Record<string, unknown>;
    let request: Record<string, unknown>;
    try {
      intent = JSON.parse(intentRaw) as Record<string, unknown>;
      if (intent.schema_version !== "1.0" || intent.project_id !== projectId || intent.request_id !== version.request_id
        || typeof intent.request_sha256 !== "string") return false;
      // Historical committed publications stored the request digest without
      // its JSON envelope. Reconstruct only the exact request represented by
      // this immutable version, and trust it only when the digest matches.
      const legacyRequestJson = JSON.stringify({
        operation: "publish", request_id: version.request_id, project_id: projectId,
        document_id: documentId, expected_version_id: version.parent_version_id,
        created_at: version.created_at
      });
      const requestJson = typeof intent.request_json === "string" ? intent.request_json
        : intent.request_json === undefined ? legacyRequestJson : null;
      if (!requestJson || await sha256Text(requestJson) !== intent.request_sha256) return false;
      request = parseManagedDocumentRequest(JSON.parse(requestJson)) as unknown as Record<string, unknown>;
    } catch { return false; }
    if (request.operation !== "publish" || request.request_id !== version.request_id
      || request.project_id !== projectId || request.document_id !== documentId
      || request.expected_version_id !== version.parent_version_id) return false;

    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${version.request_id}/receipt.json`;
    charge(budget);
    const receiptRaw = await this.runtime.objects.readText(receiptPath);
    if (!receiptRaw) return false;
    let receiptRecord: Record<string, unknown>;
    let receipt: Record<string, unknown>;
    try {
      receiptRecord = JSON.parse(receiptRaw) as Record<string, unknown>;
      if (receiptRecord.schema_version !== "1.0" || receiptRecord.project_id !== projectId
        || receiptRecord.request_id !== version.request_id || receiptRecord.request_sha256 !== intent.request_sha256
        || receiptRecord.request_json !== intent.request_json || typeof receiptRecord.receipt_json !== "string") return false;
      receipt = JSON.parse(receiptRecord.receipt_json) as Record<string, unknown>;
    } catch { return false; }
    if (receipt.status !== "committed" || receipt.request_id !== version.request_id || receipt.project_id !== projectId
      || receipt.document_id !== documentId || receipt.version_id !== versionId || receipt.stage !== "published"
      || receipt.logical_path !== logicalPath || receipt.provider_rev !== current.revision_token) return false;

    charge(budget);
    let admission: Awaited<ReturnType<ExecutionJournal["readAdmission"]>>;
    try { admission = await new ExecutionJournal(this.runtime, projectId, "document", version.request_id).readAdmission(); }
    catch { return false; }
    if (!admission || admission.admission.operation !== "document.publish"
      || admission.admission.request_hash !== await executionHash(request) || admission.admission.verdict !== "allow") return false;
    const matchingResources = admission.admission.resources.filter((resource) => resource.resource_id === documentId
      && resource.resource_type === "document" && resource.zone === "DOCUMENTS"
      && resource.version === version.parent_version_id && resource.expected_version === version.parent_version_id);
    return matchingResources.length === 1;
  }

  private async readCommittedInstanceRepair(
    projectId: string, documentId: string, logicalPath: string, versionId: string,
    current: { path: string; object_id: string; revision_token: string; size: number },
    version: CurrentDocumentVersionRecord, rawVersion: string, budget: SliceBudget
  ): Promise<{ content_sha256: string } | null> {
    const historical = {
      object_id: version.provider_file_id ?? version.provider_evidence?.object_id,
      revision_token: version.provider_rev ?? version.provider_evidence?.revision_token,
      path: version.provider_path ?? version.provider_evidence?.path,
      size: version.size ?? version.provider_evidence?.size
    };
    if (typeof historical.object_id !== "string" || typeof historical.revision_token !== "string"
      || typeof historical.path !== "string" || typeof historical.size !== "number") return null;
    const currentProvider = { object_id: current.object_id, revision_token: current.revision_token, path: current.path, size: current.size };
    const versionRecordSha256 = await sha256Text(rawVersion);
    const contentBinding = {
      project_id: projectId,
      document_id: documentId,
      version_id: versionId,
      logical_path: logicalPath,
      version_record_sha256: versionRecordSha256,
      historical_provider: historical,
      current_provider: currentProvider
    };
    const bindingSha256 = await sha256Canonical(contentBinding);
    const proofPath = machineDocumentInstanceRepairPath(projectId, documentId, versionId, bindingSha256);
    charge(budget);
    const proofRaw = await this.runtime.objects.readText(proofPath);
    if (!proofRaw) return null;
    let proof: Record<string, unknown>;
    try { proof = JSON.parse(proofRaw) as Record<string, unknown>; }
    catch { return null; }
    if (proof.schema_version !== "1.0" || proof.operation !== "document.instance.repair"
      || proof.project_id !== projectId || proof.document_id !== documentId || proof.version_id !== versionId
      || proof.logical_path !== logicalPath || proof.version_record_sha256 !== versionRecordSha256
      || canonicalJson(proof.historical_provider) !== canonicalJson(historical)
      || canonicalJson(proof.current_provider) !== canonicalJson(currentProvider)
      || typeof proof.request_id !== "string" || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(proof.request_id)
      || typeof proof.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.request_sha256)
      || typeof proof.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.content_sha256)
      || !Number.isSafeInteger(proof.source_generation)) return null;
    charge(budget);
    const receiptRaw = await this.runtime.objects.readText(`${machineDocumentRoot(projectId)}/requests/${proof.request_id}/receipt.json`);
    if (!receiptRaw) return null;
    let receiptRecord: Record<string, unknown>;
    let receipt: Record<string, unknown>;
    try {
      receiptRecord = JSON.parse(receiptRaw) as Record<string, unknown>;
      if (receiptRecord.project_id !== projectId || receiptRecord.request_id !== proof.request_id
        || receiptRecord.request_sha256 !== proof.request_payload_sha256 || typeof receiptRecord.receipt_json !== "string") return null;
      receipt = JSON.parse(receiptRecord.receipt_json) as Record<string, unknown>;
    }
    catch { return null; }
    const proofSha256 = await sha256Text(proofRaw);
    if (receipt.operation !== "document.instance.repair" || receipt.status !== "committed"
      || receipt.request_id !== proof.request_id || receipt.project_id !== projectId
      || receipt.document_id !== documentId || receipt.version_id !== versionId || receipt.logical_path !== logicalPath
      || receipt.admission_request_sha256 !== proof.request_sha256 || receipt.request_payload_sha256 !== proof.request_payload_sha256
      || receipt.proof_ref !== proofPath || receipt.proof_sha256 !== proofSha256
      || canonicalJson(receipt.actor) !== canonicalJson(proof.actor)) return null;
    charge(budget);
    const executionRoot = `${machineConvergenceRoot(projectId)}/executions/${await executionHash({ kind: "document", request_id: proof.request_id })}`;
    const admissionRaw = await this.runtime.objects.readText(`${executionRoot}/admission.json`);
    if (!admissionRaw) return null;
    let admissionRecord: Record<string, unknown>;
    try { admissionRecord = JSON.parse(admissionRaw) as Record<string, unknown>; }
    catch { return null; }
    const admission = admissionRecord.admission as Record<string, unknown> | undefined;
    const actor = admission?.actor as Record<string, unknown> | undefined;
    const resources = admission?.resources;
    const repairResourceVersion = `${versionId}:${String(proof.source_generation)}:${versionRecordSha256}:${String(proof.content_sha256)}:${await sha256Canonical({ historical_provider: historical, current_provider: currentProvider })}`;
    if (!admission || admission.kind !== "document" || admission.project_id !== projectId
      || admission.request_id !== proof.request_id || admission.operation !== "document.instance.repair"
      || admission.request_hash !== proof.request_sha256 || actor?.actor_id !== "control_tower"
      || actor.authority !== "control_tower_operator" || canonicalJson(actor) !== canonicalJson(proof.actor)
      || !Array.isArray(resources) || !resources.some((value) => {
        if (!value || typeof value !== "object") return false;
        const resource = value as Record<string, unknown>;
        return resource.resource_id === documentId && resource.resource_type === "document" && resource.zone === "WORKING"
          && resource.version === repairResourceVersion;
      })) return null;
    return { content_sha256: proof.content_sha256 };
  }

  private async readVisible(
    path: string,
    observation: { object_id: string; revision_token: string; size: number },
    version: CurrentDocumentVersionRecord,
    budget: SliceBudget
  ): Promise<{ sha256: string; size: number } | null> {
    charge(budget);
    const before = await this.runtime.objects.getMetadata(path);
    if (!metadataMatches(before, observation)) return null;
    let bytes: Uint8Array | null;
    if (this.runtime.objects.readBytes) {
      charge(budget);
      bytes = await this.runtime.objects.readBytes(path, Math.max(1, observation.size));
    } else {
      charge(budget);
      const text = await this.runtime.objects.readText(path);
      bytes = text === null ? null : new TextEncoder().encode(text);
    }
    if (!bytes || bytes.byteLength !== observation.size) return null;
    charge(budget);
    const after = await this.runtime.objects.getMetadata(path);
    const actualSha = await sha256Bytes(bytes);
    if (!metadataMatches(after, observation) || !metadataMatches(before, observation)) return null;
    if (version.content_sha256) {
      if (actualSha !== version.content_sha256) return null;
    } else if (version.provider_evidence?.integrity_hash.algorithm === "sha256") {
      if (actualSha !== version.provider_evidence.integrity_hash.value) return null;
    } else {
      // V1 provider hashes such as Dropbox content_hash are not SHA-256. In
      // that case bind the visible bytes to the exact immutable version payload.
      let immutable: Uint8Array | null;
      if (this.runtime.objects.readBytes) {
        charge(budget);
        immutable = await this.runtime.objects.readBytes(version.immutable_payload_path, Math.max(1, observation.size));
      } else {
        charge(budget);
        const text = await this.runtime.objects.readText(version.immutable_payload_path);
        immutable = text === null ? null : new TextEncoder().encode(text);
      }
      if (!immutable || immutable.byteLength !== bytes.byteLength || !sameBytes(immutable, bytes)) return null;
    }
    return { sha256: actualSha, size: bytes.byteLength };
  }

  private sourcesRoot(projectId: string, zone: NavigationZone): string {
    // Keep the persisted namespace owned by ZoneNavigationSources. The root
    // helper is imported lazily through the module-level function below.
    return zoneNavigationCatalogRoot(projectId, zone);
  }
}

function activePointer(head: CurrentManagedDocumentHead, zone: NavigationZone): { versionId?: string; observation?: NonNullable<CurrentManagedDocumentHead["provider"]>["working"]; stage: "working" | "review" | "published" } {
  if (zone === "WORKING") return { versionId: head.working_version_id, observation: head.provider?.working, stage: "working" };
  if (zone === "REVIEW") return { versionId: head.review_version_id, observation: head.provider?.review, stage: "review" };
  return { versionId: head.published_version_id, observation: head.provider?.published, stage: "published" };
}

function normalizeObservation(value: NonNullable<CurrentManagedDocumentHead["provider"]>["working"]): { path: string; object_id: string; revision_token: string; size: number } {
  if (!value) throw new Error("provider_observation_missing");
  const observation = value as unknown as Record<string, unknown>;
  const object_id = typeof observation.object_id === "string" ? observation.object_id : observation.file_id;
  const revision_token = typeof observation.revision_token === "string" ? observation.revision_token : observation.rev;
  if (typeof observation.path !== "string" || typeof object_id !== "string" || typeof revision_token !== "string" || typeof observation.size !== "number") throw new Error("provider_observation_invalid");
  return { path: observation.path, object_id, revision_token, size: observation.size };
}

function metadataMatches(metadata: ProviderObjectMetadata | null, identity: { object_id: string; revision_token: string; size: number }): boolean {
  return !!metadata && metadata.objectId === identity.object_id && metadata.revisionToken === identity.revision_token && metadata.size === identity.size;
}

function requireBudget(budget: SliceBudget, calls: number): void {
  if (!budget.canStartEffect(calls)) throw new Error("slice_budget_exhausted");
}

function withCheckpointReserve(budget: SliceBudget, reservedCalls: number): SliceBudget {
  return {
    get deadline_ms() { return budget.deadline_ms; },
    get calls_left() { return budget.calls_left; },
    now: () => budget.now(),
    signal: budget.signal,
    beforeHttp() {
      if (budget.calls_left <= reservedCalls) throw new Error("slice_budget_exhausted");
      budget.beforeHttp();
    },
    canStartEffect(requiredCalls) { return budget.canStartEffect(requiredCalls); }
  };
}

function generationFromSnapshot(snapshotId: string): number {
  const match = /^source:(\d+)$/.exec(snapshotId);
  if (!match) throw new Error("navigation_inventory_snapshot_invalid");
  return Number(match[1]);
}

function charge(budget: SliceBudget): void { budget.beforeHttp(); }

function encodeCursor(phase: PagePhase, cursor: string): string { return `${phase}:${encodeURIComponent(cursor)}`; }

function parseInitialHeadPageCursor(cursor: string): InitialHeadPageCursor | null {
  let value: unknown;
  try { value = JSON.parse(cursor); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).kind !== "zone-navigation-head-batch-v1") return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "entries", "provider_cursor", "listing_limit"].includes(key))
    || !Array.isArray(record.entries)
    || (record.provider_cursor !== null && typeof record.provider_cursor !== "string")
    || typeof record.listing_limit !== "number" || !Number.isSafeInteger(record.listing_limit) || record.listing_limit < 1 || record.listing_limit > MAX_INITIAL_HEADS_PER_PAGE) {
    throw new Error("navigation_inventory_cursor_invalid");
  }
  const entries: ProviderEntry[] = record.entries.map((item): ProviderEntry => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("navigation_inventory_cursor_invalid");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["kind", "name", "path"].includes(key))
      || (entry.kind !== "file" && entry.kind !== "folder" && entry.kind !== "deleted")
      || typeof entry.name !== "string" || (entry.path !== undefined && typeof entry.path !== "string")) throw new Error("navigation_inventory_cursor_invalid");
    return { kind: entry.kind, name: entry.name, ...(entry.path === undefined ? {} : { path: entry.path }) } as ProviderEntry;
  });
  return { kind: "zone-navigation-head-batch-v1", entries, provider_cursor: record.provider_cursor as string | null, listing_limit: record.listing_limit };
}

function decodeCursor(value: string): PageCursor {
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("navigation_inventory_cursor_invalid");
  const phase = value.slice(0, separator);
  if (phase !== "initial" && phase !== "packages" && phase !== "artifacts" && phase !== "artifact-bindings" && phase !== "artifact-finalize" && phase !== "dirty" && phase !== "dirty-package" && phase !== "dirty-artifacts" && phase !== "dirty-finish" && phase !== "catalog" && phase !== "catalog-compact") throw new Error("navigation_inventory_cursor_invalid");
  const encoded = value.slice(separator + 1);
  return { phase, cursor: encoded ? decodeURIComponent(encoded) : null };
}

function sameEntry(left: NavigationInventoryEntry, right: NavigationInventoryEntry): boolean {
  return left.project_id === right.project_id && left.zone === right.zone && left.resource_id === right.resource_id
    && left.version === right.version && left.logical_path === right.logical_path && left.path === right.path
    && left.expected.object_id === right.expected.object_id && left.expected.revision_token === right.expected.revision_token
    && left.expected.content_sha256 === right.expected.content_sha256 && left.expected.size === right.expected.size;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isBudgetError(error: unknown): boolean { return error instanceof Error && error.message.includes("slice_budget_exhausted"); }
function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ProviderOperationError ? error.retryable
    : Boolean(error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable === true);
}

function classifyGap(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("binding") ? "canonical_binding_invalid" : text.includes("JSON") ? "canonical_record_invalid" : "canonical_source_unavailable";
}

function unsupportedSourceCode(resourceId: string): string {
  return resourceId.startsWith("package:") ? "finalized_package_resolver_unavailable"
    : resourceId.startsWith("artifact:") ? "committed_artifact_resolver_unavailable"
      : "canonical_source_resolver_unavailable";
}

function unresolvedSourceFamilyGaps(): NavigationCoverageGap[] {
  return [];
}

interface CurrentPackageNavigation {
  head: PackageNavigationHead | null;
  base_path: string;
  visible_members: Array<{ path: string; provider_id: string; object_id: string; revision_token: string; content_sha256: string }> | null;
}

interface ArtifactBindingCursor {
  next_intent_cursor: string | null;
  request_id: string;
  destination_path: string;
  binding_cursor: string | null;
  eligible_request_ids: string[];
  gaps: NavigationCoverageGap[];
  quarantine_cursor?: string | null;
  committed_unverified?: boolean;
  dirty?: { resource_id: string; dirty_cursor: string | null };
}

interface DirtyArtifactCursor {
  resource_id: string;
  dirty_cursor: string | null;
  intent_cursor: string | null;
  destination_path: string | null;
  request_id?: string;
  binding_cursor: string | null;
  eligible_request_ids: string[];
  gaps: NavigationCoverageGap[];
}

async function readCurrentPackageNavigation(runtime: ProjectOsPersistenceRuntime, projectId: string, zone: NavigationZone, budget: SliceBudget): Promise<CurrentPackageNavigation | null> {
  const bounded = budgetedRuntime(runtime, budget);
  const path = packageNavigationPath(projectId);
  const before = await bounded.objects.getMetadata(path);
  if (!before) return null;
  if (before.size > MAX_PACKAGE_LEDGER_BYTES || !bounded.objects.readBytes) throw new Error("package_navigation_ledger_oversize_or_unreadable");
  const bytes = await bounded.objects.readBytes(path, MAX_PACKAGE_LEDGER_BYTES);
  const after = await bounded.objects.getMetadata(path);
  if (!bytes || bytes.byteLength !== before.size || after?.objectId !== before.objectId || after?.revisionToken !== before.revisionToken) throw new Error("package_navigation_ledger_unstable");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const ledger = packageNavigationLedgerSchema.parse(JSON.parse(raw));
  if (ledger.project_id !== projectId) throw new Error("package_navigation_binding");
  const repository = new DocumentLedgerRepository(bounded);
  const { admitted } = await repository.readPackageExecutionEvidence(projectId, "document", ledger.source_request_id);
  const headHash = await sha256Text(raw);
  if (!admitted.plan?.steps.some((step) => step.action.kind === "write_if_unchanged" && step.action.destination.path === path && step.action.desired.content_sha256 === headHash)) throw new Error("package_navigation_unproven");
  const stateWrite = admitted.plan.steps.find((step) => step.action.kind === "write_if_unchanged" && step.action.destination.logical_path === "STATE.md");
  if (!stateWrite || stateWrite.action.kind !== "write_if_unchanged" || !stateWrite.action.destination.path.endsWith("/STATE.md")) throw new Error("package_navigation_workspace_unavailable");
  const basePath = stateWrite.action.destination.path.slice(0, -"/STATE.md".length);
  const expectedRoot = new RegExp(`^/PROJECT_OS/WORKSPACE/PROJECTS/${escapeRegExp(projectId)}-[A-Za-z0-9][A-Za-z0-9_-]*$`);
  if (!expectedRoot.test(basePath)) throw new Error("package_navigation_workspace_binding");
  const head = ledger.heads[zone] ?? null;
  if (head && (head.project_id !== projectId || head.zone !== zone
    || new Set(head.packages.map((item) => item.ref.package_id)).size !== head.packages.length
    || head.packages.some((item) => item.ref.project_id !== projectId || item.root !== `${zone}/PACKAGES/${item.ref.package_id}/${item.ref.version}`))) throw new Error("package_navigation_binding");
  return { head, base_path: basePath, visible_members: ledger.visible_members ?? null };
}

async function resolvePackageIndex(
  runtime: ProjectOsPersistenceRuntime,
  projectId: string,
  zone: NavigationZone,
  selected: PackageNavigationHead["packages"][number],
  source: CurrentPackageNavigation,
  memberIndex: number,
  budget: SliceBudget,
  verifyAllMembers = false
): Promise<{ entry: NavigationInventoryEntry | null; gap?: NavigationCoverageGap; pending?: boolean }> {
  const ref = packageRefSchema.parse(selected.ref);
  if (ref.project_id !== projectId || selected.root !== `${zone}/PACKAGES/${ref.package_id}/${ref.version}`) throw new Error("package_navigation_binding");
  const bounded = budgetedRuntime(runtime, budget);
  const manifestPath = packageManifestPath(ref);
  const metadata = await bounded.objects.getMetadata(manifestPath);
  if (!metadata || metadata.size > MAX_PACKAGE_MANIFEST_BYTES || !bounded.objects.readBytes) throw new Error("package_manifest_unavailable_or_oversize");
  const bytes = await bounded.objects.readBytes(manifestPath, MAX_PACKAGE_MANIFEST_BYTES);
  const metadataAfter = await bounded.objects.getMetadata(manifestPath);
  if (!bytes || bytes.byteLength !== metadata.size || metadataAfter?.objectId !== metadata.objectId || metadataAfter?.revisionToken !== metadata.revisionToken) throw new Error("package_manifest_unstable");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (await sha256Text(raw) !== ref.manifest_sha256) throw new Error("package_manifest_binding");
  const manifest = parsePackageManifest(JSON.parse(raw));
  if (manifest.project_id !== projectId || manifest.version !== ref.version || await packageIdFor(projectId, manifest.creation_request_id) !== ref.package_id || canonicalJson(manifest) !== raw) throw new Error("package_manifest_binding");
  if (!source.visible_members) throw new Error("package_visible_member_evidence_unavailable");
  if (verifyAllMembers) {
    // Member metadata is one provider call each; validating the visible INDEX
    // needs before/read/after (three more). Manifest stability was already
    // checked above, so reserving its calls again starves bounded verify_entry
    // slices for larger legacy package pages.
    if (!budget.canStartEffect(manifest.members.length + 3)) throw new Error("slice_budget_exhausted");
    for (const member of manifest.members) await verifyPackageMember(runtime, bounded, projectId, selected.root, source, member);
  } else {
    if (memberIndex >= manifest.members.length) throw new Error("package_member_cursor_invalid");
    await verifyPackageMember(runtime, bounded, projectId, selected.root, source, manifest.members[memberIndex]);
    if (memberIndex + 1 < manifest.members.length) return { entry: null, pending: true };
  }
  const logicalPath = `${selected.root.slice(zone.length + 1)}/INDEX.md`;
  const content = `# ${ref.package_id} v${ref.version}\n\n${manifest.members.map((member) => `- [[${selected.root}/${member.relative_path}]]`).join("\n")}\n`;
  const contentHash = await sha256Text(content);
  const visiblePath = `${source.base_path}/${selected.root}/INDEX.md`;
  const before = await bounded.objects.getMetadata(visiblePath);
  if (!before || before.size > MAX_VISIBLE_SOURCE_BYTES || !bounded.objects.readBytes) throw new Error("package_index_visible_unavailable");
  const visible = await bounded.objects.readBytes(visiblePath, Math.max(1, before.size));
  const after = await bounded.objects.getMetadata(visiblePath);
  if (!visible || visible.byteLength !== before.size || after?.objectId !== before.objectId || after?.revisionToken !== before.revisionToken || await sha256Bytes(visible) !== contentHash) throw new Error("package_index_visible_changed");
  return { entry: navigationInventoryEntrySchema.parse({
    project_id: projectId,
    zone,
    resource_id: `package:${ref.package_id}`,
    version: packageResourceVersion(ref),
    logical_path: logicalPath,
    path: visiblePath,
    expected: { object_id: before.objectId, revision_token: before.revisionToken, content_sha256: contentHash, size: before.size }
  }) };
}

async function verifyPackageMember(
  runtime: ProjectOsPersistenceRuntime,
  bounded: ProjectOsPersistenceRuntime,
  projectId: string,
  packageRoot: string,
  source: CurrentPackageNavigation,
  member: ReturnType<typeof parsePackageManifest>["members"][number]
): Promise<void> {
  const memberPath = `${source.base_path}/${packageRoot}/${member.relative_path}`;
  const memberEvidence = source.visible_members!.filter((candidate) => candidate.path === memberPath);
  if (memberEvidence.length !== 1 || memberEvidence[0].provider_id !== runtime.providerId || memberEvidence[0].content_sha256 !== member.content_sha256) throw new Error("package_visible_member_binding");
  const memberMetadata = await bounded.objects.getMetadata(memberPath);
  if (!memberMetadata || memberMetadata.objectId !== memberEvidence[0].object_id || memberMetadata.revisionToken !== memberEvidence[0].revision_token || memberMetadata.size !== member.size) throw new Error("package_visible_member_changed");
}

function budgetedRuntime(runtime: ProjectOsPersistenceRuntime, budget: SliceBudget): ProjectOsPersistenceRuntime {
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(value, property, receiver) {
      const member = Reflect.get(value, property, receiver) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => { charge(budget); return member.apply(value, args); };
    }
  });
  return {
    ...runtime,
    objects: wrap(runtime.objects),
    ...(runtime.pagedListing ? { pagedListing: wrap(runtime.pagedListing) } : {})
  };
}

function classifyPackageGap(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("unfinalized") || message.includes("unproven") ? "finalized_package_evidence_unavailable"
    : message.includes("binding") ? "finalized_package_binding_invalid"
      : message.includes("oversize") || message.includes("unreadable") ? "finalized_package_source_out_of_bounds"
        : "finalized_package_source_unavailable";
}

function artifactNavigationTarget(projectId: string, path: string): { kind: "zone"; zone: NavigationZone; logical_path: string } | { kind: "outside" } | { kind: "invalid" } {
  const match = /^\/PROJECT_OS\/WORKSPACE\/PROJECTS\/(PRJ-[0-9]{4,})-([A-Za-z0-9][A-Za-z0-9_-]*)\/(WORKING|REVIEW|DELIVERABLES)\/(.+)$/.exec(path);
  if (!match) {
    const projectPrefix = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-`;
    return path.startsWith(projectPrefix) ? { kind: "outside" } : { kind: "invalid" };
  }
  if (match[1] !== projectId) return { kind: "invalid" };
  try {
    return { kind: "zone", zone: match[3] as NavigationZone, logical_path: match[4] };
  } catch { return { kind: "invalid" }; }
}

function isGenericArtifactDestination(projectId: string, path: string): boolean {
  const match = /^\/PROJECT_OS\/WORKSPACE\/PROJECTS\/(PRJ-[0-9]{4,})-([A-Za-z0-9][A-Za-z0-9_-]*)\/ARTIFACTS\/(.+)$/.exec(path);
  if (match?.[1] !== projectId) return false;
  try { return workspaceArtifactPath(projectId, match[2], match[3]) === path; }
  catch { return false; }
}

async function resolveArtifactEntry(
  runtime: ProjectOsPersistenceRuntime,
  projectId: string,
  zone: NavigationZone,
  intent: NonNullable<Awaited<ReturnType<MutationGateRepository["readArtifactIntent"]>>>,
  logicalPath: string,
  budget: SliceBudget
): Promise<NavigationInventoryEntry | null> {
  const bounded = budgetedRuntime(runtime, budget);
  const before = await bounded.objects.getMetadata(intent.destination_path);
  if (!before || before.size > MAX_VISIBLE_SOURCE_BYTES || !bounded.objects.readBytes) return null;
  const bytes = await bounded.objects.readBytes(intent.destination_path, Math.max(1, before.size));
  const after = await bounded.objects.getMetadata(intent.destination_path);
  if (!bytes || bytes.byteLength !== before.size || after?.objectId !== before.objectId || after?.revisionToken !== before.revisionToken || await sha256Bytes(bytes) !== intent.expected_content_sha256) return null;
  return navigationInventoryEntrySchema.parse({
    project_id: projectId,
    zone,
    resource_id: `artifact:${await sha256Text(intent.destination_path)}`,
    version: `${intent.request_id}:${intent.expected_content_sha256}`,
    logical_path: logicalPath,
    path: intent.destination_path,
    expected: { object_id: before.objectId, revision_token: before.revisionToken, content_sha256: intent.expected_content_sha256, size: before.size }
  });
}

function classifyArtifactGap(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("destination_binding") || message.includes("destination_binding_") ? "artifact_destination_binding_invalid"
    : message.includes("binding") ? "committed_artifact_binding_invalid"
      : message.includes("receipt") || message.includes("intent") ? "committed_artifact_receipt_unavailable"
        : message.includes("out_of_bounds") ? "committed_artifact_source_out_of_bounds"
          : "committed_artifact_source_unavailable";
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
