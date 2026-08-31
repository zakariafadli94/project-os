import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { inputIntakeIdFor } from "../src/documents/input-intake";
import { InputIntakeRepository } from "../src/documents/input-intake-repository";
import { InputIntakeService } from "../src/documents/input-intake-service";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class WithdrawalDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  failSourceRemovedMarkerOnce = false;
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (
      this.failSourceRemovedMarkerOnce
      && /\/documents\/intakes\/INTAKE-[A-F0-9]{24}\.json$/.test(path)
      && content.includes('"phase": "SOURCE_REMOVED"')
    ) {
      this.failSourceRemovedMarkerOnce = false;
      throw new Error("injected deleted-source marker crash");
    }
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError("exists", "req-upload", "path/conflict/file");
    }
    await this.set(path, content, this.metadata.get(path)?.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const meta = this.metadata.get(from);
    if (content === undefined || !meta) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from); this.metadata.delete(from); await this.set(to, content, meta.id);
  }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }
  async delete(path: string): Promise<void> { this.files.delete(path); this.metadata.delete(path); }
  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }
  async externalAdd(path: string, content: string): Promise<DropboxFileMetadata> { return this.set(path, content); }

  private async set(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:W${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await hash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-31T12:20:00.000Z"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
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

function deleted(path: string): ProviderChangeEntry {
  return { kind: "deleted", name: path.split("/").at(-1)!, path };
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const project = () => emptyProjectState("PRJ-4530", "Withdrawal", "withdrawal", "Input withdrawal tests");
const now = () => "2026-08-31T13:20:00+01:00";

describe("deleted INPUTS reconciliation", () => {
  it("resolves a bound incomplete intake to WITHDRAWN instead of ignoring the deleted change", async () => {
    const dropbox = new WithdrawalDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const relative = "withdrawn/before-capture.pdf";
    const sourcePath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", relative);
    const source = await dropbox.externalAdd(sourcePath, "withdraw before capture");
    const intakeId = await inputIntakeIdFor({
      projectId: state.project_id,
      providerId: runtime.providerId,
      objectId: source.id,
      revisionToken: source.rev
    });
    const repository = new InputIntakeRepository(runtime.objects);
    const record = await repository.create({
      schema_version: "1.0",
      intake_id: intakeId,
      project_id: state.project_id,
      phase: "DETECTED",
      source: {
        provider_id: runtime.providerId,
        object_id: source.id,
        revision_token: source.rev,
        integrity_hash: { algorithm: "dropbox-content-hash", value: source.content_hash },
        size: source.size,
        provider_path: sourcePath,
        relative_input_path: relative
      },
      detected_at: now(),
      updated_at: now()
    });
    await repository.bindSourcePath(record);
    await dropbox.delete(sourcePath);

    const result = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [deleted(sourcePath)]);

    expect(result).toMatchObject({ withdrawn: 1, intake_resumed: 1, ignored: 0 });
    expect((await repository.read(state.project_id, intakeId))?.phase).toBe("WITHDRAWN");
  });

  it("converges a reference-committed intake to COMPLETE when the deleted-source event arrives", async () => {
    const dropbox = new WithdrawalDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = project();
    const relative = "completed/delete-before-marker.pdf";
    const sourcePath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", relative);
    const source = await dropbox.externalAdd(sourcePath, "durably captured bytes");
    const metadata = providerMetadata(source);
    dropbox.failSourceRemovedMarkerOnce = true;

    await expect(new InputIntakeService(runtime, { now }).ingest(state, {
      sourcePath,
      relativeInputPath: relative,
      metadata
    })).rejects.toThrow(/marker crash/i);
    expect(dropbox.files.has(sourcePath)).toBe(false);

    const intakeId = await inputIntakeIdFor({
      projectId: state.project_id,
      providerId: runtime.providerId,
      objectId: source.id,
      revisionToken: source.rev
    });
    const repository = new InputIntakeRepository(runtime.objects);
    expect((await repository.read(state.project_id, intakeId))?.phase).toBe("REFERENCE_COMMITTED");

    const result = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [deleted(sourcePath)]);

    expect(result).toMatchObject({ intake_completed: 1, intake_resumed: 1, ignored: 0 });
    expect((await repository.read(state.project_id, intakeId))?.phase).toBe("COMPLETE");
  });
});
