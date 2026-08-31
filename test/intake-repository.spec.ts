import { describe, expect, it } from "vitest";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import { IntakeRepository } from "../src/documents/intake-repository";

function runtime() {
  const files = new Map<string, string>();
  const value = {
    providerId: "test",
    objects: {
      readText: async (path: string) => files.get(path) ?? null,
      createText: async (path: string, content: string) => {
        if (files.has(path)) throw new ProviderConflictError(`exists ${path}`);
        files.set(path, content);
      },
      upsertText: async (path: string, content: string) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: { writeTextConditional: async () => { throw new Error("unused"); } },
    serverSideCopy: { copyObject: async () => { throw new Error("unused"); } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" as const },
      revisionToken: { semantics: "opaque-object-revision" as const },
      integrityHash: { semantics: "identified-algorithm" as const }
    }
  } satisfies ProjectOsPersistenceRuntime;
  return { value, files };
}

const observation = {
  project_id: "PRJ-0002",
  provider_id: "dropbox",
  object_id: "id:abc",
  revision_token: "rev-7",
  logical_input_path: "REFERRAL-example.md",
  observed_at: "2026-08-30T10:20:00.000Z"
};

describe("IntakeRepository", () => {
  it("converges duplicate discovery of one provider revision onto one durable intake record", async () => {
    const storage = runtime();
    const repo = new IntakeRepository(storage.value);
    const first = await repo.beginObservation(observation);
    const replay = await repo.beginObservation(observation);
    expect(replay).toEqual(first);
    expect([...storage.files.keys()].filter((path) => path.includes("/documents/intake/records/"))).toHaveLength(1);

    const nextRevision = await repo.beginObservation({ ...observation, revision_token: "rev-8" });
    expect(nextRevision.intake_id).not.toBe(first.intake_id);
  });

  it("enforces monotone terminal transitions while allowing retryable failure to resume", async () => {
    const repo = new IntakeRepository(runtime().value);
    const observed = await repo.beginObservation(observation);
    const failed = await repo.write({
      ...observed,
      state: "failed",
      retryable: true,
      last_attempt_at: "2026-08-30T10:21:00.000Z",
      attempt_count: 1,
      last_error: "temporary provider failure"
    });
    const resumed = await repo.write({
      ...failed,
      state: "processing",
      retryable: undefined,
      last_attempt_at: "2026-08-30T10:22:00.000Z",
      attempt_count: 2,
      last_error: undefined
    });
    expect(resumed.state).toBe("processing");

    const ingested = await repo.write({
      ...resumed,
      state: "ingested",
      document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      version_id: "VER-EXT-BBBBBBBBBBBBBBBBBBBBBBBB",
      reference_path: "UNCLASSIFIED/REFERRAL-example.md"
    });
    await expect(repo.write({ ...ingested, state: "processing" })).rejects.toThrow(/terminal|transition/i);
  });
});
