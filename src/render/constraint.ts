import type { ConstraintRecord, ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderConstraint(state: ProjectState, record: ConstraintRecord): string {
  return `${renderProjectFrontmatter(state, record.constraint_id, "constraint")}${MANAGED_NOTICE}\n# ${record.title}\n\nConstraint ID: ${record.constraint_id}\nCreated: ${record.created_at}\n\n## Constraint\n\n${record.description}\n`;
}
