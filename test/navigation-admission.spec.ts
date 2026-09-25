import { describe, expect, it } from "vitest";
import { normalizeDocumentAdmission } from "../src/admission/operation-context";
import { parseManagedDocumentRequest } from "../src/domain/managed-document-request";
import { normalizedMutationOperations } from "../src/rules/check-catalogue";

const request = {
  operation: "navigation.reconcile",
  request_id: "DOCREQ-NAVIGATION-0001",
  project_id: "PRJ-0002",
  zone: "WORKING",
  expected_project_revision: 149,
  expected_generation: 3,
  expected_index: null,
  created_at: "2026-09-25T10:00:00.000Z"
} as const;

describe("governed navigation admission", () => {
  it("parses a strict intent without accepting source inventory or effect paths", async () => {
    const parsed = parseManagedDocumentRequest(request);
    expect(parsed).toEqual(request);
    expect(await normalizeDocumentAdmission(parsed)).toMatchObject({
      operation: "navigation.reconcile",
      resources: [{
        resource_id: "navigation:WORKING",
        resource_type: "navigation",
        zone: "WORKING",
        version: "3"
      }]
    });
    expect(() => parseManagedDocumentRequest({ ...request, sources: [] })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, destination: "/WORKING/index.md" })).toThrow();
  });

  it("normalizes both supported index identities and only admits nonnegative generations", () => {
    const expected_index = {
      basename: "00-CURRENT-INDEX.md",
      object_id: "id:index001",
      revision_token: "rev001",
      content_sha256: "a".repeat(64)
    } as const;
    expect(parseManagedDocumentRequest({ ...request, expected_index })).toMatchObject({ expected_index });
    expect(() => parseManagedDocumentRequest({ ...request, expected_generation: -1 })).toThrow();
    expect(() => parseManagedDocumentRequest({ ...request, expected_index: { ...expected_index, basename: "index.md" } })).toThrow();
  });

  it("exposes navigation as a rule-admissible mutation operation", () => {
    expect(normalizedMutationOperations).toContain("navigation.reconcile");
  });
});
