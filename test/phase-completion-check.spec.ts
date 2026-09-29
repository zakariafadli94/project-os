import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import { emptyProjectState } from "../src/domain/transitions";
import { checkPhaseCompletion } from "../src/domain/phase-completion-check";

function stateWithCurrentPhase(): ProjectState {
  const state = emptyProjectState("PRJ-9997", "Phase check fixture", "phase-check-fixture");
  state.plan_phases["PHASE-9997"] = {
    phase_id: "PHASE-9997",
    title: "Current phase",
    objective: "Check the canonical completion predicate",
    status: "active",
    next_actions: [],
    created_at: "2026-09-29T00:00:00.000Z",
    updated_at: "2026-09-29T00:00:00.000Z"
  };
  state.current_phase_id = "PHASE-9997";
  return state;
}

describe("checkPhaseCompletion", () => {
  it("reports a missing phase", () => {
    expect(checkPhaseCompletion(stateWithCurrentPhase(), "PHASE-4040")).toEqual({
      code: "PHASE_NOT_FOUND",
      message: "Phase PHASE-4040 does not exist"
    });
  });

  it("keeps a completed phase terminal", () => {
    const state = stateWithCurrentPhase();
    state.plan_phases["PHASE-9997"].status = "completed";

    expect(checkPhaseCompletion(state, "PHASE-9997")).toEqual({
      code: "PHASE_COMPLETED",
      message: "Phase PHASE-9997 is already completed"
    });
  });

  it("requires the active current phase", () => {
    const state = stateWithCurrentPhase();
    state.current_phase_id = null;

    expect(checkPhaseCompletion(state, "PHASE-9997")).toEqual({
      code: "PHASE_NOT_CURRENT",
      message: "Only the active current phase can be completed: PHASE-9997"
    });
  });

  it("rejects state with multiple active phases before considering tasks", () => {
    const state = stateWithCurrentPhase();
    state.plan_phases["PHASE-9998"] = {
      ...state.plan_phases["PHASE-9997"],
      phase_id: "PHASE-9998",
      title: "Unexpected active phase"
    };
    state.tasks["TASK-9997"] = {
      task_id: "TASK-9997",
      title: "Still pending",
      status: "pending",
      phase_id: "PHASE-9997",
      created_at: "2026-09-29T00:00:00.000Z",
      updated_at: "2026-09-29T00:00:00.000Z"
    };

    expect(checkPhaseCompletion(state, "PHASE-9997")).toEqual({
      code: "PHASE_STATE_INCONSISTENT",
      message: "Multiple active phases exist: PHASE-9997, PHASE-9998"
    });
  });

  it.each(["pending", "active", "blocked"] as const)("rejects completion with an attached %s task", (status) => {
    const state = stateWithCurrentPhase();
    state.tasks["TASK-9997"] = {
      task_id: "TASK-9997",
      title: "Not completed",
      status,
      phase_id: "PHASE-9997",
      created_at: "2026-09-29T00:00:00.000Z",
      updated_at: "2026-09-29T00:00:00.000Z"
    };

    expect(checkPhaseCompletion(state, "PHASE-9997")).toEqual({
      code: "PHASE_HAS_UNFINISHED_TASKS",
      message: "Phase PHASE-9997 has unfinished attached tasks"
    });
  });

  it("allows completion when every attached task is completed", () => {
    const state = stateWithCurrentPhase();
    state.tasks["TASK-9997"] = {
      task_id: "TASK-9997",
      title: "Completed work",
      status: "completed",
      phase_id: "PHASE-9997",
      created_at: "2026-09-29T00:00:00.000Z",
      updated_at: "2026-09-29T00:00:00.000Z"
    };

    expect(checkPhaseCompletion(state, "PHASE-9997")).toBeNull();
  });

  it("never mutates the supplied canonical state", () => {
    const state = stateWithCurrentPhase();
    state.tasks["TASK-9997"] = {
      task_id: "TASK-9997",
      title: "Completed work",
      status: "completed",
      phase_id: "PHASE-9997",
      created_at: "2026-09-29T00:00:00.000Z",
      updated_at: "2026-09-29T00:00:00.000Z"
    };
    const before = structuredClone(state);

    expect(checkPhaseCompletion(state, "PHASE-9997")).toBeNull();
    expect(state).toEqual(before);
  });
});
