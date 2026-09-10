export type ProjectConvergenceMode = "off" | "observe" | "repair";
export type AdmissionMode = "observe" | "strict";
export type HumanAlertPolicy = "required" | "deferred";

export interface RolloutEvidence {
  reader_compatible: boolean;
  single_writer: boolean;
  fencing_proven: boolean;
  registry_continuation_proven: boolean;
  notification_ack_proven: boolean;
  transport_complete: boolean;
  capacity_qualified: boolean;
  recovery_qualified: boolean;
  compatible_stable_ready: boolean;
}

export interface CapacityObservation {
  queued_outputs: number;
  oldest_pending_seconds: number;
  continuation_available: boolean;
  within_qualified_envelope: boolean;
}

export class ConvergenceAdmissionError extends Error {
  readonly status = 503;
  constructor(readonly code: "convergence_capacity_exceeded") {
    super(code);
  }
}

/** Deferred delivery is an explicit review policy, never an implicit default. */
export function rolloutBlockers(
  evidence: RolloutEvidence,
  humanAlertPolicy: HumanAlertPolicy = "required"
): string[] {
  return Object.entries(evidence)
    .filter(([name, proven]) => !proven && !(humanAlertPolicy === "deferred" && name === "notification_ack_proven"))
    .map(([name]) => name)
    .sort();
}

/** Parses a scoped rollout map without permitting undeclared projects. */
export function parseProjectModes<T extends string>(
  raw: string | undefined,
  projectIds: readonly string[],
  allowed: readonly T[],
  fallback: T
): Record<string, T> {
  const known = new Set(projectIds);
  const result = Object.fromEntries(projectIds.map((projectId) => [projectId, fallback])) as Record<string, T>;
  if (raw === undefined || raw === "") return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_project_mode");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_project_mode");
  for (const [projectId, mode] of Object.entries(parsed)) {
    if (!known.has(projectId) || typeof mode !== "string" || !allowed.includes(mode as T)) {
      throw new Error("invalid_project_mode");
    }
    result[projectId] = mode as T;
  }
  return result;
}

export function convergenceModeForProject(raw: string | undefined, projectId: string): ProjectConvergenceMode {
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("invalid_project_mode");
  if (raw === undefined || raw === "") return "off";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_project_mode");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_project_mode");
  for (const [configuredProjectId, mode] of Object.entries(parsed)) {
    if (!/^PRJ-[0-9]{4,}$/.test(configuredProjectId) || !["off", "observe", "repair"].includes(mode as string)) {
      throw new Error("invalid_project_mode");
    }
  }
  const configured = (parsed as Record<string, unknown>)[projectId];
  return configured === undefined ? "off" : configured as ProjectConvergenceMode;
}

export function admissionModeForProject(raw: string | undefined, projectId: string): AdmissionMode {
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("invalid_project_mode");
  if (raw === undefined || raw === "") return "observe";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_project_mode");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_project_mode");
  for (const [configuredProjectId, mode] of Object.entries(parsed)) {
    if (!/^PRJ-[0-9]{4,}$/.test(configuredProjectId) || !["observe", "strict"].includes(mode as string)) {
      throw new Error("invalid_project_mode");
    }
  }
  const configured = (parsed as Record<string, unknown>)[projectId];
  return configured === undefined ? "observe" : configured as AdmissionMode;
}

/** Admission is protected; durable repair work itself is never rejected here. */
export function assertCapacity(value: CapacityObservation): void {
  if (!value.continuation_available || !value.within_qualified_envelope) {
    throw new ConvergenceAdmissionError("convergence_capacity_exceeded");
  }
}
