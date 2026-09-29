import type { ProjectState } from "./project-state";

export interface PhaseCompletionIssue {
  code:
    | "PHASE_NOT_FOUND"
    | "PHASE_COMPLETED"
    | "PHASE_NOT_CURRENT"
    | "PHASE_STATE_INCONSISTENT"
    | "PHASE_HAS_UNFINISHED_TASKS";
  message: string;
}

/** Pure canonical predicate shared by phase admission and transition enforcement. */
export function checkPhaseCompletion(state: ProjectState, phaseId: string): PhaseCompletionIssue | null {
  const phase = state.plan_phases[phaseId];
  if (!phase) return { code: "PHASE_NOT_FOUND", message: `Phase ${phaseId} does not exist` };
  if (phase.status === "completed") {
    return { code: "PHASE_COMPLETED", message: `Phase ${phase.phase_id} is already completed` };
  }
  if (phase.status !== "active" || state.current_phase_id !== phase.phase_id) {
    return { code: "PHASE_NOT_CURRENT", message: `Only the active current phase can be completed: ${phase.phase_id}` };
  }
  const otherActive = Object.values(state.plan_phases).find(
    (candidate) => candidate.phase_id !== phase.phase_id && candidate.status === "active"
  );
  if (otherActive) {
    return {
      code: "PHASE_STATE_INCONSISTENT",
      message: `Multiple active phases exist: ${phase.phase_id}, ${otherActive.phase_id}`
    };
  }
  if (Object.values(state.tasks).some((task) => task.phase_id === phase.phase_id && task.status !== "completed")) {
    return { code: "PHASE_HAS_UNFINISHED_TASKS", message: `Phase ${phase.phase_id} has unfinished attached tasks` };
  }
  return null;
}
