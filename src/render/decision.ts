import type { DecisionRecord } from "../domain/project-state";
import { MANAGED_NOTICE } from "./shared";

export function renderDecision(decision: DecisionRecord): string {
  const impacts = decision.impacts.map((impact) => `- ${impact}`).join("\n") || "- None";
  const supersession = decision.status === "superseded"
    ? `\n## Supersession\n\nSuperseded by: [[${decision.superseded_by ?? "unknown"}]]\nReason: ${decision.superseded_reason ?? "Not recorded"}\n`
    : "";

  return `${MANAGED_NOTICE}\n# ${decision.decision_id} — ${decision.title}\n\nStatus: ${decision.status}\nCreated: ${decision.created_at}\nUpdated: ${decision.updated_at}\n\n## Decision\n\n${decision.decision}\n\n## Reason\n\n${decision.reason}\n\n## Impacts\n\n${impacts}\n${supersession}`;
}
