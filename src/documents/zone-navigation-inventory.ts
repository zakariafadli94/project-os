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
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentVersionPath } from "../persistence/layout";
import { sha256Text } from "./hash";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "./zone-navigation-sources";

type PagePhase = "initial" | "dirty" | "catalog";
interface PageCursor { phase: PagePhase; cursor: string | null }

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
      next_cursor: page.cursor === null ? null : encodeCursor("initial", page.cursor)
    };
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
  if (phase !== "initial" && phase !== "dirty" && phase !== "catalog") throw new Error("navigation_inventory_cursor_invalid");
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
  return [
    { resource_id: "packages", code: "finalized_package_inventory_unavailable" },
    { resource_id: "artifacts", code: "committed_artifact_inventory_unavailable" }
  ];
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
