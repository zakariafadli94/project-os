import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import {
  DropboxConflictError,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, { content: string; metadata: DropboxFileMetadata }>();
  private revision = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    this.set(path, content, this.files.get(path)?.metadata.id);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.files.get(path);
    if (!current || current.metadata.rev !== expectedRev) {
      throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    }
    return this.set(path, content, current.metadata.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path)?.content ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.files.get(path)?.metadata ?? null; }

  async move(from: string, to: string): Promise<void> {
    const source = this.files.get(from);
    if (!source) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.set(to, source.content, source.metadata.id);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const source = this.files.get(from);
    if (!source) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, source.content);
  }

  async delete(path: string): Promise<void> { this.files.delete(path); }

  private set(path: string, content: string, id?: string): DropboxFileMetadata {
    this.revision += 1;
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:visible-${this.revision}`,
      path,
      rev: `visible-rev-${this.revision}`,
      content_hash: fakeContentHash(content),
      size: new TextEncoder().encode(content).byteLength
    };
    this.files.set(path, { content, metadata });
    return metadata;
  }
}

function fakeContentHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function state() {
  return emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed identity");
}

const logicalPath = "strategy/commercial.md";
const workingPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", logicalPath);
const reviewPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "review", logicalPath);
const publishedPath = workspaceManagedDocumentPath("PRJ-0002", "project-os", "deliverables", logicalPath);

describe("ManagedDocumentService visible identity", () => {
  it("stores and materializes enriched Markdown bytes and preserves identity through publication", async () => {
    const transport = new FakeTransport();
    const runtime = persistenceFromDropbox(transport);
    const service = new ManagedDocumentService(runtime);
    const ledger = new DocumentLedgerRepository(runtime);
    const callerContent = "# Strategy\n\nInitial draft\n";

    const working = await service.writeWorking({
      request_id: "DOCREQ-VISIBLE-WORK-001",
      project_id: "PRJ-0002",
      logical_path: logicalPath,
      content: callerContent,
      content_sha256: await sha256Text(callerContent),
      created_at: "2026-08-30T17:00:00+01:00"
    }, state());

    const visibleWorking = transport.files.get(workingPath)?.content;
    expect(visibleWorking).toContain("project_id: PRJ-0002\n");
    expect(visibleWorking).toContain(`document_id: ${working.document_id}\n`);
    expect(visibleWorking).toContain("# Strategy\n");
    expect(visibleWorking).not.toBe(callerContent);

    const workingVersion = await ledger.readVersion("PRJ-0002", working.document_id, working.version_id);
    expect(workingVersion?.content_sha256).toBe(await sha256Text(visibleWorking!));
    expect(workingVersion?.content_sha256).not.toBe(await sha256Text(callerContent));
    expect(transport.files.get(workingVersion!.immutable_payload_path)?.content).toBe(visibleWorking);

    const review = await service.promoteToReview({
      request_id: "DOCREQ-VISIBLE-REVIEW-001",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      expected_version_id: working.version_id,
      created_at: "2026-08-30T17:01:00+01:00"
    }, state());
    expect(review.document_id).toBe(working.document_id);
    expect(transport.files.get(reviewPath)?.content).toBe(visibleWorking);

    const reviewSource = [
      "---",
      "project_id: PRJ-0002",
      `document_id: ${working.document_id}`,
      "task_id: TASK-IDENTITY001",
      "---",
      "# Strategy",
      "",
      "Founder candidate",
      ""
    ].join("\n");
    const reviewEdit = await service.writeReview({
      request_id: "DOCREQ-VISIBLE-REVIEW-002",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      content: reviewSource,
      content_sha256: await sha256Text(reviewSource),
      expected_version_id: review.version_id,
      created_at: "2026-08-30T17:02:00+01:00"
    }, state());

    const visibleReview = transport.files.get(reviewPath)?.content;
    expect(visibleReview).toBe(reviewSource);
    expect(visibleReview?.match(/^project_id:/gm)).toHaveLength(1);
    expect(visibleReview?.match(/^document_id:/gm)).toHaveLength(1);
    expect(visibleReview).toContain("task_id: TASK-IDENTITY001\n");

    const published = await service.publish({
      request_id: "DOCREQ-VISIBLE-PUBLISH-001",
      project_id: "PRJ-0002",
      document_id: working.document_id,
      expected_version_id: reviewEdit.version_id,
      created_at: "2026-08-30T17:03:00+01:00"
    }, state());

    expect(published.document_id).toBe(working.document_id);
    expect(transport.files.get(publishedPath)?.content).toBe(reviewSource);
    expect(transport.files.get(publishedPath)?.content).toContain(`document_id: ${working.document_id}\n`);
  });
});
