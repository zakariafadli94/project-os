import { describe, expect, it } from "vitest";
import type { SliceBudget } from "../src/convergence/contract";
import type { NavigationInventoryEntry } from "../src/domain/zone-navigation";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "../src/documents/zone-navigation-sources";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentTextPayloadPath, machineDocumentVersionPath, workspaceProjectRoot } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";

const projectId = "PRJ-0002";
const documentId = "DOC-0123456789ABCDEF01234567";
const versionId = "VER-REQ-0123456789ABCDEF01234567";
const slug = "project-os";

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
        const error = readErrors.get(path);
        if (error) throw error;
        if (missingOnRead.has(path)) return null;
        return files.get(path)?.content ?? null;
      },
      readBytes: async (path, maxBytes) => {
        const file = files.get(path);
        if (!file) return null;
        const bytes = new TextEncoder().encode(file.content);
        return bytes.length > maxBytes ? null : bytes;
      },
      createText: async (path, content) => { if (files.has(path)) throw new Error("exists"); put(path, content); },
      upsertText: async (path, content) => put(path, content),
      getMetadata: async (path) => metadata(path),
      listChildren: async () => [],
      move: async () => {},
      delete: async (path) => { files.delete(path); },
      deleteIfUnchanged: async (path, expected) => {
        const current = metadata(path);
        if (!current) return "missing";
        if (current.objectId !== expected.objectId || current.revisionToken !== expected.revisionToken) return "changed";
        files.delete(path);
        return "deleted";
      }
    },
    conditionalWrite: { writeTextConditional: async (path, content) => { put(path, content); return metadata(path)!; } },
    serverSideCopy: { copyObject: async () => ({ path: "", objectId: "", revisionToken: "", size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "" }) },
    pagedListing: { listPage: async ({ path, cursor, limit }) => {
      pageLimits.push(limit);
      pagePaths.push(path);
      const matching = [...files.keys()].filter((key) => key.startsWith(`${path}/`)).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } },
    evidence: { stableObjectId: { semantics: "stable-through-move" }, revisionToken: { semantics: "opaque-object-revision" }, integrityHash: { semantics: "identified-algorithm" } }
  };
  const sources = new ZoneNavigationSources(runtime);
  return { runtime, files, pageLimits, pagePaths, missingOnRead, readErrors, put, sources, inventory: new ZoneNavigationInventory(runtime, sources) };
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

describe("ZoneNavigationInventory", () => {
  it("enumerates only current canonical zone heads with a provider page size of one", async () => {
    const h = harness();
    const visiblePath = await addWorkingHead(h, "current body");

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    expect(h.pageLimits.every((limit) => limit === 1)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(1);
    expect(page.snapshot_id).toBe("source:0");
    expect(page.next_cursor).toBeNull();
    expect(page.gaps).toEqual(expect.arrayContaining([
      { resource_id: "packages", code: "finalized_package_inventory_unavailable" },
      { resource_id: "artifacts", code: "committed_artifact_inventory_unavailable" }
    ]));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject<Partial<NavigationInventoryEntry>>({
      project_id: projectId, zone: "WORKING", resource_id: `head:${documentId}`, version: versionId,
      logical_path: "draft.md", path: visiblePath,
      expected: { object_id: "id:visible", revision_token: "rev-visible", content_sha256: await sha256Text("current body"), size: 12 }
    });
    expect(page.entries[0].expected.content_sha256).toBe(await sha256Text("current body"));
  });

  it("persists opaque head-page cursors and never asks the provider for more than one item", async () => {
    const h = harness();
    await addWorkingHead(h, "first body");
    const secondId = "DOC-1123456789ABCDEF01234567";
    const secondVersion = "VER-REQ-1123456789ABCDEF01234567";
    await addWorkingHead(h, "second body", "rev-second", secondId, secondVersion, "second.md");

    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    const second = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget() });

    expect(first.entries).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    expect(second.entries).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(h.pageLimits.every((limit) => limit === 1)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(2);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.resource_id)).size).toBe(2);
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

    const updated = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    expect(h.pagePaths.slice(pathsBeforeDelta)).not.toContain(headListingPath);
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].expected.content_sha256).toBe(await sha256Text("new body"));
    expect(updated.entries[0].expected.content_sha256).not.toBe(original.expected.content_sha256);
    expect(await h.inventory.verifySnapshot({ project_id: projectId, zone: "WORKING", snapshot_id: "source:1", budget: budget() })).toBe(true);
  });

  it("keeps visible gaps for canonical source families without a verifiable resolver", async () => {
    const h = harness();

    const page = await h.inventory.listPage({ project_id: projectId, zone: "DELIVERABLES", cursor: null, limit: 8, budget: budget() });

    expect(page.gaps).toEqual(expect.arrayContaining([
      { resource_id: "packages", code: expect.any(String) },
      { resource_id: "artifacts", code: expect.any(String) }
    ]));
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
