import type { DecisionRecord, ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export function renderDecision(state: ProjectState, decision: DecisionRecord): string {
  const impacts = decision.impacts.map((impact) => `- ${impact}`).join("\n") || "- None";
  const supersession = decision.status === "superseded"
    ? `\n## Supersession\n\nSuperseded by: ${decision.superseded_by ? `[[DECISIONS/${decision.superseded_by}|${decision.superseded_by}]]` : "unknown"}\nReason: ${decision.superseded_reason ?? "Not recorded"}\n`
    : "";

  return `${renderProjectFrontmatter(state, decision.decision_id, "decision")}${MANAGED_NOTICE}\n# ${decision.decision_id} — ${decision.title}\n\nStatus: ${decision.status}\nCreated: ${decision.created_at}\nUpdated: ${decision.updated_at}\n\n## Decision\n\n${decision.decision}\n\n## Reason\n\n${decision.reason}\n\n## Impacts\n\n${impacts}\n${supersession}`;
}
