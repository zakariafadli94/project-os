import { expect, it } from "vitest";
import { candidate } from "./helpers/review-candidate";
import { parseArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import { resolveArtifactDestination } from "../src/persistence/artifact-routing";
import { assertManagedRelativePath } from "../src/domain/managed-document";
const state = { ...emptyProjectState("PRJ-0002", "Project OS", "project-os", "Test"), revision: 149 };
it("resolves explicit candidates to reserved immutable REVIEW namespace without a route", () => {
  expect(resolveArtifactDestination(state, candidate.relative_path, parseArtifactWriteRequest(candidate)).path)
    .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf");
});
it("does not let a managed document claim the candidate namespace", () => {
  expect(() => assertManagedRelativePath("CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf")).toThrow();
});
