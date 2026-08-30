import { describe, expect, it } from "vitest";
import {
  intakeIdFor,
  isIntakeStale,
  parseIntakeState
} from "../src/domain/intake";

const firstSeen = "2026-08-30T07:00:00Z";

describe("intake domain", () => {
  it("derives one deterministic intake id per bound provider revision", async () => {
    const first = await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-7");
    expect(first).toMatch(/^INTAKE-[A-F0-9]{24}$/);
    expect(await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-7")).toBe(first);
    expect(await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-8")).not.toBe(first);
    expect(await intakeIdFor("PRJ-0003", "dropbox", "id:abc", "rev-7")).not.toBe(first);
  });

  it("accepts exactly the intake state machine values", () => {
    for (const state of ["observed", "processing", "ingested", "duplicate", "failed"] as const) {
      expect(parseIntakeState(state)).toBe(state);
    }
    expect(() => parseIntakeState("stale")).toThrow();
  });

  it("marks an intake stale exactly at fifteen minutes", () => {
    expect(isIntakeStale(firstSeen, "2026-08-30T07:14:59Z")).toBe(false);
    expect(isIntakeStale(firstSeen, "2026-08-30T07:15:00Z")).toBe(true);
  });
});
