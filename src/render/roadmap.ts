import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderRoadmap(state: ProjectState): string {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;
  const direction = currentPhase
    ? `${currentPhase.title}${currentPhase.objective ? ` — ${currentPhase.objective}` : ""}`
    : "No roadmap phase has been defined yet.";

  const now = Object.values(state.tasks)
    .filter((task) => task.status === "active" || task.status === "pending")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title}${task.status === "pending" ? " — pending" : ""}`);

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

  const completedTasks = Object.values(state.tasks)
    .filter((task) => task.status === "completed")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title}`);

  const deliverables = Object.values(state.deliverables)
    .sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))
    .map((deliverable) => {
      const status = deliverable.status === "completed" ? "completed" : "pending";
      return `- [[DELIVERABLES/${deliverable.deliverable_id}|${deliverable.title}]] — ${status}`;
    });

  return `${renderProjectFrontmatter(state, "ROADMAP", "roadmap")}${MANAGED_NOTICE}\n# Roadmap — ${state.name}\n\n## Current direction\n\n${direction}\n\n## Now\n\n${now.join("\n") || "No active work is currently recorded."}\n\n## Blocked\n\n${blocked.join("\n") || "No blockers are currently recorded."}\n\n## Next\n\n${next.join("\n") || "No next actions have been defined yet."}\n\n## Completed\n\n${completedTasks.join("\n") || "No completed work has been recorded yet."}\n\n## Deliverables\n\n${deliverables.join("\n") || "No deliverables have been recorded yet."}\n`;
}
