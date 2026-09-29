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
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, { content: string; metadata: DropboxFileMetadata }>();
  uploads: Array<{ path: string; mode: string }> = [];
  moves: Array<{ from: string; to: string }> = [];
  copies: Array<{ from: string; to: string }> = [];
  operations: string[] = [];
  raceBeforeConditional?: { path: string; content: string };
  failCopyAfterWrite = false;
  failConditionalDelete: "before" | "after" | null = null;
  failHeadWriteOnce = false;
  private revision = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (this.failHeadWriteOnce && path.includes("/heads/")) {
      this.failHeadWriteOnce = false;
      throw new Error("injected interruption before publication head advance");
    }
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("conflict", "req-add", "path/conflict/file");
    this.set(path, content);
    this.uploads.push({ path, mode });
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const race = this.raceBeforeConditional;
    const beforeRace = this.files.get(path);
    if (race?.path === path && beforeRace) {
      this.raceBeforeConditional = undefined;
      this.set(path, race.content, beforeRace.metadata.id);
    }
    const current = this.files.get(path);
    if (!current || current.metadata.rev !== expectedRev) {
      throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    }
    this.operations.push(`conditional-write:${path}`);
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
    this.operations.push(`copy:${to}`);
    if (this.failCopyAfterWrite) {
      this.failCopyAfterWrite = false;
      throw new Error("injected lost archive-copy response");
    }
    return this.files.get(to)!.metadata;
  }

  async delete(path: string): Promise<void> { this.files.delete(path); }

  async deleteIfRevision(path: string, revision: string): Promise<boolean> {
    const current = this.files.get(path);
    if (!current || current.metadata.rev !== revision) return false;
    const fail = this.failConditionalDelete;
    this.failConditionalDelete = null;
    if (fail === "before") throw new Error("injected interruption before conditional review delete");
    this.files.delete(path);
    if (fail === "after") throw new Error("injected lost conditional review-delete response");
    return true;
  }

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

