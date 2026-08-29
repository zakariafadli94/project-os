import { describe, expect, it } from "vitest";
import { DocumentLedgerRepository, providerFileBindingV2Path } from "../../src/documents/repository";
import { MutationGateRepository } from "../../src/mutation-gate/repository";
import {
  machineDocumentHeadPath,
  machineMutationIntentPath
} from "../../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../../src/persistence/provider/errors";
import {
  configureSchemaEvidenceObserver,
  withSchemaRuntimePolicy
} from "../../src/schema/runtime-policy";

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
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async (): Promise<ProviderObjectMetadata | null> => null,
      listChildren: async (path): Promise<ProviderEntry[]> => {
        const prefix = `${path}/`;
        return [...files.keys()]
          .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
          .map((candidate) => ({ kind: "file", name: candidate.slice(prefix.length), path: candidate }));
      },
      move: async (from, to) => {
        const value = files.get(from);
        if (value === undefined) throw new ProviderConflictError("missing");
        files.delete(from);
        files.set(to, value);
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
  return { runtime, files };
}

describe("repository runtime schema policy", () => {
  it("writes provider-qualified document indexes from runtime policy without constructor stage", async () => {
    const projectId = "PRJ-9301";
    const documentId = "DOC-0123456789ABCDEF01234567";
    const objectId = "id:runtime-policy";
    const { runtime, files } = memoryRuntime();
    const wrapped = withSchemaRuntimePolicy(runtime, "provider_v2");
    const seen: string[] = [];
    configureSchemaEvidenceObserver(wrapped, (stage) => seen.push(stage));

    files.set(machineDocumentHeadPath(projectId, documentId), JSON.stringify({
      schema_version: "1.0",
      project_id: projectId,
      document_id: documentId,
      kind: "reference",
      logical_path: "reference.md",
      reference_version_id: "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA",
      provider: {
        reference: {
          path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9301-runtime/REFERENCES/reference.md",
          file_id: objectId,
          rev: "rev-a",
          content_hash: "a".repeat(64),
          size: 1
        }
      },
      reconciliation_status: "clean"
    }));

    const repository = new DocumentLedgerRepository(wrapped);
    await repository.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: projectId,
      provider_file_id: objectId,
      document_id: documentId
    });

    const path = await providerFileBindingV2Path(projectId, "dropbox", objectId);
    expect(JSON.parse(files.get(path) ?? "null").schema_version).toBe("2.0");
    expect(seen).toContain("provider_v2");
  });

  it("writes MutationGate intent V2 from runtime policy without constructor stage", async () => {
    const projectId = "PRJ-9302";
    const requestId = "ART-RUNTIME-POLICY-9302";
    const { runtime, files } = memoryRuntime();
    const wrapped = withSchemaRuntimePolicy(runtime, "provider_v2");
    const seen: string[] = [];
    configureSchemaEvidenceObserver(wrapped, (stage) => seen.push(stage));

    const repository = new MutationGateRepository(wrapped);
    await repository.ensureArtifactIntent({
      schema_version: "1.0",
      intent_id: "MUTINT-AAAAAAAAAAAAAAAAAAAAAAAA",
      project_id: projectId,
      kind: "artifact",
      request_id: requestId,
      request_sha256: "a".repeat(64),
      request_json: JSON.stringify({ request_id: requestId }),
      base_project_revision: 1,
      destination_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9302-runtime/ARTIFACTS/out.md",
      provider_precondition: { kind: "absent", provider_id: "dropbox" },
      expected_content_sha256: "b".repeat(64),
      mode: "create",
      recorded_at: "2026-08-29T02:10:00+01:00"
    });

    const durable = JSON.parse(files.get(machineMutationIntentPath(projectId, requestId)) ?? "null");
    expect(durable.schema_version).toBe("2.0");
    expect(durable.provider_precondition).toEqual({ kind: "absent", provider_id: "dropbox" });
    expect(seen).toContain("provider_v2");
  });
});
