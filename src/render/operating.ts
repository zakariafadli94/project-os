import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { MANAGED_NOTICE } from "./shared";

export const OPERATING_CONTRACT_VERSION = 3 as const;

export function renderOperating(state: ProjectState): string {
  const frontmatter = renderProjectFrontmatter(state, "OPERATING", "operating-contract")
    .replace("\n---\n", `\noperating_contract_version: ${OPERATING_CONTRACT_VERSION}\n---\n`);

  return `${frontmatter}${MANAGED_NOTICE}
# Operating Contract — ${state.name}

This generated contract defines the current Project OS working routes for humans and chats. Refresh HANDOFF.md and STATE.md before significant project work, then follow this contract.

## Artifact persistence preflight

- Before generating binary artifacts, more than 10 files, work expected to take more than 15 minutes before the first durable output, or any package whose delivery depends on a governed gate, prove the complete persistence route in the current chat with a representative canary.
- The canary must exercise the same payload class and governed destination as the planned work. A successful text canary does not prove binary persistence.
- Evidence must advance through \`LOCAL_GENERATED → STAGED → SUBMITTED → COMMITTED → CANONICAL_VERIFIED → ACCEPTED\`; local creation or staging alone is not delivery.
- Do not begin bulk generation while the required canary is unavailable, rejected, unverified, or incomplete. Report the exact blocked capability and preserve any existing local output.
- Never write directly to a governed final zone to bypass the preflight, ProjectGuard, MutationGate, or the receipt gate.

## Canonical business state

- Accepted decisions, constraints, tasks, plan/lifecycle changes and accepted research are durable only through typed Project OS transactions.
- A durable mutation is not considered persisted until its receipt has \`status: committed\`.
- Generated projections such as STATE.md, HANDOFF.md, ROADMAP.md, TASKS/, DECISIONS/, CONSTRAINTS/ and RESEARCH/ are views of canonical state and must not be directly edited to create canonical truth.
- MutationGate and Project Guard remain authoritative for governed writes and concurrency.

## Project-session isolation and cross-project routing

- A PROJECT_SESSION must not change its primary project unless the user explicitly asks to switch.
- Mentioning another project does not authorize rebinding.
- Ambiguous acknowledgements such as \`go ahead\`, \`ok\`, \`do it\`, or \`continue\` never authorize rebinding.
- French equivalents such as \`vas-y\`, \`fais-le\`, \`ok\`, or \`continue\` also never authorize rebinding.
- When the user asks to deposit, send, route, or pass information to another project, route the information to the target project's \`INPUTS/\` without changing the current session binding.
- Do not load the target project's HANDOFF.md or STATE.md merely to deliver the referral. Resolve only the target identity/path needed for delivery.
- A routed input is evidence/request material, not automatically accepted canonical truth in the target project.
- A referral should preserve enough provenance to understand its source, target, type, title/body, timestamp, and source evidence when relevant. It does not automatically create a task, decision, research record, or deliverable in the target project.

## Sources and references

- New files supplied for analysis, R&D or evidence enter through \`INPUTS/\`.
- Intake reconciliation snapshots evidence and routes it to \`REFERENCES/UNCLASSIFIED/\` before optional explicit classification under \`REFERENCES/\`.
- Existing reference content keeps its governed identity; bootstrap does not bulk-move historical files.

## Collaborative documents

- Drafts and active collaborative work live in \`WORKING/\`.
- Before editing a managed document, refresh its logical head/current version.
- Explicit review candidates live in \`REVIEW/\`.
- Approved or published outputs live in \`DELIVERABLES/\` only through governed publication; direct final-zone edits are not implicit publication.

## Routing summary

- Cross-project referral → target INPUTS/ while current PROJECT_SESSION remains bound
- Sources → INPUTS/ → REFERENCES/UNCLASSIFIED/ → REFERENCES/
- Drafts → WORKING/ → REVIEW/
- Published → DELIVERABLES/
- Business facts → typed transactions → committed receipt → regenerated projections
`;
}
