import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import {
  DropboxConflictError,
  type DropboxEntry,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { ArtifactContentConflictError, ProjectRepository } from "../src/dropbox/repository";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  private ids = new Map<string, string>();
  private revisions = new Map<string, number>();
  private nextId = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-artifact", "path/conflict/file");
    }
    this.ensureIdentity(path);
    this.files.set(path, content);
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
    this.uploads.push({ path, mode });
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(): Promise<void> {
    throw new Error("unused");
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    const content = this.files.get(path);
    if (content === undefined) return null;
    this.ensureIdentity(path);
    if (!this.revisions.has(path)) this.revisions.set(path, 1);
    return {
      id: this.ids.get(path)!,
      path,
      rev: `fake-rev-${this.revisions.get(path)}`,
      content_hash: await sha256(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T16:00:00.000Z"
    };
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .sort()
      .map((candidate) => ({
        tag: "file" as const,
        name: candidate.slice(prefix.length),
        path_display: candidate
      }));
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new DropboxConflictError(`missing ${from}`, "req-copy", "from_lookup/not_found");
    }
    if (this.files.has(to)) {
      throw new DropboxConflictError(`exists ${to}`, "req-copy", "to/conflict/file");
    }
    this.ensureIdentity(to);
    this.files.set(to, content);
    this.revisions.set(to, 1);
    return (await this.getMetadata(to))!;
  }

  private ensureIdentity(path: string): void {
    if (!this.ids.has(path)) this.ids.set(path, `id:fake-${String(this.nextId++).padStart(6, "0")}`);
  }
}

const hash = "b517e96409d16740c506cef42d9a539c46a5a9bb4f4301e85198a16ee5711ebd";
const request: ArtifactWriteRequest = {
  request_id: "ART-GROWTH-000001",
  project_id: "PRJ-0003",
  relative_path: "playbooks/06-acquisition-multicanale.md",
  content: "# Acquisition",
  content_sha256: hash,
  mode: "create"
};

function state() {
  return emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
}

function visibleUploads(transport: FakeTransport) {
  return transport.uploads.filter((entry) => entry.path.includes("/WORKSPACE/PROJECTS/"));
}

function hasCandidateEvidence(transport: FakeTransport) {
  return [...transport.files.keys()].some((path) => path.includes("/mutation-gate/candidates/MUTCAND-"));
}

describe("ProjectRepository artifact writes", () => {
  it("creates a new artifact after durable mutation evidence", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");

    await expect(repository.writeArtifact(state(), request)).resolves.toBe("written");
    expect(visibleUploads(transport)).toHaveLength(1);
    expect(visibleUploads(transport)[0]?.mode).toBe("add");
    expect(transport.uploads[0]?.path).toContain("/mutation-gate/intents/artifacts/");
  });

  it("treats same-content governed create replay as idempotent", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    await repository.writeArtifact(state(), request);

    await expect(repository.writeArtifact(state(), request)).resolves.toBe("idempotent");
    expect(visibleUploads(transport)).toHaveLength(1);
    expect(hasCandidateEvidence(transport)).toBe(false);
  });

  it("captures and blocks a different pre-existing artifact on create", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "different");

    await expect(repository.writeArtifact(state(), request)).rejects.toBeInstanceOf(ArtifactContentConflictError);
    expect(visibleUploads(transport)).toHaveLength(0);
    expect(transport.files.get(path)).toBe("different");
    expect(transport.uploads.some((entry) => entry.path.includes("/mutation-gate/intents/artifacts/"))).toBe(true);
    expect(hasCandidateEvidence(transport)).toBe(true);
  });

  it("blocks ordinary replace when the destination is an unresolved external candidate", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "old");

    await expect(repository.writeArtifact(state(), { ...request, mode: "replace" }))
      .rejects.toBeInstanceOf(ArtifactContentConflictError);
    expect(transport.files.get(path)).toBe("old");
    expect(visibleUploads(transport)).toHaveLength(0);
    expect(hasCandidateEvidence(transport)).toBe(true);
  });

  it("does not launder a same-content pre-existing file as an idempotent replace", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "# Acquisition");

    await expect(repository.writeArtifact(state(), { ...request, mode: "replace" }))
      .rejects.toBeInstanceOf(ArtifactContentConflictError);
    expect(transport.files.get(path)).toBe("# Acquisition");
    expect(visibleUploads(transport)).toHaveLength(0);
    expect(hasCandidateEvidence(transport)).toBe(true);
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
