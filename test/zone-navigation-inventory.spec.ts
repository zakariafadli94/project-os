import { describe, expect, it } from "vitest";
import type { SliceBudget } from "../src/convergence/contract";
import type { NavigationInventoryEntry } from "../src/domain/zone-navigation";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "../src/documents/zone-navigation-sources";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentTextPayloadPath, machineDocumentVersionPath, workspaceProjectRoot } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { canonicalJson } from "../src/rules/contract";
import { packageRuntime } from "./helpers/package-runtime";
import { packageNavigationPath } from "../src/domain/document-package";
import { machineArtifactReceiptPath } from "../src/persistence/layout";
import { mutationIntentIdFor } from "../src/domain/mutation-gate";
import { MutationGateRepository } from "../src/mutation-gate/repository";

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

describe("ZoneNavigationInventory", () => {
  it("enumerates only current canonical zone heads from a bounded provider page", async () => {
    const h = harness();
    const visiblePath = await addWorkingHead(h, "current body");

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    expect(h.pageLimits.every((limit) => limit <= 8)).toBe(true);
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
    expect(h.pageLimits.every((limit) => limit <= 8)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(1);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.resource_id)).size).toBe(3);
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
    expect(h.pageLimits.every((limit) => limit <= 8)).toBe(true);
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

  it("defers an active head when its proof budget is short, then resumes the exact source", async () => {
    const h = harness();
    await addWorkingHead(h, "active body");
    const short = budget(15);
    const deferred = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: short });
    expect(deferred.entries).toEqual([]);
    expect(deferred.next_cursor?.startsWith("initial:")).toBe(true);
    expect(short.calls_left).toBeGreaterThanOrEqual(0);
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: deferred.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries.map((entry) => entry.resource_id)).toEqual([`head:${documentId}`]);
    expect(resumed.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
    expect(await h.inventory.verifyEntry(resumed.entries[0], budget(12))).toBe(true);
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
    await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });
    expect(JSON.parse(h.files.get(catalogPath)!.content).entry).toBeNull();
    expect(stale).toBe(visiblePath);
  });

  it("includes only a finalized current package index as a bounded canonical source", async () => {
    const store = packageRuntime();
    const runtime = store.runtime;
    const repository = new DocumentLedgerRepository(runtime);
    const state = emptyProjectState("PRJ-9300", "Packages", "packages");
    const body = "package member";
    const content_sha256 = await sha256Text(body);
    const document_id = `DOC-${"1".repeat(24)}`;
    const document_version_id = `VER-REQ-${"1".repeat(24)}`;
    const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, body);
    await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: "member.md", source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: body.length });
    const body2 = "second package member";
    const content_sha256_2 = await sha256Text(body2);
    const document_id_2 = `DOC-${"2".repeat(24)}`;
    const document_version_id_2 = `VER-REQ-${"2".repeat(24)}`;
    const immutable_payload_path_2 = await repository.storeTextPayload(state.project_id, content_sha256_2, body2);
    await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id: document_id_2, version_id: document_version_id_2, kind: "work_product", stage: "working", logical_path: "second.md", source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path: immutable_payload_path_2, content_sha256: content_sha256_2, size: body2.length });
    const manifest = { schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members: [
      { relative_path: "member.md", document_id, document_version_id, immutable_payload_path, content_sha256, size: body.length },
      { relative_path: "second.md", document_id: document_id_2, document_version_id: document_version_id_2, immutable_payload_path: immutable_payload_path_2, content_sha256: content_sha256_2, size: body2.length }
    ], links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
    const ref = await repository.freezePackage(manifest);
    const request = { operation: "package.replace" as const, request_id: "DOCREQ-REPLACE-0001", project_id: state.project_id, candidate: ref, zone: "WORKING" as const, expected_navigation_generation: 0, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
    const admission = { project_id: state.project_id, operation: "package.replace", kind: "document", request_id: request.request_id, request_hash: await sha256Text(canonicalJson(request)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: ref.package_id, resource_type: "package", zone: "WORKING", version: `${ref.version}:${ref.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    const result = await new ManagedDocumentService(runtime).replacePackage(request, state, admission as never);
    expect(result.status).toBe("finalized");
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
    expect(pages).toHaveLength(4);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `package:${ref.package_id}`, logical_path: `PACKAGES/${ref.package_id}/1/INDEX.md`, version: `1:${ref.manifest_sha256}` });
    expect(await inventory.verifyEntry(entries[0], budget())).toBe(true);
    expect(pages.flatMap((page) => page.gaps)).not.toContainEqual(expect.objectContaining({ resource_id: "packages" }));

    await sources.beginAdoption(state.project_id, "WORKING", "NAV-ADOPT-PACKAGE-1", 0, budget());
    expect(await sources.finishAdoption(state.project_id, "WORKING", "NAV-ADOPT-PACKAGE-1", 0, budget())).toBe(true);
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
    expect(permanentResult.next_cursor).toBeNull();
    expect(await inventory.verifySnapshot({ project_id: state.project_id, zone: "WORKING", snapshot_id: permanentStart.snapshot_id, budget: budget() })).toBe(false);
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
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `artifact:${await sha256Text(destination)}`, version: `ART-NAVIGATION-001:${await sha256Text("approved artifact")}`, logical_path: "report.md", path: destination });
    expect(await h.inventory.verifyEntry(entries[0], budget())).toBe(true);
  });

  it("does not choose by timestamp when multiple committed receipts prove identical destination bytes", async () => {
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

    expect(pages.flatMap((page) => page.entries)).toEqual([]);
    expect(pages.flatMap((page) => page.gaps)).toContainEqual(expect.objectContaining({
      resource_id: `artifact:${await sha256Text(destination)}`, code: "artifact_destination_ambiguous"
    }));
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
    expect(pages.flatMap((page) => page.gaps)).toContainEqual(expect.objectContaining({ code: "artifact_destination_outside_navigation_zones" }));
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
