import { z } from "zod";
import { navigationInventoryEntrySchema, type NavigationInventoryEntry, type NavigationZone } from "../domain/zone-navigation";
import type { SliceBudget } from "../convergence/contract";
import { machineDocumentRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { canonicalJson } from "../rules/contract";
import { sha256Text } from "./hash";

const zones = ["WORKING", "REVIEW", "DELIVERABLES"] as const;
const zoneStateSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  adopted: z.boolean(),
  adoption_request_id: z.string().nullable(),
  adoption_generation: z.number().int().nonnegative().safe().nullable(),
  in_flight_writes: z.array(z.strictObject({ resource_id: z.string(), generation: z.number().int().positive().safe() }))
});
const stateSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: z.string(),
  state_revision: z.number().int().nonnegative().safe(),
  zones: z.record(z.enum(zones), zoneStateSchema)
});
const catalogSchema = z.strictObject({ schema_version: z.literal("1.0"), entry: z.unknown() });
const dirtySchema = z.strictObject({
  schema_version: z.literal("1.0"),
  resource_id: z.string(),
  generation: z.number().int().positive().safe(),
  entry_hash: z.string().nullable()
});
const DEFAULT_ZONE_STATE: z.infer<typeof zoneStateSchema> = {
  generation: 0, adopted: false, adoption_request_id: null, adoption_generation: null, in_flight_writes: []
};
const STATE_REVISION_TOKEN = Symbol("zone-navigation-state-revision-token");
type StoredProjectState = z.infer<typeof stateSchema> & { [STATE_REVISION_TOKEN]?: string };

export interface ZoneNavigationSourceState {
  schema_version: "1.0";
  project_id: string;
  zone: NavigationZone;
  generation: number;
  adopted: boolean;
  adoption_request_id: string | null;
  in_flight_resource_ids: string[];
}

export interface ZoneNavigationHeadWriteTicket {
  project_id: string;
  zone: NavigationZone;
  resource_id: string;
  generation: number;
}

