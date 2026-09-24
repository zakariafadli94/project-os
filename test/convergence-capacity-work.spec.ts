import { describe, expect, it } from "vitest";
import type { Obligation } from "../src/convergence/contract";
import { classifyCapacityWork } from "../src/convergence/capacity-work";

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: "a".repeat(64), layer: "human_handoff", from_revision: 0,
    target: { revision: 1, projection_version: 6 }, incident: 1,
    state: "pending", first_pending_at: "2026-09-24T10:00:00.000Z",
    next_attempt_at: null, failure_count: 0, last_attempt_number: 0,
    last_closed_attempt_number: 0, last_verified_at: null, code: null,
    lease_until: null, continuation: "resume", ...overrides
  };
}

describe("capacity work classification", () => {
  it("counts only executable obligations and ages only that queue", () => {
    const result = classifyCapacityWork([
      obligation({ id: "a".repeat(64), continuation: "resume" }),
      obligation({ id: "b".repeat(64), state: "verified", continuation: "resume" }),
      obligation({ id: "c".repeat(64), continuation: null }),
      obligation({ id: "d".repeat(64), state: "exhausted", continuation: null, first_pending_at: "2020-01-01T00:00:00.000Z" })
    ], Date.parse("2026-09-24T10:01:00.000Z"));

    expect(result).toMatchObject({
      executable: [
        expect.objectContaining({ id: "a".repeat(64) }),
        expect.objectContaining({ id: "c".repeat(64) })
      ],
      terminal: [expect.objectContaining({ id: "d".repeat(64) })],
      oldest_pending_seconds: 60
    });
  });

  it("does not charge a running record whose cursor is explicitly empty", () => {
    const result = classifyCapacityWork([
      obligation({ state: "running", continuation: "", first_pending_at: "2020-01-01T00:00:00.000Z" })
    ], Date.now());
    expect(result).toMatchObject({ executable: [], oldest_pending_seconds: 0 });
  });

  it("marks terminal work repair-required without inventing a retry delay", () => {
    const result = classifyCapacityWork([
      obligation({ state: "blocked", continuation: null, next_attempt_at: null, code: "directory_target_conflict" })
    ], Date.now());
    expect(result).toMatchObject({
      executable: [],
      terminal: [expect.objectContaining({ state: "blocked" })],
      oldest_pending_seconds: 0
    });
  });
});
