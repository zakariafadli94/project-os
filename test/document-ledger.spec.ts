import { describe, expect, it } from "vitest";
import type { DocumentVersionRecord, ManagedDocumentHead } from "../src/domain/managed-document";
import { DropboxConflictError, type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { machineDocumentProviderPayloadPath, machineDocumentTextPayloadPath } from "../src/dropbox/layout";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { sha256Text } from "../src/documents/hash";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  downloads: string[] = [];
  copies: Array<{ from: string; to: string }> = [];

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError("conflict", "req-add", "path/conflict/file");
    }
    this.files.set(path, content);
  }

  async download(path: string): Promise<string | null> {
    this.downloads.push(path);
    return this.files.get(path) ?? null;
  }

  async move(): Promise<void> { throw new Error("unused"); }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    return this.metadata.get(path) ?? null;
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    this.copies.push({ from, to });
    if (this.metadata.has(to)) throw new DropboxConflictError("copy conflict", "req-copy", "to/conflict/file");
    const source = this.metadata.get(from);
    if (!source) throw new Error(`missing source metadata ${from}`);
    const copied = { ...source, id: `id:copy-${this.copies.length}`, path: to, rev: `copy-${this.copies.length}` };
    this.metadata.set(to, copied);
    return copied;
  }
}

const projectId = "PRJ-0002";
const documentId = "DOC-0123456789ABCDEF01234567";
const v1 = "VER-REQ-111111111111111111111111";
const v2 = "VER-REQ-222222222222222222222222";
const v3 = "VER-REQ-333333333333333333333333";

function record(overrides: Partial<DocumentVersionRecord> = {}): DocumentVersionRecord {
  return {
    schema_version: "1.0",
    project_id: projectId,
    document_id: documentId,
    version_id: v1,
    kind: "work_product",
    stage: "working",
    logical_path: "strategy/commercial.md",
    source: "project_os",
    created_at: "2026-08-24T19:00:00+01:00",
    immutable_payload_path: machineDocumentTextPayloadPath(projectId, "a".repeat(64)),
    content_sha256: "a".repeat(64),
    request_id: "DOCREQ-WORK-000001",
    ...overrides
  };
}

function head(overrides: Partial<ManagedDocumentHead> = {}): ManagedDocumentHead {
  return {
    schema_version: "1.0",
    project_id: projectId,
    document_id: documentId,
    kind: "work_product",
    logical_path: "strategy/commercial.md",
    working_version_id: v1,
    reconciliation_status: "clean",
    ...overrides
  };
}

