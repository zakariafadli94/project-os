export const CONTINUITY_CONTRACT_VERSION = "1.0" as const;

export type ContinuityMode = "stable" | "automatic" | "rollback";
export type ContinuityPath = "stable" | "candidate";

export interface ContinuityProofs {
  user_workflow_unchanged: boolean;
  zero_downtime: boolean;
  project_isolation_proven: boolean;
  canonical_compatibility_proven: boolean;
  old_new_chat_compatibility_proven: boolean;
  stable_path_retained: boolean;
  rollback_proven: boolean;
  history_preserved: boolean;
  production_proof_complete: boolean;
}

export interface ContinuityEvaluationInput {
  mode: ContinuityMode;
  candidate_available: boolean;
  proofs: ContinuityProofs;
}

export interface ContinuityStatus {
  contract_version: typeof CONTINUITY_CONTRACT_VERSION;
  mode: ContinuityMode;
  effective_path: ContinuityPath;
  candidate_available: boolean;
  ready_for_candidate: boolean;
  blockers: string[];
  user_workflow_change_required: false;
}

const PROOF_REQUIREMENTS: ReadonlyArray<[keyof ContinuityProofs, string]> = [
  ["user_workflow_unchanged", "USER_WORKFLOW_CHANGE_REQUIRED"],
  ["zero_downtime", "ZERO_DOWNTIME_NOT_PROVEN"],
  ["project_isolation_proven", "PROJECT_ISOLATION_NOT_PROVEN"],
  ["canonical_compatibility_proven", "CANONICAL_COMPATIBILITY_NOT_PROVEN"],
  ["old_new_chat_compatibility_proven", "CHAT_COMPATIBILITY_NOT_PROVEN"],
  ["stable_path_retained", "STABLE_PATH_NOT_RETAINED"],
  ["rollback_proven", "ROLLBACK_NOT_PROVEN"],
  ["history_preserved", "HISTORY_PRESERVATION_NOT_PROVEN"],
  ["production_proof_complete", "PRODUCTION_PROOF_INCOMPLETE"]
];

export function parseContinuityMode(value?: string): ContinuityMode {
  if (value === undefined || value === "") return "stable";
  if (value === "stable" || value === "automatic" || value === "rollback") return value;
  return "stable";
}

export function continuityStatus(value?: string): ContinuityStatus {
  return {
    contract_version: CONTINUITY_CONTRACT_VERSION,
    mode: parseContinuityMode(value),
    effective_path: "stable",
    candidate_available: false,
    ready_for_candidate: false,
    blockers: ["CANDIDATE_NOT_AVAILABLE"],
    user_workflow_change_required: false
  };
}

export function evaluateContinuity(input: ContinuityEvaluationInput): ContinuityStatus {
  const blockers: string[] = [];
  if (!input.candidate_available) blockers.push("CANDIDATE_NOT_AVAILABLE");
  for (const [proof, code] of PROOF_REQUIREMENTS) {
    if (input.proofs[proof] !== true) blockers.push(code);
  }

  const readyForCandidate = input.candidate_available && blockers.length === 0;
  const effectivePath: ContinuityPath = input.mode === "automatic" && readyForCandidate
    ? "candidate"
    : "stable";

  return {
    contract_version: CONTINUITY_CONTRACT_VERSION,
    mode: input.mode,
    effective_path: effectivePath,
    candidate_available: input.candidate_available,
    ready_for_candidate: readyForCandidate,
    blockers,
    user_workflow_change_required: false
  };
}
