import { expect, it } from "vitest";
import type { DocumentVersionRecord } from "../src/domain/managed-document";
import { DocumentLedgerRepository } from "../src/documents/repository";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";

function runtimeWithFiles(): { runtime: ProjectOsPersistenceRuntime; files: Map<string, string> } {
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
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: {
      writeTextConditional: async (path) => ({ path, size: 0 })
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

it("reads and writes schema-1.0 versions through neutral persistence", async () => {
  const { runtime } = runtimeWithFiles();
  const repository = new DocumentLedgerRepository(runtime);
  const record: DocumentVersionRecord = {
    schema_version: "1.0",
    project_id: "PRJ-0002",
    document_id: "DOC-0123456789ABCDEF01234567",
    version_id: "VER-REQ-111111111111111111111111",
    kind: "work_product",
    stage: "working",
    logical_path: "strategy/a.md",
    source: "project_os",
    created_at: "2026-08-26T12:45:00+01:00",
    immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    content_sha256: "a".repeat(64)
  };

  await repository.writeVersion(record);
  await expect(repository.readVersion(record.project_id, record.document_id, record.version_id))
    .resolves.toEqual(record);
});
