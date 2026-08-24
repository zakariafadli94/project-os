import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import {
  DropboxConflictError,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import {
  ManagedDocumentConflictError,
  ManagedDocumentService
} from "../src/documents/service";
import { sha256Text } from "../src/documents/hash";

class FakeTransport implements DropboxTransport {
  files = new Map<string, { content: string; metadata: DropboxFileMetadata }>();
  uploads: Array<{ path: string; mode: string }> = [];
  moves: Array<{ from: string; to: string }> = [];
  copies: Array<{ from: string; to: string }> = [];
  private revision = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("conflict", "req-add", "path/conflict/file");
    this.set(path, content);
    this.uploads.push({ path, mode });
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.files.get(path);
    if (!current || current.metadata.rev !== expectedRev) {
      throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    }
    this.set(path, content, current.metadata.id);
    this.uploads.push({ path, mode: `update:${expectedRev}` });
    return this.files.get(path)!.metadata;
  }

  async download(path: string): Promise<string | null> { return this.files.get(path)?.content ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.files.get(path)?.metadata ?? null; }

  async move(from: string, to: string): Promise<void> {
    const source = this.files.get(from);
    if (!source) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("conflict", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.set(to, source.content, source.metadata.id);
    this.moves.push({ from, to });
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const source = this.files.get(from);
    if (!source) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("conflict", "req-copy", "to/conflict/file");
    this.set(to, source.content);
    this.copies.push({ from, to });
    return this.files.get(to)!.metadata;
  }

  async delete(path: string): Promise<void> { this.files.delete(path); }

  private set(path: string, content: string, id?: string) {
    this.revision += 1;
    this.files.set(path, {
      content,
      metadata: {
        id: id ?? `id:file-${this.revision}`,
        path,
        rev: `rev-${this.revision}`,
        content_hash: contentHash(content),
        size: content.length
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
const reviewPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "review", logicalPath);
const publishedPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "deliverables", logicalPath);

async function write(service: ManagedDocumentService, requestId: string, content: string, expectedVersionId?: string) {
  return service.writeWorking({
    request_id: requestId,
    project_id: "PRJ-0002",
    logical_path: logicalPath,
    content,
    content_sha256: await sha256Text(content),
    created_at: "2026-08-24T19:00:00+01:00",
    ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {})
  }, state());
}

describe("ManagedDocumentService work-product lifecycle", () => {
  it("builds one visible working file over multiple immutable versions and tracks its current provider rev", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(transport);

    const v1 = await write(service, "DOCREQ-WORK-000001", "# Strategy\n\n## ICP\nTBD");
    const v2 = await write(service, "DOCREQ-WORK-000002", "# Strategy\n\n## ICP\nMid-market", v1.version_id);

    expect(v1.document_id).toBe(v2.document_id);
    expect(v1.version_id).not.toBe(v2.version_id);
    expect(transport.files.get(workingPath)?.content).toContain("Mid-market");
    expect([...transport.files.keys()].filter((path) => path === workingPath)).toHaveLength(1);
    const status = await service.status("PRJ-0002", v2.document_id);
    expect(status?.provider?.working).toEqual(expect.objectContaining({
      path: workingPath,
      rev: transport.files.get(workingPath)?.metadata.rev,
      content_hash: transport.files.get(workingPath)?.metadata.content_hash
    }));
  });

  it("rejects an AI write based on a stale logical version without touching the newer working file", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(transport);
    const v1 = await write(service, "DOCREQ-WORK-000003", "one");
    const v2 = await write(service, "DOCREQ-WORK-000004", "two", v1.version_id);

    await expect(write(service, "DOCREQ-WORK-000005", "stale", v1.version_id))
      .rejects.toBeInstanceOf(ManagedDocumentConflictError);
    expect(transport.files.get(workingPath)?.content).toBe("two");
    expect((await service.status("PRJ-0002", v2.document_id))?.working_version_id).toBe(v2.version_id);
  });

  it("promotes working to review, allows review edits, and publishes only on explicit publish", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(transport);
    const working = await write(service, "DOCREQ-WORK-000006", "draft");

    const review = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000001",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      expected_version_id: working.version_id,
      created_at: "2026-08-24T19:01:00+01:00"
    }, state());
    expect(transport.files.has(workingPath)).toBe(false);
    expect(transport.files.get(reviewPath)?.content).toBe("draft");
    expect(transport.files.has(publishedPath)).toBe(false);
    let status = await service.status("PRJ-0002", working.document_id);
    expect(status?.provider?.working).toBeUndefined();
    expect(status?.provider?.review?.rev).toBe(transport.files.get(reviewPath)?.metadata.rev);

    const reviewEdit = await service.writeReview({
      request_id: "DOCREQ-REVIEW-000002",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      content: "final candidate",
      content_sha256: await sha256Text("final candidate"),
      expected_version_id: review.version_id,
      created_at: "2026-08-24T19:02:00+01:00"
    }, state());
    expect(transport.files.has(publishedPath)).toBe(false);

    const published = await service.publish({
      request_id: "DOCREQ-PUBLISH-000001",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      expected_version_id: reviewEdit.version_id,
      created_at: "2026-08-24T19:03:00+01:00"
    }, state());

    expect(transport.files.has(reviewPath)).toBe(false);
    expect(transport.files.get(publishedPath)?.content).toBe("final candidate");
    status = await service.status("PRJ-0002", working.document_id);
    expect(status?.published_version_id).toBe(published.version_id);
    expect(status?.review_version_id).toBeUndefined();
    expect(status?.provider?.review).toBeUndefined();
    expect(status?.provider?.published?.rev).toBe(transport.files.get(publishedPath)?.metadata.rev);
  });

  it("reopens a published deliverable into working while keeping the published version frozen and provider observations independent", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(transport);
    const working = await write(service, "DOCREQ-WORK-000007", "published content");
    const review = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000003", project_id: "PRJ-0002", document_id: working.document_id,
      expected_version_id: working.version_id, created_at: "2026-08-24T19:01:00+01:00"
    }, state());
    const published = await service.publish({
      request_id: "DOCREQ-PUBLISH-000002", project_id: "PRJ-0002", document_id: working.document_id,
      expected_version_id: review.version_id, created_at: "2026-08-24T19:02:00+01:00"
    }, state());
    const publishedRev = transport.files.get(publishedPath)!.metadata.rev;

    const reopened = await service.reopenPublished({
      request_id: "DOCREQ-REOPEN-000001", project_id: "PRJ-0002", document_id: working.document_id,
      expected_version_id: published.version_id, created_at: "2026-08-24T19:04:00+01:00"
    }, state());

    expect(transport.files.get(publishedPath)?.content).toBe("published content");
    expect(transport.files.get(workingPath)?.content).toBe("published content");
    const status = await service.status("PRJ-0002", working.document_id);
    expect(status?.published_version_id).toBe(published.version_id);
    expect(status?.working_version_id).toBe(reopened.version_id);
    expect(status?.provider?.published?.rev).toBe(publishedRev);
    expect(status?.provider?.working?.rev).toBe(transport.files.get(workingPath)?.metadata.rev);
  });

  it("writes immutable publish evidence before advancing the mutable document head", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(transport);
    const working = await write(service, "DOCREQ-WORK-000008", "candidate");
    const review = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000004", project_id: "PRJ-0002", document_id: working.document_id,
      expected_version_id: working.version_id, created_at: "2026-08-24T19:01:00+01:00"
    }, state());
    const before = transport.uploads.length;

    const published = await service.publish({
      request_id: "DOCREQ-PUBLISH-000003", project_id: "PRJ-0002", document_id: working.document_id,
      expected_version_id: review.version_id, created_at: "2026-08-24T19:02:00+01:00"
    }, state());
    const publishUploads = transport.uploads.slice(before).map((entry) => entry.path);
    const versionIndex = publishUploads.findIndex((path) => path.includes(`/versions/${working.document_id}/${published.version_id}.json`));
    const headIndex = publishUploads.findIndex((path) => path.endsWith(`/heads/${working.document_id}.json`));

    expect(versionIndex).toBeGreaterThanOrEqual(0);
    expect(headIndex).toBeGreaterThan(versionIndex);
  });
});
