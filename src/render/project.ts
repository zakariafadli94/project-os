import type { ProjectKindView } from "../domain/project-governance";
import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export interface ProjectGovernanceView {
  project_kind: ProjectKindView;
}

export function renderProject(
  state: ProjectState,
  governance: ProjectGovernanceView = { project_kind: "unknown_legacy" }
): string {
  const aliases = state.aliases.length ? state.aliases.map((alias) => `- ${alias}`).join("\n") : "- None";
  const constraints = Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map((item) => `- **${item.constraint_id} — ${item.title}:** ${item.description}`)
    .join("\n") || "- None";
  const synthetic = governance.project_kind === "synthetic_probe" || governance.project_kind === "synthetic_stress_test";
  const syntheticNotice = synthetic
    ? "\nSynthetic project — fictitious / non-business\n"
    : "";

  return `${renderProjectFrontmatter(state, "PROJECT", "project")}${MANAGED_NOTICE}\n# ${state.name}\n\nProject ID: ${state.project_id}\nStatus: ${state.status}\nRevision: ${state.revision}\nProject kind: ${governance.project_kind}\n${syntheticNotice}\n## Start here\n\n- [[BRIEF|Brief]] — what this project is and what success means.\n- [[DISCOVERY|Discovery]] — what we know, learned and still need to explore.\n- [[ROADMAP|Roadmap]] — what is happening now and what comes next.\n\n## Objective\n\n${state.objective || "Not defined"}\n\n## Aliases\n\n${aliases}\n\n## Durable constraints\n\n${constraints}\n`;
}
