import { describe, expect, it } from "vitest";
import {
  assertManagedRelativePath,
  assertReferenceCollectionPath,
  documentIdFor,
  externalVersionIdFor,
  parseDocumentVersionRecord,
  parseManagedDocumentHead
} from "../src/domain/managed-document";

describe("managed document domain", () => {
  it("derives stable project-bound document IDs", async () => {
    const first = await documentIdFor("PRJ-0002", "strategy/commercial.md");
    const replay = await documentIdFor("PRJ-0002", "strategy/commercial.md");
    const otherProject = await documentIdFor("PRJ-0003", "strategy/commercial.md");

    expect(first).toMatch(/^DOC-[A-F0-9]{24}$/);
    expect(replay).toBe(first);
    expect(otherProject).not.toBe(first);
  });

  it("derives stable external version IDs without exposing raw provider revs", async () => {
    const first = await externalVersionIdFor("a1c10ce0dd78");
    expect(first).toMatch(/^VER-EXT-[A-F0-9]{24}$/);
    expect(await externalVersionIdFor("a1c10ce0dd78")).toBe(first);
    expect(first).not.toContain("a1c10ce0dd78");
  });

  it("accepts one work product with published and newer working pointers at the same time", () => {
    const head = parseManagedDocumentHead({
      schema_version: "1.0",
      project_id: "PRJ-0002",
      document_id: "DOC-0123456789ABCDEF01234567",
      kind: "work_product",
      logical_path: "strategy/commercial.md",
      working_version_id: "VER-EXT-111111111111111111111111",
      published_version_id: "VER-REQ-222222222222222222222222",
      reconciliation_status: "clean"
    });

    expect(head.working_version_id).not.toBe(head.published_version_id);
  });

  it("accepts immutable binary-friendly version metadata without requiring text content", () => {
    const record = parseDocumentVersionRecord({
      schema_version: "1.0",
      project_id: "PRJ-0002",
      document_id: "DOC-0123456789ABCDEF01234567",
      version_id: "VER-EXT-111111111111111111111111",
      kind: "reference",
      stage: "reference",
      logical_path: "market/report.pdf",
      source: "input_ingest",
      created_at: "2026-08-24T19:00:00+01:00",
      immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/DOC-0123456789ABCDEF01234567/VER-EXT-111111111111111111111111/report.pdf",
      provider_content_hash: "f".repeat(64),
      provider_file_id: "id:abc",
      provider_rev: "a1c10ce0dd78",
      size: 42000,
      media_type: "application/pdf"
    });

    expect(record.content_sha256).toBeUndefined();
    expect(record.provider_content_hash).toBe("f".repeat(64));
  });

  it.each([
    "../STATE.md",
    "foo/../../STATE.md",
    "/absolute.md",
    "foo//bar.md",
    "foo/./bar.md",
    "",
    "INPUTS/file.md"
  ])("rejects unsafe or reserved managed relative path %s", (value) => {
    expect(() => assertManagedRelativePath(value)).toThrow();
  });

  it("accepts safe nested managed relative paths", () => {
    expect(assertManagedRelativePath("strategy/commercial.md")).toBe("strategy/commercial.md");
  });

  it.each([
    "../MARKET",
    "/MARKET",
    "MARKET//Reports",
    "MARKET/./Reports",
    "INPUTS",
    "WORKING/foo",
    "DELIVERABLES",
    "A/B/C/D/E"
  ])("rejects unsafe or reserved reference collection %s", (value) => {
    expect(() => assertReferenceCollectionPath(value)).toThrow();
  });

  it("accepts bounded project-specific reference collections", () => {
    expect(assertReferenceCollectionPath("MARKET/Reports")).toBe("MARKET/Reports");
    expect(assertReferenceCollectionPath("COMPETITORS/HubSpot")).toBe("COMPETITORS/HubSpot");
    expect(assertReferenceCollectionPath("UNCLASSIFIED")).toBe("UNCLASSIFIED");
  });
});
