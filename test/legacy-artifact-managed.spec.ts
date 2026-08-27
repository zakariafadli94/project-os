import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { workspaceProjectRoot } from "../src/dropbox/layout";
import { LegacyArtifactDocumentWriter } from "../src/documents/legacy-artifact";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  conditionalWrites = 0;
  raceBeforeConditional?: { path: string; content: string };
  private revision = 0;

  seed(path: string, content: string): DropboxFileMetadata {
    return this.set(path, content);
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    this.set(path, content, this.metadata.get(path)?.id);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const race = this.raceBeforeConditional;
    const before = this.metadata.get(path);
    if (race?.path === path && before) {
      this.raceBeforeConditional = undefined;
      this.set(path, race.content, before.id);
    }
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    this.conditionalWrites += 1;
    return this.set(path, content, current.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }

  async listFolder(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing source ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) throw new Error(`missing source ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.metadata.delete(from);
    this.set(to, content, metadata.id);
  }

  private set(path: string, content: string, id?: string): DropboxFileMetadata {
    this.revision += 1;
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:legacy-${this.revision}`,
      path,
      rev: `legacy-rev-${this.revision}`,
      content_hash: contentHash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: `2026-08-25T09:${String(this.revision).padStart(2, "0")}:00Z`
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

function contentHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function state(targetPrefix = "DELIVERABLES/REVENUE-OS") {
  const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
  state.decisions["DEC-LEGACY001"] = {
    decision_id: "DEC-LEGACY001", title: "govern legacy route", decision: "govern", reason: "safety", impacts: [], status: "accepted",
    created_at: "2026-08-25T09:00:00Z", updated_at: "2026-08-25T09:00:00Z"
  };
  state.artifact_routes = {
    "ROUTE-LEGACY001": {
      route_id: "ROUTE-LEGACY001",
      source_prefix: "REVENUE-OS",
      target_prefix: targetPrefix,
      ...(targetPrefix.startsWith("DELIVERABLES/") ? { archive_prefix: "ARCHIVES/REVENUE-OS" } : {}),
      exclusive: true,
      decision_ids: ["DEC-LEGACY001"],
      created_at: "2026-08-25T09:00:00Z",
      updated_at: "2026-08-25T09:00:00Z"
    }
  };
  return state;
}

async function request(content: string, mode: "create" | "replace", requestId: string): Promise<ArtifactWriteRequest> {
  return {
    request_id: requestId,
    project_id: "PRJ-0003",
    relative_path: "REVENUE-OS/strategy/commercial.md",
    content,
    content_sha256: await sha256(content),
    mode
  };
}

describe("legacy artifact managed-document compatibility", () => {
  it("records a routed DELIVERABLES artifact as a published managed-document version", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const writer = new LegacyArtifactDocumentWriter(runtime);
    const result = await writer.writeIfManaged(state(), await request("published v1", "create", "ART-LEGACY-000001"));

    expect(result).toBe("written");
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/DELIVERABLES/REVENUE-OS/strategy/commercial.md`;
    expect(dropbox.files.get(visible)).toBe("published v1");

    const ledger = new DocumentLedgerRepository(runtime);
    const heads = [...dropbox.files.keys()].filter((path) => path.includes("/documents/heads/"));
    expect(heads).toHaveLength(1);
    const head = JSON.parse(dropbox.files.get(heads[0])!);
    const version = await ledger.readVersion("PRJ-0003", head.document_id, head.published_version_id);
    expect(version).toMatchObject({ stage: "published", source: "legacy_artifact_api", request_id: "ART-LEGACY-000001" });
  });

  it("replaces a governed deliverable through provider CAS and keeps the legacy archive", async () => {
    const dropbox = new FakeDropbox();
    const writer = new LegacyArtifactDocumentWriter(persistenceFromDropbox(dropbox));
    await writer.writeIfManaged(state(), await request("published v1", "create", "ART-LEGACY-000002"));
    await writer.writeIfManaged(state(), await request("published v2", "replace", "ART-LEGACY-000003"));

    expect(dropbox.conditionalWrites).toBe(1);
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/DELIVERABLES/REVENUE-OS/strategy/commercial.md`;
    expect(dropbox.files.get(visible)).toBe("published v2");
    const archive = [...dropbox.files.keys()].find((path) => path.includes("/ARCHIVES/REVENUE-OS/") && path.includes("commercial.previous-"));
    expect(archive).toBeDefined();
    expect(dropbox.files.get(archive!)).toBe("published v1");
  });

  it("fails closed when a human edit races with a legacy deliverable replace", async () => {
    const dropbox = new FakeDropbox();
    const writer = new LegacyArtifactDocumentWriter(persistenceFromDropbox(dropbox));
    await writer.writeIfManaged(state(), await request("published v1", "create", "ART-LEGACY-000004"));
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/DELIVERABLES/REVENUE-OS/strategy/commercial.md`;
    dropbox.raceBeforeConditional = { path: visible, content: "human edit" };

    await expect(writer.writeIfManaged(state(), await request("published v2", "replace", "ART-LEGACY-000005")))
      .rejects.toMatchObject({ name: "ArtifactContentConflictError" });
    expect(dropbox.files.get(visible)).toBe("human edit");
  });

  it("records a routed REFERENCES artifact as a managed reference without changing the legacy API contract", async () => {
    const dropbox = new FakeDropbox();
    const writer = new LegacyArtifactDocumentWriter(persistenceFromDropbox(dropbox));
    const result = await writer.writeIfManaged(state("REFERENCES/MARKET"), await request("reference bytes", "create", "ART-LEGACY-000006"));

    expect(result).toBe("written");
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/REFERENCES/MARKET/strategy/commercial.md`;
    expect(dropbox.files.get(visible)).toBe("reference bytes");
    const heads = [...dropbox.files.keys()].filter((path) => path.includes("/documents/heads/"));
    const head = JSON.parse(dropbox.files.get(heads[0])!);
    expect(head).toMatchObject({ kind: "reference", collection_path: "MARKET", logical_path: "strategy/commercial.md" });
  });

  it("repairs an interrupted first DELIVERABLES create by attaching the original artifact request provenance", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const writer = new LegacyArtifactDocumentWriter(runtime);
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/DELIVERABLES/REVENUE-OS/strategy/commercial.md`;
    dropbox.seed(visible, "partial published");

    const result = await writer.writeIfManaged(state(), await request("partial published", "create", "ART-LEGACY-000008"));
    expect(result).toBe("idempotent");

    const heads = [...dropbox.files.keys()].filter((path) => path.includes("/documents/heads/"));
    const head = JSON.parse(dropbox.files.get(heads[0])!);
    const version = await new DocumentLedgerRepository(runtime).readVersion("PRJ-0003", head.document_id, head.published_version_id);
    expect(version).toMatchObject({ source: "legacy_artifact_api", request_id: "ART-LEGACY-000008", stage: "published" });
  });

  it("repairs an interrupted first REFERENCES create by attaching the original artifact request provenance", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const writer = new LegacyArtifactDocumentWriter(runtime);
    const visible = `${workspaceProjectRoot("PRJ-0003", "growth")}/REFERENCES/MARKET/strategy/commercial.md`;
    dropbox.seed(visible, "partial reference");

    const result = await writer.writeIfManaged(state("REFERENCES/MARKET"), await request("partial reference", "create", "ART-LEGACY-000009"));
    expect(result).toBe("idempotent");

    const heads = [...dropbox.files.keys()].filter((path) => path.includes("/documents/heads/"));
    const head = JSON.parse(dropbox.files.get(heads[0])!);
    const version = await new DocumentLedgerRepository(runtime).readVersion("PRJ-0003", head.document_id, head.reference_version_id);
    expect(version).toMatchObject({ source: "legacy_artifact_api", request_id: "ART-LEGACY-000009", stage: "reference" });
  });

  it("returns null for historical artifact destinations that are not managed-document zones", async () => {
    const dropbox = new FakeDropbox();
    const writer = new LegacyArtifactDocumentWriter(persistenceFromDropbox(dropbox));
    const result = await writer.writeIfManaged(emptyProjectState("PRJ-0003", "Growth", "growth", "Build"), await request("plain", "create", "ART-LEGACY-000007"));
    expect(result).toBeNull();
  });
});
