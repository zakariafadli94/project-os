import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { InlineArtifactWriteRequest } from "../src/domain/artifact-write";
import type { Env } from "../src/env";
import { emptyProjectState } from "../src/domain/transitions";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { ManagedDocumentChangeJobStore } from "../src/documents/change-job-store";
import { sha256Text } from "../src/documents/hash";
import { DropboxConflictError, type DropboxEntry, type DropboxTransport } from "../src/dropbox/client";
import { ProjectRepository } from "../src/dropbox/repository";
import { ArtifactMutationIntentService } from "../src/mutation-gate/artifact-intent";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { MutationGateService } from "../src/mutation-gate/service";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

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

async function request(): Promise<InlineArtifactWriteRequest> {
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
    const runtime = persistenceFromDropbox(transport);
    const gate = new MutationGateRepository(runtime);
    const service = new ArtifactMutationIntentService(gate, runtime);
    const artifact = await request();

    const first = await service.prepare(stateBeforeRoute(), artifact);
    expect(first.destination.path).toBe(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/REVENUE-OS/foo.md"
    );
    expect(first.intent.provider_precondition).toEqual({ kind: "absent", provider_id: "dropbox" });
    await transport.upload(first.destination.path, artifact.content, "add");

    const replay = await service.prepare(stateAfterRoute(), artifact);
    expect(replay.destination.path).toBe(first.destination.path);
    expect(replay.intent.provider_precondition).toEqual({ kind: "absent", provider_id: "dropbox" });

    const repository = new ProjectRepository(runtime, "v2");
    expect(await repository.writeArtifact(stateAfterRoute(), artifact, replay.destination)).toBe("idempotent");
    expect([...transport.files.keys()].some((path) => path.includes("/DELIVERABLES/REVENUE-OS/foo.md"))).toBe(false);
  });

  it("recovers a provider-written artifact from durable intent without creating a candidate", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const runtime = persistenceFromDropbox(transport);
    const mutationRepository = new MutationGateRepository(runtime);
    const intentService = new ArtifactMutationIntentService(mutationRepository, runtime);
    const artifact = await request();
    const state = stateBeforeRoute();
    const prepared = await intentService.prepare(state, artifact);

    // Simulate the crash window: provider bytes landed after the durable intent,
    // but ProjectGuard never got far enough to publish a terminal artifact receipt.
    await transport.upload(prepared.destination.path, artifact.content, "add");
    expect([...transport.files.keys()].some((path) => path.includes("/.project-os/artifacts/receipts/"))).toBe(false);

    const summary = await new MutationGateService(runtime, "observe").processChanges(state, [{
      tag: "file",
      name: "foo.md",
      path: prepared.destination.path,
      id: "id:artifact-crash-recovery",
      rev: "rev-crash-1",
      content_hash: "b".repeat(64),
      size: new TextEncoder().encode(artifact.content).byteLength,
      server_modified: "2026-08-25T18:40:00+01:00"
    }], "incremental");

    expect(summary).toMatchObject({ candidates: 0, policy_violations: 0, artifact_destination_paths: [prepared.destination.path] });
    expect(await mutationRepository.listCandidates(artifact.project_id)).toHaveLength(0);

    const repository = new ProjectRepository(runtime, "v2");
    expect(await repository.writeArtifact(state, artifact, prepared.destination)).toBe("idempotent");
    expect(await mutationRepository.listCandidates(artifact.project_id)).toHaveLength(0);
    expect([...transport.files.keys()].some((path) => path.includes("/.project-os/artifacts/receipts/"))).toBe(false);

    await repository.writeArtifactReceipt({
      request_id: artifact.request_id,
      project_id: artifact.project_id,
      relative_path: artifact.relative_path,
      content_sha256: artifact.content_sha256,
      status: "committed"
    });
    expect([...transport.files.keys()].some((path) => path.endsWith(`/artifacts/receipts/${artifact.request_id}.json`))).toBe(true);
  });

  it("persists invalidation for an observed artifact routed outside the ARTIFACTS folder", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const runtime = persistenceFromDropbox(transport);
    const mutationRepository = new MutationGateRepository(runtime);
    const artifact = await request();
    const state = stateAfterRoute();
    const prepared = await new ArtifactMutationIntentService(mutationRepository, runtime).prepare(state, artifact);
    await transport.upload(prepared.destination.path, artifact.content, "add");
    runtime.changeFeed = { listChanges: async () => ({ entries: [{
      kind: "file", name: "foo.md", path: prepared.destination.path,
      metadata: { path: prepared.destination.path, objectId: "id:artifact-route", revisionToken: "rev-artifact-route", size: new TextEncoder().encode(artifact.content).byteLength, integrityHash: { algorithm: "dropbox-content-hash", value: "b".repeat(64) } }
    }], cursor: "artifact-route-observed" }) };
    const values = new Map<string, unknown>([["managed-document-change-cursor-v1", "before-observation"]]);
    const invalidations: unknown[] = [];
    const coordinator = new ManagedDocumentChangeCoordinator(runtime, {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    }, "observe", undefined, async (...args) => { invalidations.push(args); });

    const summary = await coordinator.reconcile(state);

    expect(prepared.destination.path).toContain("/DELIVERABLES/REVENUE-OS/foo.md");
    expect(summary.artifact_destination_paths).toEqual([prepared.destination.path]);
    expect(invalidations).toEqual([[state.project_id, "DELIVERABLES", `artifact:${await sha256Text(prepared.destination.path)}`]]);
  });

  it("invalidates a deleted routed artifact before completing its durable change job", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const runtime = persistenceFromDropbox(transport);
    const state = stateAfterRoute();
    const artifact = await request();
    const repository = new MutationGateRepository(runtime);
    const prepared = await new ArtifactMutationIntentService(repository, runtime).prepare(state, artifact);
    await transport.upload(prepared.destination.path, artifact.content, "add");
    transport.files.delete(prepared.destination.path);
    runtime.pagedListing = {
      listPage: async ({ path, limit }) => {
        const prefix = `${path}/`;
        const entries = [...transport.files.keys()]
          .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
          .slice(0, limit)
          .map((candidate) => ({ kind: "file" as const, name: candidate.slice(prefix.length), path: candidate }));
        return { entries, cursor: null };
      }
    };
    runtime.changeFeed = {
      listChanges: async () => ({ entries: [{ kind: "deleted", name: "foo.md", path: prepared.destination.path }], cursor: "artifact-delete-cursor" })
    };
    const invalidations: unknown[] = [];
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(state.project_id);
    const summary = await runInDurableObject(guard, async (_instance, durableState) => {
      const jobs = new ManagedDocumentChangeJobStore(durableState.storage);
      jobs.registerPage({ expected_cursor: null, next_cursor: "before-artifact-delete", jobs: [] });
      return new ManagedDocumentChangeCoordinator(runtime, durableState.storage, "observe", undefined, async (...args) => {
        invalidations.push(args);
      }).reconcile(state);
    });

    expect(summary).toMatchObject({ jobs_completed: 1, jobs_pending: 0 });
    expect(invalidations).toEqual([[state.project_id, "DELIVERABLES", `artifact:${await sha256Text(prepared.destination.path)}`]]);
  });

  it("rejects exact request-id replay when durable intent binds different request JSON", async () => {
    const transport = new FakeArtifactIntentDropbox();
    const runtime = persistenceFromDropbox(transport);
    const gate = new MutationGateRepository(runtime);
    const service = new ArtifactMutationIntentService(gate, runtime);
    const artifact = await request();
    await service.prepare(stateBeforeRoute(), artifact);

    await expect(service.prepare(stateBeforeRoute(), {
      ...artifact,
      content: "# changed",
      content_sha256: await sha256Text("# changed")
    })).rejects.toThrow(/intent conflict/i);
  });
});

it("rejects stale review revision before intent, but keeps frozen exact crash replay", async () => {
  const { candidate } = await import("./helpers/review-candidate");
  const { parseArtifactWriteRequest } = await import("../src/domain/artifact-write");
  const raw = new FakeArtifactIntentDropbox();
  const runtime = persistenceFromDropbox(raw);
  const intents = new ArtifactMutationIntentService(new MutationGateRepository(runtime), runtime);
  const state = { ...stateBeforeRoute(), project_id: "PRJ-0002", revision: 150 };
  const request = parseArtifactWriteRequest(candidate);
  await expect(intents.prepare(state, request)).rejects.toThrow(/revision/i);
  expect(raw.uploads).toHaveLength(0);
  const first = await intents.prepare({ ...state, revision: 149 }, request);
  const replay = await intents.prepare(state, request);
  expect(replay.intent).toEqual(first.intent);
});
