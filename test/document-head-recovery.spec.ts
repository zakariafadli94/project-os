import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { machineDocumentHeadPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { ManagedDocumentService } from "../src/documents/service";

class RecoveryTransport implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  private revision = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("conflict", "req-add", "path/conflict/file");
    this.set(path, content, this.metadata.get(path)?.id);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    this.set(path, content, current.id);
    return this.metadata.get(path)!;
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.metadata.delete(from);
    this.set(to, content, metadata.id);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    this.set(to, content);
    return this.metadata.get(to)!;
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
  }

  remove(path: string): void {
    this.files.delete(path);
    this.metadata.delete(path);
  }

  private set(path: string, content: string, id?: string): void {
    this.revision += 1;
    this.files.set(path, content);
    this.metadata.set(path, {
      id: id ?? `id:recovery-${this.revision}`,
      path,
      rev: `recovery-rev-${this.revision}`,
      content_hash: hash64(content),
      size: new TextEncoder().encode(content).byteLength
    });
  }
}

function hash64(value: string): string {
  let accumulator = 0;
  for (const char of value) accumulator = (accumulator * 31 + char.charCodeAt(0)) >>> 0;
  return accumulator.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

const project = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Recover managed docs");

async function write(service: ManagedDocumentService, requestId: string, content: string, expectedVersionId?: string) {
  return service.writeWorking({
    request_id: requestId,
    project_id: project.project_id,
    logical_path: "strategy/recovery.md",
    content,
    content_sha256: await sha256Text(content),
    ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
    created_at: "2026-08-25T02:00:00+01:00"
  }, project);
}

describe("managed document head recovery", () => {
  it("reconstructs a missing head from immutable versions for status and the next CAS write", async () => {
    const transport = new RecoveryTransport();
    const service = new ManagedDocumentService(transport);
    const first = await write(service, "DOCREQ-HEADREC-0001", "version one");
    const headPath = machineDocumentHeadPath(project.project_id, first.document_id);

    transport.remove(headPath);
    const restored = await service.status(project.project_id, first.document_id);
    expect(restored?.working_version_id).toBe(first.version_id);
    expect(transport.files.has(headPath)).toBe(true);

    transport.remove(headPath);
    const second = await write(service, "DOCREQ-HEADREC-0002", "version two", first.version_id);
    expect(second.status).toBe("committed");
    expect(second.version_id).not.toBe(first.version_id);
    expect((await service.status(project.project_id, first.document_id))?.working_version_id).toBe(second.version_id);
  });
});
