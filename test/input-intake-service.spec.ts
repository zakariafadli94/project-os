import { describe, expect, it } from "vitest";
import { documentIdForProviderFile } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { inputIntakeIdFor } from "../src/documents/input-intake";
import { InputIntakeRepository } from "../src/documents/input-intake-repository";
import { InputIntakeService } from "../src/documents/input-intake-service";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { machineDocumentProviderPayloadPath } from "../src/persistence/layout";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class IntakeDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  readonly deleteCalls: string[] = [];
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-upload", "path/conflict/file");
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
  async delete(path: string): Promise<void> {
    this.deleteCalls.push(path);
    this.files.delete(path);
    this.metadata.delete(path);
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
      id: id ?? `id:I${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await hash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-31T11:55:00.000Z"
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

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const state = () => emptyProjectState("PRJ-4510", "Intake", "intake", "Input intake tests");
const now = () => "2026-08-31T11:56:00+01:00";

describe("postcondition-driven input intake", () => {
  it("converges a nested INPUT to a governed UNCLASSIFIED reference and removes only the source file", async () => {
    const dropbox = new IntakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const relative = "market/2026/report.pdf";
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", relative);
    const source = await dropbox.externalAdd(inputPath, "report bytes");

    const result = await new InputIntakeService(runtime, { now }).ingest(project, {
      sourcePath: inputPath,
      relativeInputPath: relative,
      metadata: providerMetadata(source)
    });

    expect(result).toMatchObject({ status: "completed", resumed: false });
    expect(dropbox.files.has(inputPath)).toBe(false);
    const targetPath = workspaceManagedDocumentPath(
      project.project_id,
      project.slug,
      "references",
      `UNCLASSIFIED/${relative}`
    );
    expect(dropbox.files.get(targetPath)).toBe("report bytes");
    expect(dropbox.deleteCalls).toEqual([inputPath]);
    expect(dropbox.files.get(machineDocumentProviderPayloadPath(
      project.project_id,
      result.document_id!,
      result.version_id!
    ))).toBe("report bytes");

    const intake = await new InputIntakeRepository(runtime.objects).read(project.project_id, result.intake_id);
    expect(intake?.phase).toBe("COMPLETE");
    const head = await new DocumentLedgerRepository(runtime).readHead(project.project_id, result.document_id!);
    expect(head).toMatchObject({
      kind: "reference",
      logical_path: relative,
      collection_path: "UNCLASSIFIED",
      reference_version_id: result.version_id
    });
  });

  it("replays an already COMPLETE intake without repeating cleanup or creating new reference identity", async () => {
    const dropbox = new IntakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const relative = "market/replay.pdf";
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", relative);
    const source = await dropbox.externalAdd(inputPath, "replay bytes");
    const request = { sourcePath: inputPath, relativeInputPath: relative, metadata: providerMetadata(source) };
    const service = new InputIntakeService(runtime, { now });

    const first = await service.ingest(project, request);
    const replay = await service.ingest(project, request);

    expect(first).toMatchObject({ status: "completed", resumed: false });
    expect(replay).toMatchObject({
      status: "completed",
      resumed: true,
      intake_id: first.intake_id,
      document_id: first.document_id,
      version_id: first.version_id
    });
    expect(dropbox.deleteCalls).toEqual([inputPath]);
  });

  it("records WITHDRAWN without resurrecting a source that disappeared before governed capture", async () => {
    const dropbox = new IntakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const relative = "withdrawn/report.pdf";
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", relative);
    const source = await dropbox.externalAdd(inputPath, "withdrawn bytes");
    const metadata = providerMetadata(source);
    const intakeId = await inputIntakeIdFor({
      projectId: project.project_id,
      providerId: runtime.providerId,
      objectId: source.id,
      revisionToken: source.rev
    });
    const repository = new InputIntakeRepository(runtime.objects);
    const detected = await repository.create({
      schema_version: "1.0",
      intake_id: intakeId,
      project_id: project.project_id,
      phase: "DETECTED",
      source: {
        provider_id: runtime.providerId,
        object_id: source.id,
        revision_token: source.rev,
        integrity_hash: { algorithm: "dropbox-content-hash", value: source.content_hash },
        size: source.size,
        provider_path: inputPath,
        relative_input_path: relative
      },
      detected_at: now(),
      updated_at: now()
    });
    await repository.bindSourcePath(detected);
    await dropbox.delete(inputPath);

    const result = await new InputIntakeService(runtime, { now }).ingest(project, {
      sourcePath: inputPath,
      relativeInputPath: relative,
      metadata
    });

    expect(result).toMatchObject({ status: "withdrawn", resumed: true, intake_id: intakeId });
    expect((await repository.read(project.project_id, intakeId))?.phase).toBe("WITHDRAWN");
    const targetPath = workspaceManagedDocumentPath(project.project_id, project.slug, "references", `UNCLASSIFIED/${relative}`);
    expect(dropbox.files.has(targetPath)).toBe(false);
    expect(dropbox.files.has(inputPath)).toBe(false);
  });

  it("cleans an exact duplicate INPUT without creating a second reference document", async () => {
    const dropbox = new IntakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const service = new InputIntakeService(runtime, { now });

    const firstPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", "market/report.pdf");
    const first = await dropbox.externalAdd(firstPath, "same report");
    const firstResult = await service.ingest(project, {
      sourcePath: firstPath,
      relativeInputPath: "market/report.pdf",
      metadata: providerMetadata(first)
    });
    expect(firstResult.status).toBe("completed");

    const duplicatePath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", "duplicates/report-copy.pdf");
    const duplicate = await dropbox.externalAdd(duplicatePath, "same report");
    const duplicateResult = await service.ingest(project, {
      sourcePath: duplicatePath,
      relativeInputPath: "duplicates/report-copy.pdf",
      metadata: providerMetadata(duplicate)
    });

    expect(duplicateResult).toMatchObject({ status: "duplicate_cleaned" });
    expect(dropbox.files.has(duplicatePath)).toBe(false);
    const duplicateDocumentId = await documentIdForProviderFile(project.project_id, duplicate.id);
    expect(await new DocumentLedgerRepository(runtime).readHead(project.project_id, duplicateDocumentId)).toBeNull();
  });

  it("fails closed on a divergent reference destination and preserves the INPUT", async () => {
    const dropbox = new IntakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const project = state();
    const relative = "conflict/report.pdf";
    const inputPath = workspaceManagedDocumentPath(project.project_id, project.slug, "inputs", relative);
    const targetPath = workspaceManagedDocumentPath(project.project_id, project.slug, "references", `UNCLASSIFIED/${relative}`);
    const source = await dropbox.externalAdd(inputPath, "source bytes");
    await dropbox.externalAdd(targetPath, "different destination bytes");

    const result = await new InputIntakeService(runtime, { now }).ingest(project, {
      sourcePath: inputPath,
      relativeInputPath: relative,
      metadata: providerMetadata(source)
    });

    expect(result.status).toBe("conflict");
    expect(dropbox.files.get(inputPath)).toBe("source bytes");
    expect(dropbox.files.get(targetPath)).toBe("different destination bytes");
    expect((await new InputIntakeRepository(runtime.objects).read(project.project_id, result.intake_id))?.phase).toBe("CONFLICT");
  });
});
