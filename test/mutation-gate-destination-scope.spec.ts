import { expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { MutationGateService } from "../src/mutation-gate/service";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";

it("does not scan historical mutation candidates when the destination is absent", async () => {
  const candidateScans: string[] = [];
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async () => null,
      createText: async () => undefined,
      upsertText: async () => undefined,
      getMetadata: async () => null,
      listChildren: async (path) => {
        if (path.includes("/mutation-gate/candidates")) candidateScans.push(path);
        return [];
      },
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: {
      writeTextConditional: async () => ({ path: "/unused", size: 0 })
    },
    serverSideCopy: {
      copyObject: async () => ({ path: "/unused", size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "unused" })
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  const state = emptyProjectState("PRJ-9902", "Scoped Gate", "scoped-gate", "Avoid historical scans");
  const gate = new MutationGateService(runtime, "enforce");

  await expect(gate.assertDestinationClear(
    state,
    "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9902-scoped-gate/ARTIFACTS/new.md"
  )).resolves.toBeUndefined();

  expect(candidateScans).toEqual([]);
});
