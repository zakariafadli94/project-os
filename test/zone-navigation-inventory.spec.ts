import { describe, expect, it, vi } from "vitest";
import type { SliceBudget } from "../src/convergence/contract";
import type { ExecutionAdmission } from "../src/execution/contract";
import { navigationReconcileSchema, type NavigationInventoryEntry, type NavigationInventoryPort } from "../src/domain/zone-navigation";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources, zoneNavigationCatalogRoot } from "../src/documents/zone-navigation-sources";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentTextPayloadPath, machineDocumentVersionPath, machineStatePath, workspaceProjectRoot } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { canonicalJson } from "../src/rules/contract";
import { packageRuntime } from "./helpers/package-runtime";
import { packageNavigationPath } from "../src/domain/document-package";
import { machineArtifactReceiptPath, machineMutationIntentPath } from "../src/persistence/layout";
import { mutationIntentIdFor } from "../src/domain/mutation-gate";
import { MutationGateRepository } from "../src/mutation-gate/repository";

const projectId = "PRJ-0002";
const documentId = "DOC-0123456789ABCDEF01234567";
const versionId = "VER-REQ-0123456789ABCDEF01234567";
const slug = "project-os";

describe("compact catalog adoption gate", () => {
  it("does not resume a saved compact cursor from an unadopted source state", async () => {
    const h = harness();
    const staleCompactEntry: NavigationInventoryEntry = {
      project_id: projectId, zone: "WORKING", resource_id: "head:DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      version: "VER-STALE-COMPACT", logical_path: "stale.md", path: "/stale.md",
      expected: { object_id: "id:stale", revision_token: "rev:stale", content_sha256: "a".repeat(64), size: 5 }
    };
    await h.sources.recordVerifiedCatalogEntry(staleCompactEntry, "source:0", budget(2000));
    await h.sources.markCatalogReady(projectId, "WORKING", 0, budget(2000));

    const page = await h.inventory.listPage({
      project_id: projectId, zone: "WORKING", cursor: "catalog-compact:0", limit: 8, budget: budget(2000)
    });

    expect(page.entries).toEqual([]);
    expect(typeof page.next_cursor === "string" && page.next_cursor.startsWith("catalog-compact:")).toBe(false);
    expect(h.pagePaths).toContain(zoneNavigationCatalogRoot(projectId, "WORKING"));
  });
});

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
  let providerCalls = 0;
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
        providerCalls += 1;
        const error = readErrors.get(path);
        if (error) throw error;
        if (missingOnRead.has(path)) return null;
        return files.get(path)?.content ?? null;
      },
      readBytes: async (path, maxBytes) => {
        providerCalls += 1;
        const file = files.get(path);
        if (!file) return null;
        const bytes = new TextEncoder().encode(file.content);
        return bytes.length > maxBytes ? null : bytes;
      },
      createText: async (path, content) => { providerCalls += 1; if (files.has(path)) throw new Error("exists"); put(path, content); },
      upsertText: async (path, content) => { providerCalls += 1; put(path, content); },
      getMetadata: async (path) => { providerCalls += 1; return metadata(path); },
      listChildren: async () => { providerCalls += 1; return []; },
      move: async () => { providerCalls += 1; },
      delete: async (path) => { providerCalls += 1; files.delete(path); },
      deleteIfUnchanged: async (path, expected) => {
        providerCalls += 1;
        const current = metadata(path);
        if (!current) return "missing";
        if (current.objectId !== expected.objectId || current.revisionToken !== expected.revisionToken) return "changed";
        files.delete(path);
        return "deleted";
      }
    },
    conditionalWrite: { writeTextConditional: async (path, content) => { providerCalls += 1; put(path, content); return metadata(path)!; } },
    serverSideCopy: { copyObject: async () => { providerCalls += 1; return { path: "", objectId: "", revisionToken: "", size: 0 }; } },
    changeFeed: { listChanges: async () => { providerCalls += 1; return { entries: [], cursor: "" }; } },
    pagedListing: { listPage: async ({ path, cursor, limit }) => {
      providerCalls += 1;
      pageLimits.push(limit);
      pagePaths.push(path);
      const matching = [...files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } },
    directoryProvisioning: { ensureDirectory: async () => { providerCalls += 1; } },
    evidence: { stableObjectId: { semantics: "stable-through-move" }, revisionToken: { semantics: "opaque-object-revision" }, integrityHash: { semantics: "identified-algorithm" } }
  };
  const sources = new ZoneNavigationSources(runtime);
  return { runtime, files, pageLimits, pagePaths, missingOnRead, readErrors, put, sources, inventory: new ZoneNavigationInventory(runtime, sources), get providerCalls() { return providerCalls; } };
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

