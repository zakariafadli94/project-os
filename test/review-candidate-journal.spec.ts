import { describe, expect, it } from "vitest";
import type { ArtifactWriteReceipt, ReviewCandidateRequest } from "../src/domain/artifact-write";
import { ReviewCandidateJournal } from "../src/artifacts/review-journal";
import { ManagedDocumentPromotionJournal, type ManagedDocumentPromotionRecord } from "../src/documents/promotion-journal";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { ProviderConflictError } from "../src/persistence/provider/errors";

const candidate: ReviewCandidateRequest = {
  operation: "REVIEW_CANDIDATE",
  request_id: "ART-REVIEW-CANDIDATE-0001",
  project_id: "PRJ-0002",
  relative_path: "fiche.pdf",
  content_sha256: "a".repeat(64),
  mode: "create",
  base_revision: 150,
  media_type: "application/pdf",
  source: {
    kind: "staged_provider_object",
    provider_id: "dropbox",
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-REVIEW-CANDIDATE-0001/fiche.pdf",
    object_id: "id:candidate",
    revision_token: "rev-candidate",
    size: 16,
    integrity: { algorithm: "dropbox-content-hash", value: "b".repeat(64) }
  }
};

const sourceObservation = {
  provider_id: "dropbox",
  path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/fiche.pdf",
  object_id: "id:candidate",
  revision_token: "rev-candidate",
  size: 16,
  integrity: { algorithm: "dropbox-content-hash", value: "b".repeat(64) }
};

const providerSourceObservation = {
  provider_id: sourceObservation.provider_id,
  path: sourceObservation.path,
  object_id: sourceObservation.object_id,
  revision_token: sourceObservation.revision_token,
  size: sourceObservation.size,
  integrity_hash: sourceObservation.integrity
};

const receipt: ArtifactWriteReceipt = {
  request_id: candidate.request_id,
  project_id: candidate.project_id,
  relative_path: candidate.relative_path,
  content_sha256: candidate.content_sha256,
  status: "committed",
  operation: "REVIEW_CANDIDATE",
  accepted: false,
  published: false,
  final_observation: sourceObservation
};

function runtime() {
  const files = new Map<string, string>();
  return persistenceFromDropbox({
    upload: async (path, content, mode) => {
      if (mode === "add" && files.has(path)) throw new ProviderConflictError("path/conflict/file");
      files.set(path, content);
    },
    download: async (path) => files.get(path) ?? null,
    move: async (from, to) => { const content = files.get(from); if (content === undefined) throw new Error("missing"); files.delete(from); files.set(to, content); },
    getMetadata: async () => null,
    listFolder: async () => [],
    delete: async (path) => { files.delete(path); }
  });
}

describe("review candidate immutable journals", () => {
  it("loads a committed candidate terminal by project and request id", async () => {
    const journal = new ReviewCandidateJournal(runtime());
    await journal.recordTerminal(candidate, receipt);

    const loaded = await journal.terminalByRequestId(candidate.project_id, candidate.request_id);
    expect(loaded).toEqual({ request: candidate, receipt });
  });

  it("keeps promotion evidence immutable when a request is retried with different destination evidence", async () => {
    const journal = new ManagedDocumentPromotionJournal(runtime());
    const record: ManagedDocumentPromotionRecord = {
      schema_version: "1.0",
      request_id: "DOCREQ-CANDIDATE-PROMOTE-0001",
      project_id: "PRJ-0002",
      candidate_request_id: candidate.request_id,
      document_id: "DOC-0123456789ABCDEF01234567",
      version_id: "VER-REQ-0123456789ABCDEF01234567",
      logical_path: "dg-v2.0/fiche.pdf",
      destination_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/dg-v2.0/fiche.pdf",
      accepted: true,
      published: true,
      source: providerSourceObservation,
      destination: { ...providerSourceObservation, path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/dg-v2.0/fiche.pdf", object_id: "id:published", revision_token: "rev-published" },
      created_at: "2026-09-07T20:00:00Z"
    };
    await journal.write(record);
    await expect(journal.write({ ...record, destination: { ...record.destination, revision_token: "rev-other" } })).rejects.toThrow(/immutable|conflict/i);
    await expect(journal.read(record.project_id, record.request_id)).resolves.toEqual(record);
  });
});
