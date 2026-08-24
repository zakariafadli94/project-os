import { expect, it } from "vitest";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath,
  workspaceManagedDocumentPath,
  workspaceManagedZoneRoot
} from "../src/dropbox/layout";
import { assertSafeSlug, projectRoot } from "../src/dropbox/paths";

it("builds a canonical project path", () => {
  expect(projectRoot("PRJ-0001", "agency")).toBe("/PROJECT_OS/PROJECTS/PRJ-0001-agency");
});

it("rejects traversal and separators in slug", () => {
  expect(() => assertSafeSlug("../../secret")).toThrow();
  expect(() => assertSafeSlug("a/b")).toThrow();
  expect(() => assertSafeSlug("Agency")).toThrow();
});

it("rejects malformed project IDs", () => {
  expect(() => projectRoot("../1", "agency")).toThrow();
});

it("builds clean visible managed-document zone paths", () => {
  expect(workspaceManagedZoneRoot("PRJ-0003", "growth", "inputs"))
    .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/INPUTS");
  expect(workspaceManagedZoneRoot("PRJ-0003", "growth", "working"))
    .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/WORKING");
  expect(workspaceManagedDocumentPath("PRJ-0003", "growth", "references", "MARKET/Reports/report.pdf"))
    .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/REFERENCES/MARKET/Reports/report.pdf");
});

it("builds project-isolated hidden document ledger paths", () => {
  const documentId = "DOC-0123456789ABCDEF01234567";
  const versionId = "VER-EXT-111111111111111111111111";
  const hash = "a".repeat(64);

  expect(machineDocumentHeadPath("PRJ-0002", documentId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/documents/heads/${documentId}.json`);
  expect(machineDocumentVersionPath("PRJ-0002", documentId, versionId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/documents/versions/${documentId}/${versionId}.json`);
  expect(machineDocumentTextPayloadPath("PRJ-0002", hash))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/sha256/${hash}`);
  expect(machineDocumentProviderPayloadPath("PRJ-0002", documentId, versionId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/provider/${documentId}/${versionId}/payload`);
});

it("rejects unsafe managed document path components", () => {
  expect(() => workspaceManagedDocumentPath("PRJ-0003", "growth", "working", "../STATE.md")).toThrow();
  expect(() => machineDocumentHeadPath("PRJ-0002", "DOC-bad")).toThrow();
  expect(() => machineDocumentVersionPath("PRJ-0002", "DOC-0123456789ABCDEF01234567", "VER-bad")).toThrow();
  expect(() => machineDocumentTextPayloadPath("PRJ-0002", "abc")).toThrow();
});
