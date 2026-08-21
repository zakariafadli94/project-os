import type { ProjectState, TaskRecord } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderTask(state: ProjectState, record: TaskRecord): string {
  const phase = record.phase_id ? `\nPhase: ${record.phase_id}\n` : "";
  const description = record.description ? `\n## Description\n\n${record.description}\n` : "";
  const blocker = record.blocked_reason ? `\n## Blocker\n\n${record.blocked_reason}\n` : "";
  const result = record.result ? `\n## Result\n\n${record.result}\n` : "";
  return `${renderProjectFrontmatter(state, record.task_id, "task")}${MANAGED_NOTICE}\n# ${record.title}\n\nTask ID: ${record.task_id}\nStatus: ${record.status}\nCreated: ${record.created_at}\nUpdated: ${record.updated_at}\n${phase}${description}${blocker}${result}`;
}
