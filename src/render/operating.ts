import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export const OPERATING_CONTRACT_VERSION = 1 as const;

export function renderOperating(state: ProjectState): string {
  const frontmatter = renderProjectFrontmatter(state, "OPERATING", "operating-contract")
    .replace("\n---\n", `\noperating_contract_version: ${OPERATING_CONTRACT_VERSION}\n---\n`);

  return `${frontmatter}${MANAGED_NOTICE}\n# Operating Contract — ${state.name}\n\nThis generated contract defines the current Project OS working routes for humans and chats. Refresh HANDOFF.md and STATE.md before significant project work, then follow this contract.\n\n## Canonical business state\n\n- Accepted decisions, constraints, tasks, plan/lifecycle changes and accepted research are durable only through typed Project OS transactions.\n- A durable mutation is not considered persisted until its receipt has \`status: committed\`.\n- Generated projections such as STATE.md, HANDOFF.md, ROADMAP.md, TASKS/, DECISIONS/, CONSTRAINTS/ and RESEARCH/ are views of canonical state and must not be directly edited to create canonical truth.\n- MutationGate and Project Guard remain authoritative for governed writes and concurrency.\n\n## Sources and references\n\n- New files supplied for analysis, R&D or evidence enter through \`INPUTS/\`.\n- Intake reconciliation snapshots evidence and routes it to \`REFERENCES/UNCLASSIFIED/\` before optional explicit classification under \`REFERENCES/\`.\n- Existing reference content keeps its governed identity; bootstrap does not bulk-move historical files.\n\n## Collaborative documents\n\n- Drafts and active collaborative work live in \`WORKING/\`.\n- Before editing a managed document, refresh its logical head/current version.\n- Explicit review candidates live in \`REVIEW/\`.\n- Approved or published outputs live in \`DELIVERABLES/\` only through governed publication; direct final-zone edits are not implicit publication.\n\n## Routing summary\n\n- Sources → INPUTS/ → REFERENCES/UNCLASSIFIED/ → REFERENCES/\n- Drafts → WORKING/ → REVIEW/\n- Published → DELIVERABLES/\n- Business facts → typed transactions → committed receipt → regenerated projections\n`;
}
