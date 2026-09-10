import { describe, expect, it } from "vitest";
import { assertCapacity } from "../src/convergence/rollout";
import { qualifyVirtualCapacity, toCapacityObservation } from "../src/convergence/capacity";

const qualifiedEnvelope = {
  duration_minutes: 24 * 60,
  project_count: 10,
  commits_per_minute_per_project: 5,
  outputs_per_project: 200,
  changed_outputs_per_commit: 20,
  bytes_per_commit: 1024 * 1024,
  fleet_concurrency: 4,
  provider_call_latency_ms: 5
} as const;

describe("virtual convergence capacity qualification", () => {
  it("keeps the 24-hour qualified envelope within the bounded slice and SLO limits at provider concurrency 1 and 4", () => {
    const serial = qualifyVirtualCapacity({ ...qualifiedEnvelope, provider_concurrency: 1 });
    const parallel = qualifyVirtualCapacity({ ...qualifiedEnvelope, provider_concurrency: 4 });

    for (const report of [serial, parallel]) {
      expect(report.commits_simulated).toBe(72_000);
      expect(report.max_provider_calls_per_slice).toBeLessThanOrEqual(32);
      expect(report.continuation_available).toBe(true);
      expect(report.p99_machine_ms).toBeLessThanOrEqual(120_000);
      expect(report.p999_human_ms).toBeLessThanOrEqual(600_000);
      expect(report.fleet_visit_ms).toBeLessThanOrEqual(300_000);
      expect(report.within_qualified_envelope).toBe(true);
    }
    expect(parallel.p99_machine_ms).toBeLessThan(serial.p99_machine_ms);
  });

  it("turns a load beyond the envelope into explicit admission backpressure while preserving continuations", () => {
    const report = qualifyVirtualCapacity({
      ...qualifiedEnvelope,
      provider_concurrency: 1,
      commits_per_minute_per_project: 6
    });

    expect(report.continuation_available).toBe(true);
    expect(report.within_qualified_envelope).toBe(false);
    expect(() => assertCapacity(toCapacityObservation(report))).toThrow(
      expect.objectContaining({ code: "convergence_capacity_exceeded", status: 503 })
    );
  });
});
