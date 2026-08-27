import { expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { ProjectRepository } from "../src/dropbox/repository";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
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
      delete: async (path) => { files.delete(path); }
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

it("reads canonical state through the neutral persistence runtime", async () => {
  const runtime = neutralRuntime();
  const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Neutral repository");
  await runtime.objects.upsertText(
    "/PROJECT_OS/.project-os/projects/PRJ-0002/state.json",
    `${JSON.stringify(state, null, 2)}\n`
  );

  const repository = new ProjectRepository(runtime, "v2");
  await expect(repository.readProjectState("PRJ-0002")).resolves.toEqual(state);
});
