import type { ProjectState } from "../domain/project-state";
import { MANAGED_NOTICE } from "./shared";

export function renderProject(state: ProjectState): string {
  const aliases = state.aliases.length ? state.aliases.map((alias) => `- ${alias}`).join("\n") : "- None";
  const constraints = Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map((item) => `- **${item.constraint_id} — ${item.title}:** ${item.description}`)
    .join("\n") || "- None";

  return `${MANAGED_NOTICE}\n# ${state.name}\n\nProject ID: ${state.project_id}\nStatus: ${state.status}\nRevision: ${state.revision}\n\n## Objective\n\n${state.objective || "Not defined"}\n\n## Aliases\n\n${aliases}\n\n## Durable constraints\n\n${constraints}\n`;
}
