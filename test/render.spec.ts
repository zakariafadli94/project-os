import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderDecision } from "../src/render/decision";
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
  state.decisions["DEC-ARCH0001"] = {
    decision_id: "DEC-ARCH0001",
    title: "Canonical architecture",
    decision: "Use the guarded architecture.",
    reason: "Deterministic persistence.",
    impacts: ["Project state"],
    status: "accepted",
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

  it("adds deterministic project-scoped frontmatter to root views", () => {
    const state = sampleState();
    const project = renderProject(state);
    expect(project).toContain("project_id: PRJ-0001");
    expect(project).toContain("project_slug: agency");
    expect(project).toContain("project_name: Agency");
    expect(project).toContain("note_id: PROJECT");
    expect(project).toContain("note_type: project");
    expect(project).toContain("canonical: true");
    expect(project).toContain("revision: 7");

    expect(renderState(state)).toContain("note_id: STATE");
    expect(renderPlan(state)).toContain("note_id: PLAN");
    expect(renderHandoff(state)).toContain("note_id: HANDOFF");
  });

  it("uses project-scoped decision links and decision frontmatter", () => {
    const state = sampleState();
    const handoff = renderHandoff(state);
    expect(handoff).toContain("[[DECISIONS/DEC-ARCH0001|Canonical architecture]]");
    expect(handoff).not.toContain("[[DEC-ARCH0001]]");

    const decision = renderDecision(state, state.decisions["DEC-ARCH0001"]);
    expect(decision).toContain("project_id: PRJ-0001");
    expect(decision).toContain("note_id: DEC-ARCH0001");
    expect(decision).toContain("note_type: decision");
  });

  it("renders stable project, plan and handoff documents", () => {
    const state = sampleState();
    expect(renderProject(state)).toContain("Launch the agency");
    expect(renderPlan(state)).toContain("PHASE-0001");
    expect(renderHandoff(state)).toContain("PRJ-0001");
  });
});
