import { z } from "zod";
import { navigationCatalogManifestIdentitySchema, navigationInventoryEntrySchema, zoneNavigationReceiptSchema, type NavigationCatalogManifestIdentity, type NavigationInventoryEntry, type NavigationZone, type ZoneNavigationReceipt } from "../domain/zone-navigation";
import type { SliceBudget } from "../convergence/contract";
import { machineDocumentHeadPath, machineDocumentRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { canonicalJson } from "../rules/contract";
import { sha256Text } from "./hash";

const zones = ["WORKING", "REVIEW", "DELIVERABLES"] as const;
export const ZONE_NAVIGATION_CATALOG_SHARDS = 64;
const zoneStateSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  adopted: z.boolean(),
  adoption_request_id: z.string().nullable(),
  adoption_generation: z.number().int().nonnegative().safe().nullable(),
  catalog_rebuild_request_id: z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/).nullable().default(null),
  catalog_cache_write_permits: z.array(z.strictObject({ id: z.string().uuid(), generation: z.number().int().nonnegative().safe(), expires_at: z.number().int().nonnegative().safe() })).max(256).default([]),
  in_flight_writes: z.array(z.strictObject({ resource_id: z.string(), generation: z.number().int().positive().safe(), write_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), owner_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }))
});
const stateSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: z.string(),
  state_revision: z.number().int().nonnegative().safe(),
  zones: z.record(z.enum(zones), zoneStateSchema)
});
const catalogSchema = z.strictObject({ schema_version: z.literal("1.0"), resource_id: z.string().optional(), entry: z.unknown() });
const compactEntrySchema = z.strictObject({
  resource_id: z.string(),
  source_generation: z.number().int().nonnegative().safe(),
  entry_hash: z.string().regex(/^[a-f0-9]{64}$/),
  entry: navigationInventoryEntrySchema
});
const compactChunkSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: z.string(),
  zone: z.enum(zones),
  shard: z.number().int().nonnegative().max(63),
  entries: z.array(compactEntrySchema)
});
const generationRangeSchema = z.strictObject({ start: z.number().int().positive().safe(), end: z.number().int().positive().safe() }).superRefine((value, ctx) => {
  if (value.start > value.end) ctx.addIssue({ code: "custom", message: "generation range start must not exceed end" });
});
const coalescedDirtySchema = z.strictObject({ resource_id: z.string(), latest_generation: z.number().int().positive().safe(), covered_generations: z.array(generationRangeSchema).max(64) });
const compactReadySchema = z.strictObject({ schema_version: z.literal("1.0"), project_id: z.string(), zone: z.enum(zones), ready_generation: z.number().int().nonnegative().safe().nullable(), shards: z.array(z.number().int().nonnegative().max(ZONE_NAVIGATION_CATALOG_SHARDS)).max(ZONE_NAVIGATION_CATALOG_SHARDS), completed_generations: z.array(generationRangeSchema).max(64).default([]), coalesced_dirty: z.array(coalescedDirtySchema).max(512).default([]), rebuilding_request_id: z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/).nullable().optional(), rebuild_repair_required: z.boolean().default(false) }).superRefine((value, ctx) => {
  if (new Set(value.shards).size !== value.shards.length || value.shards.some((shard, index) => index > 0 && value.shards[index - 1] >= shard)) {
    ctx.addIssue({ code: "custom", message: "compact shards must be unique and ordered" });
  }
});
const MAX_COMPACT_CHUNK_ENTRIES = 256;
const MAX_COMPACT_CHUNK_BYTES = 128_000;
const dirtySchema = z.strictObject({
  schema_version: z.literal("1.0"),
  resource_id: z.string(),
  generation: z.number().int().positive().safe(),
  entry_hash: z.string().nullable()
});
const DEFAULT_ZONE_STATE: z.infer<typeof zoneStateSchema> = {
  generation: 0, adopted: false, adoption_request_id: null, adoption_generation: null, catalog_rebuild_request_id: null, catalog_cache_write_permits: [], in_flight_writes: []
};
const STATE_REVISION_TOKEN = Symbol("zone-navigation-state-revision-token");
type StoredProjectState = z.infer<typeof stateSchema> & { [STATE_REVISION_TOKEN]?: string };
const sourceMutationQueues = new WeakMap<object, Map<string, Promise<void>>>();

export interface ZoneNavigationSourceState {
  schema_version: "1.0";
  project_id: string;
  zone: NavigationZone;
  generation: number;
  adopted: boolean;
  adoption_request_id: string | null;
  adoption_generation: number | null;
  in_flight_resource_ids: string[];
}

export interface ZoneNavigationHeadWriteTicket {
  project_id: string;
  zone: NavigationZone;
  resource_id: string;
  generation: number;
  write_hash: string | null;
  owner_hash?: string;
}

export type PublishedAdoptionResult =
  | { status: "adopted"; source_generation: number }
  | { status: "superseded"; published_source_generation: number; current_source_generation: number; refresh_required: true }
  | { status: "unchanged"; reason: "unverified_publication" | "owner_changed" | "source_changed" };

export type CompactCatalogManifestIdentity = NavigationCatalogManifestIdentity;

export interface CompactCatalogRebuildStart {
  project_id: string;
  zone: NavigationZone;
  request_id: string;
  expected_generation: number;
  expected_manifest: CompactCatalogManifestIdentity;
}

export interface CompactCatalogRebuildShard {
  project_id: string;
  zone: NavigationZone;
  request_id: string;
  snapshot_id: string;
  shard: number;
  entries: NavigationInventoryEntry[];
}

export interface CompactCatalogRebuildPublication extends CompactCatalogRebuildStart {
  snapshot_id: string;
  shards: number[];
}

export interface CompactCatalogRebuildPublished {
  ready_generation: number;
  shards: number[];
  identity: CompactCatalogManifestIdentity;
  chunk_evidence: { shard: number; object_id: string; revision_token: string; content_sha256: string }[];
}

export function zoneNavigationCatalogRoot(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation-sources/${zone}/catalog`;
}

export function zoneNavigationCompactCatalogRoot(projectId: string, zone: NavigationZone): string {
  return `${zoneNavigationCatalogRoot(projectId, zone)}/compact`;
}

function compactCatalogRebuildRoot(projectId: string, zone: NavigationZone, requestId: string): string {
  return `${zoneNavigationCompactCatalogRoot(projectId, zone)}/rebuilds/${requestId}`;
}

function compactReadyPath(projectId: string, zone: NavigationZone): string {
  return `${zoneNavigationCompactCatalogRoot(projectId, zone)}/ready.json`;
}

export function zoneNavigationDirtyRoot(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation-sources/${zone}/dirty`;
}

function compactChunkPath(projectId: string, zone: NavigationZone, shard: number): string {
  return `${zoneNavigationCompactCatalogRoot(projectId, zone)}/${shard.toString(16).padStart(2, "0")}.json`;
}

function statePath(projectId: string): string {
  return `${machineDocumentRoot(projectId)}/navigation-sources/state.json`;
}

async function resourcePath(root: string, resourceId: string): Promise<string> {
  return `${root}/${await sha256Text(resourceId)}.json`;
}