async function seedHistoricalPublishedHead(
  h: ReturnType<typeof harness>,
  options: { currentObjectId?: string; receiptRevision?: string; providerSlug?: string } = {}
) {
  const requestId = "DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1";
  const parentVersionId = "VER-REQ-1123456789ABCDEF01234567";
  const publishedVersionId = `VER-REQ-${(await sha256Text(`${requestId}\npublished`)).slice(0, 24).toUpperCase()}`;
  const content = "historically published body";
  const contentHash = await sha256Text(content);
  const size = new TextEncoder().encode(content).byteLength;
  const workingPath = `${workspaceProjectRoot(projectId, options.providerSlug ?? slug)}/WORKING/draft.md`;
  const deliverablesPath = `${workspaceProjectRoot(projectId, options.providerSlug ?? slug)}/DELIVERABLES/draft.md`;
  const request = {
    operation: "publish", request_id: requestId, project_id: projectId, document_id: documentId,
    expected_version_id: parentVersionId, created_at: "2026-09-29T10:00:00.000Z"
  };
  const requestJson = JSON.stringify(request);
  const requestHash = await executionHash(request);

  h.put(machineStatePath(projectId), JSON.stringify(emptyProjectState(projectId, "Project OS", slug)));
  h.put(deliverablesPath, content, options.currentObjectId ?? "id:shared-published-object");
  h.files.set(deliverablesPath, { ...h.files.get(deliverablesPath)!, revision_token: "rev-published" });
  h.put(machineDocumentTextPayloadPath(projectId, contentHash), content);
  h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
    schema_version: "1.0", project_id: projectId, document_id: documentId, kind: "work_product", logical_path: "draft.md",
    published_version_id: publishedVersionId,
    provider: { published: { path: deliverablesPath, file_id: options.currentObjectId ?? "id:shared-published-object", rev: "rev-published", content_hash: contentHash, size } },
    reconciliation_status: "clean"
  }));
  h.put(machineDocumentVersionPath(projectId, documentId, parentVersionId), JSON.stringify({
    schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: parentVersionId,
    kind: "work_product", stage: "review", logical_path: "draft.md", source: "project_os",
    created_at: "2026-09-29T09:00:00.000Z", immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
    content_sha256: contentHash, provider_evidence: {
      provider_id: "test", object_id: "id:shared-published-object", revision_token: "rev-working",
      path: workingPath, integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size
    }
  }));
  h.put(machineDocumentVersionPath(projectId, documentId, publishedVersionId), JSON.stringify({
    schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: publishedVersionId,
    parent_version_id: parentVersionId, kind: "work_product", stage: "published", logical_path: "draft.md", source: "project_os",
    created_at: request.created_at, request_id: requestId, immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
    content_sha256: contentHash, provider_evidence: {
      provider_id: "test", object_id: "id:shared-published-object", revision_token: "rev-working", path: workingPath,
      integrity_hash: { algorithm: "dropbox-content-hash", value: "d".repeat(64) }, size
    }
  }));
  await new ExecutionJournal(h.runtime, projectId, "document", requestId).commit({
    project_id: projectId, request_id: requestId, kind: "document", operation: "document.publish", request_hash: requestHash,
    actor: { actor_id: "operator:test", authority: "project_guard" },
    resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: parentVersionId, expected_version: parentVersionId }],
    global_revision: 0, project_revision: 0,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 },
    verdict: "allow", results: [], gaps: [], deferred_rules: []
  } as unknown as ExecutionAdmission, null);
  h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`, JSON.stringify({
    schema_version: "1.0", project_id: projectId, request_id: requestId,
    request_sha256: await sha256Text(requestJson), request_json: requestJson
  }));
  h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`, JSON.stringify({
    schema_version: "1.0", project_id: projectId, request_id: requestId,
    request_sha256: await sha256Text(requestJson), request_json: requestJson,
    receipt_json: JSON.stringify({
      request_id: requestId, project_id: projectId, document_id: documentId, version_id: publishedVersionId,
      stage: "published", logical_path: "draft.md", status: "committed", provider_rev: options.receiptRevision ?? "rev-published"
    })
  }));
  return {
    entry: {
      project_id: projectId, zone: "DELIVERABLES" as const, resource_id: `head:${documentId}`, version: publishedVersionId,
      logical_path: "draft.md", path: deliverablesPath,
      expected: { object_id: options.currentObjectId ?? "id:shared-published-object", revision_token: "rev-published", content_sha256: contentHash, size }
    } satisfies NavigationInventoryEntry
  };
}

