import type { ProjectState, ResearchRecord } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderResearch(state: ProjectState, record: ResearchRecord): string {
  const source = record.source ? `\nSource: ${record.source}\n` : "";
  return `${renderProjectFrontmatter(state, record.research_id, "research")}${MANAGED_NOTICE}\n# ${record.title}\n\nResearch ID: ${record.research_id}\nCreated: ${record.created_at}\n${source}\n## Research\n\n${record.body}\n`;
}
