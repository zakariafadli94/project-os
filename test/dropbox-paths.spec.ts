import { expect, it } from "vitest";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath,
  machineMutationCandidatePath,
  machineMutationCandidatePayloadPath,
  machineMutationGateRoot,
  machineMutationIntentDestinationBindingRoot,
  machineMutationIntentPath,
  machineMutationResolutionPath,
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

it("builds project-isolated mutation-gate paths", () => {
  const requestId = "ART-MUTATION-000001";
  const candidateId = "MUTCAND-111111111111111111111111";
  const resolutionId = "MUTRES-222222222222222222222222";
  const hash = "a".repeat(64);

  expect(machineMutationGateRoot("PRJ-0002"))
    .toBe("/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate");
  expect(machineMutationIntentPath("PRJ-0002", requestId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate/intents/artifacts/${requestId}.json`);
  expect(machineMutationIntentDestinationBindingRoot("PRJ-0002", hash))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate/intent-bindings/destination/${hash}`);
  expect(machineMutationCandidatePath("PRJ-0002", candidateId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate/candidates/${candidateId}.json`);
  expect(machineMutationCandidatePayloadPath("PRJ-0002", candidateId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate/payloads/candidates/${candidateId}/payload`);
  expect(machineMutationResolutionPath("PRJ-0002", candidateId, resolutionId))
    .toBe(`/PROJECT_OS/.project-os/projects/PRJ-0002/mutation-gate/resolutions/${candidateId}/${resolutionId}.json`);
});

it("rejects unsafe managed document path components", () => {
  expect(() => workspaceManagedDocumentPath("PRJ-0003", "growth", "working", "../STATE.md")).toThrow();
  expect(() => machineDocumentHeadPath("PRJ-0002", "DOC-bad")).toThrow();
  expect(() => machineDocumentVersionPath("PRJ-0002", "DOC-0123456789ABCDEF01234567", "VER-bad")).toThrow();
  expect(() => machineDocumentTextPayloadPath("PRJ-0002", "abc")).toThrow();
});

it("rejects unsafe mutation-gate path components", () => {
  expect(() => machineMutationIntentPath("PRJ-0002", "ART-bad")).toThrow();
  expect(() => machineMutationIntentDestinationBindingRoot("PRJ-0002", "abc")).toThrow();
  expect(() => machineMutationCandidatePath("PRJ-0002", "MUTCAND-bad")).toThrow();
  expect(() => machineMutationCandidatePayloadPath("PRJ-0002", "../candidate")).toThrow();
  expect(() => machineMutationResolutionPath(
    "PRJ-0002",
    "MUTCAND-111111111111111111111111",
    "MUTRES-bad"
  )).toThrow();
});
