import type { ReviewCandidateRequest } from "../../src/domain/artifact-write";

export const candidate: ReviewCandidateRequest = {
  request_id: "ART-REVIEW-CANDIDATE-0001", project_id: "PRJ-0002",
  operation: "REVIEW_CANDIDATE", base_revision: 149,
  relative_path: "example.pdf", media_type: "application/pdf",
  content_sha256: "a".repeat(64), mode: "create",
  source: {
    kind: "staged_provider_object", provider_id: "dropbox",
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-REVIEW-CANDIDATE-0001/example.pdf",
    object_id: "id:source", revision_token: "rev-1", size: 10,
    integrity: { algorithm: "dropbox-content-hash", value: "b".repeat(64) }
  }
};
