import { describe, expect, it } from "vitest";
import type { DropboxFileMetadata, DropboxTransport } from "../src/persistence/providers/dropbox/client";
import { DropboxConflictError } from "../src/persistence/providers/dropbox/client";
import { machineDocumentProviderPayloadPath } from "../src/persistence/layout";
import { sha256Text } from "../src/documents/hash";
import { DocumentLedgerRepository } from "../src/documents/repository";
import {
  buildManagedDocumentSearchRecord,
  buildManagedDocumentSearchRecords
} from "../src/search/document-records";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class SearchDocumentDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    }
    await this.setFile(path, content, this.metadata.get(path)?.id);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) {
      throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    }
    if (this.files.has(to)) {
      throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    }
    this.files.delete(from);
    this.metadata.delete(from);
    await this.setFile(to, content, metadata.id);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
  }

  async listFolder(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({
        tag: "file" as const,
        name: candidate.slice(prefix.length),
        path_display: candidate
      }));
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    return this.metadata.get(path) ?? null;
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    if (this.files.has(to)) {
      throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    }
    const content = this.files.get(from);
    if (content === undefined) {
      throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    }
    return this.setFile(to, content);
  }

  async externalAdd(path: string, content: string): Promise<DropboxFileMetadata> {
    return this.setFile(path, content);
  }

  private async setFile(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:S${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-09-01T10:30:00.000Z"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

const projectId = "PRJ-7001";
const workDocumentId = "DOC-AAAAAAAAAAAAAAAAAAAAAAAA";
const referenceDocumentId = "DOC-BBBBBBBBBBBBBBBBBBBBBBBB";
const binaryDocumentId = "DOC-CCCCCCCCCCCCCCCCCCCCCCCC";
const publishedVersionId = "VER-REQ-111111111111111111111111";
const workingVersionId = "VER-REQ-222222222222222222222222";
const referenceVersionId = "VER-EXT-333333333333333333333333";
const binaryVersionId = "VER-EXT-444444444444444444444444";

async function writeProjectOsTextVersion(
  ledger: DocumentLedgerRepository,
  input: {
    documentId: string;
    versionId: string;
    parentVersionId?: string;
    stage: "working" | "published";
    logicalPath: string;
    content: string;
  }
) {
  const contentSha256 = await sha256Text(input.content);
  const immutablePayloadPath = await ledger.storeTextPayload(projectId, contentSha256, input.content);
  await ledger.writeVersion({
    schema_version: "1.0",
    project_id: projectId,
    document_id: input.documentId,
    version_id: input.versionId,
    ...(input.parentVersionId ? { parent_version_id: input.parentVersionId } : {}),
    kind: "work_product",
    stage: input.stage,
    logical_path: input.logicalPath,
    source: "project_os",
    created_at: "2026-09-01T10:30:00+01:00",
    immutable_payload_path: immutablePayloadPath,
    content_sha256: contentSha256,
    media_type: "text/markdown"
  });
}

async function writeExternalVersion(
  dropbox: SearchDocumentDropbox,
  ledger: DocumentLedgerRepository,
  input: {
    documentId: string;
    versionId: string;
    kind: "reference" | "work_product";
    stage: "reference" | "working";
    logicalPath: string;
    visiblePath: string;
    content: string;
    mediaType: string;
  }
) {
  const source = await dropbox.externalAdd(input.visiblePath, input.content);
  await ledger.snapshotProviderFile(projectId, input.documentId, input.versionId, input.visiblePath, source);
  await ledger.writeVersion({
    schema_version: "1.0",
    project_id: projectId,
    document_id: input.documentId,
    version_id: input.versionId,
    kind: input.kind,
    stage: input.stage,
    logical_path: input.logicalPath,
    source: "external_human",
    created_at: source.server_modified ?? "2026-09-01T10:30:00.000Z",
    immutable_payload_path: machineDocumentProviderPayloadPath(projectId, input.documentId, input.versionId),
    provider_content_hash: source.content_hash,
    provider_file_id: source.id,
    provider_rev: source.rev,
    provider_path: input.visiblePath,
    size: source.size,
    media_type: input.mediaType
  });
  return source;
}

describe("managed document search projection", () => {
  it("chooses a current working head before its published ancestor and verifies Project OS text", async () => {
    const dropbox = new SearchDocumentDropbox();
    const ledger = new DocumentLedgerRepository(persistenceFromDropbox(dropbox));
    const published = "# Commercial strategy\n\nPublished baseline";
    const working = `${published}\n\nWorking iteration`;

    await writeProjectOsTextVersion(ledger, {
      documentId: workDocumentId,
      versionId: publishedVersionId,
      stage: "published",
      logicalPath: "strategy/commercial.md",
      content: published
    });
    await writeProjectOsTextVersion(ledger, {
      documentId: workDocumentId,
      versionId: workingVersionId,
      parentVersionId: publishedVersionId,
      stage: "working",
      logicalPath: "strategy/commercial.md",
      content: working
    });
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: projectId,
      document_id: workDocumentId,
      kind: "work_product",
      logical_path: "strategy/commercial.md",
      working_version_id: workingVersionId,
      published_version_id: publishedVersionId,
      reconciliation_status: "clean"
    });

    const record = await buildManagedDocumentSearchRecord(ledger, projectId, workDocumentId);

    expect(record).toMatchObject({
      project_id: projectId,
      record_id: `document:${workDocumentId}`,
      document_id: workDocumentId,
      version_id: workingVersionId,
      title: "commercial",
      logical_path: "strategy/commercial.md",
      zone: "working",
      stage_or_collection: "working",
      reconciliation_status: "clean",
      body_text: working,
      media_type: "text/markdown",
      authority_ref: {
        kind: "managed_document",
        project_id: projectId,
        document_id: workDocumentId,
        version_id: workingVersionId,
        logical_path: "strategy/commercial.md",
        content_sha256: await sha256Text(working)
      }
    });
  });

  it("keeps externally captured markdown full-text searchable after immutable snapshot verification", async () => {
    const dropbox = new SearchDocumentDropbox();
    const ledger = new DocumentLedgerRepository(persistenceFromDropbox(dropbox));
    const content = "# Human draft\n\nExternal edit retained";
    const visiblePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-search/WORKING/notes/human.md";

    await writeExternalVersion(dropbox, ledger, {
      documentId: workDocumentId,
      versionId: workingVersionId,
      kind: "work_product",
      stage: "working",
      logicalPath: "notes/human.md",
      visiblePath,
      content,
      mediaType: "text/markdown"
    });
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: projectId,
      document_id: workDocumentId,
      kind: "work_product",
      logical_path: "notes/human.md",
      working_version_id: workingVersionId,
      reconciliation_status: "clean"
    });

    expect(await buildManagedDocumentSearchRecord(ledger, projectId, workDocumentId)).toMatchObject({
      document_id: workDocumentId,
      version_id: workingVersionId,
      zone: "working",
      body_text: content
    });
  });

  it("projects reference collection identity and reports binary governed content as metadata only", async () => {
    const dropbox = new SearchDocumentDropbox();
    const ledger = new DocumentLedgerRepository(persistenceFromDropbox(dropbox));

    const referencePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-search/REFERENCES/VENDORS/report.md";
    const referenceMeta = await writeExternalVersion(dropbox, ledger, {
      documentId: referenceDocumentId,
      versionId: referenceVersionId,
      kind: "reference",
      stage: "reference",
      logicalPath: "report.md",
      visiblePath: referencePath,
      content: "# Vendor report\n\nGoverned reference",
      mediaType: "text/markdown"
    });
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: projectId,
      document_id: referenceDocumentId,
      kind: "reference",
      logical_path: "report.md",
      collection_path: "VENDORS",
      reference_version_id: referenceVersionId,
      provider: {
        reference: {
          path: referencePath,
          file_id: referenceMeta.id,
          rev: referenceMeta.rev,
          content_hash: referenceMeta.content_hash,
          size: referenceMeta.size
        }
      },
      reconciliation_status: "conflict"
    });

    const binaryPath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-search/REFERENCES/FILES/archive.pdf";
    const binaryMeta = await writeExternalVersion(dropbox, ledger, {
      documentId: binaryDocumentId,
      versionId: binaryVersionId,
      kind: "reference",
      stage: "reference",
      logicalPath: "archive.pdf",
      visiblePath: binaryPath,
      content: "%PDF-test-bytes",
      mediaType: "application/pdf"
    });
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: projectId,
      document_id: binaryDocumentId,
      kind: "reference",
      logical_path: "archive.pdf",
      collection_path: "FILES",
      reference_version_id: binaryVersionId,
      provider: {
        reference: {
          path: binaryPath,
          file_id: binaryMeta.id,
          rev: binaryMeta.rev,
          content_hash: binaryMeta.content_hash,
          size: binaryMeta.size
        }
      },
      reconciliation_status: "clean"
    });

    const [reference, binary] = await buildManagedDocumentSearchRecords(
      ledger,
      projectId,
      [binaryDocumentId, referenceDocumentId]
    );

    expect(reference).toMatchObject({
      document_id: binaryDocumentId,
      version_id: binaryVersionId,
      zone: "references",
      stage_or_collection: "FILES",
      media_type: "application/pdf"
    });
    expect(reference?.body_text).toBeUndefined();

    expect(binary).toMatchObject({
      document_id: referenceDocumentId,
      version_id: referenceVersionId,
      zone: "references",
      stage_or_collection: "VENDORS",
      reconciliation_status: "conflict",
      body_text: "# Vendor report\n\nGoverned reference"
    });
    expect(await ledger.listHeadIds(projectId)).toEqual([referenceDocumentId, binaryDocumentId]);
  });

  it("fails closed when immutable Project OS text no longer matches its declared SHA-256", async () => {
    const dropbox = new SearchDocumentDropbox();
    const ledger = new DocumentLedgerRepository(persistenceFromDropbox(dropbox));
    const content = "# Verified";
    const contentSha256 = await sha256Text(content);
    const immutablePayloadPath = await ledger.storeTextPayload(projectId, contentSha256, content);
    await ledger.writeVersion({
      schema_version: "1.0",
      project_id: projectId,
      document_id: workDocumentId,
      version_id: workingVersionId,
      kind: "work_product",
      stage: "working",
      logical_path: "verified.md",
      source: "project_os",
      created_at: "2026-09-01T10:30:00+01:00",
      immutable_payload_path: immutablePayloadPath,
      content_sha256: contentSha256,
      media_type: "text/markdown"
    });
    await ledger.writeHead({
      schema_version: "1.0",
      project_id: projectId,
      document_id: workDocumentId,
      kind: "work_product",
      logical_path: "verified.md",
      working_version_id: workingVersionId,
      reconciliation_status: "clean"
    });
    dropbox.files.set(immutablePayloadPath, "tampered");

    await expect(buildManagedDocumentSearchRecord(ledger, projectId, workDocumentId)).rejects.toThrow(/SHA-256|hash|integrity/i);
  });
});
