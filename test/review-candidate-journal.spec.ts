import { expect, it } from "vitest";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import { ReviewCandidateJournal } from "../src/artifacts/review-journal";
import { candidate } from "./helpers/review-candidate";

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

it("loads the immutable committed review candidate terminal by its project-bound request id", async () => {
  const journal = new ReviewCandidateJournal(runtimeWithFiles());
  const receipt = {
    request_id: candidate.request_id,
    project_id: candidate.project_id,
    relative_path: candidate.relative_path,
    content_sha256: candidate.content_sha256,
    status: "committed" as const,
    operation: "REVIEW_CANDIDATE" as const,
    accepted: false as const,
    published: false as const,
    final_observation: {
      provider_id: "dropbox",
      path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf",
      object_id: "id:review-candidate",
      revision_token: "rev-1",
      size: 10,
      integrity: { algorithm: "dropbox-content-hash", value: "b".repeat(64) }
    }
  };
  await journal.recordTerminal(candidate, receipt);

  await expect(journal.terminalByRequestId(candidate.project_id, candidate.request_id)).resolves.toEqual({
    request: candidate,
    receipt
  });
});

it("labels a changed frozen review observation with a stable evidence error", async () => {
  const journal = new ReviewCandidateJournal(runtimeWithFiles());
  await journal.recordObservation(candidate, {
    path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf",
    objectId: "id:review-candidate",
    revisionToken: "rev-1",
    integrityHash: { algorithm: "dropbox-content-hash", value: "b".repeat(64) },
    size: 10
  });

  await expect(journal.observation(candidate)).rejects.toMatchObject({
    name: "ReviewCandidateEvidenceChangedError"
  });
});

it("classifies rejected staged candidates as terminal while retaining exact immutable rejection evidence", async () => {
  const journal: any = new ReviewCandidateJournal(runtimeWithFiles());
  const receipt = { request_id: candidate.request_id, project_id: candidate.project_id, relative_path: candidate.relative_path, content_sha256: candidate.content_sha256, status: "rejected", operation: "REVIEW_CANDIDATE", accepted: false, published: false, code: "CONTENT_VALIDATION_FAILED" };
  await journal.recordTerminal(candidate, receipt);
  expect(await journal.classifyStaging(candidate)).toMatchObject({ terminal: true, classification: "rejected_preserved", staging: "absent", evidence_ref: expect.stringContaining("review-terminals") });
  expect(await journal.terminal(candidate)).toEqual(receipt);
});
