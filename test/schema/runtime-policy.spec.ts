import { describe, expect, it } from "vitest";
import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../../src/persistence/provider/contract";
import {
  configureSchemaEvidenceObserver,
  schemaWriterStageFor,
  withSchemaRuntimePolicy
} from "../../src/schema/runtime-policy";

function runtime(): ProjectOsPersistenceRuntime {
  const files = new Map<string, string>();
  return {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new Error(`exists ${path}`);
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async (from, to) => {
        const content = files.get(from);
        if (content === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, content);
      },
      delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: {
      writeTextConditional: async (path, content) => {
        files.set(path, content);
        return metadata(path, content);
      }
    },
    serverSideCopy: {
      copyObject: async (from, to) => {
        const content = files.get(from) ?? "";
        files.set(to, content);
        return metadata(to, content);
      }
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

function metadata(path: string, content: string): ProviderObjectMetadata {
  return {
    path,
    size: content.length,
    objectId: `id:${path.length}`,
    revisionToken: "rev-1",
    integrityHash: { algorithm: "test", value: "hash" }
  };
}

describe("schema runtime policy", () => {
  it("makes one deployment writer stage available to all repositories sharing the runtime", () => {
    const wrapped = withSchemaRuntimePolicy(runtime(), "provider_v2");
    expect(schemaWriterStageFor(wrapped)).toBe("provider_v2");
    expect(schemaWriterStageFor(wrapped, "v1_only")).toBe("provider_v2");
  });

  it("reports core-v2 evidence from state, manifest or a 1.0 commit carrying nested ProjectState 2.0", async () => {
    const wrapped = withSchemaRuntimePolicy(runtime(), "core_v2");
    const seen: string[] = [];
    configureSchemaEvidenceObserver(wrapped, (stage) => seen.push(stage));

    await wrapped.objects.upsertText(
      "/PROJECT_OS/.project-os/projects/PRJ-9107/state.json",
      JSON.stringify({ schema_version: "2.0", project_id: "PRJ-9107" })
    );
    await wrapped.objects.upsertText(
      "/PROJECT_OS/.project-os/projects/PRJ-9107/manifest.json",
      JSON.stringify({ schema_version: "2.0", project_id: "PRJ-9107" })
    );
    await wrapped.objects.createText(
      "/PROJECT_OS/.project-os/projects/PRJ-9107/commits/REV-000001.json",
      JSON.stringify({ schema_version: "1.0", state: { schema_version: "2.0" } })
    );

    expect(seen).toEqual(["core_v2", "core_v2", "core_v2"]);
  });

  it("reports provider-v2 evidence from every first-write provider namespace and ignores unrelated schema 2.0", async () => {
    const wrapped = withSchemaRuntimePolicy(runtime(), "provider_v2");
    const seen: string[] = [];
    configureSchemaEvidenceObserver(wrapped, (stage) => seen.push(stage));
    const root = "/PROJECT_OS/.project-os/projects/PRJ-9108";

    await wrapped.objects.upsertText(
      `${root}/documents/heads/DOC-AAAAAAAAAAAAAAAAAAAAAAAA.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/documents/versions/DOC-AAAAAAAAAAAAAAAAAAAAAAAA/VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/documents/provider-file-bindings/v2/${"a".repeat(64)}.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/documents/reference-fingerprints/v2/${"b".repeat(64)}.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/mutation-gate/intents/artifacts/ART-RUNTIME-POLICY-9108.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/mutation-gate/candidates/MUTCAND-AAAAAAAAAAAAAAAAAAAAAAAA.json`,
      JSON.stringify({ schema_version: "2.0" })
    );
    await wrapped.objects.createText(
      `${root}/materializations/REV-000001-PV-0002.json`,
      JSON.stringify({ schema_version: "2.0" })
    );

    expect(seen).toEqual([
      "provider_v2",
      "provider_v2",
      "provider_v2",
      "provider_v2",
      "provider_v2",
      "provider_v2"
    ]);
  });

  it("reconstructs evidence from reads and ignores V1 or non-JSON payloads", async () => {
    const wrapped = withSchemaRuntimePolicy(runtime(), "provider_v2");
    const seen: string[] = [];
    configureSchemaEvidenceObserver(wrapped, (stage) => seen.push(stage));
    const headPath = "/PROJECT_OS/.project-os/projects/PRJ-9109/documents/heads/DOC-BBBBBBBBBBBBBBBBBBBBBBBB.json";
    const payloadPath = "/PROJECT_OS/.project-os/projects/PRJ-9109/documents/payloads/sha256/abc";

    await wrapped.objects.upsertText(headPath, JSON.stringify({ schema_version: "2.0" }));
    await wrapped.objects.upsertText(payloadPath, "raw bytes");
    seen.length = 0;
    await wrapped.objects.readText(headPath);
    await wrapped.objects.readText(payloadPath);

    expect(seen).toEqual(["provider_v2"]);
  });
});
