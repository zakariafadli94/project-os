import { describe, expect, it } from "vitest";
import { validateProjectCreateAuthorizationWindow } from "../src/governance/project-create-authorization";

const issued = "2026-08-30T08:00:00.000Z";

describe("project-create authorization policy", () => {
  it("accepts a positive authorization window up to exactly 30 minutes", () => {
    expect(() => validateProjectCreateAuthorizationWindow(
      issued,
      "2026-08-30T08:30:00.000Z"
    )).not.toThrow();
  });

  it("rejects non-positive and longer-than-30-minute authorization windows", () => {
    expect(() => validateProjectCreateAuthorizationWindow(
      issued,
      issued
    )).toThrow(/after issued_at/i);
    expect(() => validateProjectCreateAuthorizationWindow(
      issued,
      "2026-08-30T08:30:00.001Z"
    )).toThrow(/30 minutes/i);
  });
});
