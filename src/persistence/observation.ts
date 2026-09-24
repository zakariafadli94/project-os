import { sha256Canonical } from "../materialization/hash";

export type RequestKind = "transaction" | "document" | "artifact";
export interface PersistenceObservation {
  project_id: string;
  kind: RequestKind;
  request_id: string;
  status: "not_submitted" | "unknown" | "not_received" | "admitted_uncommitted" | "committed" | "finalizing" | "finalized" | "rejected" | "conflict" | "failed";
  observed_at: string;
  receipt: unknown | null;
  receipt_status: "committed" | "rejected" | "conflict" | null;
  execution_status: string | null;
  terminal: boolean;
  code: string | null;
  correlation_id: string;
  recovery: {
    durable_intent: boolean | null;
    state: "none" | "scheduled" | "running" | "blocked" | "complete";
    next_attempt_at: string | null;
    action: "check_status" | "retry_same_request" | "resume_execution" | "wait_for_dependency" | "resolve_conflict" | "none";
    owner: "client" | "system" | "operator" | "founder" | "none";
    requires_new_approval: boolean;
  };
}

/** Evidence must have its project/request bindings checked by the family owner.
 * This pure presentation layer never performs I/O or creates authority. */
export interface ObservationEvidence {
  project_id: string; kind: RequestKind; request_id: string;
  observed_at: string; correlation_id: string;
  receipt?: unknown;
  execution?: { status: string; terminal?: boolean; finalization_ref?: string | null } | null;
  durable_intent?: boolean | null;
  absence_verified?: boolean;
  not_submitted?: boolean;
  next_attempt_at?: string | null;
  running?: boolean;
  blocked?: boolean;
  code?: string | null;
}

export function requestDigest(request: unknown): Promise<string> {
  return sha256Canonical(request);
}

export function persistenceObservation(input: ObservationEvidence): PersistenceObservation {
  const raw = input.receipt && typeof input.receipt === "object"
    ? (input.receipt as { status?: unknown }).status : null;
  const receiptStatus = raw === "committed" || raw === "rejected" || raw === "conflict" ? raw : null;
  const finalized = receiptStatus === "committed" && input.execution?.status === "finalized"
    && input.execution.terminal === true && Boolean(input.execution.finalization_ref);
  let status: PersistenceObservation["status"] = "unknown";
  if (finalized) status = "finalized";
  else if (receiptStatus === "committed") status = input.execution?.status === "finalizing" ? "finalizing" : "committed";
  else if (receiptStatus === "rejected" || receiptStatus === "conflict") status = receiptStatus;
  else if (input.durable_intent === true) status = "admitted_uncommitted";
  else if (input.not_submitted) status = "not_submitted";
  else if (input.absence_verified) status = "not_received";
  const terminal = finalized || status === "rejected" || status === "conflict";
  const next = terminal || input.blocked ? null : input.next_attempt_at ?? null;
  const recovery: PersistenceObservation["recovery"] = {
    durable_intent: input.not_submitted && !receiptStatus ? false : input.durable_intent ?? null,
    state: terminal ? "complete" : input.blocked ? "blocked" : input.running ? "running" : next ? "scheduled" : "none",
    next_attempt_at: next,
    action: status === "conflict" ? "resolve_conflict" : terminal ? "none" : input.blocked ? "wait_for_dependency"
      : input.running || next ? "resume_execution" : status === "not_submitted" || status === "not_received" ? "retry_same_request" : "check_status",
    owner: status === "conflict" || input.blocked ? "operator" : terminal ? "none" : input.running || next ? "system" : "client",
    requires_new_approval: false
  };
  return {
    project_id: input.project_id, kind: input.kind, request_id: input.request_id,
    status, observed_at: input.observed_at, receipt: input.receipt ?? null,
    receipt_status: receiptStatus, execution_status: input.execution?.status ?? null,
    terminal, code: input.code ?? null, correlation_id: input.correlation_id, recovery
  };
}
