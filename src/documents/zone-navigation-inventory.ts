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
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentVersionPath, machineMutationGateRoot, machineMutationIntentDestinationBindingRoot } from "../persistence/layout";
import { sha256Text } from "./hash";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "./zone-navigation-sources";
import { packageIdFor, packageManifestPath, packageNavigationLedgerSchema, packageNavigationPath, packageRefSchema, packageResourceVersion, parsePackageManifest, type PackageNavigationHead, type PackageRef } from "../domain/document-package";
import { DocumentLedgerRepository } from "./repository";
import { canonicalJson } from "../rules/contract";
import { MutationGateRepository } from "../mutation-gate/repository";
import { MutationGateService } from "../mutation-gate/service";

type PagePhase = "initial" | "packages" | "artifacts" | "artifact-bindings" | "dirty" | "catalog";
interface PageCursor { phase: PagePhase; cursor: string | null }

const MAX_PACKAGE_LEDGER_BYTES = 128_000;
const MAX_PACKAGE_MANIFEST_BYTES = 256_000;
const MAX_VISIBLE_SOURCE_BYTES = 2_000_000;

/** Canonical, bounded source adapter used by ZoneNavigationEngine. */
export class ZoneNavigationInventory implements NavigationInventoryPort {
  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly sources: ZoneNavigationSources
  ) {}

  async listPage(input: {
    project_id: string;
    zone: NavigationZone;
    cursor: string | null;
    limit: number;
    budget: SliceBudget;
  }): Promise<{ entries: NavigationInventoryEntry[]; gaps: NavigationCoverageGap[]; snapshot_id: string; next_cursor: string | null }> {
    const { project_id: projectId, zone, budget } = input;
    const state = await this.sources.readState(projectId, zone, budget);
    const snapshot_id = `source:${state.generation}`;
    if (state.in_flight_resource_ids.length) {
      return { entries: [], gaps: [{ resource_id: "in_flight", code: "canonical_source_write_in_progress" }], snapshot_id, next_cursor: null };
    }

    const saved = input.cursor === null ? null : decodeCursor(input.cursor);
    const phase: PagePhase = saved?.phase ?? (state.adopted ? "dirty" : "initial");
    const providerCursor = saved?.cursor ?? null;
    if (phase === "initial") return this.initialPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget);
    if (phase === "packages") return this.packagePage(projectId, zone, providerCursor, snapshot_id, budget);
    if (phase === "artifacts") return this.artifactPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget);
    if (phase === "artifact-bindings") return this.artifactBindingsPage(projectId, zone, providerCursor, snapshot_id, budget);
    if (phase === "dirty") return this.dirtyAndCatalogPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget);
    return this.catalogPage(projectId, zone, providerCursor, input.limit, snapshot_id, budget, input.cursor === null);
  }

  async verifySnapshot(input: { project_id: string; zone: NavigationZone; snapshot_id: string; budget: SliceBudget }): Promise<boolean> {
    return this.sources.verifySnapshot(input.project_id, input.zone, input.snapshot_id, input.budget);
  }

  async verifyEntry(entry: NavigationInventoryEntry, budget: SliceBudget): Promise<boolean> {
    const resolved = await this.resolveHead(entry.project_id, entry.zone, entry.resource_id, budget);
    return resolved.entry !== null && sameEntry(resolved.entry, entry);
  }

  private async initialPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget
  ) {
    if (!this.runtime.pagedListing) return {
      entries: [], gaps: [{ resource_id: "heads", code: "paged_listing_unavailable" }, ...unresolvedSourceFamilyGaps()], snapshot_id: snapshotId, next_cursor: null
    };
    // Reserve before obtaining a cursor that must not be lost between slices.
    requireBudget(budget, 9);
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({
      path: `${machineDocumentRoot(projectId)}/heads`, cursor, limit: 1
    });
    const entries: NavigationInventoryEntry[] = [];
    const gaps: NavigationCoverageGap[] = [];
    for (const item of page.entries) {
      if (item.kind !== "file" || !item.path) continue;
      const match = /^(DOC-[A-F0-9]{24})\.json$/.exec(item.name);
      if (!match) continue;
      const resourceId = `head:${match[1]}`;
      if (item.path !== machineDocumentHeadPath(projectId, match[1])) {
        gaps.push({ resource_id: resourceId, code: "head_listing_path_mismatch" });
        continue;
      }
      try {
        const resolved = await this.resolveHead(projectId, zone, resourceId, budget);
        if (resolved.gap) gaps.push(resolved.gap);
        if (resolved.entry) {
          await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
          entries.push(resolved.entry);
        } else await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      } catch (error) {
        if (isBudgetError(error)) throw error;
        await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        gaps.push({ resource_id: resourceId, code: classifyGap(error) });
      }
    }
    if (cursor === null) gaps.push(...unresolvedSourceFamilyGaps());
    return {
      entries,
      gaps,
      snapshot_id: snapshotId,
      next_cursor: page.cursor === null ? encodeCursor("packages", JSON.stringify({ package_index: 0, member_index: 0 })) : encodeCursor("initial", page.cursor)
    };
  }

  private async packagePage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget) {
    requireBudget(budget, 22);
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
      if (isBudgetError(error)) throw error;
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
      if (resolved.entry) await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resolved.entry.resource_id, budget, generationFromSnapshot(snapshotId));
      else await this.sources.writeCatalogEntry(null, projectId, zone, `package:${selected.ref.package_id}`, budget, generationFromSnapshot(snapshotId));
      return {
        entries: resolved.entry ? [resolved.entry] : [], gaps, snapshot_id: snapshotId,
        next_cursor: packageIndex + 1 < packages.length ? encodeCursor("packages", JSON.stringify({ package_index: packageIndex + 1, member_index: 0 })) : encodeCursor("artifacts", "")
      };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      gaps.push({ resource_id: `package:${selected.ref.package_id}`, code: classifyPackageGap(error) });
      return { entries: [], gaps, snapshot_id: snapshotId, next_cursor: packageIndex + 1 < packages.length ? encodeCursor("packages", JSON.stringify({ package_index: packageIndex + 1, member_index: 0 })) : encodeCursor("artifacts", "") };
    }
  }

  private async artifactPage(projectId: string, zone: NavigationZone, cursor: string | null, _requestedLimit: number, snapshotId: string, budget: SliceBudget) {
    if (!this.runtime.pagedListing) return { entries: [], gaps: [{ resource_id: "artifacts", code: "paged_listing_unavailable" }], snapshot_id: snapshotId, next_cursor: null };
    requireBudget(budget, 16);
    const root = `${machineMutationGateRoot(projectId)}/intents/artifacts`;
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({ path: root, cursor, limit: 1 });
    const item = page.entries[0];
    if (!item) return { entries: [], gaps: [], snapshot_id: snapshotId, next_cursor: null };
    const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(item.name);
    if (item.kind !== "file" || !item.path || item.path !== `${root}/${item.name}` || !match) {
      return { entries: [], gaps: [{ resource_id: item.name, code: "artifact_intent_listing_invalid" }], snapshot_id: snapshotId, next_cursor: page.cursor === null ? null : encodeCursor("artifacts", page.cursor) };
    }
    let intent: Awaited<ReturnType<MutationGateRepository["readArtifactIntent"]>>;
    try {
      intent = await new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, match[1]);
      if (!intent || intent.request_id !== match[1] || intent.project_id !== projectId) throw new Error("artifact_intent_binding");
    } catch (error) {
      if (isBudgetError(error)) throw error;
      return { entries: [], gaps: [{ resource_id: `artifact:${match[1]}`, code: "committed_artifact_intent_unavailable" }], snapshot_id: snapshotId, next_cursor: page.cursor === null ? null : encodeCursor("artifacts", page.cursor) };
    }
    const target = artifactNavigationTarget(projectId, intent.destination_path);
    if (target.kind === "outside") {
      return { entries: [], gaps: [{ resource_id: `artifact:${await sha256Text(intent.destination_path)}`, code: "artifact_destination_outside_navigation_zones" }], snapshot_id: snapshotId, next_cursor: page.cursor === null ? null : encodeCursor("artifacts", page.cursor) };
    }
    if (target.kind === "invalid") {
      return { entries: [], gaps: [{ resource_id: `artifact:${await sha256Text(intent.destination_path)}`, code: "artifact_destination_binding_invalid" }], snapshot_id: snapshotId, next_cursor: page.cursor === null ? null : encodeCursor("artifacts", page.cursor) };
    }
    if (target.zone !== zone) return { entries: [], gaps: [], snapshot_id: snapshotId, next_cursor: page.cursor === null ? null : encodeCursor("artifacts", page.cursor) };
    const state: ArtifactBindingCursor = { next_intent_cursor: page.cursor, request_id: intent.request_id, destination_path: intent.destination_path, binding_cursor: null, eligible_request_ids: [], gaps: [] };
    return this.scanArtifactBindings(projectId, zone, state, snapshotId, budget);
  }

  private async artifactBindingsPage(projectId: string, zone: NavigationZone, cursor: string | null, snapshotId: string, budget: SliceBudget) {
    let state: ArtifactBindingCursor;
    try {
      state = JSON.parse(cursor ?? "") as ArtifactBindingCursor;
      if (!state || typeof state.request_id !== "string" || typeof state.destination_path !== "string" || !Array.isArray(state.eligible_request_ids) || !Array.isArray(state.gaps)
        || (state.next_intent_cursor !== null && typeof state.next_intent_cursor !== "string") || (state.binding_cursor !== null && typeof state.binding_cursor !== "string")) throw new Error("invalid");
    } catch { throw new Error("navigation_inventory_cursor_invalid"); }
    return this.scanArtifactBindings(projectId, zone, state, snapshotId, budget);
  }

  private async scanArtifactBindings(projectId: string, zone: NavigationZone, state: ArtifactBindingCursor, snapshotId: string, budget: SliceBudget) {
    if (!this.runtime.pagedListing) return { entries: [], gaps: [{ resource_id: `artifact:${await sha256Text(state.destination_path)}`, code: "paged_listing_unavailable" }], snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
    requireBudget(budget, 22);
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
        const metadata = await budgetedRuntime(this.runtime, budget).objects.getMetadata(state.destination_path);
        if (!metadata || metadata.size > MAX_VISIBLE_SOURCE_BYTES) throw new Error("artifact_visible_out_of_bounds");
        const status = await new MutationGateService(budgetedRuntime(this.runtime, budget), "observe").artifactStatus(projectId, match[1]);
        if (status?.verification_state === "canonical_verified" && status.receipt_status === "committed" && status.operation !== "REVIEW_CANDIDATE") {
          const resolved = await resolveArtifactEntry(this.runtime, projectId, zone, intent, target.logical_path, budget);
          if (resolved) state.eligible_request_ids.push(match[1]);
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
    const resourceId = `artifact:${destinationHash}`;
    const distinct = [...new Set(state.eligible_request_ids)];
    if (distinct.length > 1) {
      await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
      state.gaps.push({ resource_id: resourceId, code: "artifact_destination_ambiguous" });
      return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
    }
    if (distinct.length === 1 && distinct[0] === state.request_id) {
      const intent = await new MutationGateRepository(budgetedRuntime(this.runtime, budget)).readArtifactIntent(projectId, state.request_id);
      if (!intent) throw new Error("committed_artifact_intent_unavailable");
      const target = artifactNavigationTarget(projectId, state.destination_path);
      if (target.kind !== "zone" || target.zone !== zone) throw new Error("artifact_destination_zone_mismatch");
      const status = await new MutationGateService(budgetedRuntime(this.runtime, budget), "observe").artifactStatus(projectId, state.request_id);
      const entry = status?.verification_state === "canonical_verified" && status.receipt_status === "committed" && status.operation !== "REVIEW_CANDIDATE"
        ? await resolveArtifactEntry(this.runtime, projectId, zone, intent, target.logical_path, budget) : null;
      if (entry) {
        await this.sources.writeCatalogEntry(entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        return { entries: [entry], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
      }
    }
    return { entries: [], gaps: state.gaps, snapshot_id: snapshotId, next_cursor: state.next_intent_cursor === null ? null : encodeCursor("artifacts", state.next_intent_cursor) };
  }

  private async dirtyAndCatalogPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget
  ) {
    // One dirty record may require marker listing/read, canonical head/version,
    // visible metadata/bytes/metadata (plus immutable payload fallback), a
    // catalog write, dirty compare-and-clear, and one catalog-page listing/read.
    // Worst case: dirty list/read (2), head/version (2), visible bytes and
    // metadata with immutable fallback (4), catalog write (4), dirty compare-
    // and-clear (7), and catalog list/read (2). Keep the checkpoint reserve too.
    requireBudget(budget, 21);
    const dirtyPage = await this.sources.listDirtyPage(projectId, zone, cursor, 1, budget);
    const gaps: NavigationCoverageGap[] = [];
    for (const resourceId of dirtyPage.resource_ids) {
      if (!resourceId.startsWith("head:DOC-")) {
        // No finalized current package/artifact resolver is wired here. Remove
        // an obsolete cached entry, but retain the dirty marker so a snapshot
        // cannot certify a catalog whose canonical source was not checked.
        await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        gaps.push({ resource_id: resourceId, code: unsupportedSourceCode(resourceId) });
        continue;
      }
      try {
        const resolved = await this.resolveHead(projectId, zone, resourceId, budget);
        if (resolved.gap) {
          await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
          gaps.push(resolved.gap);
          continue;
        }
        await this.sources.writeCatalogEntry(resolved.entry, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        if (!await this.sources.finishDirty(projectId, zone, resourceId, resolved.entry, budget)) {
          gaps.push({ resource_id: resourceId, code: "dirty_identity_changed" });
        }
      } catch (error) {
        if (isBudgetError(error)) throw error;
        await this.sources.writeCatalogEntry(null, projectId, zone, resourceId, budget, generationFromSnapshot(snapshotId));
        gaps.push({ resource_id: resourceId, code: classifyGap(error) });
      }
    }
    if (dirtyPage.next_cursor !== null) return {
      entries: [], gaps, snapshot_id: snapshotId, next_cursor: encodeCursor("dirty", dirtyPage.next_cursor)
    };
    const catalog = await this.catalogPage(projectId, zone, null, requestedLimit, snapshotId, budget, true);
    return { ...catalog, gaps: [...gaps, ...catalog.gaps] };
  }

  private async catalogPage(
    projectId: string,
    zone: NavigationZone,
    cursor: string | null,
    _requestedLimit: number,
    snapshotId: string,
    budget: SliceBudget,
    includeFamilyGaps: boolean
  ) {
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

  private async resolveHead(projectId: string, zone: NavigationZone, resourceId: string, budget: SliceBudget): Promise<{ entry: NavigationInventoryEntry | null; gap?: NavigationCoverageGap }> {
    const match = /^head:(DOC-[A-F0-9]{24})$/.exec(resourceId);
    if (!match) return { entry: null, gap: { resource_id: resourceId, code: "invalid_head_resource_id" } };
    const documentId = match[1];
    charge(budget);
    const rawHead = await this.runtime.objects.readText(machineDocumentHeadPath(projectId, documentId));
    if (rawHead === null) return { entry: null };
    const head = readManagedDocumentHead(JSON.parse(rawHead)).head;
    if (head.project_id !== projectId || head.document_id !== documentId) throw new Error("head_binding_mismatch");
    if (head.reconciliation_status !== "clean") return { entry: null, gap: { resource_id: resourceId, code: "head_reconciliation_conflict" } };
    const pointer = activePointer(head, zone);
    if (!pointer.versionId && !pointer.observation) return { entry: null };
    if (!pointer.versionId || !pointer.observation) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_binding_missing" } };
    const observation = normalizeObservation(pointer.observation);
    charge(budget);
    const rawVersion = await this.runtime.objects.readText(machineDocumentVersionPath(projectId, documentId, pointer.versionId));
    if (rawVersion === null) return { entry: null, gap: { resource_id: resourceId, code: "active_version_missing" } };
    const version = readDocumentVersionRecord(JSON.parse(rawVersion)).record;
    if (version.project_id !== projectId || version.document_id !== documentId || version.version_id !== pointer.versionId || version.kind !== head.kind || version.stage !== pointer.stage || version.logical_path !== head.logical_path) {
      return { entry: null, gap: { resource_id: resourceId, code: "active_version_binding_mismatch" } };
    }
    if (version.provider_file_id !== observation.object_id || version.provider_rev !== observation.revision_token || version.provider_path !== observation.path || version.size !== observation.size) {
      return { entry: null, gap: { resource_id: resourceId, code: "active_version_provider_mismatch" } };
    }
    if (!observation.path.endsWith(`/${zone}/${version.logical_path}`)) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_path_mismatch" } };
    const verified = await this.readVisible(observation.path, observation, version, budget);
    if (!verified) return { entry: null, gap: { resource_id: resourceId, code: "active_provider_content_unverified" } };
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

function generationFromSnapshot(snapshotId: string): number {
  const match = /^source:(\d+)$/.exec(snapshotId);
  if (!match) throw new Error("navigation_inventory_snapshot_invalid");
  return Number(match[1]);
}

function charge(budget: SliceBudget): void { budget.beforeHttp(); }

function encodeCursor(phase: PagePhase, cursor: string): string { return `${phase}:${encodeURIComponent(cursor)}`; }

function decodeCursor(value: string): PageCursor {
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("navigation_inventory_cursor_invalid");
  const phase = value.slice(0, separator);
  if (phase !== "initial" && phase !== "packages" && phase !== "artifacts" && phase !== "artifact-bindings" && phase !== "dirty" && phase !== "catalog") throw new Error("navigation_inventory_cursor_invalid");
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
  budget: SliceBudget
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
  if (memberIndex >= manifest.members.length) throw new Error("package_member_cursor_invalid");
  const member = manifest.members[memberIndex];
  const memberPath = `${source.base_path}/${selected.root}/${member.relative_path}`;
  const memberEvidence = source.visible_members.filter((candidate) => candidate.path === memberPath);
  if (memberEvidence.length !== 1 || memberEvidence[0].provider_id !== runtime.providerId || memberEvidence[0].content_sha256 !== member.content_sha256) throw new Error("package_visible_member_binding");
  const memberMetadata = await bounded.objects.getMetadata(memberPath);
  if (!memberMetadata || memberMetadata.objectId !== memberEvidence[0].object_id || memberMetadata.revisionToken !== memberEvidence[0].revision_token || memberMetadata.size !== member.size) throw new Error("package_visible_member_changed");
  if (memberIndex + 1 < manifest.members.length) return { entry: null, pending: true };
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
