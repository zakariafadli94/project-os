import { describe, expect, it, vi } from "vitest";
import { ZoneNavigationSources, zoneNavigationCatalogRoot, zoneNavigationDirtyRoot, zoneNavigationCatalogShardForResource } from "../src/documents/zone-navigation-sources";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { NavigationInventoryEntry } from "../src/domain/zone-navigation";

function harness() {
  const files = new Map<string, string>();
  const revisions = new Map<string, number>();
  let nextCatalogGate: { entered(): void; enteredPromise: Promise<void>; wait: Promise<void>; release(): void } | null = null;
  let failDirtyDelete = false;
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
        if (failDirtyDelete && path.includes("/dirty/")) { failDirtyDelete = false; throw new Error("simulated dirty-clear interruption"); }
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
    failNextDirtyDelete() { failDirtyDelete = true; },
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
  it("treats a paginated dirty-marker tail as an incomplete snapshot", async () => {
    const { runtime, sources } = harness();
    vi.spyOn(runtime.pagedListing!, "listPage").mockResolvedValue({ entries: [], cursor: "dirty-tail" });

    await expect(sources.verifySnapshot("PRJ-0002", "WORKING", "source:0", budget())).resolves.toBe(false);
  });

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

  it("does not rewrite shared source state when the exact adoption owner resumes", async () => {
    const { sources, files, runtime } = harness();
    const b = budget();
    const requestId = "DOCREQ-NAVIGATION-WORKING-0001";
    await expect(sources.beginAdoption("PRJ-0002", "WORKING", requestId, 0, b)).resolves.toBe(true);
    const statePath = [...files.keys()].find((path) => path.endsWith("/navigation-sources/state.json"))!;
    const before = JSON.parse(files.get(statePath)!);
    await expect(sources.beginAdoption("PRJ-0002", "WORKING", requestId, 0, b)).resolves.toBe(true);
    const after = JSON.parse(files.get(statePath)!);
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.zones.WORKING.adoption_request_id).toBe(requestId);
  });

  it("treats a missing compact shard listed by the ready manifest as unavailable", async () => {
    const { sources, files } = harness();
    const b = budget();
    const e = entry();
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await expect(sources.markCatalogReady("PRJ-0002", "WORKING", 0, b)).resolves.toBe(true);
    const manifestPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    const manifest = JSON.parse(files.get(manifestPath)!);
    const shard = manifest.shards[0] as number;
    const path = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/${shard.toString(16).padStart(2, "0")}.json`;
    files.delete(path);

    await sources.recordVerifiedCatalogTombstone("PRJ-0002", "WORKING", e.resource_id, "source:0", b);
    expect(JSON.parse(files.get(manifestPath)!).shards).toContain(shard);
    await expect(sources.readCompactCatalogShard("PRJ-0002", "WORKING", shard, 0, b)).rejects.toThrow("navigation_compact_catalog_missing");
  });

  it("rebuilds a missing compact shard from a frozen verified snapshot and publishes the manifest last", async () => {
    const { sources, files, runtime } = harness();
    const b = budget(3000);
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT01", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT01", 0, b);
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const identity = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    expect(identity).not.toBeNull();
    const shard = (await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))!.shards[0];
    const manifestPath = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/ready.json`;
    const chunkPath = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/${shard.toString(16).padStart(2, "0")}.json`;
    const manifestRevisionBefore = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    files.delete(chunkPath);

    const started = await sources.beginCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!
    }, b);
    const invalidated = await sources.invalidateCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!
    }, b);
    expect((await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))?.ready_generation).toBeNull();
    await sources.stageCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      snapshot_id: started.snapshot_id, shard, entries: [e]
    }, b);
    await expect(sources.readCompactCatalogShard("PRJ-0002", "WORKING", shard, 0, b)).rejects.toThrow("navigation_compact_catalog_missing");

    const evidence = await sources.publishCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard
    }, b);
    await sources.verifyCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard, evidence
    }, b);
    const published = await sources.publishCompactCatalogRebuildManifest({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, chunk_evidence: [evidence]
    }, b);

    expect(published.ready_generation).toBe(0);
    expect(await sources.readCompactCatalogShard("PRJ-0002", "WORKING", shard, 0, b)).toEqual([e]);
    expect(published.identity.revision_token).not.toBe(manifestRevisionBefore!.revision_token);
    expect(JSON.parse(files.get(manifestPath)!).shards).toEqual([shard]);
    await expect(sources.recordVerifiedCatalogEntry({ ...e, version: "VER-REBUILD-FENCED-WRITE" }, "source:0", b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    await expect(sources.verifyPublishedCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id,
      shards: [shard], invalidated_manifest: invalidated, shard, evidence
    }, b)).resolves.toBeUndefined();
    const publishedChunk = files.get(chunkPath)!;
    files.set(chunkPath, "{}");
    await expect(sources.verifyPublishedCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id,
      shards: [shard], invalidated_manifest: invalidated, shard, evidence
    }, b)).rejects.toThrow("navigation_catalog_rebuild_chunk_postcheck_failed");
    files.set(chunkPath, publishedChunk);
    // Simulates restart after the final manifest CAS but before the immutable
    // certificate/progress write: the exact verified publication is replayable.
    await expect(sources.publishCompactCatalogRebuildManifest({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, chunk_evidence: [evidence]
    }, b)).resolves.toMatchObject({ ready_generation: 0, identity: published.identity });
    await expect(sources.recordVerifiedCatalogEntry({ ...e, version: "VER-REBUILD-FENCED-REPLAY" }, "source:0", b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");

    files.set(chunkPath, "{}");
    await expect(sources.verifyPublishedCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id,
      shards: [shard], invalidated_manifest: invalidated, shard, evidence
    }, b)).rejects.toThrow("navigation_catalog_rebuild_chunk_postcheck_failed");
    vi.spyOn(runtime.conditionalWrite!, "writeTextConditional").mockRejectedValueOnce(new Error("simulated manifest CAS failure"));
    await expect(sources.invalidateFailedPublishedCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_final_manifest: published.identity
    }, b)).resolves.toEqual({ status: "pending" });
    expect((await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))?.ready_generation).toBe(0);
    await expect(sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    const failureInvalidation = await sources.invalidateFailedPublishedCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_final_manifest: published.identity
    }, b);
    expect(failureInvalidation).toMatchObject({ status: "invalidated", identity: expect.any(Object) });
    if (failureInvalidation.status !== "invalidated") throw new Error("expected rebuild failure invalidation");
    expect(await sources.compactCatalogManifest("PRJ-0002", "WORKING", b)).toMatchObject({
      ready_generation: null, rebuilding_request_id: "DOCREQ-CATALOG-REBUILD-0001", shards: [shard]
    });
    await expect(sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    vi.spyOn(runtime.conditionalWrite!, "writeTextConditional").mockRejectedValueOnce(new Error("simulated abandon CAS failure"));
    await expect(sources.abandonFailedCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_unready_manifest: failureInvalidation.identity
    }, b)).resolves.toEqual({ status: "pending" });
    await expect(sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    const abandoned = await sources.abandonFailedCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_unready_manifest: failureInvalidation.identity
    }, b);
    expect(abandoned).toMatchObject({ status: "abandoned", identity: expect.any(Object) });
    if (abandoned.status !== "abandoned") throw new Error("expected rebuild abandonment");
    expect(await sources.compactCatalogManifest("PRJ-0002", "WORKING", b)).toMatchObject({
      ready_generation: null, rebuilding_request_id: null, rebuild_repair_required: true, shards: [shard]
    });
    await expect(sources.markCatalogReady("PRJ-0002", "WORKING", 0, b)).resolves.toBe(false);
    await expect(sources.abandonFailedCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0001",
      expected_unready_manifest: failureInvalidation.identity
    }, b)).resolves.toEqual(abandoned);
    const nextRequest = {
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0002",
      expected_generation: 0, expected_manifest: abandoned.identity
    } as const;
    await expect(sources.beginCompactCatalogRebuild(nextRequest, b)).resolves.toEqual({ snapshot_id: "source:0" });
    const nextInvalidation = await sources.invalidateCompactCatalogRebuild(nextRequest, b);
    expect(nextInvalidation.revision_token).not.toBe(abandoned.identity.revision_token);
    expect(await sources.compactCatalogManifest("PRJ-0002", "WORKING", b)).toMatchObject({
      ready_generation: null, rebuilding_request_id: nextRequest.request_id, rebuild_repair_required: true
    });
    await sources.releaseCompactCatalogRebuildFence("PRJ-0002", "WORKING", nextRequest.request_id, b);
    await sources.releaseCompactCatalogRebuildFence("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-0001", b);
  });

  it("replaces a stale existing shard only while the manifest is invalidated and CAS publishes readiness last", async () => {
    const { sources, files } = harness();
    const b = budget();
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT02", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT02", 0, b);
    const stale = { ...e, expected: { ...e.expected, revision_token: "stale-revision", content_sha256: "b".repeat(64) } };
    await sources.recordVerifiedCatalogEntry(stale, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const identity = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    const shard = (await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))!.shards[0];
    const chunkPath = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/${shard.toString(16).padStart(2, "0")}.json`;
    const started = await sources.beginCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      expected_generation: 0, expected_manifest: identity!
    }, b);
    await sources.stageCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      snapshot_id: started.snapshot_id, shard, entries: [e]
    }, b);
    const invalidated = await sources.invalidateCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      expected_generation: 0, expected_manifest: identity!
    }, b);
    const evidence = await sources.publishCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard
    }, b);
    await sources.verifyCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard, evidence
    }, b);
    expect((await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))?.ready_generation).toBeNull();
    expect(JSON.parse(files.get(chunkPath)!).entries[0].entry.expected).toEqual(e.expected);
    await sources.publishCompactCatalogRebuildManifest({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0003",
      expected_generation: 0, expected_manifest: identity!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, chunk_evidence: [evidence]
    }, b);
    expect((await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))?.ready_generation).toBe(0);
  });

  it("replays a post-CAS publication with more than eight shards within a bounded slice", async () => {
    const { sources, files } = harness();
    const wide = budget(10000);
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT03", 0, wide);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT03", 0, wide);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, wide);
    const byShard = new Map<number, NavigationInventoryEntry>();
    for (let i = 0; byShard.size < 9 && i < 10000; i++) {
      const candidate = entry();
      candidate.resource_id = `head:rebuild-fixture-${i}`;
      candidate.version = `VER-rebuild-fixture-${i}`;
      const shard = zoneNavigationCatalogShardForResource(candidate.resource_id);
      if (!byShard.has(shard)) byShard.set(shard, candidate);
    }
    expect(byShard.size).toBe(9);
    for (const item of byShard.values()) await sources.recordVerifiedCatalogEntry(item, "source:0", wide);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, wide);
    const expectedManifest = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", wide);
    const shards = [...byShard.keys()].sort((a, b) => a - b);
    const requestId = "DOCREQ-CATALOG-REBUILD-WIDE01";
    const started = await sources.beginCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expectedManifest! }, wide);
    for (const [shard, item] of byShard) await sources.stageCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, snapshot_id: started.snapshot_id, shard, entries: [item] }, wide);
    const invalidated = await sources.invalidateCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expectedManifest! }, wide);
    const evidence = [];
    for (const shard of shards) {
      const itemEvidence = await sources.publishCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expectedManifest!, snapshot_id: started.snapshot_id, shards, invalidated_manifest: invalidated, shard }, wide);
      await sources.verifyCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expectedManifest!, snapshot_id: started.snapshot_id, shards, invalidated_manifest: invalidated, shard, evidence: itemEvidence }, wide);
      evidence.push(itemEvidence);
    }
    const published = await sources.publishCompactCatalogRebuildManifest({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_manifest: expectedManifest!, expected_generation: 0, snapshot_id: started.snapshot_id, shards, invalidated_manifest: invalidated, chunk_evidence: evidence }, wide);

    // Crash after manifest CAS but before certificate/progress. A changed live
    // chunk must be caught by the engine's durable per-shard replay cursor.
    const changedShard = shards[0]!;
    const changedPath = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/${changedShard.toString(16).padStart(2, "0")}.json`;
    const unchangedChunk = (files.get(changedPath))!;
    files.set(changedPath, "{}");
    await expect(sources.verifyPublishedCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0,
      expected_manifest: expectedManifest!, snapshot_id: started.snapshot_id, shards,
      invalidated_manifest: invalidated, shard: changedShard,
      evidence: evidence.find((item) => item.shard === changedShard)!
    }, wide)).rejects.toThrow("navigation_catalog_rebuild_chunk_postcheck_failed");
    files.set(changedPath, unchangedChunk);
    for (const itemEvidence of evidence) {
      await sources.verifyPublishedCompactCatalogRebuildShard({
        project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0,
        expected_manifest: expectedManifest!, snapshot_id: started.snapshot_id, shards,
        invalidated_manifest: invalidated, shard: itemEvidence.shard, evidence: itemEvidence
      }, wide);
    }

    await expect(sources.publishCompactCatalogRebuildManifest({
      project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0,
      expected_manifest: expectedManifest!, snapshot_id: started.snapshot_id, shards, invalidated_manifest: invalidated, chunk_evidence: evidence
    }, budget(32))).resolves.toMatchObject({ ready_generation: 0, shards, identity: published.identity });
    await expect(sources.recordVerifiedCatalogEntry({ ...byShard.values().next().value!, version: "VER-REBUILD-FENCED-WRITE" }, "source:0", wide))
      .rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    await sources.releaseCompactCatalogRebuildFence("PRJ-0002", "WORKING", requestId, wide);
  });

  it("does not let a rebuild steal another request's source-writer fence", async () => {
    const { sources } = harness();
    const b = budget();
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT-FENCE", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT-FENCE", 0, b);
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const expected = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    await sources.beginCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-OWNER01", expected_generation: 0, expected_manifest: expected! }, b);
    await sources.invalidateCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-OWNER01", expected_generation: 0, expected_manifest: expected! }, b);
    await expect(sources.acquireCompactCatalogRebuildFence({ project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-OWNER02", expected_generation: 0, expected_manifest: expected! }, b)).resolves.toBe(false);
    await expect(sources.recordVerifiedCatalogEntry(e, "source:0", b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
  });

  it("fences source and compact-cache writers between final evidence verification and manifest CAS", async () => {
    const { sources, pauseNextCatalogWrite } = harness();
    const b = budget(2000);
    const requestId = "DOCREQ-CATALOG-REBUILD-FENCE01";
    const writeResource = "head:DOC-0123456789ABCDEF01234567";
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT04", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT04", 0, b);
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-FENCEADOPT", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-FENCEADOPT", 0, b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const expected = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    const shard = zoneNavigationCatalogShardForResource(e.resource_id);
    const started = await sources.beginCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expected! }, b);
    await sources.stageCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, snapshot_id: started.snapshot_id, shard, entries: [e] }, b);
    const invalidated = await sources.invalidateCompactCatalogRebuild({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expected! }, b);
    const evidence = await sources.publishCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expected!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard }, b);
    await sources.verifyCompactCatalogRebuildShard({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expected!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard, evidence }, b);

    const pause = pauseNextCatalogWrite();
    const publishing = sources.publishCompactCatalogRebuildManifest({ project_id: "PRJ-0002", zone: "WORKING", request_id: requestId, expected_generation: 0, expected_manifest: expected!, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, chunk_evidence: [evidence] }, b);
    await pause.entered;
    await expect(sources.beginHeadWrite("PRJ-0002", "WORKING", writeResource, b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    await expect(sources.recordVerifiedCatalogEntry(e, "source:0", b)).rejects.toThrow("navigation_catalog_rebuild_writer_fenced");
    expect((await sources.listDirtyPage("PRJ-0002", "WORKING", null, 1, b)).resource_ids).toEqual([]);
    pause.release();
    await expect(publishing).resolves.toMatchObject({ ready_generation: 0, shards: [shard] });
    await sources.releaseCompactCatalogRebuildFence("PRJ-0002", "WORKING", requestId, b);

    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", writeResource, b);
    expect(ticket?.generation).toBe(1);
    await sources.completeHeadWrite(ticket, e, b);
    expect((await sources.listDirtyPage("PRJ-0002", "WORKING", null, 1, b)).resource_ids).toContain(writeResource);
  });

  it("forces a pre-fence compact writer token stale before final rebuild publication", async () => {
    const { sources, pauseNextCatalogWrite } = harness();
    const b = budget(2000);
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT-PERMIT", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT-PERMIT", 0, b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const expected = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    const requestId = "DOCREQ-CATALOG-REBUILD-PERMIT1";
    const request = { project_id: "PRJ-0002", zone: "WORKING" as const, request_id: requestId, expected_generation: 0, expected_manifest: expected! };
    const started = await sources.beginCompactCatalogRebuild(request, b);
    const shard = zoneNavigationCatalogShardForResource(e.resource_id);
    await sources.stageCompactCatalogRebuildShard({ ...request, snapshot_id: started.snapshot_id, shard, entries: [e] }, b);
    const changed = { ...e, version: "VER-CATALOG-WRITER-CHANGED", expected: { ...e.expected, revision_token: "rev-new", content_sha256: "b".repeat(64) } };
    const gate = pauseNextCatalogWrite();
    const writing = sources.recordVerifiedCatalogEntry(changed, "source:0", b);
    await gate.entered;
    const invalidated = await sources.invalidateCompactCatalogRebuild(request, b);
    const evidence = await sources.publishCompactCatalogRebuildShard({ ...request, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard }, b);
    await sources.verifyCompactCatalogRebuildShard({ ...request, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, shard, evidence }, b);
    gate.release();
    await expect(writing).rejects.toThrow("precondition_failed");
    await expect(sources.publishCompactCatalogRebuildManifest({ ...request, snapshot_id: started.snapshot_id, shards: [shard], invalidated_manifest: invalidated, chunk_evidence: [evidence] }, b))
      .resolves.toMatchObject({ ready_generation: 0, shards: [shard] });
  });

  it("refuses compact catalog publication when the source generation changed after staging", async () => {
    const { sources } = harness();
    const b = budget();
    const e = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT1", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-CATALOG-REBUILD-ADOPT1", 0, b);
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const identity = await sources.compactCatalogManifestIdentity("PRJ-0002", "WORKING", b);
    const shard = (await sources.compactCatalogManifest("PRJ-0002", "WORKING", b))!.shards[0];
    const started = await sources.beginCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0002",
      expected_generation: 0, expected_manifest: identity!
    }, b);
    await sources.stageCompactCatalogRebuildShard({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0002",
      snapshot_id: started.snapshot_id, shard, entries: [e]
    }, b);
    await sources.beginHeadWrite("PRJ-0002", "WORKING", e.resource_id, b);

    await expect(sources.invalidateCompactCatalogRebuild({
      project_id: "PRJ-0002", zone: "WORKING", request_id: "DOCREQ-CATALOG-REBUILD-0002",
      expected_generation: 0, expected_manifest: identity!
    }, b)).rejects.toThrow("navigation_catalog_rebuild_snapshot_stale");
  });

  it("does not add a compact shard for a tombstone with no compact entry", async () => {
    const { sources, files } = harness();
    const b = budget();
    await expect(sources.markCatalogReady("PRJ-0002", "WORKING", 0, b)).resolves.toBe(true);

    await sources.writeCatalogEntry(null, "PRJ-0002", "WORKING", entry().resource_id, b, 0);

    const manifestPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    expect(JSON.parse(files.get(manifestPath)!).shards).toEqual([]);
    expect([...files.keys()].filter((path) => /\/compact\/[0-9a-f]{2}\.json$/.test(path))).toEqual([]);
  });

  it("rejects compact entries whose persisted identity hash no longer matches", async () => {
    const { sources, files } = harness();
    const b = budget();
    const e = entry();
    await sources.recordVerifiedCatalogEntry(e, "source:0", b);
    const manifestPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    const manifest = JSON.parse(files.get(manifestPath)!);
    const shard = manifest.shards[0] as number;
    const path = `${zoneNavigationCatalogRoot("PRJ-0002", "WORKING")}/compact/${shard.toString(16).padStart(2, "0")}.json`;
    const chunk = JSON.parse(files.get(path)!);
    chunk.entries[0].entry.expected.revision_token = "tampered";
    files.set(path, JSON.stringify(chunk));

    await expect(sources.readCompactCatalogShard("PRJ-0002", "WORKING", shard, 0, b)).rejects.toThrow("navigation_compact_catalog_proof_invalid");
  });

  it("does not bless a compact catalog across a generation consumed by a legacy writer", async () => {
    const { sources, files } = harness();
    const b = budget();
    const original = entry();
    const requestId = "DOCREQ-NAVIGATION-WORKING-0001";
    await sources.beginAdoption("PRJ-0002", "WORKING", requestId, 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", requestId, 0, b);
    await sources.recordVerifiedCatalogEntry(original, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);

    const oldTicket = await sources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    const legacyChanged = { ...original, version: "VER-2123456789ABCDEF01234567", expected: { ...original.expected, revision_token: "legacy-new", content_sha256: "b".repeat(64) } };
    await sources.completeHeadWrite(oldTicket, legacyChanged, b);
    const legacyDirty = [...files.keys()].find((path) => path.startsWith(`${zoneNavigationDirtyRoot("PRJ-0002", "WORKING")}/`))!;
    files.delete(legacyDirty); // Simulate an older runtime consuming its marker without compact-catalog support.

    const next = { ...original, resource_id: "head:DOC-1123456789ABCDEF01234567", version: "VER-1123456789ABCDEF01234567" };
    const newTicket = await sources.beginHeadWrite("PRJ-0002", "WORKING", next.resource_id, b);
    await sources.completeHeadWrite(newTicket, next, b);
    await sources.writeCatalogEntry(next, "PRJ-0002", "WORKING", next.resource_id, b, 2);
    expect(await sources.finishDirty("PRJ-0002", "WORKING", next.resource_id, next, b)).toBe(true);

    const readyPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    expect(JSON.parse(files.get(readyPath)!).ready_generation).toBe(0);
  });

  it("advances compact readiness across a batch of two independently verified dirty generations", async () => {
    const { sources, files } = harness();
    const b = budget();
    const first = entry();
    const second = { ...first, resource_id: "head:DOC-1123456789ABCDEF01234567", version: "VER-1123456789ABCDEF01234567" };
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    for (const initial of [first, second]) await sources.recordVerifiedCatalogEntry(initial, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);

    const changedEntries = [] as { entry: NavigationInventoryEntry; generation: number }[];
    for (const initial of [first, second]) {
      const changed = { ...initial, version: `${initial.version}-NEXT`, expected: { ...initial.expected, revision_token: `${initial.expected.revision_token}-next`, content_sha256: "b".repeat(64) } };
      const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", initial.resource_id, b);
      await sources.completeHeadWrite(ticket, changed, b);
      await sources.writeCatalogEntry(changed, "PRJ-0002", "WORKING", changed.resource_id, b, ticket!.generation);
      changedEntries.push({ entry: changed, generation: ticket!.generation });
    }
    for (const { entry: changed } of changedEntries) {
      expect(await sources.finishDirty("PRJ-0002", "WORKING", changed.resource_id, changed, b)).toBe(true);
    }

    const readyPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    expect(JSON.parse(files.get(readyPath)!).ready_generation).toBe(2);
  });

  it("covers coalesced updates to one resource when recording its latest dirty proof", async () => {
    const { sources, files } = harness();
    const b = budget();
    const original = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.recordVerifiedCatalogEntry(original, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);

    const first = { ...original, version: "VER-1123456789ABCDEF01234567", expected: { ...original.expected, revision_token: "rev-first", content_sha256: "b".repeat(64) } };
    const firstTicket = await sources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    await sources.completeHeadWrite(firstTicket, first, b);
    const latest = { ...first, version: "VER-2123456789ABCDEF01234567", expected: { ...first.expected, revision_token: "rev-latest", content_sha256: "c".repeat(64) } };
    const latestTicket = await sources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    await sources.completeHeadWrite(latestTicket, latest, b);
    await sources.writeCatalogEntry(latest, "PRJ-0002", "WORKING", latest.resource_id, b, latestTicket!.generation);
    expect(await sources.finishDirty("PRJ-0002", "WORKING", latest.resource_id, latest, b)).toBe(true);

    const readyPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    expect(JSON.parse(files.get(readyPath)!).ready_generation).toBe(2);
  });

  it("replays a durably acknowledged generation after interruption before dirty-marker deletion", async () => {
    const { sources, files, failNextDirtyDelete } = harness();
    const b = budget();
    const original = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.recordVerifiedCatalogEntry(original, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const changed = { ...original, version: "VER-1123456789ABCDEF01234567", expected: { ...original.expected, revision_token: "rev-next", content_sha256: "b".repeat(64) } };
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    await sources.completeHeadWrite(ticket, changed, b);
    await sources.writeCatalogEntry(changed, "PRJ-0002", "WORKING", changed.resource_id, b, ticket!.generation);
    failNextDirtyDelete();

    await expect(sources.finishDirty("PRJ-0002", "WORKING", changed.resource_id, changed, b)).rejects.toThrow("simulated dirty-clear interruption");
    const readyPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    expect(JSON.parse(files.get(readyPath)!).completed_generations).toEqual([{ start: 1, end: 1 }]);
    expect([...files.keys()].some((path) => path.startsWith(`${zoneNavigationDirtyRoot("PRJ-0002", "WORKING")}/`))).toBe(true);

    expect(await sources.finishDirty("PRJ-0002", "WORKING", changed.resource_id, changed, b)).toBe(true);
    expect(JSON.parse(files.get(readyPath)!).ready_generation).toBe(1);
    expect(JSON.parse(files.get(readyPath)!).completed_generations).toEqual([]);
  });

  it("invalidates compact readiness instead of stranding dirty cleanup when generation acknowledgements overflow", async () => {
    const { sources, files } = harness();
    const b = budget();
    const original = entry();
    await sources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await sources.recordVerifiedCatalogEntry(original, "source:0", b);
    await sources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const readyPath = [...files.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    const manifest = JSON.parse(files.get(readyPath)!);
    manifest.completed_generations = Array.from({ length: 64 }, (_, index) => ({ start: index * 2 + 3, end: index * 2 + 3 }));
    files.set(readyPath, JSON.stringify(manifest));

    const changed = { ...original, version: "VER-1123456789ABCDEF01234567", expected: { ...original.expected, revision_token: "rev-next", content_sha256: "b".repeat(64) } };
    const ticket = await sources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    await sources.completeHeadWrite(ticket, changed, b);
    await sources.writeCatalogEntry(changed, "PRJ-0002", "WORKING", changed.resource_id, b, ticket!.generation);

    await expect(sources.finishDirty("PRJ-0002", "WORKING", changed.resource_id, changed, b)).resolves.toBe(true);
    expect(JSON.parse(files.get(readyPath)!).ready_generation).toBeNull();
    expect([...files.keys()].some((path) => path.startsWith(`${zoneNavigationDirtyRoot("PRJ-0002", "WORKING")}/`))).toBe(false);

    const coalesced = harness();
    const coalescedSources = coalesced.sources;
    const coalescedFiles = coalesced.files;
    await coalescedSources.beginAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await coalescedSources.finishAdoption("PRJ-0002", "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0, b);
    await coalescedSources.recordVerifiedCatalogEntry(original, "source:0", b);
    await coalescedSources.markCatalogReady("PRJ-0002", "WORKING", 0, b);
    const firstTicket = await coalescedSources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    const firstChange = { ...original, version: "VER-1123456789ABCDEF01234567", expected: { ...original.expected, revision_token: "rev-one", content_sha256: "b".repeat(64) } };
    await coalescedSources.completeHeadWrite(firstTicket, firstChange, b);
    const coalescedReadyPath = [...coalescedFiles.keys()].find((path) => path.endsWith("/compact/ready.json"))!;
    const coalescedManifest = JSON.parse(coalescedFiles.get(coalescedReadyPath)!);
    coalescedManifest.coalesced_dirty = [{ resource_id: original.resource_id, latest_generation: 1, covered_generations: Array.from({ length: 64 }, (_, index) => ({ start: index * 2 + 3, end: index * 2 + 3 })) }];
    coalescedFiles.set(coalescedReadyPath, JSON.stringify(coalescedManifest));
    const secondTicket = await coalescedSources.beginHeadWrite("PRJ-0002", "WORKING", original.resource_id, b);
    const secondChange = { ...firstChange, version: "VER-2123456789ABCDEF01234567", expected: { ...firstChange.expected, revision_token: "rev-two", content_sha256: "c".repeat(64) } };
    await expect(coalescedSources.completeHeadWrite(secondTicket, secondChange, b)).resolves.toBeUndefined();
    expect(JSON.parse(coalescedFiles.get(coalescedReadyPath)!).ready_generation).toBeNull();
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

  it("rejects a foreign owner before changing an owned repair source fence", async () => {
    const { sources } = harness();
    const resourceId = entry().resource_id;
    const ownerA = "a".repeat(64), ownerB = "b".repeat(64);
    const owned = await sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, undefined, null, true, ownerA);
    expect(owned?.owner_hash).toBe(ownerA);
    await expect(sources.beginHeadWrite("PRJ-0002", "WORKING", resourceId, undefined, null, true, ownerB))
      .rejects.toThrow("navigation_source_owner_conflict");
    expect(await sources.readOwnedHeadWrite("PRJ-0002", "WORKING", resourceId, ownerA)).toEqual(owned);
    expect(await sources.readState("PRJ-0002", "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [resourceId] });
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
