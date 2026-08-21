import type { DeliverableRecord, ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderDeliverable(state: ProjectState, record: DeliverableRecord): string {
  const description = record.description ? `\n## Description\n\n${record.description}\n` : "";
  const reference = record.reference ? `\nReference: ${record.reference}\n` : "";
  const outcome = record.outcome ? `\n## Outcome\n\n${record.outcome}\n` : "";
  return `${renderProjectFrontmatter(state, record.deliverable_id, "deliverable")}${MANAGED_NOTICE}\n# ${record.title}\n\nDeliverable ID: ${record.deliverable_id}\nStatus: ${record.status}\nCreated: ${record.created_at}\nUpdated: ${record.updated_at}\n${reference}${description}${outcome}`;
}
