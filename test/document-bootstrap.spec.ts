import { describe, expect, it } from "vitest";
import { documentIdFor } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ManagedDocumentBootstrapper } from "../src/documents/bootstrap";
import { sha256Text } from "../src/documents/hash";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, { content: string; metadata: DropboxFileMetadata }>();
  visibleUploads: string[] = [];
  copies: Array<{ from: string; to: string }> = [];
  private revision = 0;

  seed(path: string, content: string, id?: string): DropboxFileMetadata {
    this.set(path, content, id);
    return this.files.get(path)!.metadata;
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("conflict", "req-add", "path/conflict/file");
    this.set(path, content, this.files.get(path)?.metadata.id);
    if (path.includes("/WORKSPACE/PROJECTS/")) this.visibleUploads.push(path);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.files.get(path);
    if (!current || current.metadata.rev !== expectedRev) {
      throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    }
    this.set(path, content, current.metadata.id);
    if (path.includes("/WORKSPACE/PROJECTS/")) this.visibleUploads.push(path);
    return this.files.get(path)!.metadata;
  }

  async download(path: string): Promise<string | null> { return this.files.get(path)?.content ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.files.get(path)?.metadata ?? null; }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const source = this.files.get(from);
    if (!source) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("conflict", "req-copy", "to/conflict/file");
    this.set(to, source.content);
    this.copies.push({ from, to });
    return this.files.get(to)!.metadata;
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.files.get(from);
    if (!source) throw new Error(`missing ${from}`);
    this.files.delete(from);
    this.set(to, source.content, source.metadata.id);
  }

  private set(path: string, content: string, id?: string): void {
    this.revision += 1;
    this.files.set(path, {
      content,
      metadata: {
        id: id ?? `id:bootstrap-${this.revision}`,
        path,
        rev: `bootstrap-rev-${this.revision}`,
        content_hash: contentHash(content),
        size: new TextEncoder().encode(content).byteLength,
        server_modified: `2026-08-24T22:${String(this.revision).padStart(2, "0")}:00Z`
      }
    });
  }
}

function contentHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function state() {
  return emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
}

const logicalPath = "strategy/commercial.md";
const workingPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", logicalPath);
const publishedPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "deliverables", logicalPath);

