import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { DropboxConflictError, type DropboxEntry, type DropboxTransport } from "../src/dropbox/client";
import { ProjectRepository } from "../src/dropbox/repository";
import { ArtifactMutationIntentService } from "../src/mutation-gate/artifact-intent";
import { MutationGateRepository } from "../src/mutation-gate/repository";

class FakeArtifactIntentDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly uploads: string[] = [];

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-intent", "path/conflict/file");
    }
    this.files.set(path, content);
    this.uploads.push(path);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async getMetadata(): Promise<null> {
    return null;
  }

  async move(): Promise<void> {
    throw new Error("unused");
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file", name: candidate.slice(prefix.length), path_display: candidate }));
  }
}

async function request(): Promise<ArtifactWriteRequest> {
  const content = "# frozen route";
  return {
    request_id: "ART-ROUTE-DRIFT-0001",
    project_id: "PRJ-0003",
    relative_path: "REVENUE-OS/foo.md",
    content,
    content_sha256: await sha256Text(content),
    mode: "create"
  };
}

function stateBeforeRoute() {
  return emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
}

function stateAfterRoute() {
  const state = stateBeforeRoute();
  state.revision = 1;
  state.decisions["DEC-ROUTEDRIFT001"] = {
    decision_id: "DEC-ROUTEDRIFT001",
    title: "Route revenue",
    decision: "Route revenue into deliverables",
    reason: "Test route drift",
    impacts: [],
    status: "accepted",
    created_at: "2026-08-25T16:20:00+01:00",
    updated_at: "2026-08-25T16:20:00+01:00"
  };
  state.artifact_routes["ROUTE-REVENUE001"] = {
    route_id: "ROUTE-REVENUE001",
    source_prefix: "REVENUE-OS",
    target_prefix: "DELIVERABLES/REVENUE-OS",
    exclusive: true,
    decision_ids: ["DEC-ROUTEDRIFT001"],
    created_at: "2026-08-25T16:20:00+01:00",
    updated_at: "2026-08-25T16:20:00+01:00"
  };
  return state;
}

describe("ArtifactMutationIntentService", () => {
  it("freezes the resolved provider destination and absent precondition across route drift", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const gate = new MutationGateRepository(transport);
    const service = new ArtifactMutationIntentService(gate, transport);
    const artifact = await request();

    const first = await service.prepare(stateBeforeRoute(), artifact);
    expect(first.destination.path).toBe(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/REVENUE-OS/foo.md"
    );
    expect(first.intent.provider_precondition).toEqual({ kind: "absent" });
    await transport.upload(first.destination.path, artifact.content, "add");

    const replay = await service.prepare(stateAfterRoute(), artifact);
    expect(replay.destination.path).toBe(first.destination.path);
    expect(replay.intent.provider_precondition).toEqual({ kind: "absent" });

    const repository = new ProjectRepository(transport, "v2");
    expect(await repository.writeArtifact(stateAfterRoute(), artifact, replay.destination)).toBe("idempotent");
    expect([...transport.files.keys()].some((path) => path.includes("/DELIVERABLES/REVENUE-OS/foo.md"))).toBe(false);
  });

  it("rejects exact request-id replay when durable intent binds different request JSON", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const gate = new MutationGateRepository(transport);
    const service = new ArtifactMutationIntentService(gate, transport);
    const artifact = await request();
    await service.prepare(stateBeforeRoute(), artifact);

    await expect(service.prepare(stateBeforeRoute(), {
      ...artifact,
      content: "# changed",
      content_sha256: await sha256Text("# changed")
    })).rejects.toThrow(/intent conflict/i);
  });
});