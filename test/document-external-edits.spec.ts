import { describe, expect, it } from "vitest";
import { documentIdFor, documentIdForProviderFile, externalVersionIdFor } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";
import type { SliceBudget } from "../src/convergence/contract";
import { machineDocumentHeadPath, machineDocumentRoot, machineDocumentVersionPath } from "../src/persistence/layout";
import { zoneNavigationDirtyRoot } from "../src/documents/zone-navigation-sources";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { ProviderOperationError } from "../src/persistence/provider/errors";

class FakeDocumentDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  downloads: string[] = [];
  copies: Array<{ from: string; to: string }> = [];
  failVerificationAfterUploadPath: string | null = null;
  private verificationFailureArmed = false;
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    await this.setFile(path, content, this.metadata.get(path)?.id);
    if (path === this.failVerificationAfterUploadPath) this.verificationFailureArmed = true;
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    return this.setFile(path, content, current.id);
  }

  async download(path: string): Promise<string | null> {
    this.downloads.push(path);
    if (this.verificationFailureArmed && path === this.failVerificationAfterUploadPath) {
      this.verificationFailureArmed = false;
      throw new Error("injected_post_head_write_verification_failure");
    }
    return this.files.get(path) ?? null;
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    return this.metadata.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    if (this.files.has(to)) throw new DropboxConflictError("destination exists", "req-move", "to/conflict/file");
    const content = this.files.get(from);
    const current = this.metadata.get(from);
    if (content === undefined || !current) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    this.files.delete(from);
    this.metadata.delete(from);
    await this.setFile(to, content, current.id);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    if (this.files.has(to)) throw new DropboxConflictError("destination exists", "req-copy", "to/conflict/file");
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    this.copies.push({ from, to });
    return this.setFile(to, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
  }

  async listFolder(path: string) {
    const prefix = `${path}/`;
    const names = [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
    return names;
  }

  async listFolderPage(path: string, cursor: string | null, limit: number) {
    const entries = await this.listFolder(path);
    const offset = cursor === null ? 0 : Number(cursor);
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return { entries: page, cursor: nextOffset < entries.length ? String(nextOffset) : null };
  }

  async externalWrite(path: string, content: string): Promise<DropboxFileMetadata> {
    return this.setFile(path, content, this.metadata.get(path)?.id);
  }

  async externalAdd(path: string, content: string): Promise<DropboxFileMetadata> {
    return this.setFile(path, content);
  }

  private async setFile(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const actualId = id ?? `id:F${String(this.nextId++).padStart(6, "0")}`;
    const rev = `rev-${String(this.nextRev++).padStart(6, "0")}`;
    const metadata: DropboxFileMetadata = {
      id: actualId,
      path,
      rev,
      content_hash: await sha256(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: `2026-08-24T18:${String(this.nextRev).padStart(2, "0")}:00.000Z`
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

const state = () => emptyProjectState("PRJ-4001", "Document Project", "document-project", "Test managed docs");
const at = "2026-08-24T18:00:00.000Z";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function change(metadata: DropboxFileMetadata): ProviderChangeEntry {
  return {
    kind: "file",
    name: metadata.path.split("/").at(-1)!,
    path: metadata.path,
    metadata: {
      path: metadata.path,
      size: metadata.size,
      ...(metadata.server_modified ? { modifiedAt: metadata.server_modified } : {}),
      objectId: metadata.id,
      revisionToken: metadata.rev,
      integrityHash: { algorithm: "dropbox-content-hash", value: metadata.content_hash }
    }
  };
}

function deleted(path: string): ProviderChangeEntry {
  return { kind: "deleted", name: path.split("/").at(-1)!, path };
}

async function createWorking(service: ManagedDocumentService, project = state(), content = "draft") {
  return service.writeWorking({
    request_id: "DOCREQ-WORKING-0001",
    project_id: project.project_id,
    logical_path: "strategy/commerciale.md",
    content,
    content_sha256: await sha256(content),
    created_at: at
  }, project);
}

describe("ManagedDocumentReconciler external edits", () => {
  it("captures a human WORKING edit as the next working version without decoding a different provider file", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const first = await createWorking(service, project);
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(path, "human section edit");
    dropbox.downloads.length = 0;

    const reconciler = new ManagedDocumentReconciler(runtime);
    await reconciler.reconcileChanges(project, [change(external)]);

    const documentId = await documentIdFor(project.project_id, "strategy/commerciale.md");
    const versionId = await externalVersionIdFor(external.rev);
    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, documentId);
    const version = await ledger.readVersion(project.project_id, documentId, versionId);
    expect(head?.working_version_id).toBe(versionId);
    expect(version).toMatchObject({ parent_version_id: first.version_id, stage: "working", source: "external_human", provider_rev: external.rev });
    expect(dropbox.copies.some((copy) => copy.from === path && copy.to.includes(versionId))).toBe(true);
    expect(dropbox.downloads).toContain(path);
  });

  it("resumes an unchanged WORKING observation after head bytes persist but before navigation invalidation completes", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const working = await createWorking(new ManagedDocumentService(runtime), project);
    const sources = new ZoneNavigationSources(runtime);
    expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
    const adoptionId = "DOCREQ-NAV-WORKING-ADOPT-0001";
    expect(await sources.beginAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect(await sources.finishAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect((await sources.readState(project.project_id, "WORKING")).adopted).toBe(true);

    const visiblePath = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(visiblePath, "human edit after adoption");
    const canonicalHeadPath = machineDocumentHeadPath(project.project_id, working.document_id);
    const reconciler = new ManagedDocumentReconciler(runtime);
    dropbox.failVerificationAfterUploadPath = canonicalHeadPath;

    await expect(reconciler.reconcileChanges(project, [change(external)])).rejects.toThrow("injected_post_head_write_verification_failure");
    dropbox.failVerificationAfterUploadPath = null;

    const headAfterInterruptedWrite = dropbox.files.get(canonicalHeadPath);
    expect(headAfterInterruptedWrite).toBeDefined();
    const sourceStatePath = `${machineDocumentRoot(project.project_id)}/navigation-sources/state.json`;
    const sourceStateRaw = dropbox.files.get(sourceStatePath);
    expect(sourceStateRaw).toBeDefined();
    const sourceState = JSON.parse(sourceStateRaw!) as { zones: { WORKING: { in_flight_writes: Array<{ resource_id: string; write_hash?: string | null }> } } };
    expect(sourceState.zones.WORKING.in_flight_writes.find((write) => write.resource_id === `head:${working.document_id}`))
      .toMatchObject({ write_hash: await sha256(headAfterInterruptedWrite!) });
    const versionsBeforeRetry = [...dropbox.files.keys()].filter((path) => path.includes(`/documents/versions/${working.document_id}/`)).sort();
    expect(versionsBeforeRetry.length).toBeGreaterThanOrEqual(2);
    const externalVersion = await externalVersionIdFor(external.rev);
    const ledger = new DocumentLedgerRepository(runtime);
    expect((await ledger.readHead(project.project_id, working.document_id))?.working_version_id).toBe(externalVersion);

    await reconciler.reconcileChanges(project, [change(external)]);

    expect(dropbox.files.get(visiblePath)).toBe("human edit after adoption");
    expect([...dropbox.files.keys()].filter((path) => path.includes(`/documents/versions/${working.document_id}/`)).sort()).toEqual(versionsBeforeRetry);
    expect((await ledger.readHead(project.project_id, working.document_id))?.working_version_id).toBe(externalVersion);
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 8)).toMatchObject({ resource_ids: [`head:${working.document_id}`] });
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).toEqual([]);
  });

  it("keeps malformed head/version proofs unresolved while propagating provider read failures", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const documents = await Promise.all([
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-MALFORMED-HEAD-0001", project_id: project.project_id,
        logical_path: "orphan/malformed-head.md", content: "malformed head", content_sha256: await sha256("malformed head"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-MALFORMED-VERSION-0001", project_id: project.project_id,
        logical_path: "orphan/malformed-version.md", content: "malformed version", content_sha256: await sha256("malformed version"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-VALID-SIBLING-0001", project_id: project.project_id,
        logical_path: "orphan/valid-sibling.md", content: "valid sibling", content_sha256: await sha256("valid sibling"), created_at: at }, project)
    ]);
    const sources = new ZoneNavigationSources(runtime);
    expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
    const adoptionId = "DOCREQ-NAV-WORKING-ORPHAN-PROOF-ADOPT-0001";
    expect(await sources.beginAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect(await sources.finishAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    const ledger = new DocumentLedgerRepository(runtime);
    const paths = documents.map(document => machineDocumentHeadPath(project.project_id, document.document_id));
    const headBytes = paths.map(path => dropbox.files.get(path));
    expect(headBytes.every(value => value !== undefined)).toBe(true);
    const malformedHead = documents[0];
    const malformedVersion = documents[1];
    const validSibling = documents[2];
    const malformedHeadRaw = "{";
    dropbox.files.set(paths[0], malformedHeadRaw);
    const malformedVersionHead = await ledger.readHead(project.project_id, malformedVersion.document_id);
    expect(malformedVersionHead?.working_version_id).toBeTruthy();
    const malformedVersionPath = machineDocumentVersionPath(project.project_id, malformedVersion.document_id,
      malformedVersionHead!.working_version_id!);
    dropbox.files.set(malformedVersionPath, "{\"schema_version\":\"invalid\"}");
    const hashHead = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const malformedHeadTicket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${malformedHead.document_id}`,
      undefined, await hashHead(malformedHeadRaw));
    const malformedVersionTicket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${malformedVersion.document_id}`,
      undefined, await hashHead(headBytes[1]!));
    const validTicket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${validSibling.document_id}`,
      undefined, await hashHead(headBytes[2]!));
    expect(malformedHeadTicket).toBeTruthy();
    expect(malformedVersionTicket).toBeTruthy();
    expect(validTicket).toBeTruthy();

    await expect(ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${malformedHead.document_id}`))
      .resolves.toBe(false);
    await expect(ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${malformedVersion.document_id}`))
      .resolves.toBe(false);
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).toEqual(expect.arrayContaining([
      `head:${malformedHead.document_id}`, `head:${malformedVersion.document_id}`
    ]));
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 16)).toMatchObject({ resource_ids: [] });

    const originalReadText = runtime.objects.readText.bind(runtime.objects);
    runtime.objects.readText = async path => {
      if (path === paths[2]) throw new ProviderOperationError("provider read interrupted", true,
        { providerId: "dropbox", retryAfterMs: 60_000 });
      return originalReadText(path);
    };
    try {
      await expect(ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${validSibling.document_id}`))
        .rejects.toBeInstanceOf(ProviderOperationError);
    } finally {
      runtime.objects.readText = originalReadText;
    }
    expect(await ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${validSibling.document_id}`)).toBe(true);
  });

  it("does not complete a future-generation head ticket or write its dirty marker", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const document = await createWorking(new ManagedDocumentService(runtime), project);
    const sources = new ZoneNavigationSources(runtime);
    expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
    const adoptionId = "DOCREQ-NAV-WORKING-FUTURE-TICKET-ADOPT-0001";
    expect(await sources.beginAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect(await sources.finishAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    const headPath = machineDocumentHeadPath(project.project_id, document.document_id);
    const headRaw = dropbox.files.get(headPath);
    expect(headRaw).toBeDefined();
    const hash = await sha256(headRaw!);
    const ticket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${document.document_id}`, undefined, hash);
    expect(ticket).toBeTruthy();
    const sourcePath = `${machineDocumentRoot(project.project_id)}/navigation-sources/state.json`;
    const sourceRaw = dropbox.files.get(sourcePath);
    expect(sourceRaw).toBeDefined();
    const source = JSON.parse(sourceRaw!) as { zones: { WORKING: { generation: number; adoption_generation: number | null } } };
    expect(ticket!.generation).toBe(source.zones.WORKING.generation);
    source.zones.WORKING.generation = ticket!.generation - 1;
    dropbox.files.set(sourcePath, JSON.stringify(source));

    const ledger = new DocumentLedgerRepository(runtime);
    await expect(ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${document.document_id}`)).resolves.toBe(false);
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).toContain(`head:${document.document_id}`);
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 8)).toMatchObject({ resource_ids: [] });
  });

  it("retains a head ticket when its generation becomes future after the dirty marker is written", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const document = await createWorking(new ManagedDocumentService(runtime), project);
    const sources = new ZoneNavigationSources(runtime);
    expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
    const adoptionId = "DOCREQ-NAV-WORKING-RACED-FUTURE-ADOPT-0001";
    expect(await sources.beginAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect(await sources.finishAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    const headPath = machineDocumentHeadPath(project.project_id, document.document_id);
    const headRaw = dropbox.files.get(headPath);
    expect(headRaw).toBeDefined();
    const ticket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${document.document_id}`, undefined,
      await sha256(headRaw!));
    expect(ticket).toBeTruthy();
    const dirtyPath = `${zoneNavigationDirtyRoot(project.project_id, "WORKING")}/${await sha256(`head:${document.document_id}`)}.json`;
    const dirtyMetadataBefore = await runtime.objects.getMetadata(dirtyPath);
    expect(dirtyMetadataBefore).toBeNull();
    const sourcePath = `${machineDocumentRoot(project.project_id)}/navigation-sources/state.json`;
    const originalCreateText = runtime.objects.createText.bind(runtime.objects);
    let exactDirtyMarkerWritten = false;
    let sourceRegressedAfterDirtyWrite = false;
    runtime.objects.createText = async (path, content) => {
      await originalCreateText(path, content);
      if (path !== dirtyPath || exactDirtyMarkerWritten) return;
      const marker = JSON.parse(content) as { resource_id?: unknown; generation?: unknown };
      if (marker.resource_id !== `head:${document.document_id}` || marker.generation !== ticket!.generation) return;
      exactDirtyMarkerWritten = true;
      const sourceRaw = dropbox.files.get(sourcePath);
      if (sourceRaw === undefined) throw new Error("Expected persisted navigation source state");
      const source = JSON.parse(sourceRaw) as { zones: { WORKING: { generation: number } } };
      source.zones.WORKING.generation = ticket!.generation - 1;
      await dropbox.externalWrite(sourcePath, JSON.stringify(source));
      sourceRegressedAfterDirtyWrite = true;
    };
    let recovered = false;
    try {
      const ledger = new DocumentLedgerRepository(runtime);
      recovered = await ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${document.document_id}`);
      expect(exactDirtyMarkerWritten).toBe(true);
      expect(sourceRegressedAfterDirtyWrite).toBe(true);
      expect(JSON.parse(dropbox.files.get(dirtyPath)!)).toMatchObject({ resource_id: `head:${document.document_id}`, generation: ticket!.generation });
    } finally {
      runtime.objects.createText = originalCreateText;
    }
    expect(recovered).toBe(false);
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids)
      .toContain(`head:${document.document_id}`);
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 8)).toMatchObject({ resource_ids: [`head:${document.document_id}`] });
  });

  it("recovers only exact unowned head proofs, preserves refusals, and rotates past unresolved resources", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const documents = await Promise.all([
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-MISMATCH-0001", project_id: project.project_id,
        logical_path: "orphan/mismatch.md", content: "mismatch", content_sha256: await sha256("mismatch"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-OWNED-0001", project_id: project.project_id,
        logical_path: "orphan/owned.md", content: "owned", content_sha256: await sha256("owned"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-NULL-0001", project_id: project.project_id,
        logical_path: "orphan/null.md", content: "null", content_sha256: await sha256("null"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-MISSING-0001", project_id: project.project_id,
        logical_path: "orphan/missing-version.md", content: "missing", content_sha256: await sha256("missing"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-VALID-0001", project_id: project.project_id,
        logical_path: "orphan/valid.md", content: "valid", content_sha256: await sha256("valid"), created_at: at }, project),
      service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-BUDGET-0001", project_id: project.project_id,
        logical_path: "orphan/budget.md", content: "budget", content_sha256: await sha256("budget"), created_at: at }, project)
    ]);
    const sources = new ZoneNavigationSources(runtime);
    expect(await sources.markCatalogReady(project.project_id, "WORKING", 0)).toBe(true);
    const adoptionId = "DOCREQ-NAV-WORKING-ORPHAN-ADOPT-0001";
    expect(await sources.beginAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);
    expect(await sources.finishAdoption(project.project_id, "WORKING", adoptionId, 0)).toBe(true);

    const ledger = new DocumentLedgerRepository(runtime);
    const hashes = new Map<string, string>();
    for (const document of documents) {
      const raw = dropbox.files.get(machineDocumentHeadPath(project.project_id, document.document_id));
      if (!raw) throw new Error("orphan fixture head missing");
      hashes.set(document.document_id, await sha256(raw));
    }
    const mismatch = documents[0];
    const owned = documents[1];
    const nullHash = documents[2];
    const missingVersion = documents[3];
    const valid = documents[4];
    const budgeted = documents[5];
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${mismatch.document_id}`, undefined, hashes.get(mismatch.document_id)!)).toBeTruthy();
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${owned.document_id}`, undefined,
      hashes.get(owned.document_id)!, false, await sha256("existing-owner"))).toBeTruthy();
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${nullHash.document_id}`)).toBeTruthy();
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${missingVersion.document_id}`, undefined, hashes.get(missingVersion.document_id)!)).toBeTruthy();
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${valid.document_id}`, undefined, hashes.get(valid.document_id)!)).toBeTruthy();

    const mismatchPath = machineDocumentHeadPath(project.project_id, mismatch.document_id);
    await dropbox.externalWrite(mismatchPath, `${dropbox.files.get(mismatchPath)} `);
    const missingHead = await ledger.readHead(project.project_id, missingVersion.document_id);
    expect(missingHead?.working_version_id).toBeTruthy();
    await dropbox.delete(machineDocumentVersionPath(project.project_id, missingVersion.document_id, missingHead!.working_version_id!));

    const candidates = await sources.unownedHeadWriteRecoveryCandidates(project.project_id);
    const candidateIds = candidates.map(tickets => tickets[0]?.resource_id);
    expect(candidateIds).toContain(`head:${mismatch.document_id}`);
    expect(candidateIds).toContain(`head:${missingVersion.document_id}`);
    expect(candidateIds).toContain(`head:${valid.document_id}`);
    expect(candidateIds).not.toContain(`head:${owned.document_id}`);
    expect(candidateIds).not.toContain(`head:${nullHash.document_id}`);

    const mismatchOrdinal = candidateIds.indexOf(`head:${mismatch.document_id}`);
    const firstAttempt = await ledger.recoverOneUnownedHeadWrite(project.project_id, mismatchOrdinal);
    expect(firstAttempt).toEqual({ status: "unresolved", remainingCandidates: true });
    let validRecovered = false;
    for (let offset = 1; offset < candidates.length; offset += 1) {
      const attempt = await ledger.recoverOneUnownedHeadWrite(project.project_id, mismatchOrdinal + offset);
      if (attempt.status === "recovered") {
        validRecovered = true;
        break;
      }
    }
    expect(validRecovered).toBe(true);
    expect(await ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${mismatch.document_id}`)).toBe(false);
    expect(await ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${missingVersion.document_id}`)).toBe(false);
    const remaining = await sources.readState(project.project_id, "WORKING");
    expect(remaining.in_flight_resource_ids).toEqual(expect.arrayContaining([
      `head:${mismatch.document_id}`, `head:${owned.document_id}`, `head:${nullHash.document_id}`, `head:${missingVersion.document_id}`
    ]));
    expect(remaining.in_flight_resource_ids).not.toContain(`head:${valid.document_id}`);
    const finalSourceState = JSON.parse(dropbox.files.get(`${machineDocumentRoot(project.project_id)}/navigation-sources/state.json`)!) as {
      zones: { WORKING: { in_flight_writes: Array<{ resource_id: string; write_hash?: string | null; owner_hash?: string }> } }
    };
    expect(finalSourceState.zones.WORKING.in_flight_writes.find(write => write.resource_id === `head:${owned.document_id}`)?.owner_hash)
      .toBe(await sha256("existing-owner"));
    expect(finalSourceState.zones.WORKING.in_flight_writes.find(write => write.resource_id === `head:${nullHash.document_id}`)?.write_hash)
      .toBeNull();
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 16)).toMatchObject({ resource_ids: [`head:${valid.document_id}`] });

    const raced = await service.writeWorking({ request_id: "DOCREQ-WORKING-ORPHAN-RACE-0001", project_id: project.project_id,
      logical_path: "orphan/race.md", content: "race", content_sha256: await sha256("race"), created_at: at }, project);
    const racedPath = machineDocumentHeadPath(project.project_id, raced.document_id);
    const racedRaw = dropbox.files.get(racedPath);
    if (!racedRaw) throw new Error("raced orphan fixture head missing");
    expect(await sources.beginHeadWrite(project.project_id, "WORKING", `head:${raced.document_id}`, undefined, await sha256(racedRaw))).toBeTruthy();
    const originalReadText = runtime.objects.readText.bind(runtime.objects);
    let racedHeadReads = 0;
    runtime.objects.readText = async path => {
      const result = await originalReadText(path);
      if (path === racedPath && ++racedHeadReads === 2 && result !== null) {
        const changed = `${result} `;
        await dropbox.externalWrite(racedPath, changed);
        return changed;
      }
      return result;
    };
    try {
      await expect(ledger.recoverUnownedHeadWriteForResource(project.project_id, `head:${raced.document_id}`))
        .rejects.toThrow("navigation_source_head_superseded");
    } finally {
      runtime.objects.readText = originalReadText;
    }
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).toContain(`head:${raced.document_id}`);
    expect(await sources.listDirtyPage(project.project_id, "WORKING", null, 16)).toMatchObject({ resource_ids: [`head:${valid.document_id}`] });

    const budgetedPath = machineDocumentHeadPath(project.project_id, budgeted.document_id);
    const budgetedRaw = dropbox.files.get(budgetedPath);
    if (!budgetedRaw) throw new Error("budgeted orphan fixture head missing");
    const budgetedTicket = await sources.beginHeadWrite(project.project_id, "WORKING", `head:${budgeted.document_id}`, undefined, await sha256(budgetedRaw));
    expect(budgetedTicket).toBeTruthy();
    const dirtyPath = `${zoneNavigationDirtyRoot(project.project_id, "WORKING")}/${await sha256(`head:${budgeted.document_id}`)}.json`;
    let callsLeft = 32;
    let budgetFaultArmed = true;
    let budgetFaultInjected = false;
    const sliceBudget: SliceBudget = {
      deadline_ms: Date.now() + 60_000,
      get calls_left() { return callsLeft; },
      now: () => Date.now(),
      signal: new AbortController().signal,
      beforeHttp() {
        const markerRaw = dropbox.files.get(dirtyPath);
        if (budgetFaultArmed && markerRaw !== undefined) {
          const marker = JSON.parse(markerRaw) as { resource_id?: unknown; generation?: unknown };
          if (marker.resource_id === `head:${budgeted.document_id}` && marker.generation === budgetedTicket!.generation) {
            budgetFaultInjected = true;
            throw new Error("slice_budget_exhausted");
          }
        }
        if (callsLeft <= 0) throw new Error("slice_budget_exhausted");
        callsLeft -= 1;
      },
      canStartEffect: requiredCalls => Number.isSafeInteger(requiredCalls) && requiredCalls > 0
        && callsLeft >= requiredCalls + 4 && Date.now() < sliceBudget.deadline_ms - 3_000
    };
    try {
      await expect(sources.completeUnownedHeadWritesPreservingMismatch([budgetedTicket!], sliceBudget))
        .rejects.toThrow("slice_budget_exhausted");
    } finally {
      budgetFaultArmed = false;
    }
    expect(budgetFaultInjected).toBe(true);
    expect(JSON.parse(dropbox.files.get(dirtyPath)!)).toMatchObject({ resource_id: `head:${budgeted.document_id}`, generation: budgetedTicket!.generation });
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).toContain(`head:${budgeted.document_id}`);
    await sources.completeUnownedHeadWritesPreservingMismatch([budgetedTicket!]);
    expect((await sources.readState(project.project_id, "WORKING")).in_flight_resource_ids).not.toContain(`head:${budgeted.document_id}`);
    expect(JSON.parse(dropbox.files.get(dirtyPath)!)).toMatchObject({ resource_id: `head:${budgeted.document_id}`, generation: budgetedTicket!.generation });
  });

  it("restores a deleted WORKING file from its immutable active version without advancing history", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const working = await createWorking(service, project, "draft to protect");
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    await dropbox.delete(path);

    const summary = await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [deleted(path)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(summary.restored).toBe(1);
    expect(dropbox.files.get(path)).toContain("draft to protect");
    expect(head?.working_version_id).toBe(working.version_id);
    expect(head?.provider?.working?.path).toBe(path);
  });

  it("captures an external REVIEW edit as a new review candidate without publishing it", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const working = await createWorking(service, project);
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "review", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(path, "human QA edit");

    await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const versionId = await externalVersionIdFor(external.rev);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.review_version_id).toBe(versionId);
    expect(head?.published_version_id).toBeUndefined();
    expect(await ledger.readVersion(project.project_id, working.document_id, versionId)).toMatchObject({ parent_version_id: review.version_id, stage: "review", source: "external_human" });
  });

  it("ingests INPUTS into REFERENCES/UNCLASSIFIED with a stable provider-file identity", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", "sources/market-study.pdf");
    const input = await dropbox.externalAdd(inputPath, "binary-opaque-pdf-bytes");

    await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [change(input)]);

    const target = workspaceManagedDocumentPath(project.project_id, project.slug, "references", "UNCLASSIFIED/sources/market-study.pdf");
    expect(dropbox.files.has(inputPath)).toBe(false);
    expect(dropbox.files.get(target)).toBe("binary-opaque-pdf-bytes");
    const documentId = await documentIdForProviderFile(project.project_id, input.id);
    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, documentId);
    expect(head).toMatchObject({ kind: "reference", logical_path: "sources/market-study.pdf", collection_path: "UNCLASSIFIED" });
    expect(head?.reference_version_id).toBeDefined();
    const version = await ledger.readVersion(project.project_id, documentId, head!.reference_version_id!);
    expect(version).toMatchObject({ stage: "reference", source: "input_ingest" });
  });

  it("turns a direct human DELIVERABLE edit into a new WORKING draft and restores the published bytes", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const working = await createWorking(service, project, "approved v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0002", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    const workingPath = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(publishedPath, "human post-publish changes");

    await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.working_version_id).toBe(await externalVersionIdFor(external.rev));
    expect(dropbox.files.get(publishedPath)).toContain("approved v1");
    expect(dropbox.files.get(workingPath)).toBe("human post-publish changes");
  });

  it("restores a deleted published deliverable without changing the frozen published version", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const working = await createWorking(service, project, "approved deletion-safe v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-DELETE-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-DELETE-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    await dropbox.delete(publishedPath);

    const summary = await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [deleted(publishedPath)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(summary.restored).toBe(1);
    expect(dropbox.files.get(publishedPath)).toContain("approved deletion-safe v1");
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.provider?.published?.path).toBe(publishedPath);
  });

  it("preserves an existing WORKING draft when a published deliverable is edited externally", async () => {
    const dropbox = new FakeDocumentDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new ManagedDocumentService(runtime);
    const working = await createWorking(service, project, "approved v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0003", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-0002", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const reopened = await service.reopenPublished({ request_id: "DOCREQ-REOPEN-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: published.version_id, created_at: at }, project);
    const aiDraft = await service.writeWorking({ request_id: "DOCREQ-WORKING-0002", project_id: project.project_id, logical_path: "strategy/commerciale.md", content: "new AI draft", content_sha256: await sha256("new AI draft"), expected_version_id: reopened.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    const workingPath = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(publishedPath, "human conflicting published edit");

    await new ManagedDocumentReconciler(runtime).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.working_version_id).toBe(aiDraft.version_id);
    expect(head?.reconciliation_status).toBe("conflict");
    expect(dropbox.files.get(workingPath)).toContain("new AI draft");
    expect(dropbox.files.get(publishedPath)).toContain("approved v1");
    const recoveredId = await externalVersionIdFor(external.rev);
    expect(await ledger.readVersion(project.project_id, working.document_id, recoveredId)).toMatchObject({ stage: "recovered_external", source: "external_human", parent_version_id: published.version_id });
  });
});