export class ZoneNavigationSources {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}

  async readState(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<ZoneNavigationSourceState> {
    const state = await this.readProjectState(projectId, budget);
    const item = state.zones[zone] ?? DEFAULT_ZONE_STATE;
    return { schema_version: "1.0", project_id: projectId, zone, generation: item.generation, adopted: item.adopted, adoption_request_id: item.adoption_request_id, adoption_generation: item.adoption_generation, in_flight_resource_ids: item.in_flight_writes.map((write) => write.resource_id) };
  }

  async beginAdoption(projectId: string, zone: NavigationZone, requestId: string, expectedGeneration: number, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readProjectState(projectId, budget);
    const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.adopted) return current.generation === expectedGeneration;
    if (current.generation !== expectedGeneration || current.in_flight_writes.length) return false;
    if (current.adoption_request_id === requestId && current.adoption_generation === expectedGeneration) return true;
    if (current.adoption_request_id && (current.adoption_request_id !== requestId || current.adoption_generation !== expectedGeneration)) {
      const priorAdoptionWasInvalidated = current.adoption_generation !== null && current.generation > current.adoption_generation;
      if (!priorAdoptionWasInvalidated) return false;
    }
    current.adoption_request_id = requestId;
    current.adoption_generation = expectedGeneration;
    state.zones[zone] = current;
    await this.writeProjectState(projectId, state, budget);
    return true;
  }

  async finishAdoption(projectId: string, zone: NavigationZone, requestId: string, generation: number, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readProjectState(projectId, budget);
    const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.adopted) return current.generation === generation;
    if (current.adoption_request_id !== requestId || current.adoption_generation !== generation || current.generation !== generation || current.in_flight_writes.length) return false;
    if ((await this.listDirtyPage(projectId, zone, null, 1, budget)).resource_ids.length) return false;
    current.adopted = true;
    current.adoption_request_id = null;
    current.adoption_generation = null;
    state.zones[zone] = current;
    await this.writeProjectState(projectId, state, budget);
    return true;
  }

  /**
   * Finish an adoption only when an exact committed publication proves it.
   * A newer source generation is not implied by the older publication: release
   * only that publication's stale reservation and leave its newer dirty/flying
   * work for the caller's existing refresh path. A verified compact catalog
   * may remain adopted as baseline availability; current-generation validity
   * is still independently fenced by generation, dirty markers, and in-flight writes.
   */
  async finishPublishedAdoption(
    projectId: string,
    zone: NavigationZone,
    requestId: string,
    readVerifiedPublication: () => Promise<ZoneNavigationReceipt | null>,
    budget?: SliceBudget
  ): Promise<PublishedAdoptionResult> {
    // The callback must be the engine's readVerifiedPublication (or its exact
    // memoized result), never a receipt supplied directly by an untrusted caller.
    const rawReceipt = await readVerifiedPublication();
    if (!rawReceipt) return { status: "unchanged", reason: "unverified_publication" };
    const parsed = zoneNavigationReceiptSchema.safeParse(rawReceipt);
    if (!parsed.success) return { status: "unchanged", reason: "unverified_publication" };
    const receipt = parsed.data;
    const sourceSnapshotMatch = /^source:(0|[1-9][0-9]*)$/.exec(receipt.source_snapshot_id);
    if (receipt.project_id !== projectId || receipt.zone !== zone || receipt.request_id !== requestId
      || receipt.status !== "committed" || !sourceSnapshotMatch) {
      return { status: "unchanged", reason: "unverified_publication" };
    }
    const sourceGeneration = Number(sourceSnapshotMatch[1]);
    if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) {
      return { status: "unchanged", reason: "unverified_publication" };
    }
    if (budget && !budget.canStartEffect(5)) throw new Error("slice_budget_exhausted");

    const state = await this.readProjectState(projectId, budget);
    const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.adopted) {
      return current.generation === sourceGeneration
        ? { status: "adopted", source_generation: sourceGeneration }
        : { status: "unchanged", reason: "owner_changed" };
    }
    if (current.adoption_request_id !== requestId || current.adoption_generation !== sourceGeneration) {
      return { status: "unchanged", reason: "owner_changed" };
    }
    if (current.generation > sourceGeneration) {
      // Keep an already completed baseline available to incremental resolvers,
      // but never infer that the newer source generation is current from this
      // older publication. Missing/unavailable/stale manifests conservatively
      // retain the full-inventory fallback.
      if (current.catalog_rebuild_request_id === null && budget?.canStartEffect(6) !== false
        && await this.hasExactReadyBaseline(projectId, zone, sourceGeneration, budget)) {
        current.adopted = true;
      }
      current.adoption_request_id = null;
      current.adoption_generation = null;
      state.zones[zone] = current;
      await this.writeProjectState(projectId, state, budget);
      return { status: "superseded", published_source_generation: sourceGeneration, current_source_generation: current.generation, refresh_required: true };
    }
    if (current.generation !== sourceGeneration || current.in_flight_writes.length) return { status: "unchanged", reason: "source_changed" };
    const dirty = await this.listDirtyPage(projectId, zone, null, 1, budget);
    if (dirty.resource_ids.length || dirty.next_cursor !== null) return { status: "unchanged", reason: "source_changed" };
    current.adopted = true;
    current.adoption_request_id = null;
    current.adoption_generation = null;
    state.zones[zone] = current;
    await this.writeProjectState(projectId, state, budget);
    return { status: "adopted", source_generation: sourceGeneration };
  }

  async abortAdoption(projectId: string, zone: NavigationZone, requestId: string, generation: number, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readProjectState(projectId, budget);
    const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.adopted || current.generation !== generation || current.in_flight_writes.length > 0) return false;
    if (current.adoption_request_id === null) return true;
    if (current.adoption_request_id !== requestId || current.adoption_generation !== generation) return false;
    current.adoption_request_id = null;
    current.adoption_generation = null;
    state.zones[zone] = current;
    await this.writeProjectState(projectId, state, budget);
    return true;
  }

  async listDirtyPage(projectId: string, zone: NavigationZone, cursor: string | null, limit: number, budget?: SliceBudget): Promise<{ resource_ids: string[]; next_cursor: string | null }> {
    if (!this.runtime.pagedListing) throw new Error("navigation_paged_listing_unavailable");
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({ path: zoneNavigationDirtyRoot(projectId, zone), cursor, limit: Math.max(1, Math.min(1, limit)) });
    const resourceIds: string[] = [];
    for (const item of page.entries) {
      if (item.kind !== "file" || !item.path) throw new Error("navigation_dirty_listing_unavailable");
      charge(budget);
      const raw = await this.runtime.objects.readText(item.path);
      if (raw === null) continue;
      const parsed = dirtySchema.parse(JSON.parse(raw));
      resourceIds.push(parsed.resource_id);
    }
    return { resource_ids: resourceIds, next_cursor: page.cursor };
  }

  async hasDirtyMarker(projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget): Promise<boolean> {
    const path = await resourcePath(zoneNavigationDirtyRoot(projectId, zone), resourceId);
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return false;
    const marker = dirtySchema.parse(JSON.parse(raw));
    if (marker.resource_id !== resourceId) throw new Error("navigation_dirty_binding");
    return true;
  }

  async readCatalogEntry(projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget): Promise<NavigationInventoryEntry | null> {
    charge(budget);
    const path = await resourcePath(zoneNavigationCatalogRoot(projectId, zone), resourceId);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const record = catalogSchema.parse(JSON.parse(raw));
    if (record.resource_id !== undefined && record.resource_id !== resourceId) throw new Error("navigation_catalog_binding");
    if (record.entry === null) {
      if (record.resource_id !== resourceId) throw new Error("navigation_catalog_binding");
      return null;
    }
    const entry = navigationInventoryEntrySchema.parse(record.entry);
    if (entry.project_id !== projectId || entry.zone !== zone || entry.resource_id !== resourceId) throw new Error("navigation_catalog_binding");
    return entry;
  }

  async writeCatalogEntry(entry: NavigationInventoryEntry | null, projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget, expectedGeneration?: number): Promise<void> {
    const path = await resourcePath(zoneNavigationCatalogRoot(projectId, zone), resourceId);
    if (entry && (entry.project_id !== projectId || entry.zone !== zone || entry.resource_id !== resourceId)) throw new Error("navigation_catalog_binding");
    const content = JSON.stringify({ schema_version: "1.0", resource_id: resourceId, entry });
    const current = await this.readState(projectId, zone, budget);
    const generation = expectedGeneration ?? current.generation;
    if (current.generation !== generation || current.in_flight_resource_ids.includes(resourceId)) throw new Error("navigation_catalog_snapshot_stale");
    let manifest: z.infer<typeof compactReadySchema> | null = null;
    let manifestLoaded = false;
    if (current.adopted) {
      manifest = await this.readCompactManifest(projectId, zone, budget);
      manifestLoaded = true;
      if (manifest?.rebuilding_request_id) throw new Error("navigation_catalog_rebuild_writer_fenced");
    }
    // Cache and sidecar writes use token → fence-check → CAS. Rebuild rewrites
    // every live shard, so a pre-fence chunk token cannot win after publication;
    // dirty markers prevent starting rebuild while this sidecar is authoritative.
    const token = await this.readWriteToken(path, budget);
    if (current.adopted) await this.assertCatalogCacheWriteAllowed(projectId, zone, budget);
    await this.writeAtToken(path, content, token, budget);
    if (!manifestLoaded) manifest = await this.readCompactManifest(projectId, zone, budget);
    if (manifest?.ready_generation !== null && manifest?.ready_generation !== undefined
      && !await this.compactCatalogEntryMatches(projectId, zone, resourceId, entry, generation, manifest, budget)) {
      await this.updateCompactCatalogEntry(entry, projectId, zone, resourceId, generation, budget, false, manifest);
    }
  }

  async recordVerifiedCatalogEntry(entry: NavigationInventoryEntry, snapshotId: string, budget?: SliceBudget): Promise<void> {
    const generation = /^source:(\d+)$/.exec(snapshotId);
    if (!generation) throw new Error("navigation_inventory_snapshot_invalid");
    const sourceGeneration = Number(generation[1]);
    const state = await this.readState(entry.project_id, entry.zone, budget);
    if (state.generation !== sourceGeneration || state.in_flight_resource_ids.includes(entry.resource_id)) throw new Error("navigation_catalog_snapshot_stale");
    const manifest = await this.readCompactManifest(entry.project_id, entry.zone, budget);
    if (manifest?.rebuilding_request_id) throw new Error("navigation_catalog_rebuild_writer_fenced");
    if (manifest?.ready_generation !== null && manifest?.ready_generation !== undefined
      && await this.compactCatalogEntryMatches(entry.project_id, entry.zone, entry.resource_id, entry, sourceGeneration, manifest, budget)) return;
    if (manifest?.rebuild_repair_required && manifest.ready_generation === null) return;
    const initialUnreadyAdoption = !state.adopted && (!manifest || manifest.ready_generation === null);
    await this.updateCompactCatalogEntry(entry, entry.project_id, entry.zone, entry.resource_id, sourceGeneration, budget, initialUnreadyAdoption, manifest);
  }

  async recordVerifiedCatalogTombstone(projectId: string, zone: NavigationZone, resourceId: string, snapshotId: string, budget?: SliceBudget): Promise<void> {
    const generation = /^source:(\d+)$/.exec(snapshotId);
    if (!generation) throw new Error("navigation_inventory_snapshot_invalid");
    const sourceGeneration = Number(generation[1]);
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    if (!manifest?.shards.includes(shardFor(resourceId))) return;
    const state = await this.readState(projectId, zone, budget);
    if (state.generation !== sourceGeneration || state.in_flight_resource_ids.includes(resourceId)) throw new Error("navigation_catalog_snapshot_stale");
    if (manifest.rebuilding_request_id) throw new Error("navigation_catalog_rebuild_writer_fenced");
    if (manifest.rebuild_repair_required && manifest.ready_generation === null) return;
    if (manifest.ready_generation !== null && await this.compactCatalogEntryMatches(projectId, zone, resourceId, null, sourceGeneration, manifest, budget)) return;
    await this.updateCompactCatalogEntry(null, projectId, zone, resourceId, sourceGeneration, budget, false, manifest);
  }

  async compactCatalogManifestIdentity(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<CompactCatalogManifestIdentity | null> {
    const path = compactReadyPath(projectId, zone);
    charge(budget);
    const before = await this.runtime.objects.getMetadata(path);
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    charge(budget);
    const after = await this.runtime.objects.getMetadata(path);
    if (!before?.objectId || !before.revisionToken || !after || before.objectId !== after.objectId || before.revisionToken !== after.revisionToken) throw new Error("navigation_compact_catalog_identity_unavailable");
    const manifest = compactReadySchema.parse(JSON.parse(raw));
    if (manifest.project_id !== projectId || manifest.zone !== zone) throw new Error("navigation_compact_catalog_binding");
    return { object_id: before.objectId, revision_token: before.revisionToken, content_sha256: await sha256Text(raw) };
  }

  async beginCompactCatalogRebuild(input: CompactCatalogRebuildStart, budget?: SliceBudget): Promise<{ snapshot_id: string }> {
    const requestId = z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/).parse(input.request_id);
    const identity = navigationCatalogManifestIdentitySchema.parse(input.expected_manifest);
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) throw new Error("navigation_catalog_rebuild_generation_invalid");
    const state = await this.readState(input.project_id, input.zone, budget);
    if (!state.adopted) throw new Error("navigation_catalog_rebuild_source_not_adopted");
    if (state.generation !== input.expected_generation || state.in_flight_resource_ids.length) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    if (!await this.verifySnapshot(input.project_id, input.zone, `source:${input.expected_generation}`, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    const durableState = await this.readProjectState(input.project_id, budget);
    const zoneState = durableState.zones[input.zone] ?? { ...DEFAULT_ZONE_STATE };
    if (zoneState.catalog_rebuild_request_id && zoneState.catalog_rebuild_request_id !== requestId) throw new Error("navigation_catalog_rebuild_writer_fence_conflict");
    const currentIdentity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    if (!currentIdentity || canonicalJson(currentIdentity) !== canonicalJson(identity)) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    const manifest = await this.readCompactManifest(input.project_id, input.zone, budget);
    // A stale compact cache can be rebuilt from the newer, frozen source
    // snapshot; requiring it to be current would strand legacy lost-dirty gaps.
    const readyManifest = manifest?.ready_generation !== null && manifest?.ready_generation !== undefined
      && manifest.ready_generation <= input.expected_generation && !manifest.rebuilding_request_id;
    const abandonedUnreadyManifest = manifest?.ready_generation === null && !manifest.rebuilding_request_id;
    if (!manifest || (!readyManifest && !abandonedUnreadyManifest)) throw new Error("navigation_catalog_rebuild_manifest_not_ready");
    const root = compactCatalogRebuildRoot(input.project_id, input.zone, requestId);
    const intentPath = `${root}/intent.json`;
    const intent = { schema_version: "1.0", ...input, request_id: requestId, snapshot_id: `source:${input.expected_generation}` };
    const serialized = JSON.stringify(intent);
    charge(budget);
    try {
      await this.runtime.objects.createText(intentPath, serialized);
    } catch {
      charge(budget);
      const existing = await this.runtime.objects.readText(intentPath);
      if (existing !== serialized) throw new Error("navigation_catalog_rebuild_request_conflict");
    }
    return { snapshot_id: `source:${input.expected_generation}` };
  }

  /** Fence canonical source writes only for the short compact publication window. */
  async acquireCompactCatalogRebuildFence(input: CompactCatalogRebuildStart, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readProjectState(input.project_id, budget);
    const current = state.zones[input.zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.generation !== input.expected_generation || current.in_flight_writes.length) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    if (current.catalog_rebuild_request_id === input.request_id) return true;
    // Never steal a different request's fence. There is no lease/abandonment
    // proof here, so takeover could let the old owner publish after us.
    if (current.catalog_rebuild_request_id !== null) return false;
    current.catalog_rebuild_request_id = input.request_id;
    state.zones[input.zone] = current;
    await this.writeProjectState(input.project_id, state, budget);
    return true;
  }

  async releaseCompactCatalogRebuildFence(projectId: string, zone: NavigationZone, requestId: string, budget?: SliceBudget): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.readProjectState(projectId, budget);
      const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
      if (current.catalog_rebuild_request_id === null) return true;
      if (current.catalog_rebuild_request_id !== requestId) return false;
      current.catalog_rebuild_request_id = null;
      state.zones[zone] = current;
      try { await this.writeProjectState(projectId, state, budget); return true; }
      catch (error) { lastError = error; }
    }
    throw lastError ?? new Error("navigation_catalog_rebuild_writer_fence_release_conflict");
  }

  async abandonFailedCompactCatalogRebuild(input: {
    project_id: string;
    zone: NavigationZone;
    request_id: string;
    expected_unready_manifest: CompactCatalogManifestIdentity;
  }, budget?: SliceBudget): Promise<{ status: "abandoned"; identity: CompactCatalogManifestIdentity } | { status: "pending" }> {
    const expected = navigationCatalogManifestIdentitySchema.parse(input.expected_unready_manifest);
    const root = compactCatalogRebuildRoot(input.project_id, input.zone, input.request_id);
    const abandonmentPath = `${root}/abandonment.json`;
    const targetFor = (manifest: z.infer<typeof compactReadySchema>) => JSON.stringify({
      schema_version: "1.0", project_id: input.project_id, zone: input.zone, ready_generation: null,
      shards: manifest.shards, completed_generations: manifest.completed_generations,
      coalesced_dirty: manifest.coalesced_dirty, rebuilding_request_id: null, rebuild_repair_required: true
    });
    const readCurrent = async () => {
      const identity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
      const manifest = await this.readCompactManifest(input.project_id, input.zone, budget);
      const raw = await this.readText(compactReadyPath(input.project_id, input.zone), budget);
      return { identity, manifest, raw };
    };
    const currentSource = await this.readProjectState(input.project_id, budget);
    const sourceState = currentSource.zones[input.zone] ?? { ...DEFAULT_ZONE_STATE };
    const current = await readCurrent();
    if (!current.identity || !current.manifest || current.raw === null) return { status: "pending" };
    const owner = sourceState.catalog_rebuild_request_id;
    if (owner !== null && owner !== input.request_id) return { status: "pending" };

    if (current.manifest.ready_generation === null && current.manifest.rebuilding_request_id === null) {
      const target = targetFor(current.manifest);
      const marker = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone,
        request_id: input.request_id, expected_unready_manifest: expected, target_manifest: target });
      const recorded = await this.readText(abandonmentPath, budget);
      if (recorded !== marker || current.raw !== target || current.identity.content_sha256 !== await sha256Text(target)) return { status: "pending" };
      if (owner === input.request_id && (!sourceState.adopted || sourceState.in_flight_writes.length)) return { status: "pending" };
      if (owner === input.request_id && !await this.releaseCompactCatalogRebuildFence(input.project_id, input.zone, input.request_id, budget)) return { status: "pending" };
      return { status: "abandoned", identity: current.identity };
    }

    if (!sourceState.adopted || sourceState.in_flight_writes.length) return { status: "pending" };
    const intentRaw = await this.readText(`${root}/intent.json`, budget);
    if (intentRaw === null) return { status: "pending" };
    const intent = JSON.parse(intentRaw) as { expected_generation?: unknown };
    if (!Number.isSafeInteger(intent.expected_generation) || (intent.expected_generation as number) !== sourceState.generation
      || !await this.verifySnapshot(input.project_id, input.zone, `source:${sourceState.generation}`, budget)) return { status: "pending" };
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, sourceState.generation, budget);
    if (owner !== input.request_id || current.manifest.ready_generation !== null
      || current.manifest.rebuilding_request_id !== input.request_id
      || canonicalJson(current.identity) !== canonicalJson(expected)) return { status: "pending" };

    const target = targetFor(current.manifest);
    const marker = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone,
      request_id: input.request_id, expected_unready_manifest: expected, target_manifest: target });
    charge(budget);
    try { await this.runtime.objects.createText(abandonmentPath, marker); }
    catch {
      const recorded = await this.readText(abandonmentPath, budget);
      if (recorded !== marker) return { status: "pending" };
    }
    if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
    try {
      charge(budget);
      await this.runtime.conditionalWrite.writeTextConditional(compactReadyPath(input.project_id, input.zone), target, expected.revision_token);
    } catch {
      const observed = await readCurrent();
      if (!observed.identity || !observed.manifest || observed.raw !== target
        || observed.manifest.ready_generation !== null || observed.manifest.rebuilding_request_id !== null
        || observed.identity.content_sha256 !== await sha256Text(target)) return { status: "pending" };
    }
    const observed = await readCurrent();
    if (!observed.identity || !observed.manifest || observed.raw !== target
      || observed.manifest.ready_generation !== null || observed.manifest.rebuilding_request_id !== null
      || observed.identity.content_sha256 !== await sha256Text(target)) return { status: "pending" };
    if (!await this.releaseCompactCatalogRebuildFence(input.project_id, input.zone, input.request_id, budget)) return { status: "pending" };
    return { status: "abandoned", identity: observed.identity };
  }

  async stageCompactCatalogRebuildShard(input: CompactCatalogRebuildShard, budget?: SliceBudget): Promise<void> {
    assertCatalogRebuildBinding(input.project_id, input.zone, input.request_id, input.snapshot_id);
    if (!Number.isInteger(input.shard) || input.shard < 0 || input.shard >= ZONE_NAVIGATION_CATALOG_SHARDS) throw new Error("navigation_catalog_shard_invalid");
    const state = await this.readState(input.project_id, input.zone, budget);
    const generation = generationFromSnapshot(input.snapshot_id);
    if (state.generation !== generation || state.in_flight_resource_ids.length) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget);
    const resourceIds = new Set<string>();
    const entries = input.entries.map((entry) => navigationInventoryEntrySchema.parse(entry)).sort((left, right) => left.resource_id.localeCompare(right.resource_id));
    const packed = [] as z.infer<typeof compactEntrySchema>[];
    for (const entry of entries) {
      if (entry.project_id !== input.project_id || entry.zone !== input.zone || shardFor(entry.resource_id) !== input.shard || resourceIds.has(entry.resource_id)) throw new Error("navigation_catalog_rebuild_entry_binding");
      resourceIds.add(entry.resource_id);
      packed.push({ resource_id: entry.resource_id, source_generation: generation, entry_hash: await entryHash(entry), entry });
    }
    const content = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone, shard: input.shard, entries: packed });
    if (packed.length > MAX_COMPACT_CHUNK_ENTRIES || new TextEncoder().encode(content).byteLength > MAX_COMPACT_CHUNK_BYTES) throw new Error("navigation_compact_catalog_chunk_oversize");
    const path = `${compactCatalogRebuildRoot(input.project_id, input.zone, input.request_id)}/chunks/${input.shard.toString(16).padStart(2, "0")}.json`;
    charge(budget);
    try {
      await this.runtime.objects.createText(path, content);
    } catch {
      charge(budget);
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) throw new Error("navigation_catalog_rebuild_chunk_conflict");
    }
  }

  async invalidateCompactCatalogRebuild(input: CompactCatalogRebuildStart, budget?: SliceBudget): Promise<CompactCatalogManifestIdentity> {
    const expected = navigationCatalogManifestIdentitySchema.parse(input.expected_manifest);
    const snapshotId = `source:${input.expected_generation}`;
    assertCatalogRebuildBinding(input.project_id, input.zone, input.request_id, snapshotId);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, input.expected_generation, budget, expected);
    if (!await this.verifySnapshot(input.project_id, input.zone, snapshotId, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    if (!await this.acquireCompactCatalogRebuildFence(input, budget)) throw new Error("navigation_catalog_rebuild_writer_fence_conflict");
    if (!await this.verifySnapshot(input.project_id, input.zone, snapshotId, budget)) {
      await this.releaseCompactCatalogRebuildFence(input.project_id, input.zone, input.request_id, budget);
      throw new Error("navigation_catalog_rebuild_snapshot_stale");
    }
    const currentIdentity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    if (!currentIdentity) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    const current = await this.readCompactManifest(input.project_id, input.zone, budget);
    if (!current) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    if (current.rebuilding_request_id === input.request_id && current.ready_generation === null) return currentIdentity;
    if (canonicalJson(currentIdentity) !== canonicalJson(expected)) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    const next = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone, ready_generation: null, shards: current.shards, completed_generations: current.completed_generations, coalesced_dirty: current.coalesced_dirty, rebuilding_request_id: input.request_id, ...(current.rebuild_repair_required ? { rebuild_repair_required: true } : {}) });
    charge(budget);
    if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
    await this.runtime.conditionalWrite.writeTextConditional(compactReadyPath(input.project_id, input.zone), next, expected.revision_token);
    const identity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    if (!identity) throw new Error("navigation_catalog_rebuild_manifest_unavailable");
    return identity;
  }

  async publishCompactCatalogRebuildShard(input: CompactCatalogRebuildPublication & { shard: number; invalidated_manifest: CompactCatalogManifestIdentity }, budget?: SliceBudget): Promise<CompactCatalogRebuildPublished["chunk_evidence"][number]> {
    const generation = generationFromSnapshot(input.snapshot_id);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget, input.expected_manifest);
    if (!await this.verifySnapshot(input.project_id, input.zone, input.snapshot_id, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    const liveManifest = await this.readCompactManifest(input.project_id, input.zone, budget);
    const liveIdentity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    if (!liveManifest || liveManifest.ready_generation !== null || liveManifest.rebuilding_request_id !== input.request_id
      || !liveIdentity || canonicalJson(liveIdentity) !== canonicalJson(input.invalidated_manifest)) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    const stagedPath = `${compactCatalogRebuildRoot(input.project_id, input.zone, input.request_id)}/chunks/${input.shard.toString(16).padStart(2, "0")}.json`;
    const staged = await this.readTextRequired(stagedPath, budget);
    await this.assertRebuiltChunk(staged, input.project_id, input.zone, input.shard, generation);
    const livePath = compactChunkPath(input.project_id, input.zone, input.shard);
    const token = await this.readWriteToken(livePath, budget);
    if (token === null) {
      try { await this.createText(livePath, staged, budget); }
      catch {
        if (await this.readText(livePath, budget) !== staged) throw new Error("navigation_catalog_rebuild_chunk_conflict");
      }
    } else {
      // Always advance the revision, even when bytes already match. A cache
      // writer that obtained a token before the durable fence must then lose
      // its conditional write if it resumes after this shard is published.
      charge(budget);
      if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
      await this.runtime.conditionalWrite.writeTextConditional(livePath, staged, token);
    }
    const before = await this.metadataRequired(livePath, budget);
    const observed = await this.readTextRequired(livePath, budget);
    const after = await this.metadataRequired(livePath, budget);
    if (observed !== staged || before.objectId !== after.objectId || before.revisionToken !== after.revisionToken) throw new Error("navigation_catalog_rebuild_chunk_postcheck_failed");
    return { shard: input.shard, object_id: after.objectId, revision_token: after.revisionToken, content_sha256: await sha256Text(observed) };
  }

  async verifyCompactCatalogRebuildShard(input: CompactCatalogRebuildPublication & { shard: number; invalidated_manifest: CompactCatalogManifestIdentity; evidence: CompactCatalogRebuildPublished["chunk_evidence"][number] }, budget?: SliceBudget): Promise<void> {
    const generation = generationFromSnapshot(input.snapshot_id);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget, input.expected_manifest);
    const manifest = await this.readCompactManifest(input.project_id, input.zone, budget);
    const identity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    if (!manifest || manifest.ready_generation !== null || manifest.rebuilding_request_id !== input.request_id
      || !identity || canonicalJson(identity) !== canonicalJson(input.invalidated_manifest)) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    const staged = await this.readTextRequired(`${compactCatalogRebuildRoot(input.project_id, input.zone, input.request_id)}/chunks/${input.shard.toString(16).padStart(2, "0")}.json`, budget);
    const livePath = compactChunkPath(input.project_id, input.zone, input.shard);
    const before = await this.metadataRequired(livePath, budget);
    const raw = await this.readTextRequired(livePath, budget);
    const after = await this.metadataRequired(livePath, budget);
    if (raw !== staged || before.objectId !== after.objectId || before.revisionToken !== after.revisionToken
      || after.objectId !== input.evidence.object_id || after.revisionToken !== input.evidence.revision_token
      || await sha256Text(raw) !== input.evidence.content_sha256) throw new Error("navigation_catalog_rebuild_chunk_postcheck_failed");
  }

  async publishCompactCatalogRebuildManifest(input: CompactCatalogRebuildPublication & { invalidated_manifest: CompactCatalogManifestIdentity; chunk_evidence: CompactCatalogRebuildPublished["chunk_evidence"] }, budget?: SliceBudget): Promise<CompactCatalogRebuildPublished> {
    const generation = generationFromSnapshot(input.snapshot_id);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget, input.expected_manifest);
    await this.assertCompactCatalogRebuildFenceOwner(input.project_id, input.zone, input.request_id, budget);
    const stagedShards = await this.listStagedRebuildShards(input.project_id, input.zone, input.request_id, budget);
    if (canonicalJson(stagedShards) !== canonicalJson(input.shards)) throw new Error("navigation_catalog_rebuild_shards_incomplete");
    if (canonicalJson(input.shards) !== canonicalJson(input.chunk_evidence.map((item) => item.shard))) throw new Error("navigation_catalog_rebuild_chunk_evidence_incomplete");
    if (!await this.verifySnapshot(input.project_id, input.zone, input.snapshot_id, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    const currentIdentity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    const current = await this.readCompactManifest(input.project_id, input.zone, budget);
    const finalManifest = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone, ready_generation: generation, shards: input.shards, completed_generations: [], coalesced_dirty: [] });
    if (currentIdentity && current && current.ready_generation === generation
      && canonicalJson(current.shards) === canonicalJson(input.shards)
      && currentIdentity.content_sha256 === await sha256Text(finalManifest)) {
      // Recover the narrow crash window after the final manifest CAS but before
      // certificate/progress persistence. The engine's durable verify_shard_cursor
      // and per-shard replay cursor must physically reread every live chunk before
      // it writes the immutable certificate. The writer fence remains held here.
      if (canonicalJson(input.shards) !== canonicalJson(input.chunk_evidence.map((item) => item.shard))) throw new Error("navigation_catalog_rebuild_chunk_evidence_incomplete");
      if (!await this.verifySnapshot(input.project_id, input.zone, input.snapshot_id, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
      return { ready_generation: generation, shards: input.shards, identity: currentIdentity, chunk_evidence: input.chunk_evidence };
    }
    if (!currentIdentity || canonicalJson(currentIdentity) !== canonicalJson(input.invalidated_manifest)
      || !current || current.ready_generation !== null || current.rebuilding_request_id !== input.request_id) throw new Error("navigation_catalog_rebuild_manifest_conflict");
    charge(budget);
    if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
    await this.runtime.conditionalWrite.writeTextConditional(compactReadyPath(input.project_id, input.zone), finalManifest, input.invalidated_manifest.revision_token);
    const identity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
    const published = await this.readCompactManifest(input.project_id, input.zone, budget);
    if (!identity || !published || published.ready_generation !== generation || canonicalJson(published.shards) !== canonicalJson(input.shards)) throw new Error("navigation_catalog_rebuild_manifest_postcheck_failed");
    return { ready_generation: generation, shards: input.shards, identity, chunk_evidence: input.chunk_evidence };
  }

  /** Revalidate one live shard after manifest CAS and before rebuild certification. */
  async verifyPublishedCompactCatalogRebuildShard(input: CompactCatalogRebuildPublication & {
    invalidated_manifest: CompactCatalogManifestIdentity;
    shard: number;
    evidence: CompactCatalogRebuildPublished["chunk_evidence"][number];
  }, budget?: SliceBudget): Promise<void> {
    const generation = generationFromSnapshot(input.snapshot_id);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget, input.expected_manifest);
    await this.assertCompactCatalogRebuildFenceOwner(input.project_id, input.zone, input.request_id, budget);
    if (!await this.verifySnapshot(input.project_id, input.zone, input.snapshot_id, budget)) throw new Error("navigation_catalog_rebuild_snapshot_stale");
    const manifestRaw = JSON.stringify({ schema_version: "1.0", project_id: input.project_id, zone: input.zone, ready_generation: generation, shards: input.shards, completed_generations: [], coalesced_dirty: [] });
    const [manifestIdentity, manifest] = await Promise.all([
      this.compactCatalogManifestIdentity(input.project_id, input.zone, budget),
      this.readCompactManifest(input.project_id, input.zone, budget)
    ]);
    if (!manifestIdentity || !manifest || manifest.ready_generation !== generation || canonicalJson(manifest.shards) !== canonicalJson(input.shards)
      || manifestIdentity.content_sha256 !== await sha256Text(manifestRaw) || input.evidence.shard !== input.shard) {
      throw new Error("navigation_catalog_rebuild_manifest_conflict");
    }
    const staged = await this.readTextRequired(`${compactCatalogRebuildRoot(input.project_id, input.zone, input.request_id)}/chunks/${input.shard.toString(16).padStart(2, "0")}.json`, budget);
    await this.assertRebuiltChunk(staged, input.project_id, input.zone, input.shard, generation);
    const livePath = compactChunkPath(input.project_id, input.zone, input.shard);
    const before = await this.metadataRequired(livePath, budget);
    const raw = await this.readTextRequired(livePath, budget);
    const after = await this.metadataRequired(livePath, budget);
    if (raw !== staged || before.objectId !== after.objectId || before.revisionToken !== after.revisionToken
      || after.objectId !== input.evidence.object_id || after.revisionToken !== input.evidence.revision_token
      || await sha256Text(raw) !== input.evidence.content_sha256) throw new Error("navigation_catalog_rebuild_chunk_postcheck_failed");
  }

  /** Withdraw readiness after failed post-publication evidence verification.
   * Keep both the rebuild marker and source fence so the same governed request
   * can restage/re-publish without allowing readers or writers through. */
  async invalidateFailedPublishedCompactCatalogRebuild(input: {
    project_id: string;
    zone: NavigationZone;
    request_id: string;
    expected_final_manifest: CompactCatalogManifestIdentity;
  }, budget?: SliceBudget): Promise<{ status: "invalidated"; identity: CompactCatalogManifestIdentity } | { status: "pending" }> {
    const expectedFinal = navigationCatalogManifestIdentitySchema.parse(input.expected_final_manifest);
    const generation = generationFromSnapshot(`source:${(await this.readState(input.project_id, input.zone, budget)).generation}`);
    await this.assertCompactCatalogRebuildIntent(input.project_id, input.zone, input.request_id, generation, budget);
    await this.assertCompactCatalogRebuildFenceOwner(input.project_id, input.zone, input.request_id, budget);

    const readCurrent = async () => {
      const identity = await this.compactCatalogManifestIdentity(input.project_id, input.zone, budget);
      const manifest = await this.readCompactManifest(input.project_id, input.zone, budget);
      const raw = await this.readText(compactReadyPath(input.project_id, input.zone), budget);
      return { identity, manifest, raw };
    };
    const targetFor = (manifest: z.infer<typeof compactReadySchema>) => JSON.stringify({
      schema_version: "1.0", project_id: input.project_id, zone: input.zone, ready_generation: null,
      shards: manifest.shards, completed_generations: manifest.completed_generations,
      coalesced_dirty: manifest.coalesced_dirty, rebuilding_request_id: input.request_id
    });

    const current = await readCurrent();
    if (!current.identity || !current.manifest || current.raw === null) return { status: "pending" };
    if (current.manifest.ready_generation === null && current.manifest.rebuilding_request_id === input.request_id) {
      const target = targetFor(current.manifest);
      if (current.raw === target && current.identity.content_sha256 === await sha256Text(target)) return { status: "invalidated", identity: current.identity };
      return { status: "pending" };
    }
    if (canonicalJson(current.identity) !== canonicalJson(expectedFinal)
      || current.manifest.ready_generation !== generation || current.manifest.rebuilding_request_id) return { status: "pending" };

    const target = targetFor(current.manifest);
    if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
    try {
      charge(budget);
      await this.runtime.conditionalWrite.writeTextConditional(compactReadyPath(input.project_id, input.zone), target, expectedFinal.revision_token);
    } catch {
      // A transport error may follow a successful CAS. Only recognize that
      // outcome by its exact, owner-fenced target bytes; otherwise preserve the
      // fence and let the caller retry as pending.
      const observed = await readCurrent();
      if (observed.identity && observed.manifest?.ready_generation === null
        && observed.manifest.rebuilding_request_id === input.request_id && observed.raw === target
        && observed.identity.content_sha256 === await sha256Text(target)) return { status: "invalidated", identity: observed.identity };
      return { status: "pending" };
    }
    const observed = await readCurrent();
    if (!observed.identity || observed.raw !== target || observed.identity.content_sha256 !== await sha256Text(target)
      || observed.manifest?.ready_generation !== null || observed.manifest.rebuilding_request_id !== input.request_id) return { status: "pending" };
    return { status: "invalidated", identity: observed.identity };
  }

  private async listStagedRebuildShards(projectId: string, zone: NavigationZone, requestId: string, budget?: SliceBudget): Promise<number[]> {
    if (!this.runtime.pagedListing) throw new Error("navigation_paged_listing_unavailable");
    const root = `${compactCatalogRebuildRoot(projectId, zone, requestId)}/chunks`;
    charge(budget);
    const page = await this.runtime.pagedListing.listPage({ path: root, cursor: null, limit: ZONE_NAVIGATION_CATALOG_SHARDS + 1 });
    if (page.cursor !== null) throw new Error("navigation_catalog_rebuild_shards_incomplete");
    const shards = page.entries.map((item) => {
      const match = /^([0-9a-f]{2})\.json$/.exec(item.name);
      if (item.kind !== "file" || item.path !== `${root}/${item.name}` || !match) throw new Error("navigation_catalog_rebuild_stage_invalid");
      return Number.parseInt(match[1], 16);
    }).sort((left, right) => left - right);
    if (new Set(shards).size !== shards.length) throw new Error("navigation_catalog_rebuild_stage_invalid");
    return shards;
  }

  private async assertCompactCatalogRebuildIntent(projectId: string, zone: NavigationZone, requestId: string, generation: number, budget?: SliceBudget, expectedManifest?: CompactCatalogManifestIdentity): Promise<void> {
    const path = `${compactCatalogRebuildRoot(projectId, zone, requestId)}/intent.json`;
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) throw new Error("navigation_catalog_rebuild_intent_missing");
    const intent = JSON.parse(raw) as Record<string, unknown>;
    if (intent.schema_version !== "1.0" || intent.project_id !== projectId || intent.zone !== zone || intent.request_id !== requestId
      || intent.expected_generation !== generation || intent.snapshot_id !== `source:${generation}`
      || (expectedManifest && canonicalJson(intent.expected_manifest) !== canonicalJson(expectedManifest))) throw new Error("navigation_catalog_rebuild_request_conflict");
  }

  private async assertCompactCatalogRebuildFenceOwner(projectId: string, zone: NavigationZone, requestId: string, budget?: SliceBudget): Promise<void> {
    const state = await this.readProjectState(projectId, budget);
    if (state.zones[zone]?.catalog_rebuild_request_id !== requestId) throw new Error("navigation_catalog_rebuild_writer_fence_conflict");
  }

  private async readText(path: string, budget?: SliceBudget): Promise<string | null> {
    charge(budget);
    return this.runtime.objects.readText(path);
  }

  private async readTextRequired(path: string, budget?: SliceBudget): Promise<string> {
    const value = await this.readText(path, budget);
    if (value === null) throw new Error("navigation_catalog_rebuild_chunk_missing");
    return value;
  }

  private async createText(path: string, content: string, budget?: SliceBudget): Promise<void> {
    charge(budget);
    await this.runtime.objects.createText(path, content);
  }

  private async metadataRequired(path: string, budget?: SliceBudget): Promise<{ objectId: string; revisionToken: string }> {
    charge(budget);
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata?.objectId || !metadata.revisionToken) throw new Error("navigation_catalog_rebuild_chunk_identity_unavailable");
    return { objectId: metadata.objectId, revisionToken: metadata.revisionToken };
  }

  private async assertRebuiltChunk(raw: string, projectId: string, zone: NavigationZone, shard: number, generation: number): Promise<void> {
    if (new TextEncoder().encode(raw).byteLength > MAX_COMPACT_CHUNK_BYTES) throw new Error("navigation_compact_catalog_chunk_oversize");
    const chunk = compactChunkSchema.parse(JSON.parse(raw));
    if (chunk.project_id !== projectId || chunk.zone !== zone || chunk.shard !== shard || chunk.entries.length === 0) throw new Error("navigation_catalog_rebuild_chunk_invalid");
    const resourceIds = new Set<string>();
    for (const item of chunk.entries) {
      if (item.source_generation !== generation || item.resource_id !== item.entry.resource_id || item.entry.project_id !== projectId || item.entry.zone !== zone
        || shardFor(item.resource_id) !== shard || item.entry_hash !== await entryHash(item.entry) || resourceIds.has(item.resource_id)) throw new Error("navigation_catalog_rebuild_chunk_invalid");
      resourceIds.add(item.resource_id);
    }
  }

  async readCompactCatalogShard(projectId: string, zone: NavigationZone, shard: number, expectedGeneration: number, budget?: SliceBudget): Promise<NavigationInventoryEntry[]> {
    if (!Number.isInteger(shard) || shard < 0 || shard >= ZONE_NAVIGATION_CATALOG_SHARDS) throw new Error("navigation_catalog_shard_invalid");
    const path = compactChunkPath(projectId, zone, shard);
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) throw new Error("navigation_compact_catalog_missing");
    if (new TextEncoder().encode(raw).byteLength > MAX_COMPACT_CHUNK_BYTES) throw new Error("navigation_compact_catalog_chunk_oversize");
    const chunk = compactChunkSchema.parse(JSON.parse(raw));
    if (chunk.project_id !== projectId || chunk.zone !== zone || chunk.shard !== shard) throw new Error("navigation_compact_catalog_binding");
    const result: NavigationInventoryEntry[] = [];
    const resourceIds = new Set<string>();
    for (const item of chunk.entries) {
      if (item.resource_id !== item.entry.resource_id || item.entry.project_id !== projectId || item.entry.zone !== zone
        || shardFor(item.resource_id) !== shard || item.source_generation > expectedGeneration
        || item.entry_hash !== await entryHash(item.entry) || resourceIds.has(item.resource_id)) throw new Error("navigation_compact_catalog_proof_invalid");
      resourceIds.add(item.resource_id);
      result.push(item.entry);
    }
    return result;
  }

  async compactCatalogManifest(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<z.infer<typeof compactReadySchema> | null> {
    return this.readCompactManifest(projectId, zone, budget);
  }

  async markCatalogReady(projectId: string, zone: NavigationZone, generation: number, budget?: SliceBudget): Promise<boolean> {
    const initialState = await this.readProjectState(projectId, budget);
    if (initialState.zones[zone]?.catalog_rebuild_request_id) return false;
    const dirty = await this.listDirtyPage(projectId, zone, null, 1, budget);
    if (dirty.resource_ids.length || dirty.next_cursor !== null) return false;
    const current = initialState.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.generation !== generation || current.in_flight_writes.length) return false;
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    if (manifest?.ready_generation === generation && manifest.completed_generations.length === 0 && manifest.coalesced_dirty.length === 0) return true;
    if (manifest?.rebuild_repair_required) return false;
    return this.writeCatalogReadyGeneration(projectId, zone, generation, budget, [], []);
  }

  async finishDirty(projectId: string, zone: NavigationZone, resourceId: string, exactEntryOrNull: NavigationInventoryEntry | null, budget?: SliceBudget): Promise<boolean> {
    return this.withMutationLock(projectId, resourceId, () => this.finishDirtyUnlocked(projectId, zone, resourceId, exactEntryOrNull, budget));
  }

  private async finishDirtyUnlocked(projectId: string, zone: NavigationZone, resourceId: string, exactEntryOrNull: NavigationInventoryEntry | null, budget?: SliceBudget): Promise<boolean> {
    const markerPath = await resourcePath(zoneNavigationDirtyRoot(projectId, zone), resourceId);
    charge(budget);
    const markerMetadata = await this.runtime.objects.getMetadata(markerPath);
    charge(budget);
    const raw = await this.runtime.objects.readText(markerPath);
    if (raw === null) return true;
    const marker = dirtySchema.parse(JSON.parse(raw));
    if (marker.resource_id !== resourceId || (marker.entry_hash !== null && marker.entry_hash !== (exactEntryOrNull ? await entryHash(exactEntryOrNull) : null))) return false;
    const state = await this.readState(projectId, zone, budget);
    if (state.in_flight_resource_ids.includes(resourceId)) return false;
    const current = await this.readCatalogEntry(projectId, zone, resourceId, budget);
    if (canonicalJson(current) !== canonicalJson(exactEntryOrNull)) return false;
    if (!markerMetadata?.objectId || !markerMetadata.revisionToken || !this.runtime.objects.deleteIfUnchanged) return false;
    const coalesced = await this.readCoalescedDirty(projectId, zone, resourceId, marker.generation, budget);
    await this.recordCompletedGenerations(projectId, zone, [...coalesced, { start: marker.generation, end: marker.generation }], resourceId, marker.generation, budget);
    const deleted = (await this.runtime.objects.deleteIfUnchanged(markerPath, { objectId: markerMetadata.objectId, revisionToken: markerMetadata.revisionToken })) !== "changed";
    if (deleted) await this.advanceReadyCatalogIfClean(projectId, zone, budget);
    return deleted;
  }

  async verifySnapshot(projectId: string, zone: NavigationZone, snapshotId: string, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readState(projectId, zone, budget);
    if (snapshotId !== `source:${state.generation}` || state.in_flight_resource_ids.length) return false;
    const dirty = await this.listDirtyPage(projectId, zone, null, 1, budget);
    return dirty.resource_ids.length === 0 && dirty.next_cursor === null;
  }

  async beginHeadWrite(projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget, writeHash: string | null = null, forceGeneration = false, ownerHash?: string): Promise<ZoneNavigationHeadWriteTicket | null> {
    return (await this.beginHeadWrites(projectId, [zone], resourceId, budget, [], writeHash, forceGeneration, ownerHash))[0] ?? null;
  }

  /** Shared state read/write for a source mutation that affects several zones. */
  async beginHeadWrites(projectId: string, affectedZones: readonly NavigationZone[], resourceId: string, budget?: SliceBudget, recoveryZones: readonly NavigationZone[] = [], writeHash: string | null = null, forceGeneration = false, ownerHash?: string): Promise<ZoneNavigationHeadWriteTicket[]> {
    return this.withMutationLock(projectId, resourceId, () => this.beginHeadWritesUnlocked(projectId, affectedZones, resourceId, budget, recoveryZones, writeHash, forceGeneration, ownerHash));
  }

  private async beginHeadWritesUnlocked(projectId: string, affectedZones: readonly NavigationZone[], resourceId: string, budget?: SliceBudget, recoveryZones: readonly NavigationZone[] = [], writeHash: string | null = null, forceGeneration = false, ownerHash?: string): Promise<ZoneNavigationHeadWriteTicket[]> {
    if (writeHash !== null && !/^[a-f0-9]{64}$/.test(writeHash)) throw new Error("navigation_source_write_hash_invalid");
    if (ownerHash !== undefined && !/^[a-f0-9]{64}$/.test(ownerHash)) throw new Error("navigation_source_owner_hash_invalid");
    const state = await this.readProjectState(projectId, budget);
    for (const zone of new Set([...affectedZones, ...recoveryZones])) {
      const current = state.zones[zone] ?? DEFAULT_ZONE_STATE;
      if (current.catalog_rebuild_request_id) throw new Error("navigation_catalog_rebuild_writer_fenced");
    }
    for (const zone of new Set([...affectedZones, ...recoveryZones])) {
      const resourceFlights = (state.zones[zone] ?? DEFAULT_ZONE_STATE).in_flight_writes
        .filter((write) => write.resource_id === resourceId);
      const foreignFlight = ownerHash === undefined
        ? resourceFlights.some((write) => write.owner_hash !== undefined)
        : resourceFlights.some((write) => write.owner_hash !== ownerHash);
      if (foreignFlight) throw new Error("navigation_source_owner_conflict");
    }
    let cleanedSupersededTicket = false;
    if (writeHash !== null && resourceId.startsWith("head:DOC-")) {
      charge(budget);
      const canonicalHead = await this.runtime.objects.readText(machineDocumentHeadPath(projectId, resourceId.slice("head:".length)));
      if (canonicalHead !== null && await sha256Text(canonicalHead) === writeHash) {
        for (const zone of new Set([...affectedZones, ...recoveryZones])) {
          const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
          const priorLength = current.in_flight_writes.length;
          current.in_flight_writes = current.in_flight_writes.filter((write) => write.resource_id !== resourceId || ((write.write_hash ?? null) === writeHash && write.owner_hash === ownerHash));
          if (current.in_flight_writes.length !== priorLength) {
            state.zones[zone] = current;
            cleanedSupersededTicket = true;
          }
        }
      }
    }
    const tickets: ZoneNavigationHeadWriteTicket[] = [];
    const affected = new Set(affectedZones);
    for (const zone of new Set([...affectedZones, ...recoveryZones])) {
      const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
      const existing = current.in_flight_writes.find((write) => write.resource_id === resourceId && (write.write_hash ?? null) === writeHash && write.owner_hash === ownerHash);
      if (existing) {
        tickets.push({ project_id: projectId, zone, resource_id: resourceId, generation: existing.generation, write_hash: writeHash, ...(ownerHash ? { owner_hash: ownerHash } : {}) });
        continue;
      }
      // If an earlier write already opened a flight for this resource, a
      // later head-only update must transfer the durable fence even when its
      // own changed fields do not alter a navigation pointer. Otherwise the
      // old writer could discard the only invalidation after observing the
      // newer canonical head, leaving a clean snapshot over stale catalog.
      const supersedesInFlight = current.in_flight_writes.some((write) => write.resource_id === resourceId);
      if (!affected.has(zone) && !supersedesInFlight) continue;
      if (!current.adopted && !current.adoption_request_id && !forceGeneration) continue;
      current.generation += 1;
      current.in_flight_writes.push({ resource_id: resourceId, generation: current.generation, write_hash: writeHash, ...(ownerHash ? { owner_hash: ownerHash } : {}) });
      state.zones[zone] = current;
      tickets.push({ project_id: projectId, zone, resource_id: resourceId, generation: current.generation, write_hash: writeHash, ...(ownerHash ? { owner_hash: ownerHash } : {}) });
    }
    if (!tickets.length && !cleanedSupersededTicket) return [];
    await this.writeProjectState(projectId, state, budget);
    return tickets;
  }

  async hasOwnedHeadWrite(projectId: string, zone: NavigationZone, resourceId: string, ownerHash: string): Promise<boolean> {
    const state = await this.readProjectState(projectId);
    return (state.zones[zone] ?? DEFAULT_ZONE_STATE).in_flight_writes.some((write) => write.resource_id === resourceId && write.owner_hash === ownerHash);
  }

  async readOwnedHeadWrite(projectId: string, zone: NavigationZone, resourceId: string, ownerHash: string): Promise<ZoneNavigationHeadWriteTicket | null> {
    const state = await this.readProjectState(projectId);
    const item = state.zones[zone] ?? DEFAULT_ZONE_STATE;
    const write = item.in_flight_writes.find((candidate) => candidate.resource_id === resourceId && candidate.owner_hash === ownerHash);
    return write ? { project_id: projectId, zone, resource_id: resourceId, generation: write.generation, write_hash: write.write_hash ?? null, owner_hash: ownerHash } : null;
  }

  /** Release an owned source fence only when the caller proves its source mutation has not begun. */
  async abandonHeadWrite(ticket: ZoneNavigationHeadWriteTicket): Promise<void> {
    await this.withMutationLock(ticket.project_id, ticket.resource_id, async () => {
      const current = await this.readProjectState(ticket.project_id);
      const write = (current.zones[ticket.zone] ?? DEFAULT_ZONE_STATE).in_flight_writes
        .find((candidate) => candidate.resource_id === ticket.resource_id
          && candidate.generation === ticket.generation
          && (candidate.write_hash ?? null) === ticket.write_hash
          && candidate.owner_hash === ticket.owner_hash);
      if (write) await this.discardHeadWrite(ticket);
    });
  }

  async completeHeadWrite(ticket: ZoneNavigationHeadWriteTicket | null, observedEntry: NavigationInventoryEntry | null, budget?: SliceBudget): Promise<void> {
    if (!ticket) return;
    await this.completeHeadWrites([ticket], observedEntry === undefined ? new Map() : new Map([[ticket.zone, observedEntry]]), budget);
  }

  /** Durable dirty marker is written before clearing the in-flight fence. */
  async completeHeadWrites(tickets: readonly ZoneNavigationHeadWriteTicket[], observedEntries: ReadonlyMap<NavigationZone, NavigationInventoryEntry | null> = new Map(), budget?: SliceBudget): Promise<void> {
    if (!tickets.length) return;
    return this.withMutationLock(tickets[0].project_id, tickets[0].resource_id, () => this.completeHeadWritesUnlocked(tickets, observedEntries, budget));
  }

  private async completeHeadWritesUnlocked(tickets: readonly ZoneNavigationHeadWriteTicket[], observedEntries: ReadonlyMap<NavigationZone, NavigationInventoryEntry | null>, budget?: SliceBudget): Promise<void> {
    if (!tickets.length) return;
    const projectId = tickets[0].project_id, resourceId = tickets[0].resource_id;
    if (tickets.some((ticket) => ticket.project_id !== projectId || ticket.resource_id !== resourceId)) throw new Error("navigation_source_ticket_binding");
    const before = await this.readProjectState(projectId, budget);
    for (const { zone, generation } of tickets) {
      if (!(before.zones[zone] ?? DEFAULT_ZONE_STATE).in_flight_writes.some((write) => { const ticket = tickets.find((item) => item.zone === zone)!; return write.resource_id === resourceId && write.generation === generation && (write.write_hash ?? null) === ticket.write_hash && write.owner_hash === ticket.owner_hash; })) throw new Error("navigation_source_ticket_stale");
    }
    for (const ticket of tickets) if (!await this.headWriteIsCurrent(ticket, budget)) {
      await this.discardHeadWrite(ticket, budget);
      throw new Error("navigation_source_head_superseded");
    }
    // Capture per-resource CAS tokens before the final ticket validation. If a
    // second runtime completes a newer write after validation, its record
    // revision makes these conditional writes fail instead of being clobbered.
    const mutations = [] as { zone: NavigationZone; generation: number; catalogPath: string; dirtyPath: string; catalogToken: string | null; dirtyToken: string | null; previousGeneration: number | null; coveredGenerations: z.infer<typeof generationRangeSchema>[] }[];
    for (const { zone, generation } of tickets) {
      const catalogPath = await resourcePath(zoneNavigationCatalogRoot(projectId, zone), resourceId);
      const dirtyPath = await resourcePath(zoneNavigationDirtyRoot(projectId, zone), resourceId);
      const catalogToken = await this.readWriteToken(catalogPath, budget);
      const dirtyToken = await this.readWriteToken(dirtyPath, budget);
      let previousGeneration: number | null = null;
      let coveredGenerations: z.infer<typeof generationRangeSchema>[] = [];
      if (dirtyToken !== null) {
        charge(budget);
        const priorRaw = await this.runtime.objects.readText(dirtyPath);
        if (priorRaw === null) throw new Error("navigation_dirty_record_changed");
        const prior = dirtySchema.parse(JSON.parse(priorRaw));
        if (prior.resource_id !== resourceId || prior.generation > generation) throw new Error("navigation_dirty_generation_stale");
        if (prior.generation < generation) {
          previousGeneration = prior.generation;
          const manifest = await this.readCompactManifest(projectId, zone, budget);
          const existing = manifest?.coalesced_dirty.find((item) => item.resource_id === resourceId && item.latest_generation === prior.generation);
          // Defer range compaction to recordCoalescedDirty so overflow can
          // invalidate the optimization without blocking the source write.
          coveredGenerations = [...(existing?.covered_generations ?? []), { start: prior.generation, end: prior.generation }];
        } else {
          const manifest = await this.readCompactManifest(projectId, zone, budget);
          coveredGenerations = manifest?.coalesced_dirty.find((item) => item.resource_id === resourceId && item.latest_generation === generation)?.covered_generations ?? [];
        }
      }
      mutations.push({ zone, generation, catalogPath, dirtyPath, catalogToken, dirtyToken, previousGeneration, coveredGenerations });
    }
    const beforeWrites = await this.readProjectState(projectId, budget);
    for (const { zone, generation } of tickets) {
      if (!(beforeWrites.zones[zone] ?? DEFAULT_ZONE_STATE).in_flight_writes.some((write) => { const ticket = tickets.find((item) => item.zone === zone)!; return write.resource_id === resourceId && write.generation === generation && (write.write_hash ?? null) === ticket.write_hash && write.owner_hash === ticket.owner_hash; })) throw new Error("navigation_source_ticket_stale");
    }
    for (const { zone, generation, catalogPath, dirtyPath, catalogToken, dirtyToken, previousGeneration, coveredGenerations } of mutations) {
      const observedEntry = observedEntries.get(zone);
      if (observedEntries.has(zone) && observedEntry && (observedEntry.project_id !== projectId || observedEntry.zone !== zone || observedEntry.resource_id !== resourceId)) throw new Error("navigation_catalog_binding");
      try {
        if (observedEntries.has(zone)) await this.writeAtToken(catalogPath, JSON.stringify({ schema_version: "1.0", resource_id: resourceId, entry: observedEntry ?? null }), catalogToken, budget);
        if (previousGeneration !== null) await this.recordCoalescedDirty(projectId, zone, resourceId, previousGeneration, generation, coveredGenerations, budget);
        await this.writeAtToken(dirtyPath, JSON.stringify({ schema_version: "1.0", resource_id: resourceId, generation, entry_hash: observedEntry ? await entryHash(observedEntry) : null }), dirtyToken, budget);
      } catch (error) {
        for (const ticket of tickets) if (!await this.headWriteIsCurrent(ticket, budget)) await this.discardHeadWrite(ticket, budget);
        throw error;
      }
    }
    for (const ticket of tickets) if (!await this.headWriteIsCurrent(ticket, budget)) {
      await this.discardHeadWrite(ticket, budget);
      throw new Error("navigation_source_head_superseded");
    }
    const state = await this.readProjectState(projectId, budget);
    for (const { zone } of tickets) {
      const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
      const ticket = tickets.find((item) => item.zone === zone)!;
      if (!current.in_flight_writes.some((write) => write.resource_id === resourceId && write.generation === ticket.generation && (write.write_hash ?? null) === ticket.write_hash && write.owner_hash === ticket.owner_hash)) throw new Error("navigation_source_ticket_stale");
      current.in_flight_writes = current.in_flight_writes.filter((write) => !(write.resource_id === resourceId && write.generation === ticket.generation && (write.write_hash ?? null) === ticket.write_hash && write.owner_hash === ticket.owner_hash));
      state.zones[zone] = current;
    }
    await this.writeProjectState(projectId, state, budget);
  }

  private async headWriteIsCurrent(ticket: ZoneNavigationHeadWriteTicket, budget?: SliceBudget): Promise<boolean> {
    if (!ticket.write_hash) return true;
    charge(budget);
    const raw = await this.runtime.objects.readText(machineDocumentHeadPath(ticket.project_id, ticket.resource_id.slice("head:".length)));
    return raw !== null && await sha256Text(raw) === ticket.write_hash;
  }

  private async discardHeadWrite(ticket: ZoneNavigationHeadWriteTicket, budget?: SliceBudget): Promise<void> {
    const state = await this.readProjectState(ticket.project_id, budget);
    const current = state.zones[ticket.zone] ?? { ...DEFAULT_ZONE_STATE };
    const before = current.in_flight_writes.length;
    current.in_flight_writes = current.in_flight_writes.filter((write) => !(write.resource_id === ticket.resource_id && write.generation === ticket.generation && (write.write_hash ?? null) === ticket.write_hash && write.owner_hash === ticket.owner_hash));
    if (current.in_flight_writes.length === before) return;
    state.zones[ticket.zone] = current;
    await this.writeProjectState(ticket.project_id, state, budget);
  }

  private async withMutationLock<T>(projectId: string, resourceId: string, work: () => Promise<T>): Promise<T> {
    let projectQueues = sourceMutationQueues.get(this.runtime);
    if (!projectQueues) { projectQueues = new Map(); sourceMutationQueues.set(this.runtime, projectQueues); }
    const key = `${projectId}\n${resourceId}`;
    const previous = projectQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    projectQueues.set(key, turn);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (projectQueues.get(key) === turn) projectQueues.delete(key);
    }
  }

  private async updateCompactCatalogEntry(entry: NavigationInventoryEntry | null, projectId: string, zone: NavigationZone, resourceId: string, generation: number, budget: SliceBudget | undefined, skipFenceChecks = false, knownManifest?: z.infer<typeof compactReadySchema> | null): Promise<void> {
    if (entry && (entry.project_id !== projectId || entry.zone !== zone || entry.resource_id !== resourceId)) throw new Error("navigation_catalog_binding");
    const assertWriteAllowed = async () => {
      if (!skipFenceChecks) await this.assertCatalogCacheWriteAllowed(projectId, zone, budget);
      // A source snapshot that is not adopted cannot start a rebuild. This
      // preserves the bounded first-adoption scan; ready/adopted cache writes
      // still perform the durable source-state fence check below.
    };
    const shard = shardFor(resourceId);
    const manifest = knownManifest === undefined ? await this.readCompactManifest(projectId, zone, budget) : knownManifest;
    if (entry === null) {
      if (!manifest?.shards.includes(shard)) return;
    }
    const path = compactChunkPath(projectId, zone, shard);
    await this.ensureCompactShard(projectId, zone, shard, budget, manifest, skipFenceChecks);
    const before = await this.readWriteToken(path, budget);
    let entries: z.infer<typeof compactEntrySchema>[] = [];
    if (before !== null) {
      charge(budget);
      const raw = await this.runtime.objects.readText(path);
      if (raw === null) throw new Error("navigation_compact_catalog_changed");
      const chunk = compactChunkSchema.parse(JSON.parse(raw));
      if (chunk.project_id !== projectId || chunk.zone !== zone || chunk.shard !== shard) throw new Error("navigation_compact_catalog_binding");
      entries = chunk.entries;
    }
    if (entry) {
      const expectedHash = await entryHash(entry);
      const prior = entries.find((item) => item.resource_id === resourceId);
      if (prior && prior.source_generation === generation && prior.entry_hash === expectedHash && canonicalJson(prior.entry) === canonicalJson(entry)) return;
    } else if (!entries.some((item) => item.resource_id === resourceId)) return;
    entries = entries.filter((item) => item.resource_id !== resourceId);
    if (entry) entries.push({ resource_id: resourceId, source_generation: generation, entry_hash: await entryHash(entry), entry });
    entries.sort((left, right) => left.resource_id.localeCompare(right.resource_id));
    if (entries.length > MAX_COMPACT_CHUNK_ENTRIES) throw new Error("navigation_compact_catalog_chunk_full");
    const content = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone, shard, entries });
    if (new TextEncoder().encode(content).byteLength > MAX_COMPACT_CHUNK_BYTES) throw new Error("navigation_compact_catalog_chunk_oversize");
    await assertWriteAllowed();
    await this.writeAtToken(path, content, before, budget);
  }

  private async compactCatalogEntryMatches(projectId: string, zone: NavigationZone, resourceId: string, entry: NavigationInventoryEntry | null, generation: number, manifest: z.infer<typeof compactReadySchema>, budget?: SliceBudget): Promise<boolean> {
    const shard = shardFor(resourceId);
    if (manifest.ready_generation !== generation || !manifest.shards.includes(shard)) return entry === null;
    try {
      const entries = await this.readCompactCatalogShard(projectId, zone, shard, generation, budget);
      const current = entries.find((candidate) => candidate.resource_id === resourceId) ?? null;
      return canonicalJson(current) === canonicalJson(entry);
    } catch (error) {
      if (error instanceof Error && error.message === "navigation_compact_catalog_missing") return false;
      throw error;
    }
  }

  private async advanceReadyCatalogIfClean(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<void> {
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    if (!manifest) return;
    const current = await this.readProjectState(projectId, budget);
    const item = current.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (item.in_flight_writes.length || item.catalog_rebuild_request_id) return;
    const dirty = await this.listDirtyPage(projectId, zone, null, 1, budget);
    if (dirty.resource_ids.length || dirty.next_cursor !== null) return;
    const latest = await this.readProjectState(projectId, budget);
    const latestItem = latest.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (latestItem.generation !== item.generation || latestItem.in_flight_writes.length) return;
    if (manifest.ready_generation === latestItem.generation) return;
    // Advance only when durable per-dirty acknowledgements prove every
    // generation since ready was verified. Legacy writers which consumed a
    // dirty marker leave a gap and therefore force a full verified migration.
    if (manifest.ready_generation === null || !coversGenerationRange(manifest.completed_generations, manifest.ready_generation + 1, latestItem.generation)) return;
    await this.writeCatalogReadyGeneration(projectId, zone, latestItem.generation, budget, [], []);
  }

  private async recordCompletedGenerations(projectId: string, zone: NavigationZone, generations: z.infer<typeof generationRangeSchema>[], resourceId: string, generation: number, budget?: SliceBudget): Promise<void> {
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    if (!manifest || manifest.ready_generation === null) return;
    let completed: z.infer<typeof generationRangeSchema>[];
    try {
      completed = mergeGenerationRanges([...manifest.completed_generations, ...generations]);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "navigation_completed_generation_ranges_full") throw error;
      // Bounded acknowledgement overflow is a cache invalidation, not a
      // reason to strand a dirty marker. A later full verified scan can adopt
      // the current generation safely.
      await this.invalidateCompactReadiness(projectId, zone, budget);
      return;
    }
    const coalesced = manifest.coalesced_dirty.filter((item) => item.resource_id !== resourceId || item.latest_generation !== generation);
    if (canonicalJson(completed) === canonicalJson(manifest.completed_generations) && canonicalJson(coalesced) === canonicalJson(manifest.coalesced_dirty)) return;
    await this.writeCatalogReadyGeneration(projectId, zone, manifest.ready_generation, budget, completed, coalesced);
  }

  private async recordCoalescedDirty(projectId: string, zone: NavigationZone, resourceId: string, priorGeneration: number, latestGeneration: number, coveredGenerations: z.infer<typeof generationRangeSchema>[], budget?: SliceBudget): Promise<void> {
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    if (!manifest || manifest.ready_generation === null) return;
    const coalesced = manifest.coalesced_dirty.filter((item) => item.resource_id !== resourceId);
    let ranges: z.infer<typeof generationRangeSchema>[];
    try {
      ranges = mergeGenerationRanges([...coveredGenerations, { start: priorGeneration, end: priorGeneration }]);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "navigation_completed_generation_ranges_full") throw error;
      await this.invalidateCompactReadiness(projectId, zone, budget);
      return;
    }
    coalesced.push({ resource_id: resourceId, latest_generation: latestGeneration, covered_generations: ranges });
    if (coalesced.length > 512) {
      await this.invalidateCompactReadiness(projectId, zone, budget);
      return; // Fall back to a full verified migration; never block clearing the dirty marker.
    }
    await this.writeCatalogReadyGeneration(projectId, zone, manifest.ready_generation, budget, manifest.completed_generations, coalesced);
  }

  private async invalidateCompactReadiness(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<void> {
    await this.writeCatalogReadyGeneration(projectId, zone, null, budget, [], []);
  }

  private async readCoalescedDirty(projectId: string, zone: NavigationZone, resourceId: string, generation: number, budget?: SliceBudget): Promise<z.infer<typeof generationRangeSchema>[]> {
    const manifest = await this.readCompactManifest(projectId, zone, budget);
    return manifest?.coalesced_dirty.find((item) => item.resource_id === resourceId && item.latest_generation === generation)?.covered_generations ?? [];
  }

  private async readCatalogReadyGeneration(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<number | null> {
    const ready = await this.readCompactManifest(projectId, zone, budget);
    return ready?.ready_generation ?? null;
  }

  private async readCompactManifest(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<z.infer<typeof compactReadySchema> | null> {
    const path = compactReadyPath(projectId, zone);
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const ready = compactReadySchema.parse(JSON.parse(raw));
    if (ready.project_id !== projectId || ready.zone !== zone) throw new Error("navigation_compact_catalog_binding");
    return ready;
  }

  private async hasExactReadyBaseline(projectId: string, zone: NavigationZone, sourceGeneration: number, budget?: SliceBudget): Promise<boolean> {
    const path = compactReadyPath(projectId, zone);
    const readBytes = this.runtime.objects.readBytes;
    if (!readBytes) return false;
    try {
      charge(budget);
      const before = await this.runtime.objects.getMetadata(path);
      if (!before?.objectId || !before.revisionToken || !Number.isSafeInteger(before.size)
        || before.size < 0 || before.size > MAX_COMPACT_CHUNK_BYTES) return false;
      charge(budget);
      const bytes = await readBytes.call(this.runtime.objects, path, MAX_COMPACT_CHUNK_BYTES);
      if (!bytes || bytes.byteLength !== before.size) return false;
      charge(budget);
      const after = await this.runtime.objects.getMetadata(path);
      if (!after || before.objectId !== after.objectId || before.revisionToken !== after.revisionToken
        || before.size !== after.size) return false;
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const manifest = compactReadySchema.parse(JSON.parse(raw));
      return manifest.project_id === projectId && manifest.zone === zone
        && manifest.ready_generation === sourceGeneration
        && !manifest.rebuilding_request_id && !manifest.rebuild_repair_required;
    } catch {
      return false;
    }
  }

  private async writeCatalogReadyGeneration(projectId: string, zone: NavigationZone, generation: number | null, budget?: SliceBudget, completedGenerations?: z.infer<typeof generationRangeSchema>[], coalescedDirty?: z.infer<typeof coalescedDirtySchema>[]): Promise<boolean> {
    const path = compactReadyPath(projectId, zone);
    if (await this.readCompactManifest(projectId, zone, budget) === null) await this.ensureCompactDirectory(projectId, zone, budget);
    const token = await this.readWriteToken(path, budget);
    await this.assertCatalogCacheWriteAllowed(projectId, zone, budget);
    const current = token === null ? null : await this.readCompactManifest(projectId, zone, budget);
    const shards = [...new Set(current?.shards ?? [])].sort((left, right) => left - right);
    const content = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone, ready_generation: generation, shards, completed_generations: completedGenerations ?? current?.completed_generations ?? [], coalesced_dirty: coalescedDirty ?? current?.coalesced_dirty ?? [] });
    await this.writeAtToken(path, content, token, budget);
    return true;
  }

  private async ensureCompactShard(projectId: string, zone: NavigationZone, shard: number, budget?: SliceBudget, knownManifest?: z.infer<typeof compactReadySchema> | null, skipFenceChecks = false): Promise<void> {
    const assertWriteAllowed = async () => {
      if (!skipFenceChecks) await this.assertCatalogCacheWriteAllowed(projectId, zone, budget);
    };
    const current = knownManifest === undefined ? await this.readCompactManifest(projectId, zone, budget) : knownManifest;
    if (current?.shards.includes(shard)) return;
    if (current === null) await this.ensureCompactDirectory(projectId, zone, budget);
    const path = compactReadyPath(projectId, zone);
    const token = await this.readWriteToken(path, budget);
    const latest = token === null ? null : await this.readCompactManifest(projectId, zone, budget);
    if (skipFenceChecks && (latest?.rebuilding_request_id || ((knownManifest === null || knownManifest?.ready_generation === null) && latest?.ready_generation !== null && latest?.ready_generation !== undefined))) {
      throw new Error("navigation_catalog_rebuild_writer_fenced");
    }
    const shards = [...new Set([...(latest?.shards ?? []), shard])].sort((left, right) => left - right);
    const content = JSON.stringify({ schema_version: "1.0", project_id: projectId, zone, ready_generation: latest?.ready_generation ?? null, shards, completed_generations: latest?.completed_generations ?? [], coalesced_dirty: latest?.coalesced_dirty ?? [] });
    await assertWriteAllowed();
    await this.writeAtToken(path, content, token, budget);
  }

  private async assertCatalogCacheWriteAllowed(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<void> {
    if ((await this.readProjectState(projectId, budget)).zones[zone]?.catalog_rebuild_request_id) throw new Error("navigation_catalog_rebuild_writer_fenced");
  }

  private async ensureCompactDirectory(projectId: string, zone: NavigationZone, budget?: SliceBudget): Promise<void> {
    if (!this.runtime.directoryProvisioning) return;
    charge(budget);
    await this.runtime.directoryProvisioning.ensureDirectory(zoneNavigationCompactCatalogRoot(projectId, zone));
  }

  private async readWriteToken(path: string, budget?: SliceBudget): Promise<string | null> {
    charge(budget);
    const metadata = await this.runtime.objects.getMetadata(path);
    if (metadata && !metadata.revisionToken) throw new Error("navigation_record_revision_missing");
    return metadata?.revisionToken ?? null;
  }

  private async writeAtToken(path: string, content: string, token: string | null, budget?: SliceBudget): Promise<void> {
    charge(budget);
    if (token === null) {
      await this.runtime.objects.createText(path, content);
      return;
    }
    if (!this.runtime.conditionalWrite) throw new Error("navigation_conditional_write_unavailable");
    await this.runtime.conditionalWrite.writeTextConditional(path, content, token);
  }

  private async readProjectState(projectId: string, budget?: SliceBudget): Promise<StoredProjectState> {
    const path = statePath(projectId);
    charge(budget);
    const metadata = await this.runtime.objects.getMetadata(path);
    charge(budget);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) {
      const state: StoredProjectState = {
      schema_version: "1.0", project_id: projectId, state_revision: 0,
      zones: {
        WORKING: { ...DEFAULT_ZONE_STATE, in_flight_writes: [] },
        REVIEW: { ...DEFAULT_ZONE_STATE, in_flight_writes: [] },
        DELIVERABLES: { ...DEFAULT_ZONE_STATE, in_flight_writes: [] }
      }
      };
      return state;
    }
    const state = stateSchema.parse(JSON.parse(raw)) as StoredProjectState;
    if (state.project_id !== projectId) throw new Error("navigation_source_state_binding");
    if (!metadata?.revisionToken) throw new Error("navigation_source_state_revision_missing");
    Object.defineProperty(state, STATE_REVISION_TOKEN, { value: metadata.revisionToken, enumerable: false });
    for (const zone of zones) state.zones[zone] ??= { ...DEFAULT_ZONE_STATE, in_flight_writes: [] };
    return state;
  }

  private async writeProjectState(projectId: string, state: StoredProjectState, budget?: SliceBudget): Promise<void> {
    const path = statePath(projectId);
    const content = JSON.stringify({ schema_version: state.schema_version, project_id: state.project_id, state_revision: state.state_revision + 1, zones: state.zones });
    charge(budget);
    const revisionToken = state[STATE_REVISION_TOKEN];
    if (!revisionToken) {
      await this.runtime.objects.createText(path, content);
      return;
    }
    await this.runtime.conditionalWrite.writeTextConditional(path, content, revisionToken);
  }
}