describe("ZoneNavigationInventory", () => {
  it("keeps snapshot completion pending when an empty dirty page has a continuation", async () => {
    const h = harness();
    const listDirtyPage = vi.spyOn(h.sources, "listDirtyPage").mockResolvedValue({ resource_ids: [], next_cursor: "opaque-next" });
    const markReady = vi.spyOn(h.sources, "markCatalogReady").mockResolvedValue(false);

    const result = await h.inventory.completeSnapshot({ project_id: projectId, zone: "REVIEW", snapshot_id: "source:0", budget: budget() });

    expect(result).toBe("pending");
    expect(listDirtyPage).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
  });

  it("enumerates only current canonical zone heads from a bounded provider page", async () => {
    const h = harness();
    const visiblePath = await addWorkingHead(h, "current body");

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget() });

    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
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

  it("accepts a REVIEW head whose exact committed promotion proves the WORKING-to-REVIEW provider move", async () => {
    const h = harness();
    const content = "promoted review body";
    const contentHash = await sha256Text(content);
    const requestId = "DOCREQ-NAV-AUTO-REVIEW-S27-R439-G1";
    const request = {
      operation: "review.promote",
      request_id: requestId,
      project_id: projectId,
      document_id: documentId,
      expected_version_id: versionId,
      created_at: "2026-09-29T10:00:00.000Z"
    };
    const requestJson = JSON.stringify(request);
    const promotedVersionId = `VER-REQ-${(await sha256Text(`${requestId}\nreview`)).slice(0, 24).toUpperCase()}`;
    const workingPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/draft.md`;
    const reviewPath = `${workspaceProjectRoot(projectId, slug)}/REVIEW/draft.md`;
    h.put(reviewPath, content, "id:shared-review-object");
    h.files.set(reviewPath, { ...h.files.get(reviewPath)!, revision_token: "rev-review" });
    h.put(machineDocumentTextPayloadPath(projectId, contentHash), content);
    const size = new TextEncoder().encode(content).byteLength;
    h.put(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: documentId, kind: "work_product", logical_path: "draft.md",
      review_version_id: promotedVersionId,
      provider: { review: { path: reviewPath, file_id: "id:shared-review-object", rev: "rev-review", content_hash: contentHash, size } },
      reconciliation_status: "clean"
    }));
    const rawVersion = JSON.stringify({
      schema_version: "2.0", project_id: projectId, document_id: documentId, version_id: promotedVersionId,
      parent_version_id: versionId, kind: "work_product", stage: "review", logical_path: "draft.md", source: "project_os",
      created_at: request.created_at, request_id: requestId, immutable_payload_path: machineDocumentTextPayloadPath(projectId, contentHash),
      content_sha256: contentHash, provider_evidence: {
        provider_id: "test", object_id: "id:shared-review-object", revision_token: "rev-working", path: workingPath,
        integrity_hash: { algorithm: "sha256", value: contentHash }, size
      }
    });
    h.put(machineDocumentVersionPath(projectId, documentId, promotedVersionId), rawVersion);
    const requestHash = await executionHash(request);
    const admission = {
      project_id: projectId, request_id: requestId, kind: "document", operation: "review.promote", request_hash: requestHash,
      actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: versionId, expected_version: versionId }],
      global_revision: 0, project_revision: 0,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    await new ExecutionJournal(h.runtime, projectId, "document", requestId).commit(admission as unknown as ExecutionAdmission, null);
    h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`, JSON.stringify({
      schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: await sha256Text(requestJson), request_json: requestJson
    }));
    h.put(`${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`, JSON.stringify({
      schema_version: "1.0", project_id: projectId, request_id: requestId,
      request_sha256: await sha256Text(requestJson), request_json: requestJson,
      receipt_json: JSON.stringify({
        request_id: requestId, project_id: projectId, document_id: documentId, version_id: promotedVersionId,
        stage: "review", logical_path: "draft.md", status: "committed", provider_rev: "rev-review"
      })
    }));
    const savedAdmission = await new ExecutionJournal(h.runtime, projectId, "document", requestId).readAdmission();
    expect(savedAdmission?.admission).toMatchObject({ operation: "review.promote", request_hash: requestHash, verdict: "allow" });
    expect(savedAdmission?.admission.resources).toContainEqual(expect.objectContaining({
      resource_id: documentId, resource_type: "document", zone: "DOCUMENTS", version: versionId, expected_version: versionId
    }));

    const entry: NavigationInventoryEntry = {
      project_id: projectId, zone: "REVIEW", resource_id: `head:${documentId}`, version: promotedVersionId,
      logical_path: "draft.md", path: reviewPath,
      expected: { object_id: "id:shared-review-object", revision_token: "rev-review", content_sha256: contentHash, size }
    };

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    const receiptPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
    const savedReceipt = JSON.parse(h.files.get(receiptPath)!.content);
    const forgedReceipt = JSON.parse(savedReceipt.receipt_json);
    forgedReceipt.provider_rev = "rev-unrelated";
    h.put(receiptPath, JSON.stringify({ ...savedReceipt, receipt_json: JSON.stringify(forgedReceipt) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);

    // Earlier committed promotions retained the exact request digest but not
    // its JSON envelope. They remain provable from the immutable version.
    const intentPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/intent.json`;
    const legacyIntent = JSON.parse(h.files.get(intentPath)!.content);
    delete legacyIntent.request_json;
    h.put(intentPath, JSON.stringify(legacyIntent));
    const legacyReceipt = { ...savedReceipt };
    delete legacyReceipt.request_json;
    h.put(receiptPath, JSON.stringify(legacyReceipt));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
    h.put(receiptPath, JSON.stringify({ ...legacyReceipt, request_sha256: "0".repeat(64) }));
    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("accepts a DELIVERABLES head only when its exact committed publication proves the provider move", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(true);
  });

  it("rejects a published version whose immutable bytes differ from its REVIEW parent", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const parentPath = machineDocumentVersionPath(projectId, documentId, "VER-REQ-1123456789ABCDEF01234567");
    const parent = JSON.parse(h.files.get(parentPath)!.content) as Record<string, unknown>;
    const unrelated = "different reviewed bytes";
    const unrelatedHash = await sha256Text(unrelated);
    h.put(machineDocumentTextPayloadPath(projectId, unrelatedHash), unrelated);
    h.put(parentPath, JSON.stringify({ ...parent,
      content_sha256: unrelatedHash,
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, unrelatedHash)
    }));

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("rejects a published move when both provider paths are outside the canonical project workspace root", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h, { providerSlug: "another-project" });

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("rejects a published move when its committed receipt binds a different provider revision", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const savedReceipt = JSON.parse(h.files.get(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1/receipt.json`)!.content);
    const receipt = JSON.parse(savedReceipt.receipt_json);
    receipt.provider_rev = "rev-unrelated";
    h.put(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1/receipt.json`, JSON.stringify({ ...savedReceipt, receipt_json: JSON.stringify(receipt) }));

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("does not accept a published move from its receipt when the execution admission is absent", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h);
    const journal = new ExecutionJournal(h.runtime, projectId, "document", "DOCREQ-NAV-AUTO-PUBLISH-S27-R439-G1");
    h.files.delete(`${await journal.root()}/admission.json`);

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("rejects an otherwise valid publication proof when the current provider object is unrelated", async () => {
    const h = harness();
    const { entry } = await seedHistoricalPublishedHead(h, { currentObjectId: "id:unrelated-object" });

    await expect(h.inventory.verifyEntry(entry, budget())).resolves.toBe(false);
  });

  it("advances past a dirty head that cannot be proven instead of emitting the same gap cursor forever", async () => {
    const h = harness();
    const firstId = documentId;
    h.put(machineDocumentHeadPath(projectId, firstId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: firstId, kind: "work_product", logical_path: "draft.md",
      review_version_id: "VER-REQ-1123456789ABCDEF01234567", provider: {}, reconciliation_status: "clean"
    }));
    vi.spyOn(h.sources, "listDirtyPage").mockResolvedValue({ resource_ids: [`head:${firstId}`], next_cursor: null });

    const page = await h.inventory.listPage({ project_id: projectId, zone: "REVIEW", cursor: "dirty:", limit: 8, budget: budget() });

    expect(page.gaps).toEqual([{ resource_id: `head:${firstId}`, code: "active_provider_binding_missing" }]);
    expect(page.next_cursor).toBe("catalog:");
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
    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
    expect(h.pagePaths.filter((path) => path === `${machineDocumentRoot(projectId)}/heads`)).toHaveLength(1);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.resource_id)).size).toBe(3);
  });

  it("resumes an older persisted empty batch cursor from its provider continuation", async () => {
    const h = harness();
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [],
      provider_cursor: "provider-cursor-27",
      listing_limit: 512
    }))}`;
    let received: { cursor: string | null; limit: number } | null = null;
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received = { cursor, limit };
      return { entries: [], cursor: "provider-cursor-28" };
    };

    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() });

    expect(received).toEqual({ cursor: "provider-cursor-27", limit: 512 });
    expect(page.next_cursor).not.toBe(saved);
    expect(page.next_cursor?.startsWith("initial:")).toBe(true);
  });

  it("rejects a provider continuation cursor that does not advance", async () => {
    const h = harness();
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [],
      provider_cursor: "provider-cursor-stuck",
      listing_limit: 512
    }))}`;
    h.runtime.pagedListing!.listPage = async ({ cursor }) => ({ entries: [], cursor });

    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() }))
      .rejects.toThrow("navigation_listing_stalled");
  });

  it("fetches the continuation after all saved batch entries have been consumed", async () => {
    const h = harness();
    const id = "DOC-3123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: id,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const saved = `initial:${encodeURIComponent(JSON.stringify({
      kind: "zone-navigation-head-batch-v1",
      entries: [{ kind: "file", name: `${id}.json`, path: machineDocumentHeadPath(projectId, id) }],
      provider_cursor: "provider-cursor-41",
      listing_limit: 512
    }))}`;
    let received: { cursor: string | null; limit: number } | null = null;
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received = { cursor, limit };
      return { entries: [], cursor: null };
    };

    const consumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: saved, limit: 8, budget: budget() });
    expect(consumed.next_cursor?.startsWith("initial:")).toBe(true);
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: consumed.next_cursor, limit: 8, budget: budget() });

    expect(received).toEqual({ cursor: "provider-cursor-41", limit: 512 });
    expect(resumed.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
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
    expect(h.pageLimits.every((limit) => limit <= 512)).toBe(true);
  });

  it("catches up a legacy limit-one artifact cursor within one bounded inventory slice", async () => {
    const h = harness();
    const cursors = ["legacy-artifact-cursor-2", "legacy-artifact-cursor-3", "legacy-artifact-cursor-4", null];
    const received: Array<{ cursor: string | null; limit: number }> = [];
    h.runtime.pagedListing!.listPage = async ({ cursor, limit }) => {
      received.push({ cursor, limit });
      return { entries: [], cursor: cursors.shift() ?? null };
    };

    const slice = budget(32);
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "artifacts:legacy-artifact-cursor-1", limit: 8, budget: slice });

    expect(received.length).toBeGreaterThan(1);
    expect(received[0]).toEqual({ cursor: "legacy-artifact-cursor-1", limit: 1 });
    expect(received.slice(1).every((call) => call.limit === 1)).toBe(true);
    expect(page.entries).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(slice.calls_left).toBeGreaterThanOrEqual(0);
  });

  it("stops a batched legacy cursor before a gap so an orphaned snapshot replays identically", async () => {
    const h = harness();
    const firstId = "ART-NAVIGATION-GAP-0001";
    const firstPath = machineMutationIntentPath(projectId, firstId);
    await seedCommittedArtifact(h, firstId, `${workspaceProjectRoot(projectId, slug)}/REVIEW/other-zone.md`, "other zone");
    h.put(`${firstPath.slice(0, firstPath.lastIndexOf("/"))}/ZZZ-BROKEN.json`, "{}");

    const first = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "artifacts:", limit: 8, budget: budget() });
    const replay = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: first.next_cursor, limit: 8, budget: budget() });

    expect(first.entries).toEqual([]);
    expect(first.gaps).toEqual([]);
    expect(first.next_cursor).toBe(`artifacts:${encodeURIComponent(firstPath)}`);
    expect(replay.gaps).toContainEqual({ resource_id: "ZZZ-BROKEN.json", code: "artifact_intent_listing_invalid" });
  });

  it("fails closed when Dropbox repeats the same listing cursor", async () => {
    const h = harness();
    h.runtime.pagedListing!.listPage = async ({ cursor }) => ({ entries: [], cursor });
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: "initial:opaque", limit: 8, budget: budget() }))
      .rejects.toThrow("navigation_listing_stalled");
  });

  it("captures a sub-512-head initial listing without a fragile continuation cursor", async () => {
    const h = harness();
    for (let index = 0; index < 9; index++) {
      const id = `DOC-${index.toString(16).toUpperCase().padStart(24, "0")}`;
      h.put(machineDocumentHeadPath(projectId, id), JSON.stringify({
        schema_version: "1.0", project_id: projectId, document_id: id,
        kind: "work_product", logical_path: `inactive-${index}.md`, reconciliation_status: "clean"
      }));
    }
    const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: null, limit: 8, budget: budget(40) });
    expect(h.pageLimits[0]).toBe(512);
    expect(page.next_cursor).toBe("packages:%7B%22package_index%22%3A0%2C%22member_index%22%3A0%7D");
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
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: deferred.next_cursor, limit: 8, budget: budget(15) })).rejects.toThrow("slice_budget_exhausted");
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
    const members = [] as { relative_path: string; document_id: string; document_version_id: string; immutable_payload_path: string; content_sha256: string; size: number }[];
    for (let index = 1; index <= 4; index += 1) {
      const suffix = index.toString(16).padStart(24, "0").toUpperCase();
      const body = `package member ${index}`;
      const content_sha256 = await sha256Text(body);
      const document_id = `DOC-${suffix}`;
      const document_version_id = `VER-REQ-${suffix}`;
      const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, body);
      const relative_path = `member-${index}.md`;
      await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: relative_path, source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: body.length });
      members.push({ relative_path, document_id, document_version_id, immutable_payload_path, content_sha256, size: body.length });
    }
    const manifest = { schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members,
      links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
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
    expect(pages).toHaveLength(6);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `package:${ref.package_id}`, logical_path: `PACKAGES/${ref.package_id}/1/INDEX.md`, version: `1:${ref.manifest_sha256}` });
    expect(await inventory.verifyEntry(entries[0], budget())).toBe(true);
    expect(pages.flatMap((page) => page.gaps)).not.toContainEqual(expect.objectContaining({ resource_id: "packages" }));

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
    expect(permanentResult.next_cursor).toBe("artifacts:");
    expect(await inventory.verifyEntry(refreshedEntries[0], budget())).toBe(false);
  });

  it("finishes legacy-page package verification for 40 members in resumable 32-call slices", async () => {
    const store = packageRuntime();
    const runtime = store.runtime;
    const repository = new DocumentLedgerRepository(runtime);
    const state = emptyProjectState("PRJ-9300", "Packages", "packages");
    const members = [] as { relative_path: string; document_id: string; document_version_id: string; immutable_payload_path: string; content_sha256: string; size: number }[];
    for (let index = 1; index <= 40; index += 1) {
      const suffix = index.toString(16).padStart(24, "0").toUpperCase();
      const body = `package member ${index}`;
      const content_sha256 = await sha256Text(body);
      const document_id = `DOC-${suffix}`;
      const document_version_id = `VER-REQ-${suffix}`;
      const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, body);
      const relative_path = `member-${index}.md`;
      await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: relative_path, source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: body.length });
      members.push({ relative_path, document_id, document_version_id, immutable_payload_path, content_sha256, size: body.length });
    }
    const ref = await repository.freezePackage({ schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members, links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" });
    const packageRequest = { operation: "package.replace" as const, request_id: "DOCREQ-REPLACE-0001", project_id: state.project_id, candidate: ref, zone: "WORKING" as const, expected_navigation_generation: 0, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
    const packageAdmission = { project_id: state.project_id, operation: "package.replace", kind: "document", request_id: packageRequest.request_id, request_hash: await sha256Text(canonicalJson(packageRequest)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: ref.package_id, resource_type: "package", zone: "WORKING", version: `${ref.version}:${ref.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    expect((await new ManagedDocumentService(runtime).replacePackage(packageRequest, state, packageAdmission as never)).status).toBe("finalized");
    runtime.pagedListing = { listPage: async ({ path, cursor, limit }) => {
      const matching = [...store.files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/" )).sort();
      const start = cursor ? Math.max(0, matching.findIndex((key) => key > cursor)) : 0;
      const page = matching.slice(start, start + limit);
      return { entries: page.map((key) => ({ kind: "file" as const, name: key.slice(path.length + 1), path: key })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
    } };
    runtime.objects.listChildren = async () => { throw new Error("unbounded listChildren forbidden"); };
    const sources = new ZoneNavigationSources(runtime);
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const request = navigationReconcileSchema.parse({ operation: "navigation.reconcile", request_id: "DOCREQ-NAVIGATION-PACKAGE-0001", project_id: state.project_id, zone: "WORKING", expected_project_revision: 0, expected_generation: 0, expected_index: null, created_at: "2026-09-26T18:00:00.000Z" });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(state.project_id, state.slug)}/WORKING/00-CURRENT.md`;
    const resourceId = "navigation:WORKING";
    const admission = { project_id: state.project_id, request_id: request.request_id, kind: "document", operation: "navigation.reconcile", request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" }, resources: [{ resource_id: resourceId, resource_type: "navigation", zone: "WORKING", version: "0" }], resource_effect_scopes: [{ resource_id: resourceId, resource_version: "0", provider_id: runtime.providerId, sources: [], destinations: [{ path: indexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] };
    const legacyPort: NavigationInventoryPort = {
      listPage: async (input) => { const page = await inventory.listPage(input); const { verified_entries: _proof, ...withoutProof } = page; return withoutProof; },
      verifySnapshot: inventory.verifySnapshot.bind(inventory), verifyEntry: inventory.verifyEntry.bind(inventory), verifyEntryPage: inventory.verifyEntryPage.bind(inventory),
      verificationIncludesPhysicalIntegrity: true, recordVerifiedEntry: inventory.recordVerifiedEntry.bind(inventory), completeSnapshot: inventory.completeSnapshot.bind(inventory)
    };
    let result = await new ZoneNavigationEngine(runtime, legacyPort).reconcile(request, state, admission as never, budget(32));
    for (let attempt = 0; result.status === "pending" && attempt < 160; attempt += 1) result = await new ZoneNavigationEngine(runtime, legacyPort).reconcile(request, state, admission as never, budget(32));
    expect(result.status).toBe("finalized");
  });

  it("clears a pre-existing dirty REVIEW head only after the census proves its zone tombstone", async () => {
    const h = harness();
    const state = emptyProjectState(projectId, "Project OS", slug);
    await addWorkingHead(h, "working-only canonical head");
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-NAV-INITIAL-DIRTY-PRJ0002", project_id: projectId,
      zone: "REVIEW", expected_project_revision: state.revision, expected_generation: 0,
      expected_index: null, created_at: "2026-09-27T12:00:00.000Z"
    });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(projectId, slug)}/REVIEW/00-CURRENT.md`;
    const admission = {
      project_id: projectId, request_id: request.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: "navigation:REVIEW", resource_type: "navigation", zone: "REVIEW", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:REVIEW", resource_version: "0", provider_id: h.runtime.providerId,
        sources: [], destinations: [{ path: indexPath, logical_path: "REVIEW/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: state.revision },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    expect(await h.sources.beginAdoption(projectId, "REVIEW", "DOCREQ-NAV-PRIOR-PRJ0002", 0, budget())).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "REVIEW", `head:${documentId}`, budget());
    await h.sources.completeHeadWrite(ticket, null, budget());
    expect(await h.sources.readState(projectId, "REVIEW", budget())).toMatchObject({ generation: 1, adopted: false, adoption_request_id: "DOCREQ-NAV-PRIOR-PRJ0002" });
    expect((await h.sources.listDirtyPage(projectId, "REVIEW", null, 1, budget())).resource_ids).toEqual([`head:${documentId}`]);
    expect(await h.sources.beginAdoption(projectId, "REVIEW", request.request_id, 1, budget())).toBe(true);
    const progressPath = `${await new ExecutionJournal(h.runtime, projectId, "document", request.request_id).root()}/navigation-progress.json`;
    let result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });
    let afterCensus: { inventory_complete: boolean; verify_page: number; page_count: number; snapshot_id: string; source_ids: string[] } | undefined;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const rawProgress = h.files.get(progressPath)?.content;
      if (rawProgress) {
        const candidate = JSON.parse(rawProgress) as typeof afterCensus;
        if (candidate?.inventory_complete && candidate.verify_page === candidate.page_count) {
          afterCensus = candidate;
          break;
        }
      }
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });
    }
    expect(afterCensus).toMatchObject({ inventory_complete: true, verify_page: afterCensus?.page_count, snapshot_id: "source:1", source_ids: [] });
    const completedPageCount = afterCensus!.page_count;
    for (let attempt = 0; result.status === "pending" && attempt < 24; attempt += 1) result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, budget(), { deferPublication: true });

    expect(result.status, JSON.stringify(result)).toBe("prepared");
    const finalProgress = JSON.parse(h.files.get(progressPath)!.content) as { inventory_complete: boolean; verify_page: number; page_count: number; snapshot_id: string };
    expect(finalProgress).toMatchObject({ inventory_complete: true, verify_page: completedPageCount, page_count: completedPageCount, snapshot_id: "source:1" });
    expect(await h.sources.listDirtyPage(projectId, "REVIEW", null, 1, budget())).toMatchObject({ resource_ids: [], next_cursor: null });
    expect(await h.sources.readState(projectId, "REVIEW", budget())).toMatchObject({ generation: 1, adoption_request_id: request.request_id });
  });

  it("clears a pre-existing active WORKING head and finalizes in bounded 32-call slices", async () => {
    const h = harness();
    const state = emptyProjectState(projectId, "Project OS", slug);
    const content = "# active dirty working head\n";
    await addWorkingHead(h, content);
    const request = navigationReconcileSchema.parse({
      operation: "navigation.reconcile", request_id: "DOCREQ-NAV-INITIAL-ACTIVE-PRJ0002", project_id: projectId,
      zone: "WORKING", expected_project_revision: state.revision, expected_generation: 0,
      expected_index: null, created_at: "2026-09-27T12:00:00.000Z"
    });
    const requestHash = await executionHash(request);
    const indexPath = `${workspaceProjectRoot(projectId, slug)}/WORKING/00-CURRENT.md`;
    const admission = {
      project_id: projectId, request_id: request.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: requestHash, actor: { actor_id: "operator:test", authority: "project_guard" },
      resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "0" }],
      resource_effect_scopes: [{ resource_id: "navigation:WORKING", resource_version: "0", provider_id: h.runtime.providerId,
        sources: [], destinations: [{ path: indexPath, logical_path: "WORKING/00-CURRENT.md" }], preservation_copies: [] }],
      global_revision: 0, project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: state.revision },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    expect(await h.sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAV-PRIOR-WORKING-PRJ0002", 0, budget())).toBe(true);
    const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", `head:${documentId}`, budget());
    await h.sources.completeHeadWrite(ticket, null, budget());
    expect(await h.sources.beginAdoption(projectId, "WORKING", request.request_id, 1, budget())).toBe(true);

    const progressPath = `${await new ExecutionJournal(h.runtime, projectId, "document", request.request_id).root()}/navigation-progress.json`;
    const sliceCalls: number[] = [];
    let sliceBudget = budget(32);
    let before = h.providerCalls;
    let result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, sliceBudget, { deferPublication: true });
    sliceCalls.push(h.providerCalls - before);
    for (let attempt = 0; result.status === "pending" && attempt < 24; attempt += 1) {
      sliceBudget = budget(32);
      before = h.providerCalls;
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).reconcile(request, state, admission as never, sliceBudget, { deferPublication: true });
      sliceCalls.push(h.providerCalls - before);
    }

    expect(result.status, JSON.stringify(result)).toBe("prepared");
    expect(sliceCalls.length).toBeLessThanOrEqual(24);
    expect(sliceCalls.every((count) => count <= 32)).toBe(true);
    const preparationSlices = sliceCalls.length;
    const publicationCalls: number[] = [];
    for (let attempt = 0; result.status !== "finalized" && attempt < 24; attempt += 1) {
      sliceBudget = budget(32);
      before = h.providerCalls;
      result = await new ZoneNavigationEngine(h.runtime, h.inventory).publishPrepared(request, state, admission as never, sliceBudget, "source:1");
      publicationCalls.push(h.providerCalls - before);
    }
    expect(result.status, JSON.stringify({ result, preparationSlices, sliceCalls, publicationCalls })).toBe("finalized");
    expect(result).toMatchObject({ status: "finalized", receipt: { status: "committed", project_id: projectId,
      request_id: request.request_id, zone: "WORKING", generation: 1, source_snapshot_id: "source:1" } });
    expect(publicationCalls.length).toBeLessThanOrEqual(24);
    expect(publicationCalls.every((count) => count <= 32)).toBe(true);
    const progress = JSON.parse(h.files.get(progressPath)!.content) as { snapshot_id: string; inventory_complete: boolean; verify_page: number; page_count: number };
    expect(progress).toMatchObject({ snapshot_id: "source:1", inventory_complete: true, verify_page: progress.page_count });
    expect(progress).toMatchObject({ status: "finalized" });
    const catalog = await h.sources.readCatalogEntry(projectId, "WORKING", `head:${documentId}`, budget());
    expect(catalog?.expected.content_sha256).toBe(await sha256Text(content));
    expect(await h.sources.listDirtyPage(projectId, "WORKING", null, 1, budget())).toMatchObject({ resource_ids: [], next_cursor: null });
    expect(await h.sources.readState(projectId, "WORKING", budget())).toMatchObject({ generation: 1, adoption_request_id: request.request_id });
    const headPath = `${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`;
    expect(JSON.parse(h.files.get(headPath)!.content)).toMatchObject({ generation: 1, source_request_id: request.request_id });
    expect(h.files.get(indexPath)?.content).toContain("](./draft.md)");
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
    const proofs = pages.flatMap((page) => page.verified_entries ?? []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resource_id: `artifact:${await sha256Text(destination)}`, version: `ART-NAVIGATION-001:${await sha256Text("approved artifact")}`, logical_path: "report.md", path: destination });
    expect(proofs).toEqual([{ resource_id: entries[0].resource_id, entry_hash: await sha256Text(canonicalJson(entries[0])), persisted: false }]);
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

  it("keeps provider calls for one dirty source delta bounded as unchanged catalog references grow", async () => {
    const measure = async (count: number) => {
      const h = harness();
      const entries: NavigationInventoryEntry[] = [];
      for (let index = 0; index < count; index += 1) {
        const suffix = index === 0 ? documentId.slice("DOC-".length) : index.toString(16).padStart(24, "0").toUpperCase();
        const id = `DOC-${suffix}`;
        const version = `VER-REQ-${suffix}`;
        const content = index === 0 ? "before delta" : `unchanged ${index}`;
        const visiblePath = await addWorkingHead(h, content, "rev-visible", id, version, `draft-${index}.md`);
        const entry: NavigationInventoryEntry = {
          project_id: projectId, zone: "WORKING", resource_id: `head:${id}`, version,
          logical_path: `draft-${index}.md`, path: visiblePath,
          expected: { object_id: "id:visible", revision_token: "rev-visible", content_sha256: await sha256Text(content), size: new TextEncoder().encode(content).byteLength }
        };
        expect(await h.inventory.verifyEntry(entry, budget())).toBe(true);
        await h.sources.writeCatalogEntry(entry, projectId, "WORKING", entry.resource_id, budget(), 0);
        await h.sources.recordVerifiedCatalogEntry(entry, "source:0", budget());
        entries.push(entry);
      }
      const firstEntry = entries[0];
      const firstId = firstEntry.resource_id;
      const requestId = "DOCREQ-NAVIGATION-WORKING-0001";
      await h.sources.beginAdoption(projectId, "WORKING", requestId, 0, budget());
      await h.sources.finishAdoption(projectId, "WORKING", requestId, 0, budget());
      await h.sources.markCatalogReady(projectId, "WORKING", 0, budget());
      const ticket = await h.sources.beginHeadWrite(projectId, "WORKING", firstId, budget());
      const changedPath = await addWorkingHead(h, "after delta", "rev-after", documentId, versionId, "draft-0.md");
      const changedEntry: NavigationInventoryEntry = {
        ...firstEntry, path: changedPath,
        expected: { ...firstEntry.expected, revision_token: "rev-after", content_sha256: await sha256Text("after delta"), size: 11 }
      };
      await h.sources.completeHeadWrite(ticket, changedEntry, budget());
      const before = h.providerCalls;
      let cursor: string | null = null;
      let steps = 0;
      const listedEntries: NavigationInventoryEntry[] = [];
      const proofs: { resource_id: string; entry_hash: string; persisted: boolean }[] = [];
      do {
        const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget() });
        listedEntries.push(...page.entries);
        proofs.push(...(page.verified_entries ?? []));
        cursor = page.next_cursor;
        steps += 1;
        if (steps > count + 20) throw new Error("navigation_catalog_scan_unbounded");
      } while (cursor !== null);
      expect(listedEntries).toHaveLength(count);
      expect(proofs).toHaveLength(count);
      expect(proofs.every((proof) => proof.persisted)).toBe(true);
      return h.providerCalls - before;
    };

    const calls100 = await measure(100);
    const calls1000 = await measure(1000);
    expect(calls1000).toBeLessThanOrEqual(calls100 + 100);
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

  it("batches outside-zone artifact gaps and replays the same bounded page", async () => {
    const h = harness();
    await addWorkingHead(h, "current valid head", "rev-valid", "DOC-1123456789ABCDEF01234567", "VER-REQ-1123456789ABCDEF01234567", "valid.md");
    const inactiveId = "DOC-2123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, inactiveId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: inactiveId,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const mismatchedPath = await addWorkingHead(h, "recorded mismatch", "rev-mismatch", "DOC-3123456789ABCDEF01234567", "VER-REQ-3123456789ABCDEF01234567", "mismatch.md");
    h.put(mismatchedPath, "physical bytes changed after the head", "id:physical-mismatch");
    const expected: Array<{ resource_id: string; code: string }> = [];
    for (let index = 1; index <= 4; index += 1) {
      const requestId = `ART-NAVIGATION-BATCH-${String(index).padStart(4, "0")}`;
      const destination = `${workspaceProjectRoot(projectId, slug)}/ARCHIVE/${index}.md`;
      await seedCommittedArtifact(h, requestId, destination, `archived artifact ${index}`);
      expected.push({ resource_id: `artifact:${await sha256Text(destination)}`, code: "artifact_destination_outside_navigation_zones" });
    }

    const cursor = "artifacts:";
    const before = h.providerCalls;
    const pages = [];
    let nextCursor: string | null = cursor;
    do {
      const slice = budget(32);
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: nextCursor, limit: 8, budget: slice });
      expect(slice.calls_left).toBeGreaterThanOrEqual(0);
      pages.push(page);
      nextCursor = page.next_cursor;
    } while (nextCursor !== null);
    const callsUsed = h.providerCalls - before;
    const first = pages[0]!;
    const replay = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });

    expect(first).toEqual(replay);
    expect(first.entries).toEqual([]);
    expect(pages.flatMap((page) => page.gaps)).toEqual(expected);
    expect(callsUsed).toBe(10);
    expect(first.next_cursor).toBeNull();
    expect(pages).toHaveLength(1);

    const interruptedPrefix = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(24) });
    expect(interruptedPrefix.gaps).toHaveLength(2);
    expect(interruptedPrefix.next_cursor).not.toBeNull();
    const listPage = h.runtime.pagedListing!.listPage;
    let faulted = false;
    h.runtime.pagedListing!.listPage = async (input) => {
      if (!faulted) { faulted = true; throw new Error("injected provider interruption after acknowledged prefix"); }
      return listPage(input);
    };
    await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: interruptedPrefix.next_cursor, limit: 8, budget: budget(32) }))
      .rejects.toThrow("injected provider interruption after acknowledged prefix");
    h.runtime.pagedListing!.listPage = listPage;
    const resumed = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: interruptedPrefix.next_cursor, limit: 8, budget: budget(32) });
    expect(resumed.entries).toEqual([]);
    const recoveredGaps = [...interruptedPrefix.gaps, ...resumed.gaps];
    let recoveredCursor = resumed.next_cursor;
    let recoveryPages = 0;
    while (recoveredCursor !== null) {
      const recovery = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: recoveredCursor, limit: 8, budget: budget(32) });
      recoveredGaps.push(...recovery.gaps);
      recoveredCursor = recovery.next_cursor;
      if (++recoveryPages > 4) throw new Error("artifact_gap_recovery_unbounded");
    }
    expect(recoveredGaps).toEqual(expected);

    const fullBefore = h.providerCalls;
    const fullPages = [];
    let fullCursor: string | null = null;
    let fullSteps = 0;
    let fullFaultInjected = false;
    do {
      const isArtifactPhase = fullCursor?.startsWith("artifacts:") ?? false;
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: fullCursor, limit: 8, budget: budget(isArtifactPhase ? 24 : 32) });
      fullPages.push(page);
      fullCursor = page.next_cursor;
      if (isArtifactPhase && page.gaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones").length === 2 && fullCursor !== null) {
        const acknowledgedCursor = fullCursor;
        const providerListPage = h.runtime.pagedListing!.listPage;
        h.runtime.pagedListing!.listPage = async () => { throw new Error("injected full-traversal provider interruption"); };
        await expect(h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: acknowledgedCursor, limit: 8, budget: budget(32) }))
          .rejects.toThrow("injected full-traversal provider interruption");
        h.runtime.pagedListing!.listPage = providerListPage;
        const retry = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor: acknowledgedCursor, limit: 8, budget: budget(32) });
        fullPages.push(retry);
        fullCursor = retry.next_cursor;
        fullFaultInjected = true;
      }
      fullSteps += 1;
      if (fullSteps > 20) throw new Error("mixed_initial_navigation_unbounded");
    } while (fullCursor !== null);
    const fullCallsUsed = h.providerCalls - fullBefore;
    const fullEntries = fullPages.flatMap((page) => page.entries);
    const fullGaps = fullPages.flatMap((page) => page.gaps);
    expect(fullFaultInjected).toBe(true);
    expect(fullEntries.map((entry) => entry.resource_id)).toContain("head:DOC-1123456789ABCDEF01234567");
    expect(fullEntries.map((entry) => entry.resource_id)).not.toContain(`head:${inactiveId}`);
    expect(fullGaps.some((gap) => gap.resource_id === "head:DOC-3123456789ABCDEF01234567")).toBe(true);
    expect(fullGaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones")).toHaveLength(4);
    expect({ calls: fullCallsUsed, tranches: fullPages.length }).toEqual({ calls: 36, tranches: 4 });
  });

  it("measures the full initial traversal for mixed heads and outside-zone artifacts", async () => {
    const h = harness();
    await addWorkingHead(h, "current valid head", "rev-valid", "DOC-1123456789ABCDEF01234567", "VER-REQ-1123456789ABCDEF01234567", "valid.md");
    const inactiveId = "DOC-2123456789ABCDEF01234567";
    h.put(machineDocumentHeadPath(projectId, inactiveId), JSON.stringify({
      schema_version: "1.0", project_id: projectId, document_id: inactiveId,
      kind: "work_product", logical_path: "inactive.md", reconciliation_status: "clean"
    }));
    const mismatchedPath = await addWorkingHead(h, "recorded mismatch", "rev-mismatch", "DOC-3123456789ABCDEF01234567", "VER-REQ-3123456789ABCDEF01234567", "mismatch.md");
    h.put(mismatchedPath, "physical bytes changed after the head", "id:physical-mismatch");
    const expectedArtifacts: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const requestId = `ART-NAVIGATION-FULL-${String(index).padStart(4, "0")}`;
      const destination = `${workspaceProjectRoot(projectId, slug)}/ARCHIVE/${index}.md`;
      await seedCommittedArtifact(h, requestId, destination, `archived artifact ${index}`);
      expectedArtifacts.push(`artifact:${await sha256Text(destination)}`);
    }

    const before = h.providerCalls;
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await h.inventory.listPage({ project_id: projectId, zone: "WORKING", cursor, limit: 8, budget: budget(32) });
      pages.push(page);
      cursor = page.next_cursor;
      if (pages.length > 20) throw new Error("mixed_full_traversal_unbounded");
    } while (cursor !== null);
    const calls = h.providerCalls - before;
    const entries = pages.flatMap((page) => page.entries);
    const gaps = pages.flatMap((page) => page.gaps);
    expect(entries.map((entry) => entry.resource_id)).toContain("head:DOC-1123456789ABCDEF01234567");
    expect(entries.map((entry) => entry.resource_id)).not.toContain(`head:${inactiveId}`);
    expect(gaps.some((gap) => gap.resource_id === "head:DOC-3123456789ABCDEF01234567")).toBe(true);
    expect(gaps.filter((gap) => gap.code === "artifact_destination_outside_navigation_zones").map((gap) => gap.resource_id)).toEqual(expectedArtifacts);
    expect({ calls, tranches: pages.length }).toEqual({ calls: 32, tranches: 3 });
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
