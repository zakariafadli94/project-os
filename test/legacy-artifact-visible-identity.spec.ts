import { describe, expect, it } from "vitest";
import type { InlineArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { workspaceProjectRoot } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { LegacyArtifactDocumentWriter } from "../src/documents/legacy-artifact";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeDropbox implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  private revision = 0;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req", "path/conflict/file");
    this.set(path, content, this.metadata.get(path)?.id);
  }
  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req", "path/conflict/file");
    return this.set(path, content, current.id);
  }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async listFolder() { return []; }
  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    return this.set(to, content);
  }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) throw new Error(`missing ${from}`);
    this.files.delete(from);
    this.metadata.delete(from);
    this.set(to, content, metadata.id);
  }
  private set(path: string, content: string, id?: string): DropboxFileMetadata {
    this.revision += 1;
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:legacy-visible-${this.revision}`,
      path,
      rev: `legacy-visible-rev-${this.revision}`,
      content_hash: fakeHash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: `2026-08-30T17:${String(this.revision).padStart(2, "0")}:00Z`
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

function fakeHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function state(targetPrefix: string) {
  const project = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
  project.decisions["DEC-LEGACY001"] = {
    decision_id: "DEC-LEGACY001", title: "govern", decision: "govern", reason: "safety", impacts: [], status: "accepted",
    created_at: "2026-08-30T17:00:00+01:00", updated_at: "2026-08-30T17:00:00+01:00"
  };
  project.artifact_routes = {
    "ROUTE-LEGACY001": {
      route_id: "ROUTE-LEGACY001",
      source_prefix: "REVENUE-OS",
      target_prefix: targetPrefix,
      ...(targetPrefix.startsWith("DELIVERABLES/") ? { archive_prefix: "ARCHIVES/REVENUE-OS" } : {}),
      exclusive: true,
      decision_ids: ["DEC-LEGACY001"],
      created_at: "2026-08-30T17:00:00+01:00",
      updated_at: "2026-08-30T17:00:00+01:00"
    }
  };
  return project;
}

async function request(content: string, id: string): Promise<InlineArtifactWriteRequest> {
  return {
    request_id: id,
    project_id: "PRJ-0003",
    relative_path: "REVENUE-OS/strategy/commercial.md",
    content,
    content_sha256: await sha256Text(content),
    mode: "create"
  };
}

describe("legacy managed Markdown visible identity", () => {
  it("publishes enriched Markdown and records the hash of the exact visible bytes", async () => {
    const dropbox = new FakeDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const source = "# Commercial strategy\n\nPublished\n";
    const result = await new LegacyArtifactDocumentWriter(runtime).writeIfManaged(
      state("DELIVERABLES/REVENUE-OS"),
      await request(source, "ART-LEGACY-VISIBLE-001")
    );
    expect(result).toBe("written");

    const visiblePath = `${workspaceProjectRoot("PRJ-0003", "growth")}/DELIVERABLES/REVENUE-OS/strategy/commercial.md`;
    const visible = dropbox.files.get(visiblePath)!;
    const headPath = [...dropbox.files.keys()].find((path) => path.includes("/documents/heads/"))!;
    const head = JSON.parse(dropbox.files.get(headPath)!);
    expect(visible).toContain("project_id: PRJ-0003\n");
    expect(visible).toContain(`document_id: ${head.document_id}\n`);
    expect(visible).toContain("# Commercial strategy\n");

    const version = await new DocumentLedgerRepository(runtime).readVersion("PRJ-0003", head.document_id, head.published_version_id);
    expect(version?.content_sha256).toBe(await sha256Text(visible));
    expect(dropbox.files.get(version!.immutable_payload_path)).toBe(visible);
  });

  it("keeps legacy REFERENCES Markdown byte-preserving", async () => {
    const dropbox = new FakeDropbox();
    const source = "reference bytes\n";
    const result = await new LegacyArtifactDocumentWriter(persistenceFromDropbox(dropbox)).writeIfManaged(
      state("REFERENCES/MARKET"),
      await request(source, "ART-LEGACY-VISIBLE-002")
    );
    expect(result).toBe("written");
    const visiblePath = `${workspaceProjectRoot("PRJ-0003", "growth")}/REFERENCES/MARKET/strategy/commercial.md`;
    expect(dropbox.files.get(visiblePath)).toBe(source);
  });
});
