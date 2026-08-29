import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import type { Env } from "../src/env";
import { emptyProjectState } from "../src/domain/transitions";
import {
  machineArtifactReceiptPath,
  machineMutationIntentPath
} from "../src/dropbox/layout";
import {
  DropboxConflictError,
  type DropboxEntry,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { sha256Text } from "../src/documents/hash";
import { ArtifactMutationIntentService } from "../src/mutation-gate/artifact-intent";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { MutationCandidateResolutionService } from "../src/mutation-gate/resolution-service";
import { MutationGateService } from "../src/mutation-gate/service";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const testEnv = env as unknown as Env;

class FakeStatusDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  private sequence = 0;

  async seed(path: string, content: string): Promise<DropboxFileMetadata> {
    const metadata = await this.metadataForContent(path, content);
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-status", "path/conflict/file");
    }
    this.files.set(path, content);
    this.metadata.set(path, await this.metadataForContent(path, content));
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    this.files.delete(from);
    this.metadata.delete(from);
    this.files.set(to, content);
    this.metadata.set(to, await this.metadataForContent(to, content));
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    return this.metadata.get(path) ?? null;
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    if (this.files.has(to)) throw new DropboxConflictError(`exists ${to}`, "req-copy", "to/conflict/file");
    return this.seed(to, content);
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file", name: candidate.slice(prefix.length), path_display: candidate }));
  }

  private async metadataForContent(path: string, content: string): Promise<DropboxFileMetadata> {
    this.sequence += 1;
    return {
      id: `id:status-${String(this.sequence).padStart(6, "0")}`,
      path,
      rev: `status-rev-${this.sequence}`,
      content_hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T18:50:00+01:00"
    };
  }
}

function state() {
  return emptyProjectState("PRJ-9901", "Mutation Status", "mutation-status", "Status vocabulary");
}

async function artifactRequest(): Promise<ArtifactWriteRequest> {
  const content = "# submitted only";
  return {
    request_id: "ART-STATUS-SUBMITTED-0001",
    project_id: "PRJ-9901",
    relative_path: "status/submitted.md",
    content,
    content_sha256: await sha256Text(content),
    mode: "create"
  };
}

describe("MutationGate status vocabulary", () => {
  it("keeps SUBMITTED durable intent distinct from COMMITTED and ACCEPTED", async () => {
    const transport = new FakeStatusDropbox();
    const runtime = persistenceFromDropbox(transport);
    const repository = new MutationGateRepository(runtime);
    const gate = new MutationGateService(runtime, "observe");
    const request = await artifactRequest();

    const prepared = await new ArtifactMutationIntentService(repository, runtime).prepare(state(), request);
    const intentPath = machineMutationIntentPath(request.project_id, request.request_id);
    const intentRaw = transport.files.get(intentPath);
    const status = await gate.artifactStatus(request.project_id, request.request_id);

    expect(prepared.intent.request_id).toBe(request.request_id);
    expect(intentRaw).toBeDefined();
    expect(transport.files.has(prepared.destination.path)).toBe(false);
    expect(transport.files.has(machineArtifactReceiptPath(request.request_id))).toBe(false);
    expect(status).toMatchObject({
      project_id: request.project_id,
      request_id: request.request_id,
      verification_state: "submitted"
    });
    expect(JSON.parse(intentRaw!)).not.toHaveProperty("status");
    expect(JSON.stringify(status)).not.toMatch(/accepted|published/i);
  });

  it("reports unresolved provider presence as external_candidate, never published or accepted", async () => {
    const transport = new FakeStatusDropbox();
    const runtime = persistenceFromDropbox(transport);
    const gate = new MutationGateService(runtime, "observe");
    const repository = new MutationGateRepository(runtime);
    const project = state();
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9901-mutation-status/ARTIFACTS/direct.md";
    const metadata = await transport.seed(path, "# external candidate");

    const capture = await gate.captureExternalCandidate(project, path, metadata, "incremental");
    const durable = await repository.readCandidate(project.project_id, capture.record.candidate_id);
    const payload = await repository.readCandidatePayload(project.project_id, capture.record.candidate_id);
    const status = await gate.status(project.project_id, capture.record.candidate_id);

    expect(durable).toMatchObject({
      candidate_id: capture.record.candidate_id,
      source: "external_unverified",
      provider: { path }
    });
    expect(payload).toBe("# external candidate");
    expect(status).toMatchObject({
      candidate_id: capture.record.candidate_id,
      gate_mode: "observe",
      verification_state: "external_candidate",
      resolution_state: "unresolved"
    });
    expect(JSON.stringify(status)).not.toMatch(/accepted|published/i);
  });

  it("reports durable candidate resolution as canonical_verified without creating ACCEPTED state", async () => {
    const transport = new FakeStatusDropbox();
    const runtime = persistenceFromDropbox(transport);
    const gate = new MutationGateService(runtime, "observe");
    const project = state();
    const revisionBefore = project.revision;
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9901-mutation-status/ARTIFACTS/rejected.md";
    const metadata = await transport.seed(path, "# reject me");
    const candidate = await gate.captureExternalCandidate(project, path, metadata, "incremental");

    const receipt = await new MutationCandidateResolutionService(runtime).resolve({
      operation: "candidate.reject",
      resolution_id: "MUTRES-AAAAAAAAAAAAAAAAAAAAAAAA",
      project_id: project.project_id,
      candidate_id: candidate.record.candidate_id
    }, project, {
      artifact: async () => { throw new Error("artifact executor must not run for reject"); },
      working: async () => { throw new Error("working executor must not run for reject"); }
    });
    const status = await gate.status(project.project_id, candidate.record.candidate_id);

    expect(receipt).toMatchObject({ status: "committed", action: "reject" });
    expect(project.revision).toBe(revisionBefore);
    expect(status).toMatchObject({
      verification_state: "canonical_verified",
      resolution_state: "resolved",
      resolution_action: "reject"
    });
    expect(JSON.stringify({ receipt, status })).not.toMatch(/accepted|published/i);
  });

  it("keeps production continuity stable while production MutationGate mode is enforce", () => {
    expect(testEnv.PROJECT_OS_CONTINUITY_MODE).toBe("stable");
    expect(testEnv.PROJECT_OS_MUTATION_GATE_MODE).toBe("enforce");
  });
});
