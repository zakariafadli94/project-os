import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderBrief(state: ProjectState): string {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;
  const scope = currentPhase
    ? `${currentPhase.title}${currentPhase.objective ? ` — ${currentPhase.objective}` : ""}`
    : "No current phase has been defined yet.";

  const constraints = Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map((constraint) => `- **${constraint.title}:** ${constraint.description}`);

  const deliverables = Object.values(state.deliverables)
    .sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))
    .map((deliverable) => {
      const status = deliverable.status === "completed" ? "completed" : "pending";
      return `- [[DELIVERABLES/${deliverable.deliverable_id}|${deliverable.title}]] — ${status}`;
    });

  const successSignals = deliverables.length
    ? deliverables.join("\n")
    : "Success criteria have not been formalized yet.";

  return `${renderProjectFrontmatter(state, "BRIEF", "brief")}${MANAGED_NOTICE}\n# Brief — ${state.name}\n\n## Purpose\n\n${state.objective || "The project purpose has not been defined yet."}\n\n## Current scope\n\n${scope}\n\n## Boundaries\n\n${constraints.join("\n") || "No durable constraints have been recorded yet."}\n\n## Success signals\n\n${successSignals}\n`;
}
