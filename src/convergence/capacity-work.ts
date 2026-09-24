import type { Obligation } from "./contract";

export interface CapacityWork {
  executable: Obligation[];
  terminal: Obligation[];
  oldest_pending_seconds: number;
}

/** Workload evidence for admission excludes records that cannot be resumed. */
export function classifyCapacityWork(obligations: readonly Obligation[], nowMs: number): CapacityWork {
  const executable = obligations.filter((obligation) => obligation.state !== "verified"
    && obligation.state !== "blocked"
    && obligation.state !== "exhausted"
    && obligation.continuation !== ""
    && (obligation.continuation !== null
      || obligation.state === "pending"
      || (obligation.state === "retry_wait" && obligation.next_attempt_at !== null)));
  const terminal = obligations.filter((obligation) => (obligation.state === "blocked"
    || obligation.state === "exhausted")
    && obligation.next_attempt_at === null);
  const pendingTimes = executable
    .map((obligation) => Date.parse(obligation.first_pending_at))
    .filter(Number.isFinite);
  const oldest = pendingTimes.length === 0 ? 0 : Math.max(0, nowMs - Math.min(...pendingTimes));
  return {
    executable,
    terminal,
    oldest_pending_seconds: oldest / 1_000
  };
}
