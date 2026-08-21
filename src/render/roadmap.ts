import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

// Primary roadmap horizons follow DEC-SOPS001; secondary sections preserve operational context.
export function renderRoadmap(state: ProjectState): string {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;
  const currentDirection = currentPhase
    ? `${currentPhase.title}${currentPhase.objective ? ` — ${currentPhase.objective}` : ""}`
    : "No roadmap phase has been defined yet.";

  const activeWork = Object.values(state.tasks)
    .filter((task) => task.status === "active")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title}`);

  const blocked = Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title} — ${task.blocked_reason ?? "Blocked"}`);

  const next = currentPhase?.next_actions.length
    ? currentPhase.next_actions.map((action) => `- ${action}`)
    : Object.values(state.tasks)
        .filter((task) => task.status === "pending")
        .sort((a, b) => a.task_id.localeCompare(b.task_id))
        .slice(0, 5)
        .map((task) => `- ${task.title}`);

  const later = Object.values(state.plan_phases)
    .filter((phase) => phase.status === "pending" && phase.phase_id !== state.current_phase_id)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map((phase) => `- ${phase.title}${phase.objective ? ` — ${phase.objective}` : ""}`);

  const completedTasks = Object.values(state.tasks)
    .filter((task) => task.status === "completed")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title}`);

  const deliverables = Object.values(state.deliverables)
    .sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))
    .map((deliverable) => `- [[DELIVERABLES/${deliverable.deliverable_id}|${deliverable.title}]] — ${deliverable.status}`);

  return `${renderProjectFrontmatter(state, "ROADMAP", "roadmap")}${MANAGED_NOTICE}\n# Roadmap — ${state.name}\n\n## Current\n\n${currentDirection}\n\n### Active work\n\n${activeWork.join("\n") || "No active work is currently recorded."}\n\n### Blocked\n\n${blocked.join("\n") || "No blockers are currently recorded."}\n\n## Next\n\n${next.join("\n") || "No next actions have been defined yet."}\n\n## Later\n\n${later.join("\n") || "No later roadmap phases have been defined yet."}\n\n## Completed\n\n${completedTasks.join("\n") || "No completed work has been recorded yet."}\n\n## Deliverables\n\n${deliverables.join("\n") || "No deliverables have been recorded yet."}\n`;
}
