import type { DeliverableRecord, ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderDeliverable(state: ProjectState, record: DeliverableRecord): string {
  const metadata: string[] = [
    `Deliverable ID: ${record.deliverable_id}`,
    `Status: ${record.status}`
  ];
  if (record.version) metadata.push(`Version: ${record.version}`);
  if (record.owner) metadata.push(`Owner: ${record.owner}`);
  if (record.phase_id) metadata.push(`Phase: [[PLAN|${record.phase_id}]]`);
  metadata.push(`Created: ${record.created_at}`, `Updated: ${record.updated_at}`);

  const decisionLinks = (record.decision_ids ?? []).map((decisionId) => {
    const title = state.decisions[decisionId]?.title ?? decisionId;
    return `- [[DECISIONS/${decisionId}|${title}]]`;
  });

  const sections: string[] = [];
  if (record.status === "legacy_completed") {
    sections.push("## Acceptance\n\nAcceptance: not inferred; explicit acceptance was not recorded in the legacy model.");
  } else if (record.status === "accepted") {
    sections.push(`## Acceptance\n\nAcceptance note: ${record.acceptance_note ?? "Not recorded"}\nAccepted at: ${record.accepted_at ?? "Not recorded"}`);
  }
  if (record.status === "superseded") {
    sections.push(`## Supersession\n\nSuperseded by: ${record.superseded_by ? `[[DELIVERABLES/${record.superseded_by}|${record.superseded_by}]]` : "unknown"}\nReason: ${record.superseded_reason ?? "Not recorded"}`);
  }
  if (record.status === "abandoned") {
    sections.push(`## Abandonment\n\nReason: ${record.abandoned_reason ?? "Not recorded"}`);
  }
  if (decisionLinks.length) sections.push(`## Related decisions\n\n${decisionLinks.join("\n")}`);
  if (record.reference) sections.push(`## Reference\n\n${record.reference}`);
  if (record.description) sections.push(`## Description\n\n${record.description}`);
  if (record.outcome) sections.push(`## Outcome\n\n${record.outcome}`);

  return `${renderProjectFrontmatter(state, record.deliverable_id, "deliverable")}${MANAGED_NOTICE}\n# ${record.title}\n\n${metadata.join("\n")}\n${sections.length ? `\n${sections.join("\n\n")}\n` : "\n"}`;
}
