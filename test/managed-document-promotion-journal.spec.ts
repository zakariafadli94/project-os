import { expect, it } from "vitest";
import { ManagedDocumentPromotionJournal } from "../src/documents/promotion-journal";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";

function runtimeWithFiles(): ProjectOsPersistenceRuntime {
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
    conditionalWrite: { writeTextConditional: async (path) => ({ path, size: 0 }) },
    serverSideCopy: { copyObject: async (_from, to) => ({ path: to, size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
}

it("persists and reloads immutable evidence for an accepted candidate promotion", async () => {
  const journal = new ManagedDocumentPromotionJournal(runtimeWithFiles());
  const record = {
    schema_version: "1.0" as const,
    request_id: "DOCREQ-CANDIDATE-000001",
    project_id: "PRJ-0002",
    candidate_request_id: "ART-REVIEW-CANDIDATE-0001",
    document_id: "DOC-0123456789ABCDEF01234567",
    version_id: "VER-REQ-111111111111111111111111",
    logical_path: "reports/final-report.pdf",
    destination_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/DELIVERABLES/reports/final-report.pdf",
    accepted: true as const,
    published: true as const,
    source: {
      provider_id: "dropbox",
      path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf",
      object_id: "id:source",
      revision_token: "rev-source",
      integrity_hash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) },
      size: 42
    },
    destination: {
      provider_id: "dropbox",
      path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/DELIVERABLES/reports/final-report.pdf",
      object_id: "id:destination",
      revision_token: "rev-destination",
      integrity_hash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) },
      size: 42
    },
    created_at: "2026-09-09T18:00:00Z"
  };

  await journal.write(record);
  await expect(journal.read(record.project_id, record.request_id)).resolves.toEqual(record);
});
