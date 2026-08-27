import { describe, expect, it } from "vitest";
import { documentIdFor, documentIdForProviderFile, externalVersionIdFor } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";

class FakeDocumentDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  downloads: string[] = [];
  copies: Array<{ from: string; to: string }> = [];
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    await this.setFile(path, content, this.metadata.get(path)?.id);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    return this.setFile(path, content, current.id);
  }

  async download(path: string): Promise<string | null> {
    this.downloads.push(path);
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
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const first = await createWorking(service, project);
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(path, "human section edit");
    dropbox.downloads.length = 0;

    const reconciler = new ManagedDocumentReconciler(dropbox);
    await reconciler.reconcileChanges(project, [change(external)]);

    const documentId = await documentIdFor(project.project_id, "strategy/commerciale.md");
    const versionId = await externalVersionIdFor(external.rev);
    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, documentId);
    const version = await ledger.readVersion(project.project_id, documentId, versionId);
    expect(head?.working_version_id).toBe(versionId);
    expect(version).toMatchObject({ parent_version_id: first.version_id, stage: "working", source: "external_human", provider_rev: external.rev });
    expect(dropbox.copies.some((copy) => copy.from === path && copy.to.includes(versionId))).toBe(true);
    expect(dropbox.downloads).not.toContain(path);
  });

  it("restores a deleted WORKING file from its immutable active version without advancing history", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const working = await createWorking(service, project, "draft to protect");
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    await dropbox.delete(path);

    const summary = await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [deleted(path)]);

    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(summary.restored).toBe(1);
    expect(dropbox.files.get(path)).toBe("draft to protect");
    expect(head?.working_version_id).toBe(working.version_id);
    expect(head?.provider?.working?.path).toBe(path);
  });

  it("captures an external REVIEW edit as a new review candidate without publishing it", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const working = await createWorking(service, project);
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const path = workspaceManagedDocumentPath(project.project_id, project.slug, "review", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(path, "human QA edit");

    await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(dropbox);
    const versionId = await externalVersionIdFor(external.rev);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.review_version_id).toBe(versionId);
    expect(head?.published_version_id).toBeUndefined();
    expect(await ledger.readVersion(project.project_id, working.document_id, versionId)).toMatchObject({ parent_version_id: review.version_id, stage: "review", source: "external_human" });
  });

  it("ingests INPUTS into REFERENCES/UNCLASSIFIED with a stable provider-file identity", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", "sources/market-study.pdf");
    const input = await dropbox.externalAdd(inputPath, "binary-opaque-pdf-bytes");

    await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [change(input)]);

    const target = workspaceManagedDocumentPath(project.project_id, project.slug, "references", "UNCLASSIFIED/sources/market-study.pdf");
    expect(dropbox.files.has(inputPath)).toBe(false);
    expect(dropbox.files.get(target)).toBe("binary-opaque-pdf-bytes");
    const documentId = await documentIdForProviderFile(project.project_id, input.id);
    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, documentId);
    expect(head).toMatchObject({ kind: "reference", logical_path: "sources/market-study.pdf", collection_path: "UNCLASSIFIED" });
    expect(head?.reference_version_id).toBeDefined();
    const version = await ledger.readVersion(project.project_id, documentId, head!.reference_version_id!);
    expect(version).toMatchObject({ stage: "reference", source: "input_ingest" });
  });

  it("turns a direct human DELIVERABLE edit into a new WORKING draft and restores the published bytes", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const working = await createWorking(service, project, "approved v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0002", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    const workingPath = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(publishedPath, "human post-publish changes");

    await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.working_version_id).toBe(await externalVersionIdFor(external.rev));
    expect(dropbox.files.get(publishedPath)).toBe("approved v1");
    expect(dropbox.files.get(workingPath)).toBe("human post-publish changes");
  });

  it("restores a deleted published deliverable without changing the frozen published version", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const working = await createWorking(service, project, "approved deletion-safe v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-DELETE-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-DELETE-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    await dropbox.delete(publishedPath);

    const summary = await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [deleted(publishedPath)]);

    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(summary.restored).toBe(1);
    expect(dropbox.files.get(publishedPath)).toBe("approved deletion-safe v1");
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.provider?.published?.path).toBe(publishedPath);
  });

  it("preserves an existing WORKING draft when a published deliverable is edited externally", async () => {
    const dropbox = new FakeDocumentDropbox();
    const project = state();
    const service = new ManagedDocumentService(dropbox);
    const working = await createWorking(service, project, "approved v1");
    const review = await service.promoteToReview({ request_id: "DOCREQ-REVIEW-0003", project_id: project.project_id, document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, project);
    const published = await service.publish({ request_id: "DOCREQ-PUBLISH-0002", project_id: project.project_id, document_id: working.document_id, expected_version_id: review.version_id, created_at: at }, project);
    const reopened = await service.reopenPublished({ request_id: "DOCREQ-REOPEN-0001", project_id: project.project_id, document_id: working.document_id, expected_version_id: published.version_id, created_at: at }, project);
    const aiDraft = await service.writeWorking({ request_id: "DOCREQ-WORKING-0002", project_id: project.project_id, logical_path: "strategy/commerciale.md", content: "new AI draft", content_sha256: await sha256("new AI draft"), expected_version_id: reopened.version_id, created_at: at }, project);
    const publishedPath = workspaceManagedDocumentPath(project.project_id, project.slug, "deliverables", "strategy/commerciale.md");
    const workingPath = workspaceManagedDocumentPath(project.project_id, project.slug, "working", "strategy/commerciale.md");
    const external = await dropbox.externalWrite(publishedPath, "human conflicting published edit");

    await new ManagedDocumentReconciler(dropbox).reconcileChanges(project, [change(external)]);

    const ledger = new DocumentLedgerRepository(dropbox);
    const head = await ledger.readHead(project.project_id, working.document_id);
    expect(head?.published_version_id).toBe(published.version_id);
    expect(head?.working_version_id).toBe(aiDraft.version_id);
    expect(head?.reconciliation_status).toBe("conflict");
    expect(dropbox.files.get(workingPath)).toBe("new AI draft");
    expect(dropbox.files.get(publishedPath)).toBe("approved v1");
    const recoveredId = await externalVersionIdFor(external.rev);
    expect(await ledger.readVersion(project.project_id, working.document_id, recoveredId)).toMatchObject({ stage: "recovered_external", source: "external_human", parent_version_id: published.version_id });
  });
});