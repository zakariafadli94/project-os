import type { SliceBudget } from "./contract";
import type { ProviderRequestScope } from "../persistence/provider/contract";

const MAX_PROVIDER_CALLS = 32;
const SLICE_DURATION_MS = 10_000;
const CHECKPOINT_CALL_RESERVE = 4;
// Stop starting multi-call effects early, allow an already-started Dropbox
// operation to settle, then retain a separate window for durable checkpoints.
const EFFECT_START_TIME_RESERVE_MS = 6_000;
const CHECKPOINT_TIME_RESERVE_MS = 6_000;

export function createSliceBudget(now: () => number, signal: AbortSignal): SliceBudget {
  const budget: SliceBudget = {
    deadline_ms: now() + SLICE_DURATION_MS,
    calls_left: MAX_PROVIDER_CALLS,
    now,
    signal,
    beforeHttp() {
      if (signal.aborted || now() >= budget.deadline_ms || budget.calls_left <= 0) {
        throw new Error("slice_budget_exhausted");
      }
      budget.calls_left -= 1;
    },
    canStartEffect(requiredCalls) {
      if (!Number.isSafeInteger(requiredCalls) || requiredCalls < 1) return false;
      return !signal.aborted
        && budget.calls_left >= requiredCalls + CHECKPOINT_CALL_RESERVE
        && now() < budget.deadline_ms - EFFECT_START_TIME_RESERVE_MS;
    }
  };
  return budget;
}

export function providerRequestScopeFor(budget: SliceBudget): ProviderRequestScope {
  return {
    deadlineMs: budget.deadline_ms - CHECKPOINT_TIME_RESERVE_MS,
    signal: budget.signal,
    now: budget.now,
    beforeHttp: () => budget.beforeHttp()
  };
}

/**
 * Checkpoint writes use the final reserved window of the slice. Provider work
 * is aborted before this boundary so an unexpectedly slow Dropbox request
 * cannot consume the only window in which durable progress can be saved.
 */
export function providerCheckpointScopeFor(budget: SliceBudget): ProviderRequestScope {
  return {
    deadlineMs: budget.deadline_ms,
    signal: budget.signal,
    now: budget.now,
    beforeHttp: () => budget.beforeHttp()
  };
}
