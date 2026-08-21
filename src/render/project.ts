import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderProject(state: ProjectState): string {
  const aliases = state.aliases.length ? state.aliases.map((alias) => `- ${alias}`).join("\n") : "- None";
  const constraints = Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map((item) => `- **${item.constraint_id} — ${item.title}:** ${item.description}`)
    .join("\n") || "- None";

  return `${renderProjectFrontmatter(state, "PROJECT", "project")}${MANAGED_NOTICE}\n# ${state.name}\n\nProject ID: ${state.project_id}\nStatus: ${state.status}\nRevision: ${state.revision}\n\n## Start here\n\n- [[BRIEF|Brief]] — what this project is and what success means.\n- [[DISCOVERY|Discovery]] — what we know, learned and still need to explore.\n- [[ROADMAP|Roadmap]] — what is happening now and what comes next.\n\n## Objective\n\n${state.objective || "Not defined"}\n\n## Aliases\n\n${aliases}\n\n## Durable constraints\n\n${constraints}\n`;
}