async function entryHash(entry: NavigationInventoryEntry): Promise<string> { return sha256Text(canonicalJson(entry)); }
function mergeGenerationRanges(ranges: z.infer<typeof generationRangeSchema>[]): z.infer<typeof generationRangeSchema>[] {
  const sorted = ranges.map((range) => generationRangeSchema.parse(range)).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: z.infer<typeof generationRangeSchema>[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length > 64) throw new Error("navigation_completed_generation_ranges_full");
  return merged;
}
function coversGenerationRange(ranges: z.infer<typeof generationRangeSchema>[], start: number, end: number): boolean {
  if (start > end) return true;
  let next = start;
  for (const range of ranges) {
    if (range.end < next) continue;
    if (range.start > next) return false;
    next = range.end + 1;
    if (next > end) return true;
  }
  return false;
}
function shardFor(resourceId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < resourceId.length; index += 1) hash = Math.imul(hash ^ resourceId.charCodeAt(index), 16777619);
  return (hash >>> 0) % ZONE_NAVIGATION_CATALOG_SHARDS;
}
export function zoneNavigationCatalogShardForResource(resourceId: string): number { return shardFor(resourceId); }
function generationFromSnapshot(snapshotId: string): number {
  const match = /^source:(\d+)$/.exec(snapshotId);
  if (!match) throw new Error("navigation_inventory_snapshot_invalid");
  return Number(match[1]);
}
function assertCatalogRebuildBinding(projectId: string, zone: NavigationZone, requestId: string, snapshotId: string): void {
  if (!/^PRJ-[0-9]{4,}$/.test(projectId) || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(requestId)) throw new Error("navigation_catalog_rebuild_binding_invalid");
  if (!/^source:\d+$/.test(snapshotId)) throw new Error("navigation_catalog_rebuild_snapshot_invalid");
  navigationInventoryEntrySchema.shape.zone.parse(zone);
}
function charge(budget?: SliceBudget): void { budget?.beforeHttp(); }
