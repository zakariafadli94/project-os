import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../../src/domain/transitions";
import { machineManifestPath, machineStatePath } from "../../src/persistence/layout";
import { ProjectRepository } from "../../src/persistence/repository";
import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../../src/persistence/provider/errors";
import { encodeManifest, readManifest } from "../../src/schema/manifest";

const at = "2026-08-28T17:00:00.000Z";

function stateFixture() {
  const state = emptyProjectState(
    "PRJ-9002",
    "Manifest fixture",
    "manifest-fixture",
    "Decouple manifest schema"
  );
  state.revision = 7;
  state.last_event_id = "EVT-000007";
  state.created_at = at;
  state.updated_at = at;
  return state;
}

function v1Manifest() {
  return {
    schema_version: "1.0" as const,
    project_id: "PRJ-9002",
    slug: "manifest-fixture",
    revision: 7,
    status: "active" as const,
    last_event_id: "EVT-000007",
    updated_at: at
  };
}

function memoryRuntime(): { runtime: ProjectOsPersistenceRuntime; files: Map<string, string> } {
  const files = new Map<string, string>();
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "dropbox",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        files.set(path, content);
      },
      upsertText: async (path, content) => {
        files.set(path, content);
      },
      getMetadata: async (path): Promise<ProviderObjectMetadata | null> => {
        const content = files.get(path);
        return content === undefined ? null : { path, size: content.length };
      },
      listChildren: async (path): Promise<ProviderEntry[]> => {
        const prefix = `${path}/`;
        return [...files.keys()]
          .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
          .map((candidate) => ({ kind: "file", name: candidate.slice(prefix.length), path: candidate }));
      },
      move: async (from, to) => {
        const content = files.get(from);
        if (content === undefined) throw new ProviderConflictError("missing");
        if (files.has(to)) throw new ProviderConflictError("exists");
        files.delete(from);
        files.set(to, content);
      },
      delete: async (path) => {
        files.delete(path);
      }
    },
    conditionalWrite: {
      writeTextConditional: async () => {
        throw new ProviderPreconditionFailedError("unused");
      }
    },
    serverSideCopy: {
      copyObject: async (_from, to) => ({ path: to, size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "cursor" })
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  return { runtime, files };
}

describe("machine manifest schema codec", () => {
  it("reads V1 as an independent manifest contract with an implicit ProjectState 1.0 pointer", () => {
    expect(readManifest(v1Manifest())).toEqual({
      ...v1Manifest(),
      project_state_schema_version: "1.0"
    });
  });

  it("reads strict V2 with exactly the independent manifest fields", () => {
    const v2 = {
      schema_version: "2.0" as const,
      project_id: "PRJ-9002",
      slug: "manifest-fixture",
      revision: 7,
      status: "active" as const,
      last_event_id: "EVT-000007",
      project_state_schema_version: "2.0" as const,
      updated_at: at
    };

    expect(readManifest(v2, "2.0")).toEqual(v2);
    expect(() => readManifest({ ...v2, unexpected: true }, "2.0")).toThrow();
  });

  it("fails closed on unknown manifest versions and inconsistent state-schema pointers", () => {
    expect(() => readManifest({ ...v1Manifest(), schema_version: "3.0" })).toThrow(/manifest.*3\.0/i);
    expect(() =>
      readManifest(
        {
          ...v1Manifest(),
          schema_version: "2.0",
          project_state_schema_version: "3.0"
        },
        "3.0" as "2.0"
      )
    ).toThrow(/ProjectState|3\.0/);
    expect(() =>
      readManifest(
        {
          ...v1Manifest(),
          schema_version: "2.0",
          project_state_schema_version: "1.0"
        },
        "2.0"
      )
    ).toThrow(/manifest.*state|binding/i);
  });

  it("keeps V1 manifest bytes in v1_only and emits independent Manifest 2.0 at core_v2", () => {
    const state = stateFixture();
    expect(encodeManifest(state, "v1_only")).toEqual(v1Manifest());
    expect(encodeManifest(state, "core_v2")).toEqual({
      schema_version: "2.0",
      project_id: state.project_id,
      slug: state.slug,
      revision: state.revision,
      status: state.status,
      last_event_id: state.last_event_id,
      project_state_schema_version: "2.0",
      updated_at: state.updated_at
    });
  });

  it("converges state and manifest to V2 at the same business revision without creating an event", async () => {
    const { runtime, files } = memoryRuntime();
    const state = stateFixture();
    const repository = new ProjectRepository(runtime, "v2", "observe", "core_v2");

    await repository.writeMachineSnapshot(state);

    const serializedState = JSON.parse(files.get(machineStatePath(state.project_id)) ?? "null");
    const serializedManifest = JSON.parse(files.get(machineManifestPath(state.project_id)) ?? "null");

    expect(serializedState.schema_version).toBe("2.0");
    expect(serializedManifest).toEqual({
      schema_version: "2.0",
      project_id: state.project_id,
      slug: state.slug,
      revision: 7,
      status: "active",
      last_event_id: "EVT-000007",
      project_state_schema_version: "2.0",
      updated_at: at
    });
    expect(serializedState.revision).toBe(7);
    expect(serializedState.last_event_id).toBe("EVT-000007");
    expect([...files.keys()].some((path) => path.includes("/events/"))).toBe(false);
  });
});
