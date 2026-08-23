import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxTransport } from "../src/dropbox/client";
import { ArtifactContentConflictError, ProjectRepository } from "../src/dropbox/repository";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    this.files.set(path, content);
    this.uploads.push({ path, mode });
  }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async move(): Promise<void> { throw new Error("unused"); }
}

const hash = "a".repeat(64);
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

describe("ProjectRepository artifact writes", () => {
  it("creates a new artifact", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");

    await expect(repository.writeArtifact(state(), request)).resolves.toBe("written");
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0]?.mode).toBe("add");
  });

  it("treats same-content create replay as idempotent", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    await repository.writeArtifact(state(), request);

    await expect(repository.writeArtifact(state(), request)).resolves.toBe("idempotent");
    expect(transport.uploads).toHaveLength(1);
  });

  it("returns a real conflict for create with different existing content", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "different");

    await expect(repository.writeArtifact(state(), request)).rejects.toBeInstanceOf(ArtifactContentConflictError);
    expect(transport.uploads).toHaveLength(0);
  });

  it("replaces different content only in replace mode", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "old");

    await expect(repository.writeArtifact(state(), { ...request, mode: "replace" })).resolves.toBe("written");
    expect(transport.files.get(path)).toBe("# Acquisition");
    expect(transport.uploads.at(-1)?.mode).toBe("overwrite");
  });

  it("treats same-content replace as idempotent", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/playbooks/06-acquisition-multicanale.md";
    transport.files.set(path, "# Acquisition");

    await expect(repository.writeArtifact(state(), { ...request, mode: "replace" })).resolves.toBe("idempotent");
    expect(transport.uploads).toHaveLength(0);
  });
});
