import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderDiscovery(state: ProjectState): string {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;

  const research = Object.values(state.research)
    .sort((a, b) => a.research_id.localeCompare(b.research_id))
    .map((item) => `- [[RESEARCH/${item.research_id}|${item.title}]]`);

  const decisions = Object.values(state.decisions)
    .filter((decision) => decision.status === "accepted")
    .sort((a, b) => a.decision_id.localeCompare(b.decision_id))
    .map((decision) => `- [[DECISIONS/${decision.decision_id}|${decision.title}]]`);

  const blockers = Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.title} — ${task.blocked_reason ?? "Blocked"}`);

  const nextExploration = currentPhase?.next_actions.length
    ? currentPhase.next_actions.map((action) => `- ${action}`)
    : Object.values(state.tasks)
        .filter((task) => task.status === "pending")
        .sort((a, b) => a.task_id.localeCompare(b.task_id))
        .slice(0, 5)
        .map((task) => `- ${task.title}`);

  return `${renderProjectFrontmatter(state, "DISCOVERY", "discovery")}${MANAGED_NOTICE}\n# Discovery — ${state.name}\n\n## Current understanding\n\n${state.objective || "The project purpose has not been defined yet."}\n\n## Research and learnings\n\n${research.join("\n") || "No research has been captured yet."}\n\n## Decisions shaping direction\n\n${decisions.join("\n") || "No accepted decisions have been recorded yet."}\n\n## Unresolved issues\n\n${blockers.join("\n") || "No unresolved blockers are currently recorded."}\n\n## Explore next\n\n${nextExploration.join("\n") || "No next discovery actions have been defined yet."}\n`;
}
