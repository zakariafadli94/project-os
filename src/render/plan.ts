import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderPlan(state: ProjectState): string {
  const phases = Object.values(state.plan_phases)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map((phase) => {
      const tasks = Object.values(state.tasks)
        .filter((task) => task.phase_id === phase.phase_id)
        .sort((a, b) => a.task_id.localeCompare(b.task_id))
        .map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.task_id} — ${task.title} (${task.status})`)
        .join("\n") || "- None";
      const next = phase.next_actions.map((action) => `- ${action}`).join("\n") || "- None";
      return `## ${phase.phase_id} — ${phase.title}\n\nStatus: ${phase.status}\n${phase.objective ? `Objective: ${phase.objective}\n` : ""}\n### Tasks\n\n${tasks}\n\n### Next actions\n\n${next}`;
    })
    .join("\n\n");

  return `${renderProjectFrontmatter(state, "PLAN", "plan")}${MANAGED_NOTICE}\n# Plan — ${state.name}\n\nRevision: ${state.revision}\n\n${phases || "No validated phases yet."}\n`;
}
