import { describe, expect, it } from "vitest";
import { documentIdForProviderFile } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";

class ReferenceTransport implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  private n = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req", "path/conflict/file");
    await this.set(path, content, this.metadata.get(path)?.id);
  }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from); const meta = this.metadata.get(from);
    if (content === undefined || !meta) throw new DropboxConflictError("missing", "req", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req", "to/conflict/file");
    this.files.delete(from); this.metadata.delete(from); await this.set(to, content, meta.id);
  }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from); if (content === undefined) throw new Error("missing");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req", "to/conflict/file");
    return this.set(to, content);
  }
  async delete(path: string): Promise<void> { this.files.delete(path); this.metadata.delete(path); }
  async listFolder(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => ({ tag: "file" as const, name: p.slice(prefix.length), path_display: p }));
  }
  async externalAdd(path: string, content: string) { return this.set(path, content); }

  private async set(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    this.n += 1;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const metadata = { id: id ?? `id:C${this.n}`, path, rev: `rev-${this.n}`, content_hash: hash, size: content.length };
    this.files.set(path, content); this.metadata.set(path, metadata); return metadata;
  }
}

describe("managed reference classification", () => {
  it("moves an ingested reference into a project taxonomy without changing logical document identity", async () => {
    const dropbox = new ReferenceTransport();
    const state = emptyProjectState("PRJ-4020", "Reference", "reference", "Classify refs");
    const inputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "market/report.pdf");
    const input = await dropbox.externalAdd(inputPath, "report bytes");
    await new ManagedDocumentReconciler(dropbox).reconcileChanges(state, [{
      tag: "file", name: "report.pdf", path: inputPath, id: input.id, rev: input.rev,
      content_hash: input.content_hash, size: input.size
    }]);

    const documentId = await documentIdForProviderFile(state.project_id, input.id);
    const ledger = new DocumentLedgerRepository(dropbox);
    const before = await ledger.readHead(state.project_id, documentId);
    const receipt = await new ManagedDocumentService(dropbox).classifyReference({
      request_id: "DOCREQ-CLASSIFY-0001",
      project_id: state.project_id,
      document_id: documentId,
      expected_version_id: before!.reference_version_id,
      collection_path: "MARKET/Reports",
      created_at: "2026-08-24T19:20:00+01:00"
    }, state);

    const target = workspaceManagedDocumentPath(state.project_id, state.slug, "references", "MARKET/Reports/market/report.pdf");
    const after = await ledger.readHead(state.project_id, documentId);
    expect(receipt.document_id).toBe(documentId);
    expect(receipt.stage).toBe("reference");
    expect(after).toMatchObject({
      document_id: documentId,
      collection_path: "MARKET/Reports",
      reference_version_id: receipt.version_id
    });
    expect(dropbox.files.get(target)).toBe("report bytes");
    expect(await ledger.readVersion(state.project_id, documentId, receipt.version_id)).toMatchObject({
      parent_version_id: before!.reference_version_id,
      stage: "reference",
      source: "project_os",
      logical_path: "market/report.pdf"
    });
  });
});
