import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { InputIntakeRepository } from "../src/documents/input-intake-repository";
import { InputIntakeService } from "../src/documents/input-intake-service";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FaultyIntakeDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  failSnapshotCopyOnce = false;
  failVisibleCopyOnce = false;
  failVersionCreateOnce = false;
  failSourceDeleteOnce: string | null = null;
  failSourceRemovedMarkerOnce = false;
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (this.failVersionCreateOnce && mode === "add" && /\/documents\/versions\//.test(path)) {
      this.failVersionCreateOnce = false;
      throw new Error("injected crash before reference version persistence");
    }
    if (
      this.failSourceRemovedMarkerOnce
      && /\/documents\/intakes\/INTAKE-[A-F0-9]{24}\.json$/.test(path)
      && content.includes('"phase": "SOURCE_REMOVED"')
    ) {
      this.failSourceRemovedMarkerOnce = false;
      throw new Error("injected crash after source deletion before SOURCE_REMOVED marker");
    }
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-upload", "path/conflict/file");
    }
    await this.set(path, content, this.metadata.get(path)?.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from); const meta = this.metadata.get(from);
    if (content === undefined || !meta) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from); this.metadata.delete(from); await this.set(to, content, meta.id);
  }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    if (this.failSnapshotCopyOnce && /\/documents\/payloads\/provider\//.test(to)) {
      this.failSnapshotCopyOnce = false;
      throw new Error("injected crash before immutable source snapshot");
    }
    if (this.failVisibleCopyOnce && /\/REFERENCES\/UNCLASSIFIED\//.test(to)) {
      this.failVisibleCopyOnce = false;
      throw new Error("injected crash after snapshot before visible reference copy");
    }
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }
  async delete(path: string): Promise<void> {
    if (this.failSourceDeleteOnce === path) {
      this.failSourceDeleteOnce = null;
      throw new Error("injected crash before source deletion");
    }
    this.files.delete(path); this.metadata.delete(path);
  }
  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }
  async externalAdd(path: string, content: string): Promise<DropboxFileMetadata> { return this.set(path, content); }

  private async set(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:F${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await hash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-31T11:55:00.000Z"
    };
    this.files.set(path, content); this.metadata.set(path, metadata); return metadata;
  }
}

function providerMetadata(meta: DropboxFileMetadata): ProviderObjectMetadata {
  return {
    path: meta.path,
    size: meta.size,
    modifiedAt: meta.server_modified,
    objectId: meta.id,
    revisionToken: meta.rev,
    integrityHash: { algorithm: "dropbox-content-hash", value: meta.content_hash }
  };
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const project = () => emptyProjectState("PRJ-4520", "Intake Fault", "intake-fault", "Intake crash tests");
const now = () => "2026-08-31T11:56:00+01:00";

async function fixture(relative = "market/report.pdf") {
  const dropbox = new FaultyIntakeDropbox();
  const runtime = persistenceFromDropbox(dropbox);
  const state = project();
  const sourcePath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", relative);
  const source = await dropbox.externalAdd(sourcePath, "fault-test bytes");
  const service = new InputIntakeService(runtime, { now });
  return { dropbox, runtime, state, sourcePath, source, service, relative };
}

describe("input intake crash recovery", () => {
  it("replays after DETECTED was durable but the immutable source snapshot crashed", async () => {
    const f = await fixture("crash/detected-before-snapshot.pdf");
    f.dropbox.failSnapshotCopyOnce = true;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    const intakeId = (await f.runtime.objects.listChildren(`/PROJECT_OS/.project-os/projects/${f.state.project_id}/documents/intakes`))[0]?.name.replace(/\.json$/, "");
    expect(intakeId).toMatch(/^INTAKE-/);
    expect((await new InputIntakeRepository(f.runtime.objects).read(f.state.project_id, intakeId!))?.phase).toBe("DETECTED");

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "completed", resumed: true });
    expect(f.dropbox.files.has(f.sourcePath)).toBe(false);
  });

  it("replays after immutable snapshot succeeded but visible reference copy crashed", async () => {
    const f = await fixture("crash/snapshot-before-visible-copy.pdf");
    f.dropbox.failVisibleCopyOnce = true;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    const entries = await f.runtime.objects.listChildren(`/PROJECT_OS/.project-os/projects/${f.state.project_id}/documents/intakes`);
    const intakeId = entries[0]?.name.replace(/\.json$/, "");
    expect((await new InputIntakeRepository(f.runtime.objects).read(f.state.project_id, intakeId!))?.phase).toBe("SNAPSHOTTED");

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "completed", resumed: true });
    expect(f.dropbox.files.has(f.sourcePath)).toBe(false);
  });

  it("reuses a visible reference copy after crashing before the immutable version write", async () => {
    const f = await fixture("crash/copy-before-version.pdf");
    f.dropbox.failVersionCreateOnce = true;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    const target = workspaceManagedDocumentPath(f.state.project_id, f.state.slug, "references", `UNCLASSIFIED/${f.relative}`);
    expect(f.dropbox.files.get(target)).toBe("fault-test bytes");
    expect(f.dropbox.files.has(f.sourcePath)).toBe(true);

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "completed", resumed: true });
    expect(f.dropbox.files.has(f.sourcePath)).toBe(false);
  });

  it("finishes stale source cleanup after reference ledger commit when the first delete crashed", async () => {
    const f = await fixture("crash/ledger-before-delete.pdf");
    f.dropbox.failSourceDeleteOnce = f.sourcePath;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    expect(f.dropbox.files.has(f.sourcePath)).toBe(true);

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "completed", resumed: true });
    expect(f.dropbox.files.has(f.sourcePath)).toBe(false);
    expect(await new DocumentLedgerRepository(f.runtime).readHead(f.state.project_id, replay.document_id!)).toMatchObject({
      reference_version_id: replay.version_id
    });
  });

  it("preserves a newer source revision instead of deleting it during stale cleanup", async () => {
    const f = await fixture("crash/newer-source-before-cleanup.pdf");
    f.dropbox.failSourceDeleteOnce = f.sourcePath;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    await f.dropbox.upload(f.sourcePath, "newer human bytes", "overwrite");

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "conflict", resumed: true });
    expect(f.dropbox.files.get(f.sourcePath)).toBe("newer human bytes");
    expect((await new InputIntakeRepository(f.runtime.objects).read(f.state.project_id, replay.intake_id))?.phase).toBe("CONFLICT");
  });

  it("closes the intake when source deletion succeeded but SOURCE_REMOVED persistence crashed", async () => {
    const f = await fixture("crash/delete-before-marker.pdf");
    f.dropbox.failSourceRemovedMarkerOnce = true;
    const request = { sourcePath: f.sourcePath, relativeInputPath: f.relative, metadata: providerMetadata(f.source) };

    await expect(f.service.ingest(f.state, request)).rejects.toThrow(/injected crash/i);
    expect(f.dropbox.files.has(f.sourcePath)).toBe(false);

    const replay = await f.service.ingest(f.state, request);
    expect(replay).toMatchObject({ status: "completed", resumed: true });
    expect((await new InputIntakeRepository(f.runtime.objects).read(f.state.project_id, replay.intake_id))?.phase).toBe("COMPLETE");
  });
});
