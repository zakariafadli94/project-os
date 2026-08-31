import { describe, expect, it } from "vitest";
import { documentIdForProviderFile, externalVersionIdFor } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { InputIntakeService } from "../src/documents/input-intake-service";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { DocumentLedgerRepository } from "../src/documents/repository";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class ReferenceDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  failDeleteOnce: string | null = null;
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    await this.setFile(path, content, this.metadata.get(path)?.id);
  }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    return this.setFile(path, content, current.id);
  }
  async move(from: string, to: string): Promise<void> {
    if (this.files.has(to)) throw new DropboxConflictError("destination exists", "req-move", "to/conflict/file");
    const content = this.files.get(from);
    const meta = this.metadata.get(from);
    if (content === undefined || !meta) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    this.files.delete(from); this.metadata.delete(from);
    await this.setFile(to, content, meta.id);
  }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    if (this.files.has(to)) throw new DropboxConflictError("destination exists", "req-copy", "to/conflict/file");
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    return this.setFile(to, content);
  }
  async delete(path: string): Promise<void> {
    if (this.failDeleteOnce === path) {
      this.failDeleteOnce = null;
      throw new Error("injected stale INPUTS cleanup crash");
    }
    this.files.delete(path);
    this.metadata.delete(path);
  }
  async listFolder(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }
  async externalAdd(path: string, content: string): Promise<DropboxFileMetadata> { return this.setFile(path, content); }
  async externalWrite(path: string, content: string): Promise<DropboxFileMetadata> { return this.setFile(path, content, this.metadata.get(path)?.id); }

  private async setFile(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:R${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await hash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-24T19:15:00.000Z"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

const project = () => emptyProjectState("PRJ-4010", "Reference Project", "reference-project", "Reference tests");

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function change(meta: DropboxFileMetadata): ProviderChangeEntry {
  return {
    kind: "file",
    name: meta.path.split("/").at(-1)!,
    path: meta.path,
    metadata: {
      path: meta.path,
      size: meta.size,
      ...(meta.server_modified ? { modifiedAt: meta.server_modified } : {}),
      objectId: meta.id,
      revisionToken: meta.rev,
      integrityHash: { algorithm: "dropbox-content-hash", value: meta.content_hash }
    }
  };
}

describe("reference reconciliation", () => {
  it("captures a human edit of a managed reference as a new reference version", async () => {
    const dropbox = new ReferenceDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const inputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "market/report.pdf");
    const first = await dropbox.externalAdd(inputPath, "report-v1");
    const reconciler = new ManagedDocumentReconciler(runtime);
    await reconciler.reconcileChanges(state, [change(first)]);

    const referencePath = workspaceManagedDocumentPath(state.project_id, state.slug, "references", "UNCLASSIFIED/market/report.pdf");
    const edited = await dropbox.externalWrite(referencePath, "report-v2-human");
    await reconciler.reconcileChanges(state, [change(edited)]);

    const documentId = await documentIdForProviderFile(state.project_id, first.id);
    const versionId = await externalVersionIdFor(edited.rev);
    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(state.project_id, documentId);
    expect(head?.reference_version_id).toBe(versionId);
    expect(head?.provider?.reference).toMatchObject({ path: referencePath, rev: edited.rev, content_hash: edited.content_hash });
    expect(await ledger.readVersion(state.project_id, documentId, versionId)).toMatchObject({ stage: "reference", source: "external_human" });
  });

  it("resumes a reference-committed intake instead of hiding stale INPUTS cleanup under ignored", async () => {
    const dropbox = new ReferenceDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const inputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "stale/report.pdf");
    const source = await dropbox.externalAdd(inputPath, "stale-source-bytes");
    const sourceChange = change(source);
    dropbox.failDeleteOnce = inputPath;

    await expect(new InputIntakeService(runtime).ingest(state, {
      sourcePath: inputPath,
      relativeInputPath: "stale/report.pdf",
      metadata: sourceChange.metadata!
    })).rejects.toThrow(/cleanup crash/i);
    expect(dropbox.files.has(inputPath)).toBe(true);

    const result = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [sourceChange]);
    const metrics = result as unknown as Record<string, number>;

    expect(metrics).toMatchObject({
      ingested: 1,
      ignored: 0,
      intake_completed: 1,
      intake_resumed: 1
    });
    expect(dropbox.files.has(inputPath)).toBe(false);
  });

  it("removes a duplicate INPUTS file when identical content is already the current managed reference", async () => {
    const dropbox = new ReferenceDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const firstPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "market/report.pdf");
    const first = await dropbox.externalAdd(firstPath, "same-report-bytes");
    const reconciler = new ManagedDocumentReconciler(runtime);
    await reconciler.reconcileChanges(state, [change(first)]);

    const secondPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "duplicates/report-copy.pdf");
    const duplicate = await dropbox.externalAdd(secondPath, "same-report-bytes");
    const result = await reconciler.reconcileChanges(state, [change(duplicate)]);
    const metrics = result as unknown as Record<string, number>;

    const ledger = new DocumentLedgerRepository(runtime);
    const fingerprint = await ledger.readReferenceFingerprint(state.project_id, duplicate.content_hash);
    const originalDocumentId = await documentIdForProviderFile(state.project_id, first.id);
    const duplicateDocumentId = await documentIdForProviderFile(state.project_id, duplicate.id);
    expect(metrics).toMatchObject({ duplicates: 1, duplicate_cleaned: 1 });
    expect(dropbox.files.has(secondPath)).toBe(false);
    expect(fingerprint?.document_id).toBe(originalDocumentId);
    expect(await ledger.readHead(state.project_id, duplicateDocumentId)).toBeNull();
  });

  it("does not deduplicate against an old historical fingerprint after the managed reference changed", async () => {
    const dropbox = new ReferenceDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const originalInput = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "market/report.pdf");
    const first = await dropbox.externalAdd(originalInput, "old-report-bytes");
    const reconciler = new ManagedDocumentReconciler(runtime);
    await reconciler.reconcileChanges(state, [change(first)]);

    const referencePath = workspaceManagedDocumentPath(state.project_id, state.slug, "references", "UNCLASSIFIED/market/report.pdf");
    const edited = await dropbox.externalWrite(referencePath, "new-current-report-bytes");
    await reconciler.reconcileChanges(state, [change(edited)]);

    const newInputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "historical/old-report.pdf");
    const historicalCopy = await dropbox.externalAdd(newInputPath, "old-report-bytes");
    const result = await reconciler.reconcileChanges(state, [change(historicalCopy)]);
    const metrics = result as unknown as Record<string, number>;

    const secondDocumentId = await documentIdForProviderFile(state.project_id, historicalCopy.id);
    const ledger = new DocumentLedgerRepository(runtime);
    expect(metrics).toMatchObject({ ingested: 1, intake_completed: 1, duplicates: 0 });
    expect(await ledger.readHead(state.project_id, secondDocumentId)).toMatchObject({
      kind: "reference",
      logical_path: "historical/old-report.pdf",
      collection_path: "UNCLASSIFIED"
    });
  });
});
