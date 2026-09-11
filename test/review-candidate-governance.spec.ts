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


it("routes an unvalidated binary attachment into WORKING only through an accepted governed route", () => {
  const workingState = emptyProjectState("PRJ-0007", "Programme 1", "programme-1", "Test");
  workingState.decisions["DEC-C2ATTACH001"] = {
    decision_id: "DEC-C2ATTACH001",
    title: "C2 attachment remains working",
    decision: "Keep the C2 spreadsheet as an unvalidated working attachment",
    reason: "The spreadsheet supports C2 but is not a deliverable",
    impacts: [],
    status: "accepted",
    created_at: "2026-09-11T12:00:00Z",
    updated_at: "2026-09-11T12:00:00Z"
  };
  workingState.artifact_routes["ROUTE-C2ATTACH001"] = {
    route_id: "ROUTE-C2ATTACH001",
    source_prefix: "C2-WORKING",
    target_prefix: "WORKING/AMM-PROGRAMME-1/C2/v0.2",
    exclusive: true,
    decision_ids: ["DEC-C2ATTACH001"],
    created_at: "2026-09-11T12:00:00Z",
    updated_at: "2026-09-11T12:00:00Z"
  };

  expect(resolveArtifactDestination(workingState, "C2-WORKING/AMM-C2-CAPACITE-v0.1.xlsx").path)
    .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0007-programme-1/WORKING/AMM-PROGRAMME-1/C2/v0.2/AMM-C2-CAPACITE-v0.1.xlsx");
});
