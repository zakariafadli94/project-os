import type { ProjectState } from "../domain/project-state";
import { renderProjectFrontmatter } from "./frontmatter";
import { OPERATING_CONTRACT_VERSION } from "./operating";
import { MANAGED_NOTICE } from "./shared";

interface HandoffSections {
  currentPhase: ProjectState["plan_phases"][string] | undefined;
  activeTasks: string;
  blockers: string;
  decisions: string;
  next: string;
}

function sections(state: ProjectState): HandoffSections {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] : undefined;
  const activeTasks = Object.values(state.tasks)
    .filter((task) => task.status === "active" || task.status === "pending")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .slice(0, 10)
    .map((task) => `- ${task.task_id} — ${task.title} (${task.status})`)
    .join("\n") || "- None";
  const blockers = Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- ${task.task_id} — ${task.title}: ${task.blocked_reason ?? "Blocked"}`)
    .join("\n") || "- None";
  const decisions = Object.values(state.decisions)
    .filter((decision) => decision.status === "accepted")
    .sort((a, b) => b.decision_id.localeCompare(a.decision_id))
    .slice(0, 8)
    .map((decision) => `- [[DECISIONS/${decision.decision_id}|${decision.title}]]`)
    .join("\n") || "- None";
  const next = currentPhase?.next_actions?.length
    ? currentPhase.next_actions.map((action) => `- ${action}`).join("\n")
    : activeTasks;
  return { currentPhase, activeTasks, blockers, decisions, next };
}

export function renderLegacyHandoff(state: ProjectState): string {
  const { currentPhase, activeTasks, blockers, decisions, next } = sections(state);
  return `${renderProjectFrontmatter(state, "HANDOFF", "handoff")}${MANAGED_NOTICE}\n# Handoff — ${state.name}\n\nProject ID: ${state.project_id}\nRevision: ${state.revision}\nStatus: ${state.status}\n\n## Objective\n\n${state.objective || "Not defined"}\n\n## Current phase\n\n${currentPhase ? `${currentPhase.phase_id} — ${currentPhase.title}` : "None"}\n\n## Current work\n\n${activeTasks}\n\n## Blockers\n\n${blockers}\n\n## Important accepted decisions\n\n${decisions}\n\n## Next work\n\n${next || "- None"}\n\n## Read deeper when needed\n\n- [[PROJECT|Project overview]]\n- [[STATE|Current state]]\n- [[PLAN|Plan]]\n- DECISIONS/\n- RESEARCH/\n`;
}

export function renderHandoff(state: ProjectState): string {
  const { currentPhase, activeTasks, blockers, decisions, next } = sections(state);
  return `${renderProjectFrontmatter(state, "HANDOFF", "handoff")}${MANAGED_NOTICE}\n# Handoff — ${state.name}\n\nProject ID: ${state.project_id}\nRevision: ${state.revision}\nStatus: ${state.status}\n\n## Operating contract\n\nOperating contract version: ${OPERATING_CONTRACT_VERSION}\n\n- [[OPERATING|Current operating contract]]\n- Sources → INPUTS/ → REFERENCES/\n- Drafts → WORKING/ → REVIEW/\n- Published → DELIVERABLES/\n- Business facts → typed transactions → committed receipts\n\nRefresh this HANDOFF, STATE and the linked OPERATING contract before significant project work.\n\n## Objective\n\n${state.objective || "Not defined"}\n\n## Current phase\n\n${currentPhase ? `${currentPhase.phase_id} — ${currentPhase.title}` : "None"}\n\n## Current work\n\n${activeTasks}\n\n## Blockers\n\n${blockers}\n\n## Important accepted decisions\n\n${decisions}\n\n## Next work\n\n${next || "- None"}\n\n## Read deeper when needed\n\n- [[PROJECT|Project overview]]\n- [[STATE|Current state]]\n- [[PLAN|Plan]]\n- [[OPERATING|Current operating contract]]\n- DECISIONS/\n- RESEARCH/\n`;
}
