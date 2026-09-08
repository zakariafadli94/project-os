import { describe, expect, it } from "vitest";
import { LAYERS } from "../src/convergence/contract";
import { isConverged, publicState, unknownHealth } from "../src/convergence/health";

describe("convergence health", () => {
  it("does not close an incident when only machine layers are current", () => {
    const health = unknownHealth("PRJ-9258", "2026-09-08T00:10:40.000Z");
    for (const layer of LAYERS) {
      health.layers[layer].expected.revision = 258;
      health.layers[layer].observed.revision = 257;
    }
    for (const layer of ["canonical", "event", "state", "manifest", "receipt"] as const) {
      Object.assign(health.layers[layer], { state: "current", observation_complete: true });
      health.layers[layer].observed.revision = 258;
      health.layers[layer].last_verified_at = "2026-09-08T00:10:40.000Z";
    }

    expect(isConverged(health)).toBe(false);
    expect(publicState("running")).toBe("pending");
    expect(health.layers.human_handoff.state).toBe("unknown");
  });
});
