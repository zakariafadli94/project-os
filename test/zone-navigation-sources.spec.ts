import { describe, expect, it } from "vitest";
import { ZoneNavigationSources, zoneNavigationCatalogRoot, zoneNavigationDirtyRoot } from "../src/documents/zone-navigation-sources";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { NavigationInventoryEntry } from "../src/domain/zone-navigation";

function harness() {
  const files = new Map<string, string>();
  const revisions = new Map<string, number>();
  let nextCatalogGate: { entered(): void; enteredPromise: Promise<void>; wait: Promise<void>; release(): void } | null = null;
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new Error("exists");
        files.set(path, content);
        revisions.set(path, (revisions.get(path) ?? 0) + 1);
      },
      upsertText: async (path, content) => {
        files.set(path, content);
        revisions.set(path, (revisions.get(path) ?? 0) + 1);
      },
      getMetadata: async (path) => files.has(path) ? { path, objectId: path, revisionToken: String(revisions.get(path)), size: files.get(path)!.length } : null,
      listChildren: async () => [], move: async () => {}, delete: async (path) => { files.delete(path); },
      deleteIfUnchanged: async (path, expected) => {
        if (!files.has(path)) return "missing";
        if (path !== expected.objectId || String(revisions.get(path)) !== expected.revisionToken) return "changed";
        files.delete(path);
        revisions.delete(path);
        return "deleted";
      }
    },
    conditionalWrite: { writeTextConditional: async (path, content, token) => {
      if (path.includes("/catalog/") && nextCatalogGate) {
        const gate = nextCatalogGate; nextCatalogGate = null; gate.entered(); await gate.wait;
      }
      if (!files.has(path) || String(revisions.get(path)) !== token) throw new Error("precondition_failed");
      files.set(path, content);
      revisions.set(path, (revisions.get(path) ?? 0) + 1);
      return { path, objectId: path, revisionToken: String(revisions.get(path)), size: content.length };
    } },
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
  return {
    runtime, files, sources: new ZoneNavigationSources(runtime),
    forkRuntime() {
      const fork = { ...runtime, objects: { ...runtime.objects } };
      return { runtime: fork as ProjectOsPersistenceRuntime, sources: new ZoneNavigationSources(fork as ProjectOsPersistenceRuntime) };
    },
    pauseNextCatalogWrite() {
      let enter!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { enter = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      nextCatalogGate = { entered: enter, enteredPromise, wait, release };
      return { entered: enteredPromise, release };
    }
  };
}

function budget(calls = 256) {
  return { deadline_ms: 1000, calls_left: calls, now: () => 0, signal: new AbortController().signal, beforeHttp() { this.calls_left--; if (this.calls_left < 0) throw new Error("budget"); }, canStartEffect: () => true };
}

function entry(): NavigationInventoryEntry {
  return { project_id: "PRJ-0002", zone: "WORKING", resource_id: "head:DOC-0123456789ABCDEF01234567", version: "VER-0123456789ABCDEF01234567", logical_path: "a.md", path: "/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/a.md", expected: { object_id: "obj", revision_token: "rev", content_sha256: "a".repeat(64), size: 4 } };
}

