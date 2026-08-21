import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

function bullets(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

export function renderBrief(state: ProjectState): string {
  const constraints = Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map((constraint) => `- **${constraint.title}:** ${constraint.description}`);

  return `${renderProjectFrontmatter(state, "BRIEF", "brief")}${MANAGED_NOTICE}\n# Brief — ${state.name}\n\n## Purpose\n\n${state.objective || "The project purpose has not been defined yet."}\n\n## Scope\n\n${bullets(state.framing.scope, "Scope has not been defined yet.")}\n\n## Out of scope\n\n${bullets(state.framing.out_of_scope, "Out-of-scope items have not been defined yet.")}\n\n## Boundaries\n\n${constraints.join("\n") || "No durable constraints have been recorded yet."}\n\n## Stakeholders\n\n${bullets(state.framing.stakeholders, "Stakeholders have not been defined yet.")}\n\n## Success criteria\n\n${bullets(state.framing.success_criteria, "Success criteria have not been formalized yet.")}\n\n## Open questions\n\n${bullets(state.framing.open_questions, "No open framing questions are currently recorded.")}\n`;
}
