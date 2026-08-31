import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { DropboxConflictError } from "../src/dropbox/client";
import { sha256Text } from "../src/documents/hash";
import { InputIntakeService } from "../src/documents/input-intake-service";
import {
  ReferralProvenanceRepository,
  referralIntentPath
} from "../src/documents/referral-provenance";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class ReferralDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
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
    this.files.delete(from);
    this.metadata.delete(from);
    await this.set(to, content, meta.id);
  }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
  }
  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }

  private async set(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:R${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      // Provider integrity evidence is deliberately distinct from referral content_sha256.
      content_hash: await sha256Text(`provider-integrity:${content}`),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-31T15:05:00.000Z"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

const now = () => "2026-08-31T15:06:00+01:00";

function targetState() {
  return emptyProjectState("PRJ-5202", "Referral target", "referral-target", "Referral routing test");
}

describe("referral intake routing", () => {
  it("routes a machine-verified referral to the source-project REFERRALS collection", async () => {
    const dropbox = new ReferralDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const sourceProjectId = "PRJ-5201";
    const target = targetState();
    const relativePath = "improvements/input-lifecycle.md";
    const content = "# Referral\n\nInvestigate the INPUTS lifecycle.";
    const inputPath = workspaceManagedDocumentPath(target.project_id, target.slug, "inputs", relativePath);
    const request = {
      schema_version: "1.0" as const,
      request_id: "REF-VERIFIED-ROUTING-0001",
      source_project_id: sourceProjectId,
      target_project_id: target.project_id,
      relative_path: relativePath,
      content,
      content_sha256: await sha256Text(content),
      created_at: now(),
      referral_type: "project_os_improvement_anomaly",
      topic: "input_lifecycle"
    };

    expect(await new ReferralProvenanceRepository(runtime.objects).deliver(target, request)).toMatchObject({
      status: "committed"
    });
    const metadata = await runtime.objects.getMetadata(inputPath);
    expect(metadata).not.toBeNull();
    expect(metadata!.integrityHash?.value).not.toBe(request.content_sha256);

    const result = await new InputIntakeService(runtime, { now }).ingest(target, {
      sourcePath: inputPath,
      relativeInputPath: relativePath,
      metadata: metadata!
    });

    expect(result.status).toBe("completed");
    const referralPath = workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "references",
      `REFERRALS/${sourceProjectId}/${relativePath}`
    );
    expect(dropbox.files.get(referralPath)).toBe(content);
    expect(dropbox.files.has(inputPath)).toBe(false);

    const head = await new DocumentLedgerRepository(runtime).readHead(target.project_id, result.document_id!);
    expect(head).toMatchObject({
      kind: "reference",
      logical_path: relativePath,
      collection_path: `REFERRALS/${sourceProjectId}`,
      reference_version_id: result.version_id
    });
  });

  it("fails closed when durable referral intent and input binding disagree", async () => {
    const dropbox = new ReferralDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const target = targetState();
    const relativePath = "anomalies/provenance-mismatch.md";
    const content = "# Referral\n\nMachine provenance must match.";
    const inputPath = workspaceManagedDocumentPath(target.project_id, target.slug, "inputs", relativePath);
    const request = {
      schema_version: "1.0" as const,
      request_id: "REF-PROVENANCE-MISMATCH-0002",
      source_project_id: "PRJ-5201",
      target_project_id: target.project_id,
      relative_path: relativePath,
      content,
      content_sha256: await sha256Text(content),
      created_at: now()
    };

    expect(await new ReferralProvenanceRepository(runtime.objects).deliver(target, request)).toMatchObject({
      status: "committed"
    });
    const intentPath = referralIntentPath(target.project_id, request.request_id);
    const intent = JSON.parse(dropbox.files.get(intentPath)!);
    intent.content_sha256 = await sha256Text("different content");
    dropbox.files.set(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

    const metadata = await runtime.objects.getMetadata(inputPath);
    expect(metadata).not.toBeNull();
    const result = await new InputIntakeService(runtime, { now }).ingest(target, {
      sourcePath: inputPath,
      relativeInputPath: relativePath,
      metadata: metadata!
    });

    expect(result.status).toBe("conflict");
    expect(dropbox.files.get(inputPath)).toBe(content);
    expect(dropbox.files.has(workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "references",
      `REFERRALS/${request.source_project_id}/${relativePath}`
    ))).toBe(false);
  });

  it("keeps referral-looking Markdown without machine provenance in UNCLASSIFIED", async () => {
    const dropbox = new ReferralDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const target = targetState();
    const relativePath = "manual/referral-looking.md";
    const content = "# Cross-project referral\n\nsource_project_id: PRJ-5201";
    const inputPath = workspaceManagedDocumentPath(target.project_id, target.slug, "inputs", relativePath);

    await runtime.objects.createText(inputPath, content);
    const metadata = await runtime.objects.getMetadata(inputPath);
    expect(metadata).not.toBeNull();
    const result = await new InputIntakeService(runtime, { now }).ingest(target, {
      sourcePath: inputPath,
      relativeInputPath: relativePath,
      metadata: metadata!
    });

    expect(result.status).toBe("completed");
    expect(dropbox.files.get(workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "references",
      `UNCLASSIFIED/${relativePath}`
    ))).toBe(content);
    expect(dropbox.files.has(workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "references",
      `REFERRALS/PRJ-5201/${relativePath}`
    ))).toBe(false);
  });
});