import type { DiscoveryFinding, ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

function renderFinding(state: ProjectState, finding: DiscoveryFinding): string {
  const links = finding.research_ids.map((researchId) => {
    const title = state.research[researchId]?.title ?? researchId;
    return `[[RESEARCH/${researchId}|${title}]]`;
  });
  return `- ${finding.summary}${links.length ? ` — ${links.join(", ")}` : ""}`;
}

function renderFindings(state: ProjectState, findings: DiscoveryFinding[], empty: string): string {
  return findings.length ? findings.map((finding) => renderFinding(state, finding)).join("\n") : empty;
}

function bullets(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

export function renderDiscovery(state: ProjectState): string {
  const decisions = Object.values(state.decisions)
    .filter((decision) => decision.status === "accepted")
    .sort((a, b) => a.decision_id.localeCompare(b.decision_id))
    .map((decision) => `- [[DECISIONS/${decision.decision_id}|${decision.title}]]`);

  return `${renderProjectFrontmatter(state, "DISCOVERY", "discovery")}${MANAGED_NOTICE}\n# Discovery — ${state.name}\n\n## Confirmed findings\n\n${renderFindings(state, state.discovery.confirmed_findings, "No confirmed findings have been synthesized yet.")}\n\n## Provisional findings\n\n${renderFindings(state, state.discovery.provisional_findings, "No provisional findings are currently recorded.")}\n\n## Unresolved questions\n\n${bullets(state.discovery.unresolved_questions, "No unresolved discovery questions are currently recorded.")}\n\n## Explore next\n\n${bullets(state.discovery.next_exploration, "No next discovery actions have been defined yet.")}\n\n## Decisions shaping direction\n\n${decisions.join("\n") || "No accepted decisions have been recorded yet."}\n`;
}