describe("ManagedDocumentBootstrapper", () => {
  it("refuses to infer publication from an unknown DELIVERABLE provider file", async () => {
    const transport = new FakeTransport();
    const runtime = persistenceFromDropbox(transport);
    const content = "# Strategy\n\nUnknown provider file";
    const metadata = transport.seed(publishedPath, content, "id:published-unknown");
    const bootstrap = new ManagedDocumentBootstrapper(runtime);

    await expect(bootstrap.bootstrapExistingManagedPath(state(), publishedPath, metadata, "published"))
      .rejects.toThrow(/published provenance/i);

    const documentId = await documentIdFor("PRJ-0002", logicalPath);
    expect(await new DocumentLedgerRepository(runtime).readHead("PRJ-0002", documentId)).toBeNull();
    expect(transport.files.get(publishedPath)?.content).toBe(content);
    expect(transport.visibleUploads).toEqual([]);
    expect(transport.copies).toHaveLength(0);
  });

  it("adopts a DELIVERABLE only when explicit legacy artifact provenance is supplied", async () => {
    const transport = new FakeTransport();
    const content = "# Strategy\n\nPublished legacy version";
    const metadata = transport.seed(publishedPath, content, "id:published-legacy");
    const bootstrap = new ManagedDocumentBootstrapper(persistenceFromDropbox(transport));

    const result = await bootstrap.bootstrapExistingManagedPath(
      state(), publishedPath, metadata, "published", { publishedProvenance: "legacy_artifact" }
    );

    expect(result.adopted).toBe(true);
    expect(result.head.published_version_id).toBe(result.version.version_id);
    expect(result.version.stage).toBe("published");
    expect(result.version.source).toBe("legacy_artifact_api");
    expect(transport.files.get(publishedPath)?.content).toBe(content);
    expect(transport.visibleUploads).toEqual([]);
    expect(transport.copies).toHaveLength(1);
  });

  it("adopts a pre-ledger WORKING file and the next AI write updates it through CAS", async () => {
    const transport = new FakeTransport();
    const runtime = persistenceFromDropbox(transport);
    const content = "# Strategy\n\nHuman draft";
    const metadata = transport.seed(workingPath, content, "id:working-legacy");
    const bootstrap = new ManagedDocumentBootstrapper(runtime);
    const adopted = await bootstrap.bootstrapExistingManagedPath(state(), workingPath, metadata, "working");
    const service = new ManagedDocumentService(runtime);
    const next = "# Strategy\n\nHuman draft\n\n## ICP\nMid-market";

    const receipt = await service.writeWorking({
      request_id: "DOCREQ-BOOTSTRAP-0001",
      project_id: "PRJ-0002",
      logical_path: logicalPath,
      content: next,
      content_sha256: await sha256Text(next),
      expected_version_id: adopted.version.version_id,
      created_at: "2026-08-24T23:20:00+01:00"
    }, state());

    expect(receipt.status).toBe("committed");
    expect(receipt.version_id).not.toBe(adopted.version.version_id);
    expect(transport.files.get(workingPath)?.content).toContain(next);
    expect(transport.visibleUploads).toEqual([workingPath]);
  });

  it("merges an explicitly governed published baseline and a later WORKING baseline", async () => {
    const transport = new FakeTransport();
    const published = transport.seed(publishedPath, "# Strategy\n\nPublished V10", "id:pub-same-doc");
    const bootstrap = new ManagedDocumentBootstrapper(persistenceFromDropbox(transport));
    const publishedAdoption = await bootstrap.bootstrapExistingManagedPath(
      state(), publishedPath, published, "published", { publishedProvenance: "legacy_artifact" }
    );
    const working = transport.seed(workingPath, "# Strategy\n\nPublished V10\n\nNew iteration", "id:work-same-doc");

    const workingAdoption = await bootstrap.bootstrapExistingManagedPath(state(), workingPath, working, "working");

    expect(workingAdoption.head.document_id).toBe(publishedAdoption.head.document_id);
    expect(workingAdoption.head.published_version_id).toBe(publishedAdoption.version.version_id);
    expect(workingAdoption.head.working_version_id).toBe(workingAdoption.version.version_id);
    expect(workingAdoption.version.parent_version_id).toBe(publishedAdoption.version.version_id);
    expect(transport.files.get(publishedPath)?.content).toContain("Published V10");
    expect(transport.files.get(workingPath)?.content).toContain("New iteration");
    expect(transport.visibleUploads).toEqual([]);
  });

  it("adopts an already-classified reference while preserving its collection path and provider identity", async () => {
    const transport = new FakeTransport();
    const referencePath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "references", "MARKET/Reports/crm.pdf");
    const metadata = transport.seed(referencePath, "%PDF CRM market report", "id:reference-existing");
    const bootstrap = new ManagedDocumentBootstrapper(persistenceFromDropbox(transport));

    const result = await bootstrap.bootstrapExistingManagedPath(state(), referencePath, metadata, "reference");

    expect(result.head.kind).toBe("reference");
    expect(result.head.collection_path).toBe("MARKET/Reports");
    expect(result.head.logical_path).toBe("crm.pdf");
    expect(result.head.provider?.reference?.file_id).toBe("id:reference-existing");
    expect(transport.files.get(referencePath)?.content).toBe("%PDF CRM market report");
    expect(transport.visibleUploads).toEqual([]);
  });

  it("uses a durable provider-file binding during baseline rebuild instead of duplicating an ingested reference", async () => {
    const transport = new FakeTransport();
    const runtime = persistenceFromDropbox(transport);
    const referencePath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "references", "UNCLASSIFIED/report.pdf");
    const bootstrap = new ManagedDocumentBootstrapper(runtime);
    const originalMetadata = transport.seed(referencePath, "%PDF durable source", "id:reference-original");
    const original = await bootstrap.bootstrapExistingManagedPath(state(), referencePath, originalMetadata, "reference");

    const copiedMetadata = transport.seed(referencePath, "%PDF durable source", "id:reference-after-copy");
    const ledger = new DocumentLedgerRepository(runtime);
    await ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: "PRJ-0002",
      provider_file_id: copiedMetadata.id,
      document_id: original.head.document_id
    });

    const rebuilt = await bootstrap.bootstrapExistingManagedPath(state(), referencePath, copiedMetadata, "reference");

    expect(rebuilt.adopted).toBe(false);
    expect(rebuilt.head.document_id).toBe(original.head.document_id);
    expect(rebuilt.version.version_id).toBe(original.version.version_id);
  });
});