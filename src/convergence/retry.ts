import { sha256Canonical } from "../materialization/hash";

export async function deterministicRetryJitter(obligationId: string, attemptNumber: number): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(obligationId) || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("invalid_retry_jitter_input");
  }
  const hash = await sha256Canonical({ obligation_id: obligationId, attempt_number: attemptNumber });
  return (Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff) * 0.2;
}

export function nextRetryAt(input: {
  nowMs: number;
  failureCount: number;
  jitter: number;
  retryAfterMs: number;
}): { state: "retry_wait" | "exhausted"; at: string } {
  if (
    !Number.isInteger(input.failureCount)
    || input.failureCount < 1
    || !Number.isFinite(input.nowMs)
    || !Number.isFinite(input.retryAfterMs)
    || input.retryAfterMs < 0
    || input.jitter < 0
    || input.jitter > 0.2
  ) throw new Error("invalid_retry_input");
  const exhausted = input.failureCount >= 6;
  const base = exhausted ? 300_000 : 1_000 * 2 ** input.failureCount;
  const delay = Math.max(input.retryAfterMs, exhausted ? base : Math.ceil(base * (1 + input.jitter)));
  return {
    state: exhausted ? "exhausted" : "retry_wait",
    at: new Date(input.nowMs + delay).toISOString()
  };
}

export function minimumWake(times: readonly (string | null)[]): string | null {
  const valid = times
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return valid.length === 0 ? null : new Date(Math.min(...valid)).toISOString();
}
