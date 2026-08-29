import { describe, expect, it } from "vitest";
import { DropboxConflictError, type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import type { ExternalMutationResolutionRecord, MutationIntentRecord } from "../src/domain/mutation-gate";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { readMutationIntentRecord } from "../src/schema/mutation-gate";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeMutationGateDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  readonly calls: Array<{ kind: "upload" | "copy"; path: string; from?: string }> = [];
  private nextId = 1;
  private nextRev = 1;

  async seed(path: string, content: string, id = `id:seed-${this.nextId++}`): Promise<DropboxFileMetadata> {
    this.files.set(path, content);
    const metadata = await this.makeMetadata(path, content, id);
    this.metadata.set(path, metadata);
    return metadata;
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`conflict ${path}`, "req-test", "path/conflict/file");
    }
    this.calls.push({ kind: "upload", path });
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
      throw new DropboxConflictError(`copy conflict ${to}`, "req-test", "to/conflict/file");
    }
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing source ${from}`);
    this.calls.push({ kind: "copy", path: to, from });
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
      .map((candidate) => ({
        tag: "file" as const,
        name: candidate.slice(prefix.length),
        path_display: candidate
      }));
  }

  private async makeMetadata(path: string, content: string, id = `id:test-${this.nextId++}`): Promise<DropboxFileMetadata> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      id,
      path,
      rev: `rev-${this.nextRev++}`,
      content_hash: contentHash,
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T16:10:00+01:00"
    };
  }
}

function intent(overrides: Partial<MutationIntentRecord> = {}): MutationIntentRecord {
  return {
    schema_version: "1.0",
    intent_id: "MUTINT-111111111111111111111111",
    project_id: "PRJ-0002",
    kind: "artifact",
    request_id: "ART-MUTATION-INTENT-0001",
    request_sha256: "a".repeat(64),
    request_json: JSON.stringify({ request_id: "ART-MUTATION-INTENT-0001", content: "# governed" }),
    base_project_revision: 85,
    destination_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/REVENUE-OS/foo.md",
    provider_precondition: { kind: "absent" },
    expected_content_sha256: "b".repeat(64),
    mode: "create",
    recorded_at: "2026-08-25T16:10:00+01:00",
    ...overrides
  };
}

function currentIntent(overrides: Partial<MutationIntentRecord> = {}) {
  return readMutationIntentRecord(intent(overrides)).record;
}

function resolution(candidateId: string, action: ExternalMutationResolutionRecord["action"], resolutionId: string): ExternalMutationResolutionRecord {
  return {
    schema_version: "1.0",
    resolution_id: resolutionId,
    project_id: "PRJ-0002",
    candidate_id: candidateId,
    action,
    ...(action === "reject" ? {} : { downstream_request_id: "ART-CANDIDATE-ADOPT-0001", downstream_receipt_status: "committed" as const }),
    resolved_at: "2026-08-25T16:15:00+01:00"
  };
}

describe("MutationGateRepository", () => {
  it("captures provider bytes before immutable candidate metadata", async () => {
    const transport = new FakeMutationGateDropbox();
    const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
    const metadata = await transport.seed(visible, "direct bytes", "id:direct");
    const repo = new MutationGateRepository(persistenceFromDropbox(transport));

    const result = await repo.captureCandidate({
      projectId: "PRJ-0002",
      detectionSource: "incremental",
      visiblePath: visible,
      metadata,
      detectedAt: "2026-08-25T16:10:00+01:00"
    });

    expect(result.created).toBe(true);
    const copyIndex = transport.calls.findIndex((call) => call.kind === "copy" && call.path === result.record.immutable_payload_path);
    const recordIndex = transport.calls.findIndex((call) => call.kind === "upload" && call.path.endsWith(`/candidates/${result.record.candidate_id}.json`));
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(copyIndex);
    expect(await repo.readCandidate("PRJ-0002", result.record.candidate_id)).toEqual(result.record);
  });

  it("replays the same candidate without duplicating payload evidence", async () => {
    const transport = new FakeMutationGateDropbox();
    const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
    const metadata = await transport.seed(visible, "direct bytes", "id:direct");
    const repo = new MutationGateRepository(persistenceFromDropbox(transport));
    const input = {
      projectId: "PRJ-0002",
      detectionSource: "incremental" as const,
      visiblePath: visible,
      metadata,
      detectedAt: "2026-08-25T16:10:00+01:00"
    };

    const first = await repo.captureCandidate(input);
    const replay = await repo.captureCandidate({ ...input, detectedAt: "2026-08-25T16:20:00+01:00" });

    expect(replay.created).toBe(false);
    expect(replay.record.candidate_id).toBe(first.record.candidate_id);
    expect(transport.calls.filter((call) => call.kind === "copy" && call.path === first.record.immutable_payload_path)).toHaveLength(1);
  });

  it("keeps artifact intent immutable and indexes it by exact destination", async () => {
    const transport = new FakeMutationGateDropbox();
    const repo = new MutationGateRepository(persistenceFromDropbox(transport));
    const original = currentIntent();

    expect(await repo.ensureArtifactIntent(original)).toEqual(original);
    expect(await repo.ensureArtifactIntent(original)).toEqual(original);
    expect(await repo.listArtifactIntentsForDestination(original.project_id, original.destination_path)).toEqual([original]);
    expect(await repo.listArtifactIntentsForDestination(original.project_id, `${original.destination_path}.other`)).toEqual([]);

    await expect(repo.ensureArtifactIntent(currentIntent({ destination_path: `${original.destination_path}.moved` })))
      .rejects.toThrow(/intent conflict/i);
  });

  it("rejects a second conflicting terminal resolution", async () => {
    const transport = new FakeMutationGateDropbox();
    const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
    const metadata = await transport.seed(visible, "direct bytes", "id:direct");
    const repo = new MutationGateRepository(persistenceFromDropbox(transport));
    const candidate = (await repo.captureCandidate({
      projectId: "PRJ-0002",
      detectionSource: "incremental",
      visiblePath: visible,
      metadata,
      detectedAt: "2026-08-25T16:10:00+01:00"
    })).record;

    const rejected = resolution(candidate.candidate_id, "reject", "MUTRES-111111111111111111111111");
    expect(await repo.writeResolution(rejected)).toEqual(rejected);
    expect(await repo.writeResolution(rejected)).toEqual(rejected);
    expect(await repo.hasTerminalResolution("PRJ-0002", candidate.candidate_id)).toBe(true);

    await expect(repo.writeResolution(resolution(candidate.candidate_id, "adopt_as_artifact", "MUTRES-222222222222222222222222")))
      .rejects.toThrow(/conflicting terminal resolution/i);
  });
});