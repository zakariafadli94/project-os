import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { ArtifactGovernanceConflictError, ProjectRepository } from "../src/dropbox/repository";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  metadata = new Map<string, DropboxFileMetadata>();
  uploads: string[] = [];
  conditionalWrites = 0;
  private revision = 0;

  seed(path: string, content: string): DropboxFileMetadata {
    return this.set(path, content);
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-add", "path/conflict/file");
    this.set(path, content, this.metadata.get(path)?.id);
    this.uploads.push(path);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = this.metadata.get(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("stale", "req-cas", "path/conflict/file");
    this.conditionalWrites += 1;
    this.set(path, content, current.id);
    this.uploads.push(path);
    return this.metadata.get(path)!;
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
    if (content === undefined) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const metadata = this.metadata.get(from);
    if (content === undefined || !metadata) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.metadata.delete(from);
    this.set(to, content, metadata.id);
  }

  private set(path: string, content: string, id?: string): DropboxFileMetadata {
    this.revision += 1;
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:routing-${this.revision}`,
      path,
      rev: `routing-rev-${this.revision}`,
      content_hash: providerHash(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: `2026-08-25T09:${String(this.revision).padStart(2, "0")}:00Z`
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

function providerHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

async function artifactRequest(overrides: Partial<ArtifactWriteRequest> = {}): Promise<ArtifactWriteRequest> {
  const content = overrides.content ?? "# routed";
  return {
    request_id: "ART-ROUTING-000001",
    project_id: "PRJ-0003",
    relative_path: "REVENUE-OS/04-playbooks-sectoriels/foo.md",
    mode: "create",
    ...overrides,
    content,
    content_sha256: overrides.content_sha256 ?? await sha256Text(content)
  };
}

function configuredState() {
  const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
  state.decisions["DEC-REVENUESINGLETREE001"] = {
    decision_id: "DEC-REVENUESINGLETREE001", title: "single tree", decision: "single tree", reason: "governance", impacts: [], status: "accepted", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z"
  };
  state.decisions["DEC-REVENUEARCHIVE001"] = {
    decision_id: "DEC-REVENUEARCHIVE001", title: "archive", decision: "archive", reason: "history", impacts: [], status: "accepted", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z"
  };
  state.artifact_routes = {
    "ROUTE-REVENUE001": {
      route_id: "ROUTE-REVENUE001",
      source_prefix: "REVENUE-OS",
      target_prefix: "DELIVERABLES/REVENUE-OS",
      archive_prefix: "ARCHIVES/REVENUE-OS",
      exclusive: true,
      decision_ids: ["DEC-REVENUESINGLETREE001", "DEC-REVENUEARCHIVE001"],
      created_at: "2026-08-23T12:00:00Z",
      updated_at: "2026-08-23T12:00:00Z"
    }
  };
  return state;
}

describe("project artifact routing", () => {
  it("routes a configured domain into its governed business tree instead of ARTIFACTS", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    await repository.writeArtifact(configuredState(), await artifactRequest());

    const activePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/foo.md";
    expect(transport.files.get(activePath)).toBe("# routed");
    expect([...transport.files.keys()].some((path) => path.includes("/ARTIFACTS/REVENUE-OS/"))).toBe(false);
    expect([...transport.files.keys()].some((path) => path.includes("/.project-os/projects/PRJ-0003/documents/heads/"))).toBe(true);
  });

  it("keeps the legacy ARTIFACTS root when no route matches", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
    await repository.writeArtifact(state, await artifactRequest({ relative_path: "OTHER/foo.md" }));
    const visiblePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/OTHER/foo.md";
    expect(transport.uploads).toContain(visiblePath);
    expect(transport.uploads.findIndex((path) => path.includes("/mutation-gate/intents/artifacts/")))
      .toBeLessThan(transport.uploads.indexOf(visiblePath));
  });

  it("blocks a physical ARTIFACTS bypass for an exclusive governed domain", async () => {
    const repository = new ProjectRepository(new FakeTransport(), "v2");
    await expect(repository.writeArtifact(configuredState(), await artifactRequest({
      relative_path: "ARTIFACTS/REVENUE-OS/04-playbooks-sectoriels/foo.md"
    }))).rejects.toBeInstanceOf(ArtifactGovernanceConflictError);
  });

  it("blocks writes when a governing decision is no longer accepted", async () => {
    const state = configuredState();
    state.decisions["DEC-REVENUESINGLETREE001"].status = "superseded";
    const repository = new ProjectRepository(new FakeTransport(), "v2");
    await expect(repository.writeArtifact(state, await artifactRequest())).rejects.toBeInstanceOf(ArtifactGovernanceConflictError);
  });

  it("archives the replaced governed active content under ARCHIVES without polluting DELIVERABLES", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const activePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/foo.md";

    await repository.writeArtifact(configuredState(), await artifactRequest({
      request_id: "ART-ROUTING-SEED-0001",
      content: "# old",
      mode: "create"
    }));
    expect(transport.files.get(activePath)).toBe("# old");

    await repository.writeArtifact(configuredState(), await artifactRequest({
      request_id: "ART-ROUTING-000002",
      content: "# new",
      mode: "replace"
    }));

    expect(transport.files.get(activePath)).toBe("# new");
    expect(transport.conditionalWrites).toBe(1);
    const archivePath = transport.uploads.find((path) => path.includes("/ARCHIVES/REVENUE-OS/") && path.includes("foo.previous-"));
    expect(archivePath).toBeDefined();
    expect(archivePath?.endsWith(".md")).toBe(true);
    expect(transport.files.get(archivePath!)).toBe("# old");
    expect(transport.uploads.filter((path) => path.includes("/DELIVERABLES/REVENUE-OS/") && path.includes("previous-"))).toHaveLength(0);
  });

  it("requires accepted decisions before a route can be configured", () => {
    const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
    const tx = parseTransaction({
      schema_version: "1.0", transaction_id: "TXN-ARTROUTE-000001", project_id: "PRJ-0003", base_revision: 0,
      created_at: "2026-08-23T12:00:00Z", operation: "artifact.route.configure",
      payload: { route_id: "ROUTE-REVENUE001", source_prefix: "REVENUE-OS", target_prefix: "DELIVERABLES/REVENUE-OS", archive_prefix: "ARCHIVES/REVENUE-OS", exclusive: true, decision_ids: ["DEC-REVENUESINGLETREE001"] }
    });
    expect(applyTransaction(state, tx)).toMatchObject({ kind: "rejected", code: "ARTIFACT_ROUTE_DECISION_NOT_ACCEPTED" });
  });

  it("commits a route only when every governing decision is accepted", () => {
    const state = configuredState(); state.artifact_routes = {};
    const tx = parseTransaction({
      schema_version: "1.0", transaction_id: "TXN-ARTROUTE-000002", project_id: "PRJ-0003", base_revision: 0,
      created_at: "2026-08-23T12:00:00Z", operation: "artifact.route.configure",
      payload: { route_id: "ROUTE-REVENUE001", source_prefix: "REVENUE-OS", target_prefix: "DELIVERABLES/REVENUE-OS", archive_prefix: "ARCHIVES/REVENUE-OS", exclusive: true, decision_ids: ["DEC-REVENUESINGLETREE001", "DEC-REVENUEARCHIVE001"] }
    });
    const result = applyTransaction(state, tx);
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect(result.state.artifact_routes["ROUTE-REVENUE001"].target_prefix).toBe("DELIVERABLES/REVENUE-OS");
  });

  it("requires a newly accepted decision to change an existing route target", () => {
    const state = configuredState();
    const tx = parseTransaction({
      schema_version: "1.0", transaction_id: "TXN-ARTROUTE-000003", project_id: "PRJ-0003", base_revision: 0,
      created_at: "2026-08-23T12:05:00Z", operation: "artifact.route.configure",
      payload: { route_id: "ROUTE-REVENUE001", source_prefix: "REVENUE-OS", target_prefix: "ARTIFACTS/REVENUE-OS", archive_prefix: "ARCHIVES/REVENUE-OS", exclusive: true, decision_ids: ["DEC-REVENUESINGLETREE001", "DEC-REVENUEARCHIVE001"] }
    });
    expect(applyTransaction(state, tx)).toMatchObject({ kind: "rejected", code: "ARTIFACT_ROUTE_CHANGE_REQUIRES_NEW_DECISION" });
  });
});