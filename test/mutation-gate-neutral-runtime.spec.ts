import { expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { MutationGateService } from "../src/mutation-gate/service";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";

function neutralRuntime(): ProjectOsPersistenceRuntime {
  const files = new Map<string, string>();
  return {
    providerId: "dropbox",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: {
      writeTextConditional: async () => { throw new ProviderPreconditionFailedError("unused"); }
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
}

it("processes neutral provider changes without Dropbox runtime types", async () => {
  const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Mutation gate neutral runtime");
  const change: ProviderChangeEntry = {
    kind: "deleted",
    name: "removed.md",
    path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/removed.md"
  };

  await expect(new MutationGateService(neutralRuntime(), "observe").processChanges(
    state,
    [change],
    "incremental"
  )).resolves.toEqual({
    candidates: 0,
    mutation_gate_mode: "observe",
    policy_violations: 0
  });
});