describe("ZoneNavigationSources", () => {
  it("releases only the exact failed adoption owner for a safe new request", async () => {
    const { sources } = harness();
    const b = budget();
    const oldId = "DOCREQ-NAVIGATION-WORKING-OLD1";
    const newId = "DOCREQ-NAVIGATION-WORKING-NEW1";
    expect(await sources.beginAdoption("PRJ-0002", "WORKING", oldId, 0, b)).toBe(true);
    expect(await sources.beginAdoption("PRJ-0002", "WORKING", newId, 0, b)).toBe(false);
    expect(await sources.abortAdoption("PRJ-0002", "WORKING", newId, 0, b)).toBe(false);
    expect(await sources.abortAdoption("PRJ-0002", "WORKING", oldId, 0, b)).toBe(true);
    expect(await sources.beginAdoption("PRJ-0002", "WORKING", newId, 0, b)).toBe(true);
  });

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

  it("reuses the durable in-flight ticket when the same source write is retried", async () => {
    const { sources } = harness();
    const b = budget();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    const resourceId = entry().resource_id;
    const older = await sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, b);
    const retry = await sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, b);
    expect(retry).toEqual(older);
    await sources.completeHeadWrite(older, entry(), b);
    expect(await sources.readCatalogEntry("PRJ-0002", "WORKING", resourceId, b)).toEqual(entry());
  });

  it("lets a new adoption snapshot take over after a source write invalidates the old generation", async () => {
    const { sources } = harness();
    const b = budget();
    await expect(sources.beginAdoption("PRJ-0002", "WORKING", "NAVADOPT-old", 0, b)).resolves.toBe(true);
    const e = entry();
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b);
    await sources.completeHeadWrite(ticket, e, b);
    await expect(sources.beginAdoption("PRJ-0002", "WORKING", "NAVADOPT-new", 1, b)).resolves.toBe(true);
    expect(await sources.finishAdoption("PRJ-0002", "WORKING", "NAVADOPT-new", 1, b)).toBe(false);
    expect(await sources.finishDirty("PRJ-0002", "WORKING", e.resource_id, e, b)).toBe(true);
    expect(await sources.finishAdoption("PRJ-0002", "WORKING", "NAVADOPT-new", 1, b)).toBe(true);
  });

  it("serializes interleaved completions so an older writer cannot overwrite a newer catalog", async () => {
    const { sources, pauseNextCatalogWrite } = harness();
    const b = budget();
    await sources.beginAdoption("PRJ-0002", "WORKING", "NAVADOPT", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "NAVADOPT", 0, b);
    const oldEntry = entry();
    const newEntry = { ...oldEntry, version: "VER-1123456789ABCDEF01234567", expected: { ...oldEntry.expected, revision_token: "rev-new", content_sha256: "b".repeat(64) } };
    await sources.writeCatalogEntry(oldEntry, "PRJ-0002", "WORKING", oldEntry.resource_id, b);
    const oldTicket = await sources.beginHeadWrite("PRJ-0002", "WORKING", oldEntry.resource_id, b);
    const gate = pauseNextCatalogWrite();
    const oldCompletion = sources.completeHeadWrite(oldTicket, oldEntry, b);
    await gate.entered;
    let newBeginFinished = false;
    const newBegin = sources.beginHeadWrite("PRJ-0002", "WORKING", oldEntry.resource_id, b).then((ticket) => { newBeginFinished = true; return ticket; });
    await Promise.resolve();
    expect(newBeginFinished).toBe(false);
    gate.release();
    await oldCompletion;
    const newTicket = await newBegin;
    await sources.completeHeadWrite(newTicket, newEntry, b);
    expect(await sources.readCatalogEntry("PRJ-0002", "WORKING", oldEntry.resource_id, b)).toEqual(newEntry);
  });

  it("uses durable record CAS across distinct runtime wrappers sharing one provider store", async () => {
    const { sources, forkRuntime, pauseNextCatalogWrite } = harness();
    const b = budget();
    await sources.beginAdoption("PRJ-0002", "WORKING", "NAVADOPT", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "NAVADOPT", 0, b);
    const oldEntry = entry();
    const newEntry = { ...oldEntry, version: "VER-1123456789ABCDEF01234567", expected: { ...oldEntry.expected, revision_token: "rev-new", content_sha256: "b".repeat(64) } };
    await sources.writeCatalogEntry(oldEntry, "PRJ-0002", "WORKING", oldEntry.resource_id, b);
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", oldEntry.resource_id, b);
    const gate = pauseNextCatalogWrite();
    const staleRuntimeCompletion = sources.completeHeadWrite(ticket, oldEntry, b);
    await gate.entered;
    const newerRuntime = forkRuntime();
    await newerRuntime.sources.completeHeadWrite(ticket, newEntry, budget());
    gate.release();

    await expect(staleRuntimeCompletion).rejects.toThrow("precondition_failed");
    expect(await newerRuntime.sources.readCatalogEntry("PRJ-0002", "WORKING", oldEntry.resource_id, budget())).toEqual(newEntry);
    expect(await newerRuntime.sources.readState("PRJ-0002", "WORKING", budget())).toMatchObject({ generation: 1, in_flight_resource_ids: [] });
  });
});