describe("DocumentLedgerRepository", () => {
  it("writes immutable versions idempotently and rejects different content at the same version path", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    const first = record();

    await repository.writeVersion(first);
    await expect(repository.writeVersion(first)).resolves.toBeUndefined();
    await expect(repository.writeVersion(record({ logical_path: "strategy/other.md" }))).rejects.toThrow(/Immutable document version conflict/);
  });

  it("does not advance a document head to a missing version", async () => {
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(new FakeTransport()));
    await expect(repository.writeHead(head())).rejects.toThrow(/missing version/i);
  });

  it("stores text payloads content-addressed and verifies caller hashes", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    const content = "# Commercial strategy";
    const hash = await sha256Text(content);

    await expect(repository.storeTextPayload(projectId, hash, content))
      .resolves.toBe(machineDocumentTextPayloadPath(projectId, hash));
    await repository.storeTextPayload(projectId, hash, content);
    expect([...transport.files.keys()].filter((path) => path === machineDocumentTextPayloadPath(projectId, hash))).toHaveLength(1);
    await expect(repository.storeTextPayload(projectId, "a".repeat(64), content)).rejects.toThrow(/SHA-256/i);
  });

  it("snapshots an opaque provider file with a server-side copy and no content download", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    const source = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/report.pdf";
    const sourceMetadata: DropboxFileMetadata = {
      id: "id:source",
      path: source,
      rev: "015source",
      content_hash: "b".repeat(64),
      size: 50_000
    };
    transport.metadata.set(source, sourceMetadata);

    const snapshot = await repository.snapshotProviderFile(projectId, documentId, v1, source, sourceMetadata);

    expect(snapshot.path).toBe(machineDocumentProviderPayloadPath(projectId, documentId, v1));
    expect(transport.copies).toEqual([{ from: source, to: snapshot.path }]);
    expect(transport.downloads).not.toContain(source);
  });

  it("rebuilds independent published and newer working pointers from causal immutable versions", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    const published = record({
      version_id: v1,
      stage: "published",
      created_at: "2026-08-24T18:00:00+01:00",
      provider_content_hash: "1".repeat(64),
      provider_file_id: "id:published",
      provider_rev: "rev-published",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/strategy/commercial.md",
      size: 100
    });
    const working = record({
      version_id: v2,
      parent_version_id: v1,
      stage: "working",
      created_at: "2026-08-24T19:00:00+01:00",
      content_sha256: "b".repeat(64),
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, "b".repeat(64)),
      request_id: "DOCREQ-WORK-000002",
      provider_content_hash: "2".repeat(64),
      provider_file_id: "id:working",
      provider_rev: "rev-working",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/strategy/commercial.md",
      size: 120
    });
    await repository.writeVersion(published);
    await repository.writeVersion(working);

    const restored = await repository.restoreHeadFromVersions(projectId, documentId);

    expect(restored).toMatchObject({
      published_version_id: v1,
      working_version_id: v2,
      reconciliation_status: "clean",
      provider: {
        published: { rev: "rev-published", file_id: "id:published" },
        working: { rev: "rev-working", file_id: "id:working" }
      }
    });
    expect(restored?.review_version_id).toBeUndefined();
    expect(await repository.readHead(projectId, documentId)).toEqual(restored);
  });

  it("uses a newer live provider rev during head recovery when bytes still match immutable evidence", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    const publishedPath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/strategy/commercial.md";
    const immutable = record({
      version_id: v1,
      stage: "published",
      provider_content_hash: "3".repeat(64),
      provider_file_id: "id:published-old",
      provider_rev: "rev-old",
      provider_path: publishedPath,
      size: 140
    });
    await repository.writeVersion(immutable);
    transport.metadata.set(publishedPath, {
      id: "id:published-restored",
      path: publishedPath,
      rev: "rev-new-after-restore",
      content_hash: "3".repeat(64),
      size: 140
    });

    const restored = await repository.restoreHeadFromVersions(projectId, documentId);

    expect(restored?.published_version_id).toBe(v1);
    expect(restored?.provider?.published).toMatchObject({
      file_id: "id:published-restored",
      rev: "rev-new-after-restore",
      content_hash: "3".repeat(64),
      size: 140
    });
  });

  it("does not resurrect consumed working or review pointers after a completed publication", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    await repository.writeVersion(record({
      version_id: v1,
      stage: "working",
      created_at: "2026-08-24T18:00:00+01:00"
    }));
    await repository.writeVersion(record({
      version_id: v2,
      parent_version_id: v1,
      stage: "review",
      created_at: "2026-08-24T18:10:00+01:00",
      content_sha256: "b".repeat(64),
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, "b".repeat(64)),
      request_id: "DOCREQ-REVIEW-000001"
    }));
    await repository.writeVersion(record({
      version_id: v3,
      parent_version_id: v2,
      stage: "published",
      created_at: "2026-08-24T18:20:00+01:00",
      content_sha256: "c".repeat(64),
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, "c".repeat(64)),
      request_id: "DOCREQ-PUBLISH-000001"
    }));

    const restored = await repository.restoreHeadFromVersions(projectId, documentId);

    expect(restored?.published_version_id).toBe(v3);
    expect(restored?.working_version_id).toBeUndefined();
    expect(restored?.review_version_id).toBeUndefined();
  });

  it("keeps the frozen published ancestor while restoring a newer active review candidate", async () => {
    const transport = new FakeTransport();
    const repository = new DocumentLedgerRepository(persistenceFromDropbox(transport));
    await repository.writeVersion(record({
      version_id: v1,
      stage: "published",
      created_at: "2026-08-24T18:00:00+01:00"
    }));
    await repository.writeVersion(record({
      version_id: v2,
      parent_version_id: v1,
      stage: "working",
      created_at: "2026-08-24T18:10:00+01:00",
      content_sha256: "b".repeat(64),
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, "b".repeat(64)),
      request_id: "DOCREQ-WORK-000002"
    }));
    await repository.writeVersion(record({
      version_id: v3,
      parent_version_id: v2,
      stage: "review",
      created_at: "2026-08-24T18:20:00+01:00",
      content_sha256: "c".repeat(64),
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, "c".repeat(64)),
      request_id: "DOCREQ-REVIEW-000002"
    }));

    const restored = await repository.restoreHeadFromVersions(projectId, documentId);

    expect(restored?.published_version_id).toBe(v1);
    expect(restored?.review_version_id).toBe(v3);
    expect(restored?.working_version_id).toBeUndefined();
  });
});
