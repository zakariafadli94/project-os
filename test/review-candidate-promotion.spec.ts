import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { ReviewCandidateJournal } from "../src/artifacts/review-journal";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { ManagedDocumentService } from "../src/documents/service";
import {
  machineDocumentPromotionPath,
  machineDocumentProviderPayloadPath,
  workspaceManagedDocumentPath
} from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

it("promotes unchanged committed review evidence into one receipt-gated deliverable without removing the candidate", async () => {
  const mock = installDropboxMock({ realContentHash: true });
  const projectId = "PRJ-0002";
  const state = { ...emptyProjectState(projectId, "Review", "review", "Test"), revision: 149 };
  const requestId = "DOCREQ-CANDIDATE-000001";
  const candidateRequestId = "ART-REVIEW-CANDIDATE-0001";
  const content = "%PDF-1.7\nreview candidate\n%%EOF";
  const candidatePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-review/REVIEW/CANDIDATES/${candidateRequestId}/example.pdf`;
  const source = (await mock.writeExternal(candidatePath, content))!;
  const runtime = createProductionPersistence(testEnv);
  const candidate = {
    request_id: candidateRequestId,
    project_id: projectId,
    operation: "REVIEW_CANDIDATE" as const,
    base_revision: state.revision,
    relative_path: "example.pdf",
    media_type: "application/pdf" as const,
    content_sha256: await sha256Text(content),
    mode: "create" as const,
    source: {
      kind: "staged_provider_object" as const,
      provider_id: "dropbox",
      path: `/PROJECT_OS/.project-os/artifacts/staging/${candidateRequestId}/example.pdf`,
      object_id: source.id,
      revision_token: source.rev,
      size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
    }
  };
  const journal = new ReviewCandidateJournal(runtime);
  await journal.recordObservation(candidate, {
    path: candidatePath,
    objectId: source.id,
    revisionToken: source.rev,
    integrityHash: { algorithm: "dropbox-content-hash", value: source.content_hash },
    size: source.size
  });
  await journal.recordTerminal(candidate, {
    request_id: candidate.request_id,
    project_id: candidate.project_id,
    relative_path: candidate.relative_path,
    content_sha256: candidate.content_sha256,
    status: "committed",
    operation: "REVIEW_CANDIDATE",
    accepted: false,
    published: false,
    final_observation: {
      provider_id: "dropbox",
      path: candidatePath,
      object_id: source.id,
      revision_token: source.rev,
      size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
    }
  });
  const operation = {
    operation: "review_candidate.promote" as const,
    request_id: requestId,
    project_id: projectId,
    candidate_request_id: candidateRequestId,
    logical_path: "reports/final-report.pdf",
    expected_project_revision: state.revision,
    accepted: true as const,
    created_at: "2026-09-09T18:00:00Z"
  };

  const receipt = await new ManagedDocumentService(runtime).promoteReviewCandidate(operation, state);

  const deliverablePath = workspaceManagedDocumentPath(projectId, state.slug, "deliverables", operation.logical_path);
  expect(receipt).toMatchObject({
    request_id: requestId,
    project_id: projectId,
    stage: "published",
    logical_path: operation.logical_path,
    status: "committed",
    candidate_request_id: candidateRequestId,
    accepted: true,
    published: true
  });
  expect(mock.files.get(deliverablePath)).toBe(content);
  expect(mock.files.get(candidatePath)).toBe(content);
  expect(mock.files.has(machineDocumentProviderPayloadPath(projectId, receipt.document_id, receipt.version_id))).toBe(true);
  expect(mock.files.has(machineDocumentPromotionPath(projectId, requestId))).toBe(true);

  await expect(new ManagedDocumentService(runtime).promoteReviewCandidate(operation, state)).resolves.toEqual(receipt);
});

it("rejects promotion when the committed terminal evidence disagrees with the frozen observation", async () => {
  const mock = installDropboxMock({ realContentHash: true });
  const projectId = "PRJ-0002";
  const state = { ...emptyProjectState(projectId, "Review", "review", "Test"), revision: 149 };
  const candidateRequestId = "ART-REVIEW-CANDIDATE-0002";
  const content = "%PDF-1.7\nreview candidate\n%%EOF";
  const candidatePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-review/REVIEW/CANDIDATES/${candidateRequestId}/example.pdf`;
  const source = (await mock.writeExternal(candidatePath, content))!;
  const runtime = createProductionPersistence(testEnv);
  const candidate = {
    request_id: candidateRequestId,
    project_id: projectId,
    operation: "REVIEW_CANDIDATE" as const,
    base_revision: state.revision,
    relative_path: "example.pdf",
    media_type: "application/pdf" as const,
    content_sha256: await sha256Text(content),
    mode: "create" as const,
    source: {
      kind: "staged_provider_object" as const,
      provider_id: "dropbox",
      path: `/PROJECT_OS/.project-os/artifacts/staging/${candidateRequestId}/example.pdf`,
      object_id: source.id,
      revision_token: source.rev,
      size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
    }
  };
  const journal = new ReviewCandidateJournal(runtime);
  await journal.recordObservation(candidate, {
    path: candidatePath,
    objectId: source.id,
    revisionToken: source.rev,
    integrityHash: { algorithm: "dropbox-content-hash", value: source.content_hash },
    size: source.size
  });
  await journal.recordTerminal(candidate, {
    request_id: candidate.request_id,
    project_id: candidate.project_id,
    relative_path: candidate.relative_path,
    content_sha256: candidate.content_sha256,
    status: "committed",
    operation: "REVIEW_CANDIDATE",
    accepted: false,
    published: false,
    final_observation: {
      provider_id: "dropbox",
      path: candidatePath,
      object_id: "id:forged-terminal",
      revision_token: "rev-forged-terminal",
      size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
    }
  });
  const operation = {
    operation: "review_candidate.promote" as const,
    request_id: "DOCREQ-CANDIDATE-000002",
    project_id: projectId,
    candidate_request_id: candidateRequestId,
    logical_path: "reports/rejected-report.pdf",
    expected_project_revision: state.revision,
    accepted: true as const,
    created_at: "2026-09-09T18:00:00Z"
  };

  await expect(new ManagedDocumentService(runtime).promoteReviewCandidate(operation, state)).rejects.toMatchObject({
    code: "CANDIDATE_EVIDENCE_CHANGED"
  });
  expect(mock.files.has(workspaceManagedDocumentPath(projectId, state.slug, "deliverables", operation.logical_path))).toBe(false);
});
