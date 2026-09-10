import { describe, expect, it } from "vitest";
import { parseManagedDocumentRequest } from "../src/domain/managed-document-request";

const project_id = "PRJ-0002";
const document_id = "DOC-0123456789ABCDEF01234567";
const expected_version_id = "VER-REQ-111111111111111111111111";
const created_at = "2026-08-24T19:30:00+01:00";

describe("managed document API request", () => {
  it("parses working writes with an optional invisible base-version token", () => {
    expect(parseManagedDocumentRequest({
      operation: "working.write",
      request_id: "DOCREQ-WORK-000001",
      project_id,
      logical_path: "strategy/commercial.md",
      content: "# Strategy",
      content_sha256: "a".repeat(64),
      expected_version_id,
      created_at
    })).toMatchObject({ operation: "working.write", expected_version_id });
  });

  it.each([
    { operation: "review.promote", request_id: "DOCREQ-REVIEW-000001", project_id, document_id, expected_version_id, created_at },
    { operation: "review.write", request_id: "DOCREQ-REVIEW-000002", project_id, document_id, content: "candidate", content_sha256: "b".repeat(64), expected_version_id, created_at },
    { operation: "publish", request_id: "DOCREQ-PUBLISH-000001", project_id, document_id, expected_version_id, created_at },
    { operation: "reopen", request_id: "DOCREQ-REOPEN-000001", project_id, document_id, expected_version_id, created_at },
    { operation: "reference.classify", request_id: "DOCREQ-CLASSIFY-0001", project_id, document_id, collection_path: "MARKET/Reports", expected_version_id, created_at }
  ])("parses $operation", (request) => {
    expect(parseManagedDocumentRequest(request)).toMatchObject({ operation: request.operation, project_id });
  });

  it("parses only an explicitly accepted review candidate promotion", () => {
    const request = {
      operation: "review_candidate.promote",
      request_id: "DOCREQ-CANDIDATE-000001",
      project_id,
      candidate_request_id: "ART-REVIEW-CANDIDATE-0001",
      logical_path: "reports/final-report.pdf",
      expected_project_revision: 149,
      accepted: true,
      created_at
    };

    expect(parseManagedDocumentRequest(request)).toMatchObject(request);
    expect(() => parseManagedDocumentRequest({ ...request, accepted: false })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, logical_path: "../STATE.md" })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, candidate_request_id: "DOCREQ-NOT-A-CANDIDATE" })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, expected_project_revision: 149.5 })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, unexpected: true })).toThrow();
  });

  it("rejects unknown fields and unsafe logical/reference paths", () => {
    expect(() => parseManagedDocumentRequest({
      operation: "working.write", request_id: "DOCREQ-WORK-000009", project_id,
      logical_path: "../STATE.md", content: "x", content_sha256: "a".repeat(64), created_at
    })).toThrow();
    expect(() => parseManagedDocumentRequest({
      operation: "reference.classify", request_id: "DOCREQ-CLASSIFY-0002", project_id,
      document_id, collection_path: "../MARKET", created_at
    })).toThrow();
    expect(() => parseManagedDocumentRequest({
      operation: "publish", request_id: "DOCREQ-PUBLISH-000009", project_id,
      document_id, created_at, unexpected: true
    })).toThrow();
  });
});
