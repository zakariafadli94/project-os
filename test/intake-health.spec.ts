import { describe, expect, it } from "vitest";
import type { IntakeRecord } from "../src/domain/intake";
import { computeIntakeHealth, shouldAutomaticallyRetryIntake } from "../src/documents/intake-health";

const projectId = "PRJ-0002";
const seenAt = "2026-08-30T13:00:00.000Z";

function record(
  intakeId: string,
  state: IntakeRecord["state"],
  overrides: Partial<IntakeRecord> = {}
): IntakeRecord {
  return {
    schema_version: "1.0",
    intake_id: intakeId,
    project_id: projectId,
    provider_id: "dropbox",
    object_id: `id:${intakeId}`,
    revision_token: `rev:${intakeId}`,
    logical_input_path: `${intakeId}.md`,
    first_seen_at: seenAt,
    attempt_count: 0,
    state,
    ...overrides
  };
}

describe("intake health", () => {
  it("classifies stale exactly at the 15 minute boundary", () => {
    const pending = record("INTAKE-AAAAAAAAAAAAAAAAAAAAAAAA", "observed");

    expect(computeIntakeHealth(projectId, [pending], "2026-08-30T13:14:59.000Z")).toMatchObject({
      pending_count: 1,
      oldest_pending_age_ms: 899_000,
      stale_count: 0
    });
    expect(computeIntakeHealth(projectId, [pending], "2026-08-30T13:15:00.000Z")).toMatchObject({
      pending_count: 1,
      oldest_pending_age_ms: 900_000,
      stale_count: 1
    });
  });

  it("excludes terminal success from pending and reports the latest successful intake", () => {
    const ingested = record("INTAKE-BBBBBBBBBBBBBBBBBBBBBBBB", "ingested", {
      last_attempt_at: "2026-08-30T13:04:00.000Z",
      attempt_count: 1,
      document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      version_id: "VER-EXT-AAAAAAAAAAAAAAAAAAAAAAAA",
      reference_path: "UNCLASSIFIED/report.md"
    });
    const duplicate = record("INTAKE-CCCCCCCCCCCCCCCCCCCCCCCC", "duplicate", {
      first_seen_at: "2026-08-30T13:05:00.000Z",
      last_attempt_at: "2026-08-30T13:06:00.000Z",
      attempt_count: 1,
      document_id: "DOC-BBBBBBBBBBBBBBBBBBBBBBBB",
      version_id: "VER-EXT-BBBBBBBBBBBBBBBBBBBBBBBB",
      reference_path: "UNCLASSIFIED/duplicate.md"
    });

    expect(computeIntakeHealth(projectId, [ingested, duplicate], "2026-08-30T13:20:00.000Z")).toMatchObject({
      pending_count: 0,
      oldest_pending_age_ms: null,
      stale_count: 0,
      last_successful_intake_at: "2026-08-30T13:06:00.000Z"
    });
  });

  it("keeps retryable failures eligible while non-retryable failures remain operator-visible only", () => {
    const retryable = record("INTAKE-DDDDDDDDDDDDDDDDDDDDDDDD", "failed", {
      last_attempt_at: "2026-08-30T13:02:00.000Z",
      attempt_count: 2,
      retryable: true,
      last_error: "provider temporarily unavailable"
    });
    const terminal = record("INTAKE-EEEEEEEEEEEEEEEEEEEEEEEE", "failed", {
      first_seen_at: "2026-08-30T13:01:00.000Z",
      last_attempt_at: "2026-08-30T13:03:00.000Z",
      attempt_count: 1,
      retryable: false,
      last_error: "contradictory destination evidence"
    });

    expect(shouldAutomaticallyRetryIntake(retryable)).toBe(true);
    expect(shouldAutomaticallyRetryIntake(terminal)).toBe(false);
    expect(computeIntakeHealth(projectId, [retryable, terminal], "2026-08-30T13:20:00.000Z")).toMatchObject({
      pending_count: 2,
      stale_count: 2,
      failed_retryable_count: 1,
      failed_non_retryable_count: 1,
      last_error_summary: "contradictory destination evidence"
    });
  });

  it("carries operational reconcile and sweep timestamps without inventing business state", () => {
    expect(computeIntakeHealth(projectId, [], "2026-08-30T13:20:00.000Z", {
      last_reconcile_at: "2026-08-30T13:19:30.000Z",
      last_direct_sweep_at: "2026-08-30T13:19:35.000Z"
    })).toMatchObject({
      project_id: projectId,
      pending_count: 0,
      last_reconcile_at: "2026-08-30T13:19:30.000Z",
      last_direct_sweep_at: "2026-08-30T13:19:35.000Z"
    });
  });
});