export function zoneNavigationCatalogRoot(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation-sources/${zone}/catalog`;
}

export function zoneNavigationDirtyRoot(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation-sources/${zone}/dirty`;
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
    return { schema_version: "1.0", project_id: projectId, zone, generation: item.generation, adopted: item.adopted, adoption_request_id: item.adoption_request_id, in_flight_resource_ids: item.in_flight_writes.map((write) => write.resource_id) };
  }

  async beginAdoption(projectId: string, zone: NavigationZone, requestId: string, expectedGeneration: number, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readProjectState(projectId, budget);
    const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
    if (current.adopted) return current.generation === expectedGeneration;
    if (current.generation !== expectedGeneration || current.in_flight_writes.length) return false;
    if (current.adoption_request_id && (current.adoption_request_id !== requestId || current.adoption_generation !== expectedGeneration)) return false;
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

  async readCatalogEntry(projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget): Promise<NavigationInventoryEntry | null> {
    charge(budget);
    const path = await resourcePath(zoneNavigationCatalogRoot(projectId, zone), resourceId);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const record = catalogSchema.parse(JSON.parse(raw));
    if (record.entry === null) return null;
    const entry = navigationInventoryEntrySchema.parse(record.entry);
    if (entry.project_id !== projectId || entry.zone !== zone || entry.resource_id !== resourceId) throw new Error("navigation_catalog_binding");
    return entry;
  }

  async writeCatalogEntry(entry: NavigationInventoryEntry | null, projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget): Promise<void> {
    const path = await resourcePath(zoneNavigationCatalogRoot(projectId, zone), resourceId);
    if (entry && (entry.project_id !== projectId || entry.zone !== zone || entry.resource_id !== resourceId)) throw new Error("navigation_catalog_binding");
    if (entry === null) {
      charge(budget);
      await this.runtime.objects.delete(path);
      return;
    }
    charge(budget);
    await this.runtime.objects.upsertText(path, JSON.stringify({ schema_version: "1.0", entry }));
  }

  async finishDirty(projectId: string, zone: NavigationZone, resourceId: string, exactEntryOrNull: NavigationInventoryEntry | null, budget?: SliceBudget): Promise<boolean> {
    const markerPath = await resourcePath(zoneNavigationDirtyRoot(projectId, zone), resourceId);
    charge(budget);
    const raw = await this.runtime.objects.readText(markerPath);
    if (raw === null) return true;
    const marker = dirtySchema.parse(JSON.parse(raw));
    if (marker.resource_id !== resourceId || (marker.entry_hash !== null && marker.entry_hash !== (exactEntryOrNull ? await entryHash(exactEntryOrNull) : null))) return false;
    const state = await this.readState(projectId, zone, budget);
    if (state.in_flight_resource_ids.includes(resourceId)) return false;
    const current = await this.readCatalogEntry(projectId, zone, resourceId, budget);
    if (canonicalJson(current) !== canonicalJson(exactEntryOrNull)) return false;
    charge(budget);
    await this.runtime.objects.delete(markerPath);
    return true;
  }

  async verifySnapshot(projectId: string, zone: NavigationZone, snapshotId: string, budget?: SliceBudget): Promise<boolean> {
    const state = await this.readState(projectId, zone, budget);
    if (snapshotId !== `source:${state.generation}` || state.in_flight_resource_ids.length) return false;
    const dirty = await this.listDirtyPage(projectId, zone, null, 1, budget);
    return dirty.resource_ids.length === 0;
  }

  async beginHeadWrite(projectId: string, zone: NavigationZone, resourceId: string, budget?: SliceBudget): Promise<ZoneNavigationHeadWriteTicket | null> {
    return (await this.beginHeadWrites(projectId, [zone], resourceId, budget))[0] ?? null;
  }

  /** Shared state read/write for a source mutation that affects several zones. */
  async beginHeadWrites(projectId: string, affectedZones: readonly NavigationZone[], resourceId: string, budget?: SliceBudget): Promise<ZoneNavigationHeadWriteTicket[]> {
    const state = await this.readProjectState(projectId, budget);
    const tickets: ZoneNavigationHeadWriteTicket[] = [];
    for (const zone of new Set(affectedZones)) {
      const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
      if (!current.adopted && !current.adoption_request_id) continue;
      current.generation += 1;
      current.in_flight_writes = current.in_flight_writes.filter((write) => write.resource_id !== resourceId);
      current.in_flight_writes.push({ resource_id: resourceId, generation: current.generation });
      state.zones[zone] = current;
      tickets.push({ project_id: projectId, zone, resource_id: resourceId, generation: current.generation });
    }
    if (!tickets.length) return [];
    await this.writeProjectState(projectId, state, budget);
    return tickets;
  }

  async completeHeadWrite(ticket: ZoneNavigationHeadWriteTicket | null, observedEntry: NavigationInventoryEntry | null, budget?: SliceBudget): Promise<void> {
    if (!ticket) return;
    await this.completeHeadWrites([ticket], observedEntry === undefined ? new Map() : new Map([[ticket.zone, observedEntry]]), budget);
  }

  /** Durable dirty marker is written before clearing the in-flight fence. */
  async completeHeadWrites(tickets: readonly ZoneNavigationHeadWriteTicket[], observedEntries: ReadonlyMap<NavigationZone, NavigationInventoryEntry | null> = new Map(), budget?: SliceBudget): Promise<void> {
    if (!tickets.length) return;
    const projectId = tickets[0].project_id, resourceId = tickets[0].resource_id;
    if (tickets.some((ticket) => ticket.project_id !== projectId || ticket.resource_id !== resourceId)) throw new Error("navigation_source_ticket_binding");
    const before = await this.readProjectState(projectId, budget);
    for (const { zone, generation } of tickets) {
      if (!(before.zones[zone] ?? DEFAULT_ZONE_STATE).in_flight_writes.some((write) => write.resource_id === resourceId && write.generation === generation)) throw new Error("navigation_source_ticket_stale");
    }
    for (const { zone, generation } of tickets) {
      const observedEntry = observedEntries.get(zone);
      if (observedEntries.has(zone) && observedEntry && (observedEntry.project_id !== projectId || observedEntry.zone !== zone || observedEntry.resource_id !== resourceId)) throw new Error("navigation_catalog_binding");
      if (observedEntries.has(zone)) await this.writeCatalogEntry(observedEntry ?? null, projectId, zone, resourceId, budget);
      const markerPath = await resourcePath(zoneNavigationDirtyRoot(projectId, zone), resourceId);
      charge(budget);
      await this.runtime.objects.upsertText(markerPath, JSON.stringify({ schema_version: "1.0", resource_id: resourceId, generation, entry_hash: observedEntry ? await entryHash(observedEntry) : null }));
    }
    const state = await this.readProjectState(projectId, budget);
    for (const { zone } of tickets) {
      const current = state.zones[zone] ?? { ...DEFAULT_ZONE_STATE };
      const ticket = tickets.find((item) => item.zone === zone)!;
      if (!current.in_flight_writes.some((write) => write.resource_id === resourceId && write.generation === ticket.generation)) throw new Error("navigation_source_ticket_stale");
      current.in_flight_writes = current.in_flight_writes.filter((write) => !(write.resource_id === resourceId && write.generation === ticket.generation));
      state.zones[zone] = current;
    }
    await this.writeProjectState(projectId, state, budget);
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
function charge(budget?: SliceBudget): void { budget?.beforeHttp(); }
