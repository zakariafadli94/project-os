import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderHandoff } from "../src/render/handoff";
import { renderPlan } from "../src/render/plan";
import { renderProject } from "../src/render/project";
import { renderState } from "../src/render/state";

function sampleState() {
  const state = emptyProjectState("PRJ-0001", "Agency", "agency", "Launch the agency", ["agence"]);
  state.revision = 7;
  state.plan_phases["PHASE-0001"] = {
    phase_id: "PHASE-0001",
    title: "Launch",
    objective: "Go live",
    next_actions: ["Publish offer"],
    status: "active",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.current_phase_id = "PHASE-0001";
  state.tasks["TASK-0001"] = {
    task_id: "TASK-0001",
    title: "Publish offer",
    status: "active",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.tasks["TASK-0002"] = {
    task_id: "TASK-0002",
    title: "Get approval",
    status: "blocked",
    blocked_reason: "Waiting for client",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  return state;
}

describe("Markdown renderers", () => {
  it("renders state with revision, phase, active work, blockers and next actions", () => {
    const output = renderState(sampleState());
    expect(output).toContain("Revision: 7");
    expect(output).toContain("Launch");
    expect(output).toContain("Publish offer");
    expect(output).toContain("Waiting for client");
    expect(output).toContain("## Next actions");
    expect(output).toContain("MACHINE-MANAGED");
  });

  it("renders stable project, plan and handoff documents", () => {
    const state = sampleState();
    expect(renderProject(state)).toContain("Launch the agency");
    expect(renderPlan(state)).toContain("PHASE-0001");
    expect(renderHandoff(state)).toContain("PRJ-0001");
  });
});