function runtimeWithConditionalDelete(transport: FakeTransport) {
  const runtime = persistenceFromDropbox(transport);
  runtime.objects.readBytes = async (path, maxBytes) => {
    const content = transport.files.get(path)?.content;
    if (content === undefined) return null;
    const bytes = new TextEncoder().encode(content);
    return bytes.length <= maxBytes ? bytes : null;
  };
  runtime.serverSideCopy.copyObjectVersion = async (from, to, expected) => {
    const source = await runtime.objects.getMetadata(from);
    if (!source || source.objectId !== expected.objectId || source.revisionToken !== expected.revisionToken) {
      throw new Error("exact source revision changed");
    }
    const bytes = await runtime.objects.readBytes!(from, 10 * 1024 * 1024);
    if (!bytes) throw new Error("exact source bytes missing");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    if (hash !== expected.contentSha256) throw new Error("exact source bytes mismatch");
    await transport.copy(from, to);
    const after = await runtime.objects.getMetadata(from);
    const destination = await runtime.objects.getMetadata(to);
    if (!after || after.objectId !== expected.objectId || after.revisionToken !== expected.revisionToken || !destination) {
      throw new Error("exact source revision changed during copy");
    }
    return {
      source: { objectId: expected.objectId, revisionToken: expected.revisionToken, contentSha256: hash },
      destination
    };
  };
  runtime.objects.deleteIfUnchanged = async (path, expected) => {
    const current = transport.files.get(path);
    if (!current || current.metadata.id !== expected.objectId || current.metadata.rev !== expected.revisionToken) return "changed";
    return await transport.deleteIfRevision(path, expected.revisionToken) ? "deleted" : "changed";
  };
  return runtime;
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

// Fixture for a second publication of the same logical document.
async function prepareReplacement(transport: FakeTransport, suffix: string) {
  const service = new ManagedDocumentService(runtimeWithConditionalDelete(transport));
  const firstWorking = await write(service, `DOCREQ-WORK-PUBLISH-${suffix}-1`, "published v1");
  const firstReview = await service.promoteToReview({ request_id: `DOCREQ-REVIEW-PUBLISH-${suffix}-1`, project_id: "PRJ-0002", document_id: firstWorking.document_id, expected_version_id: firstWorking.version_id, created_at: "2026-08-24T19:05:00+01:00" }, state());
  const firstPublished = await service.publish({ request_id: `DOCREQ-PUBLISH-${suffix}-1`, project_id: "PRJ-0002", document_id: firstWorking.document_id, expected_version_id: firstReview.version_id, created_at: "2026-08-24T19:06:00+01:00" }, state());
  const firstPublishedContent = transport.files.get(publishedPath)?.content;
  const reopened = await service.reopenPublished({ request_id: `DOCREQ-REOPEN-PUBLISH-${suffix}-1`, project_id: "PRJ-0002", document_id: firstWorking.document_id, expected_version_id: firstPublished.version_id, created_at: "2026-08-24T19:07:00+01:00" }, state());
  const secondWorking = await write(service, `DOCREQ-WORK-PUBLISH-${suffix}-2`, "published v2", reopened.version_id);
  const secondReview = await service.promoteToReview({ request_id: `DOCREQ-REVIEW-PUBLISH-${suffix}-2`, project_id: "PRJ-0002", document_id: firstWorking.document_id, expected_version_id: secondWorking.version_id, created_at: "2026-08-24T19:08:00+01:00" }, state());
  const request = { request_id: `DOCREQ-PUBLISH-${suffix}-2`, project_id: "PRJ-0002", document_id: firstWorking.document_id, expected_version_id: secondReview.version_id, created_at: "2026-08-24T19:09:00+01:00" };
  const archivePath = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARCHIVES/MANAGED-DOCUMENTS/${firstWorking.document_id}/${firstPublished.version_id}/published/${request.request_id}/${logicalPath}`;
  return { service, request, firstWorking, firstPublished, firstPublishedContent, secondReview, archivePath };
}

describe("ManagedDocumentService work-product lifecycle", () => {
  it("archives a bound working version under its safe grouping and resumes after a lost source-delete response", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(runtimeWithConditionalDelete(transport));
    const working = await write(service, "DOCREQ-WORK-ARCHIVE-GROUP-1", "retired draft");
    const request = {
      operation: "document.archive" as const, request_id: "DOCREQ-ARCHIVE-GROUP-0001",
      project_id: "PRJ-0002", document_id: working.document_id, expected_version_id: working.version_id,
      stage: "working" as const, archive_group: "RESET-AGENCY-OS-2026-09/DEPUIS-WORKING",
      created_at: "2026-09-29T15:00:00Z"
    };
    const destination = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARCHIVES/RESET-AGENCY-OS-2026-09/DEPUIS-WORKING/${working.document_id}/${working.version_id}/working/${request.request_id}/${logicalPath}`;
    transport.failConditionalDelete = "after";
    await expect(service.archiveActiveDocument(request, state())).rejects.toThrow("injected lost conditional review-delete response");
    expect(transport.files.has(workingPath)).toBe(false);
    expect(transport.files.get(destination)?.content).toContain("retired draft");
    expect((await service.status("PRJ-0002", working.document_id))?.working_version_id).toBe(working.version_id);
    const receipt = await service.archiveActiveDocument(request, state());
    expect(receipt).toMatchObject({ status: "committed", archive_path: destination, archived_stage: "working" });
    expect((await service.status("PRJ-0002", working.document_id))?.working_version_id).toBeUndefined();
    expect(await service.archiveActiveDocument(request, state())).toEqual(receipt);
  });

  it("preserves a concurrent external edit during archive removal and does not clear its active head", async () => {
    const transport = new FakeTransport();
    const runtime = runtimeWithConditionalDelete(transport);
    const service = new ManagedDocumentService(runtime);
    const working = await write(service, "DOCREQ-WORK-ARCHIVE-RACE-1", "original draft");
    const remove = runtime.objects.deleteIfUnchanged!;
    runtime.objects.deleteIfUnchanged = async (path, expected) => {
      await transport.upload(path, "external edit", "overwrite");
      return remove(path, expected);
    };
    await expect(service.archiveActiveDocument({
      operation: "document.archive", request_id: "DOCREQ-ARCHIVE-RACE-0001", project_id: "PRJ-0002",
      document_id: working.document_id, expected_version_id: working.version_id, stage: "working",
      created_at: "2026-09-29T15:00:00Z"
    }, state())).rejects.toMatchObject({ code: "PROVIDER_VERSION_CHANGED" });
    expect(transport.files.get(workingPath)?.content).toBe("external edit");
    expect((await service.status("PRJ-0002", working.document_id))?.working_version_id).toBe(working.version_id);
  });

  it("refuses archive removal without conditional-delete capability before copying or clearing its head", async () => {
    const transport = new FakeTransport();
    const runtime = runtimeWithConditionalDelete(transport);
    const service = new ManagedDocumentService(runtime);
    const working = await write(service, "DOCREQ-WORK-ARCHIVE-NOPORT-1", "retired draft");
    delete runtime.objects.deleteIfUnchanged;
    await expect(service.archiveActiveDocument({
      operation: "document.archive", request_id: "DOCREQ-ARCHIVE-NOPORT-0001", project_id: "PRJ-0002",
      document_id: working.document_id, expected_version_id: working.version_id, stage: "working",
      created_at: "2026-09-29T15:00:00Z"
    }, state())).rejects.toMatchObject({ code: "CONDITIONAL_ARCHIVE_DELETE_UNAVAILABLE" });
    expect(transport.files.get(workingPath)?.content).toContain("retired draft");
    expect(transport.copies).toHaveLength(0);
    expect((await service.status("PRJ-0002", working.document_id))?.working_version_id).toBe(working.version_id);
  });

  it("builds one visible working file over multiple immutable versions and tracks its current provider rev", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(persistenceFromDropbox(transport));

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
    const service = new ManagedDocumentService(persistenceFromDropbox(transport));
    const v1 = await write(service, "DOCREQ-WORK-000003", "one");
    const v2 = await write(service, "DOCREQ-WORK-000004", "two", v1.version_id);

    await expect(write(service, "DOCREQ-WORK-000005", "stale", v1.version_id))
      .rejects.toBeInstanceOf(ManagedDocumentConflictError);
    expect(transport.files.get(workingPath)?.content).toContain("two");
    expect((await service.status("PRJ-0002", v2.document_id))?.working_version_id).toBe(v2.version_id);
  });

  it("promotes working to review, allows review edits, and publishes only on explicit publish", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(persistenceFromDropbox(transport));
    const working = await write(service, "DOCREQ-WORK-000006", "draft");

    const review = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000001",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      expected_version_id: working.version_id,
      created_at: "2026-08-24T19:01:00+01:00"
    }, state());
    expect(transport.files.has(workingPath)).toBe(false);
    expect(transport.files.get(reviewPath)?.content).toContain("draft");
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
    expect(transport.files.get(publishedPath)?.content).toContain("final candidate");
    status = await service.status("PRJ-0002", working.document_id);
    expect(status?.published_version_id).toBe(published.version_id);
    expect(status?.review_version_id).toBeUndefined();
    expect(status?.provider?.review).toBeUndefined();
    expect(status?.provider?.published?.rev).toBe(transport.files.get(publishedPath)?.metadata.rev);
  });

  it("reopens a published deliverable into working while keeping the published version frozen and provider observations independent", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(persistenceFromDropbox(transport));
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

    expect(transport.files.get(publishedPath)?.content).toContain("published content");
    expect(transport.files.get(workingPath)?.content).toContain("published content");
    const status = await service.status("PRJ-0002", working.document_id);
    expect(status?.published_version_id).toBe(published.version_id);
    expect(status?.working_version_id).toBe(reopened.version_id);
    expect(status?.provider?.published?.rev).toBe(publishedRev);
    expect(status?.provider?.working?.rev).toBe(transport.files.get(workingPath)?.metadata.rev);
  });

  it("writes immutable publish evidence before advancing the mutable document head", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(persistenceFromDropbox(transport));
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

  it("preserves a human deliverable edit that races between observation and publish CAS", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(runtimeWithConditionalDelete(transport));
    const firstWorking = await write(service, "DOCREQ-WORK-000009", "published v1");
    const firstReview = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000005", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstWorking.version_id, created_at: "2026-08-24T19:05:00+01:00"
    }, state());
    const firstPublished = await service.publish({
      request_id: "DOCREQ-PUBLISH-000004", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstReview.version_id, created_at: "2026-08-24T19:06:00+01:00"
    }, state());
    const originalPublishedContent = transport.files.get(publishedPath)?.content;
    const reopened = await service.reopenPublished({
      request_id: "DOCREQ-REOPEN-000002", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstPublished.version_id, created_at: "2026-08-24T19:07:00+01:00"
    }, state());
    const secondWorking = await write(service, "DOCREQ-WORK-000010", "candidate v2", reopened.version_id);
    const secondReview = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-000006", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: secondWorking.version_id, created_at: "2026-08-24T19:08:00+01:00"
    }, state());

    transport.raceBeforeConditional = { path: publishedPath, content: "human edit during publish" };
    await expect(service.publish({
      request_id: "DOCREQ-PUBLISH-000005", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: secondReview.version_id, created_at: "2026-08-24T19:09:00+01:00"
    }, state())).rejects.toMatchObject({ code: "PROVIDER_CAS_CONFLICT" });

    expect(transport.files.get(publishedPath)?.content).toBe("human edit during publish");
    expect(transport.files.get(reviewPath)?.content).toContain("candidate v2");
    const archivePath = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARCHIVES/MANAGED-DOCUMENTS/${firstWorking.document_id}/${firstPublished.version_id}/published/DOCREQ-PUBLISH-000005/${logicalPath}`;
    expect(transport.files.get(archivePath)?.content).toBe(originalPublishedContent);
    const status = await service.status("PRJ-0002", firstWorking.document_id);
    expect(status?.published_version_id).toBe(firstPublished.version_id);
    expect(status?.review_version_id).toBe(secondReview.version_id);
  });

  it("archives the exact prior published file before replacing it", async () => {
    const transport = new FakeTransport();
    const service = new ManagedDocumentService(runtimeWithConditionalDelete(transport));
    const firstWorking = await write(service, "DOCREQ-WORK-PUBLISH-ARCHIVE-1", "published v1");
    const firstReview = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-PUBLISH-ARCHIVE-1", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstWorking.version_id, created_at: "2026-08-24T19:05:00+01:00"
    }, state());
    const firstPublished = await service.publish({
      request_id: "DOCREQ-PUBLISH-ARCHIVE-1", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstReview.version_id, created_at: "2026-08-24T19:06:00+01:00"
    }, state());
    const firstPublishedContent = transport.files.get(publishedPath)?.content;
    const reopened = await service.reopenPublished({
      request_id: "DOCREQ-REOPEN-PUBLISH-ARCHIVE-1", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: firstPublished.version_id, created_at: "2026-08-24T19:07:00+01:00"
    }, state());
    const secondWorking = await write(service, "DOCREQ-WORK-PUBLISH-ARCHIVE-2", "published v2", reopened.version_id);
    const secondReview = await service.promoteToReview({
      request_id: "DOCREQ-REVIEW-PUBLISH-ARCHIVE-2", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: secondWorking.version_id, created_at: "2026-08-24T19:08:00+01:00"
    }, state());

    await service.publish({
      request_id: "DOCREQ-PUBLISH-ARCHIVE-2", project_id: "PRJ-0002", document_id: firstWorking.document_id,
      expected_version_id: secondReview.version_id, created_at: "2026-08-24T19:09:00+01:00"
    }, state());

    const archivePath = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARCHIVES/MANAGED-DOCUMENTS/${firstWorking.document_id}/${firstPublished.version_id}/published/DOCREQ-PUBLISH-ARCHIVE-2/${logicalPath}`;
    expect(transport.files.get(archivePath)?.content).toBe(firstPublishedContent);
    expect(transport.files.get(publishedPath)?.content).toContain("published v2");
    expect(transport.operations.indexOf(`copy:${archivePath}`)).toBeLessThan(transport.operations.indexOf(`conditional-write:${publishedPath}`));
  });

  it("resumes after a create-only archive copy succeeded but its response was lost", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "COPY-RESUME");
    transport.failCopyAfterWrite = true;

    await expect(prepared.service.publish(prepared.request, state())).rejects.toThrow("injected lost archive-copy response");
    expect(transport.files.get(publishedPath)?.content).toBe(prepared.firstPublishedContent);
    expect(transport.files.get(reviewPath)?.content).toContain("published v2");
    expect(transport.files.get(prepared.archivePath)?.content).toBe(prepared.firstPublishedContent);

    const receipt = await prepared.service.publish(prepared.request, state());
    const copyCount = transport.copies.length;
    const publishedUpdateCount = transport.uploads.filter((entry) => entry.path === publishedPath).length;
    const replay = await prepared.service.publish(prepared.request, state());
    expect(replay.version_id).toBe(receipt.version_id);
    await expect(prepared.service.publish({ ...prepared.request, expected_version_id: prepared.firstPublished.version_id }, state()))
      .rejects.toMatchObject({ code: "DOCUMENT_REQUEST_REPLAY_CONFLICT" });
    expect(transport.copies).toHaveLength(copyCount);
    expect(transport.uploads.filter((entry) => entry.path === publishedPath)).toHaveLength(publishedUpdateCount);
  });

  it("resumes after CAS and REVIEW deletion without duplicating the publication", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "CAS-RESUME");
    transport.failConditionalDelete = "after";

    await expect(prepared.service.publish(prepared.request, state())).rejects.toThrow("injected lost conditional review-delete response");
    expect(transport.files.get(publishedPath)?.content).toContain("published v2");
    expect(transport.files.has(reviewPath)).toBe(false);
    expect(transport.files.get(prepared.archivePath)?.content).toBe(prepared.firstPublishedContent);
    const casCount = transport.uploads.filter((entry) => entry.path === publishedPath).length;

    const receipt = await prepared.service.publish(prepared.request, state());
    const replay = await prepared.service.publish(prepared.request, state());
    expect(replay.version_id).toBe(receipt.version_id);
    expect(transport.uploads.filter((entry) => entry.path === publishedPath)).toHaveLength(casCount);
    expect((await prepared.service.status("PRJ-0002", prepared.firstWorking.document_id))?.published_version_id).toBe(receipt.version_id);
  });

  it("refuses a missing old REVIEW identity when a different candidate now occupies the path", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "MISSING-IDENTITY-RACE");
    const serviceRuntime = runtimeWithConditionalDelete(transport);
    const deleteIfUnchanged = serviceRuntime.objects.deleteIfUnchanged!;
    serviceRuntime.objects.deleteIfUnchanged = async (path, expected) => {
      if (path === reviewPath) {
        await transport.upload(reviewPath, "concurrent replacement candidate", "overwrite");
        return "missing";
      }
      return deleteIfUnchanged(path, expected);
    };
    const service = new ManagedDocumentService(serviceRuntime);

    await expect(service.publish(prepared.request, state()))
      .rejects.toMatchObject({ code: "PROVIDER_VERSION_CHANGED" });
    expect(transport.files.get(reviewPath)?.content).toBe("concurrent replacement candidate");
    expect((await service.status("PRJ-0002", prepared.firstWorking.document_id))?.review_version_id)
      .toBe(prepared.secondReview.version_id);
  });

  it("does not report successor publication complete until its head advances", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "HEAD-RESUME");
    transport.failHeadWriteOnce = true;

    await expect(prepared.service.publish(prepared.request, state())).rejects.toThrow("injected interruption before publication head advance");
    expect((await prepared.service.status("PRJ-0002", prepared.firstWorking.document_id))?.published_version_id)
      .toBe(prepared.firstPublished.version_id);
    expect((await prepared.service.status("PRJ-0002", prepared.firstWorking.document_id))?.review_version_id)
      .toBe(prepared.secondReview.version_id);

    const receipt = await prepared.service.publish(prepared.request, state());
    expect((await prepared.service.status("PRJ-0002", prepared.firstWorking.document_id))?.published_version_id)
      .toBe(receipt.version_id);
  });

  it("refuses a divergent deterministic archive before changing the live files", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "ARCHIVE-CONFLICT");
    await transport.upload(prepared.archivePath, "unrelated archived bytes", "add");

    await expect(prepared.service.publish(prepared.request, state())).rejects.toMatchObject({ code: "DOCUMENT_ARCHIVE_DESTINATION_CONFLICT" });
    expect(transport.files.get(publishedPath)?.content).toBe(prepared.firstPublishedContent);
    expect(transport.files.get(reviewPath)?.content).toContain("published v2");
  });

  it("refuses a changed review candidate before creating a replacement archive", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "CANDIDATE-CONFLICT");
    await transport.upload(reviewPath, "changed candidate", "overwrite");

    await expect(prepared.service.publish(prepared.request, state())).rejects.toMatchObject({ code: "PROVIDER_VERSION_CHANGED" });
    expect(transport.files.get(publishedPath)?.content).toBe(prepared.firstPublishedContent);
    expect(transport.files.has(prepared.archivePath)).toBe(false);
  });

  it("does not treat a missing REVIEW candidate as a completed successor without its request-bound archive", async () => {
    const transport = new FakeTransport();
    const prepared = await prepareReplacement(transport, "MISSING-REVIEW");
    await transport.delete(reviewPath);

    await expect(prepared.service.publish(prepared.request, state())).rejects.toMatchObject({ code: "REVIEW_CONTENT_MISSING" });
    expect(transport.files.get(publishedPath)?.content).toBe(prepared.firstPublishedContent);
    expect(transport.files.has(prepared.archivePath)).toBe(false);
    expect((await prepared.service.status("PRJ-0002", prepared.firstWorking.document_id))?.published_version_id)
      .toBe(prepared.firstPublished.version_id);
  });
});
