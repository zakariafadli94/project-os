export const CONTINUITY_CONTRACT_VERSION = "1.0" as const;

export type ContinuityMode = "stable" | "automatic" | "rollback";
export type ContinuityPath = "stable" | "candidate";

export interface ContinuityStatus {
  contract_version: typeof CONTINUITY_CONTRACT_VERSION;
  mode: ContinuityMode;
  effective_path: ContinuityPath;
  candidate_available: boolean;
  ready_for_candidate: boolean;
  blockers: string[];
  user_workflow_change_required: false;
}

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
