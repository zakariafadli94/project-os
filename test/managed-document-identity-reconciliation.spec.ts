import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  copies: Array<{ from: string; to: string }> = [];
  private rev = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req", "path/conflict/file");
    this.set(path, content, this.metadata.get(path)?.id);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req", "path/conflict/file");
    return this.set(path, content, current.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) throw new DropboxConflictError("missing", "req", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req", "to/conflict/file");
    this.files.delete(from);
    this.metadata.delete(from);
    this.set(to, content, metadata.id);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    this.copies.push({ from, to });
    return this.set(to, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
  }

  externalWrite(path: string, content: string): DropboxFileMetadata {
    return this.set(path, content, this.metadata.get(path)?.id);
  }

  private set(path: string, content: string, id?: string): DropboxFileMetadata {
    this.rev += 1;
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:identity-reconcile-${this.rev}`,
      path,
      rev: `identity-reconcile-rev-${this.rev}`,
      content_hash: fakeHash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: `2026-08-30T16:${String(this.rev).padStart(2, "0")}:00Z`
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

function fakeHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function project() {
  return emptyProjectState("PRJ-4001", "Document Project", "document-project", "Identity reconciliation");
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

describe("ManagedDocumentReconciler visible identity guard", () => {
  it("refuses to capture an external WORKING edit whose visible document_id is forged", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const service = new ManagedDocumentService(runtime);
    const source = "# Strategy\n\nDraft\n";
    const working = await service.writeWorking({
      request_id: "DOCREQ-IDENTITY-RECONCILE-001",
      project_id: state.project_id,
      logical_path: "strategy/commerciale.md",
      content: source,
      content_sha256: await sha256Text(source),
      created_at: "2026-08-30T17:00:00+01:00"
    }, state);

    const path = workspaceManagedDocumentPath(state.project_id, state.slug, "working", "strategy/commerciale.md");
    const current = dropbox.files.get(path)!;
    expect(current).toContain(`document_id: ${working.document_id}\n`);
    const forged = current.replace(
      `document_id: ${working.document_id}`,
      "document_id: DOC-AAAAAAAAAAAAAAAAAAAAAAAA"
    );
    const external = dropbox.externalWrite(path, forged);

    const summary = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [change(external)]);

    const ledger = new DocumentLedgerRepository(runtime);
    const head = await ledger.readHead(state.project_id, working.document_id);
    expect(summary.conflicts).toBe(1);
    expect(summary.captured).toBe(0);
    expect(head?.working_version_id).toBe(working.version_id);
    expect(dropbox.copies.some((entry) => entry.from === path)).toBe(false);
  });

  it("still accepts a historical Markdown edit with no visible identity", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const service = new ManagedDocumentService(runtime);
    const source = "# Legacy\n\nDraft\n";
    const working = await service.writeWorking({
      request_id: "DOCREQ-IDENTITY-RECONCILE-002",
      project_id: state.project_id,
      logical_path: "strategy/legacy.md",
      content: source,
      content_sha256: await sha256Text(source),
      created_at: "2026-08-30T17:00:00+01:00"
    }, state);
    const path = workspaceManagedDocumentPath(state.project_id, state.slug, "working", "strategy/legacy.md");
    const historicalExternal = dropbox.externalWrite(path, "# Legacy\n\nHuman edit without frontmatter\n");

    const summary = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [change(historicalExternal)]);

    const head = await new DocumentLedgerRepository(runtime).readHead(state.project_id, working.document_id);
    expect(summary.conflicts).toBe(0);
    expect(summary.captured).toBe(1);
    expect(head?.working_version_id).not.toBe(working.version_id);
  });
});
