import { describe, expect, it, vi } from "vitest";
import { DropboxConflictError, type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { MutationCandidateResolutionService } from "../src/mutation-gate/resolution-service";

class CrashableMutationGateDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  failResolutionJsonOnce = false;
  private nextId = 1;
  private nextRev = 1;

  async seed(path: string, content: string, id = `id:seed-${this.nextId++}`): Promise<DropboxFileMetadata> {
    this.files.set(path, content);
    const metadata = await this.makeMetadata(path, content, id);
    this.metadata.set(path, metadata);
    return metadata;
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (this.failResolutionJsonOnce && /\/resolutions\/MUTCAND-[A-F0-9]{24}\/MUTRES-[A-F0-9]{24}\.json$/.test(path)) {
      this.failResolutionJsonOnce = false;
      throw new Error("injected crash after terminal marker");
    }
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`conflict ${path}`, "req-fault", "path/conflict/file");
    }
    this.files.set(path, content);
    this.metadata.set(path, await this.makeMetadata(path, content));
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(): Promise<void> {
    throw new Error("unused");
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    if (this.files.has(to)) {
      throw new DropboxConflictError(`copy conflict ${to}`, "req-fault", "to/conflict/file");
    }
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing source ${from}`);
    this.files.set(to, content);
    const metadata = await this.makeMetadata(to, content);
    this.metadata.set(to, metadata);
    return metadata;
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    return this.metadata.get(path) ?? null;
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .sort()
      .map((candidate) => ({ tag: "file" as const, name: candidate.slice(prefix.length), path_display: candidate }));
  }

  private async makeMetadata(path: string, content: string, id = `id:fault-${this.nextId++}`): Promise<DropboxFileMetadata> {
    return {
      id,
      path,
      rev: `rev-${this.nextRev++}`,
      content_hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T18:10:00+01:00"
    };
  }
}

describe("MutationGate terminal resolution crash recovery", () => {
  it("blocks a conflicting downstream after terminal marker survives but resolution JSON is missing", async () => {
    const transport = new CrashableMutationGateDropbox();
    const repository = new MutationGateRepository(transport);
    const service = new MutationCandidateResolutionService(transport);
    const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Mutation gate fault test");
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARTIFACTS/direct.md";
    const content = "# candidate";
    const metadata = await transport.seed(path, content, "id:direct");
    const candidate = (await repository.captureCandidate({
      projectId: state.project_id,
      detectionSource: "incremental",
      visiblePath: path,
      metadata,
      detectedAt: "2026-08-25T18:10:00+01:00"
    })).record;

    transport.failResolutionJsonOnce = true;
    await expect(service.resolve({
      operation: "candidate.reject",
      resolution_id: "MUTRES-111111111111111111111111",
      project_id: state.project_id,
      candidate_id: candidate.candidate_id
    }, state, {
      artifact: vi.fn(),
      working: vi.fn()
    })).rejects.toThrow(/injected crash after terminal marker/i);

    expect(await repository.hasTerminalResolution(state.project_id, candidate.candidate_id)).toBe(true);
    expect(await repository.readResolutions(state.project_id, candidate.candidate_id)).toEqual([]);

    const artifact = vi.fn(async () => ({
      request_id: "ART-CANDIDATE-CONFLICT-0001",
      project_id: state.project_id,
      relative_path: "direct.md",
      content_sha256: await sha256Text(content),
      status: "committed" as const
    }));

    await expect(service.resolve({
      operation: "candidate.adopt_artifact",
      resolution_id: "MUTRES-222222222222222222222222",
      project_id: state.project_id,
      candidate_id: candidate.candidate_id,
      artifact_request: {
        request_id: "ART-CANDIDATE-CONFLICT-0001",
        project_id: state.project_id,
        relative_path: "direct.md",
        content,
        content_sha256: await sha256Text(content),
        mode: "create"
      }
    }, state, {
      artifact,
      working: vi.fn()
    })).resolves.toMatchObject({
      status: "conflict",
      code: "CANDIDATE_ALREADY_RESOLVED"
    });

    expect(artifact).not.toHaveBeenCalled();
  });
});
