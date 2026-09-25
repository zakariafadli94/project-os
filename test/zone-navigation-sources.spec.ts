import { describe, expect, it } from "vitest";
import { ZoneNavigationSources, zoneNavigationCatalogRoot, zoneNavigationDirtyRoot } from "../src/documents/zone-navigation-sources";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { NavigationInventoryEntry } from "../src/domain/zone-navigation";

function harness() {
  const files = new Map<string, string>();
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => { if (files.has(path)) throw new Error("exists"); files.set(path, content); },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async (path) => files.has(path) ? { path, objectId: path, revisionToken: "1", size: files.get(path)!.length } : null,
      listChildren: async () => [], move: async () => {}, delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: { writeTextConditional: async (path, content) => { files.set(path, content); return { path, objectId: path, revisionToken: "2", size: content.length }; } },
    serverSideCopy: { copyObject: async () => ({ path: "", objectId: "", revisionToken: "", size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "" }) },
    pagedListing: { listPage: async ({ path, cursor, limit }) => {
      const matching = [...files.keys()].filter((key) => key.startsWith(`${path}/`)).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } },
    evidence: { stableObjectId: { semantics: "stable-through-move" }, revisionToken: { semantics: "opaque-object-revision" }, integrityHash: { semantics: "identified-algorithm" } }
  };
  return { runtime, files, sources: new ZoneNavigationSources(runtime) };
}

function budget(calls = 32) {
  return { deadline_ms: 1000, calls_left: calls, now: () => 0, signal: new AbortController().signal, beforeHttp() { this.calls_left--; if (this.calls_left < 0) throw new Error("budget"); }, canStartEffect: () => true };
}

function entry(): NavigationInventoryEntry {
  return { project_id: "PRJ-0002", zone: "WORKING", resource_id: "head:DOC-0123456789ABCDEF01234567", version: "VER-0123456789ABCDEF01234567", logical_path: "a.md", path: "/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/a.md", expected: { object_id: "obj", revision_token: "rev", content_sha256: "a".repeat(64), size: 4 } };
}

describe("ZoneNavigationSources", () => {
  it("keeps source generations, adoption and in-flight head writes durable across failed writers", async () => {
    const { sources } = harness();
    const b = budget();
    expect(await sources.readState("PRJ-0002", "WORKING", b)).toMatchObject({ generation: 0, adopted: false, in_flight_resource_ids: [] });
    expect(await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b)).toBe(true);
    expect(await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b)).toBe(true);
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", "head:DOC-0123456789ABCDEF01234567", b);
    expect(ticket).toMatchObject({ generation: 1 });
    expect(await sources.readState("PRJ-0002", "WORKING", b)).toMatchObject({ generation: 1, adopted: true, in_flight_resource_ids: ["head:DOC-0123456789ABCDEF01234567"] });
  });

  it("pages dirty records through pagedListing and clears only the exact verified identity", async () => {
    const { sources, files } = harness();
    const b = budget();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    const e = entry();
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b);
    await sources.completeHeadWrite(ticket, e, b);
    const page = await sources.listDirtyPage("PRJ-0002", "WORKING", null, 8, b);
    expect(page.resource_ids).toEqual([e.resource_id]);
    expect(await sources.readCatalogEntry("PRJ-0002", "WORKING", e.resource_id, b)).toEqual(e);
    expect(await sources.finishDirty("PRJ-0002", "WORKING", e.resource_id, null, b)).toBe(false);
    expect(await sources.finishDirty("PRJ-0002", "WORKING", e.resource_id, e, b)).toBe(true);
    expect(await sources.verifySnapshot("PRJ-0002", "WORKING", "source:1", b)).toBe(true);
    expect([...files.keys()].some((path) => path.startsWith(zoneNavigationCatalogRoot("PRJ-0002", "WORKING")))).toBe(true);
    expect([...files.keys()].some((path) => path.startsWith(zoneNavigationDirtyRoot("PRJ-0002", "WORKING")))).toBe(false);
  });

  it("rejects completion from a superseded in-flight writer before changing its catalog", async () => {
    const { sources } = harness();
    const b = budget();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    const resourceId = entry().resource_id;
    const older = await sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, b);
    const newer = await sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, b);
    await expect(sources.completeHeadWrite(older, entry(), b)).rejects.toThrow("navigation_source_ticket_stale");
    expect(await sources.readCatalogEntry("PRJ-0002", "WORKING", resourceId, b)).toBeNull();
    await sources.completeHeadWrite(newer, entry(), b);
    expect(await sources.readCatalogEntry("PRJ-0002", "WORKING", resourceId, b)).toEqual(entry());
  });
});
