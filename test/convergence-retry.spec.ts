import { describe, expect, it } from "vitest";
import { deterministicRetryJitter, minimumWake, nextRetryAt } from "../src/convergence/retry";

describe("convergence retry schedule", () => {
  it("exhausts six failures without restarting the burst", () => {
    for (const [failureCount, delay] of [[1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, 32000], [6, 300000]]) {
      const next = nextRetryAt({ nowMs: 0, failureCount, jitter: 0, retryAfterMs: 0 });
      expect(Date.parse(next.at)).toBe(delay);
      expect(next.state).toBe(failureCount < 6 ? "retry_wait" : "exhausted");
    }
    expect(Date.parse(nextRetryAt({ nowMs: 0, failureCount: 2, jitter: 0.2, retryAfterMs: 60000 }).at)).toBe(60000);
  });

  it("keeps the earliest durable wakeup", () => {
    expect(minimumWake(["2026-09-08T00:00:04.000Z", null, "2026-09-08T00:00:02.000Z"])).toBe(
      "2026-09-08T00:00:02.000Z"
    );
  });

  it("derives retry jitter deterministically from the obligation and attempt", async () => {
    const first = await deterministicRetryJitter("a".repeat(64), 3);
    const repeated = await deterministicRetryJitter("a".repeat(64), 3);
    const laterAttempt = await deterministicRetryJitter("a".repeat(64), 4);

    expect(first).toBe(repeated);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0.2);
    expect(laterAttempt).not.toBe(first);
  });
});
