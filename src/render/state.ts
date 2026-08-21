import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderState(state: ProjectState): string {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;
  const active = Object.values(state.tasks)
    .filter((task) => task.status === "active" || task.status === "pending")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- [${task.status === "active" ? ">" : " "}] ${task.task_id} — ${task.title}`);
  const blocked = Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.task_id} — ${task.title}: ${task.blocked_reason ?? "Blocked"}`);
  const completed = Object.values(state.tasks)
    .filter((task) => task.status === "completed")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- [x] ${task.task_id} — ${task.title}`);
  const nextActions = currentPhase?.next_actions?.length
    ? currentPhase.next_actions.map((action) => `- ${action}`)
    : Object.values(state.tasks)
        .filter((task) => task.status === "pending")
        .sort((a, b) => a.task_id.localeCompare(b.task_id))
        .slice(0, 5)
        .map((task) => `- ${task.title}`);

  return `${renderProjectFrontmatter(state, "STATE", "state")}${MANAGED_NOTICE}\n# Current State — ${state.name}\n\nProject ID: ${state.project_id}\nStatus: ${state.status}\nRevision: ${state.revision}\nUpdated: ${state.updated_at}\n\n## Current phase\n\n${currentPhase ? `${currentPhase.phase_id} — ${currentPhase.title}` : "None"}\n\n## Active work\n\n${active.join("\n") || "- None"}\n\n## Blockers\n\n${blocked.join("\n") || "- None"}\n\n## Completed\n\n${completed.join("\n") || "- None"}\n\n## Next actions\n\n${nextActions.join("\n") || "- None"}\n`;
}
