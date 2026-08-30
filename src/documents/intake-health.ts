import { isIntakeStale, type IntakeHealthRecord, type IntakeRecord } from "../domain/intake";

export interface IntakeHealthActivity {
  last_reconcile_at?: string | null;
  last_direct_sweep_at?: string | null;
}

export function shouldAutomaticallyRetryIntake(record: IntakeRecord): boolean {
  if (record.state === "ingested" || record.state === "duplicate") return false;
  if (record.state === "failed") return record.retryable === true;
  return true;
}

export function computeIntakeHealth(
  projectId: string,
  records: readonly IntakeRecord[],
  now: string,
  activity: IntakeHealthActivity = {}
): IntakeHealthRecord {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Intake health requires a valid current timestamp");

  for (const record of records) {
    if (record.project_id !== projectId) {
      throw new Error(`Intake health project binding mismatch: expected ${projectId}, got ${record.project_id}`);
    }
  }

  const pending = records.filter((record) => record.state !== "ingested" && record.state !== "duplicate");
  const pendingAges = pending.map((record) => {
    const firstSeenMs = Date.parse(record.first_seen_at);
    if (!Number.isFinite(firstSeenMs) || nowMs < firstSeenMs) {
      throw new Error(`Invalid intake first_seen_at for health: ${record.intake_id}`);
    }
    return nowMs - firstSeenMs;
  });

  const successful = records
    .filter((record) => record.state === "ingested" || record.state === "duplicate")
    .map((record) => record.last_attempt_at ?? record.first_seen_at)
    .sort((left, right) => Date.parse(right) - Date.parse(left));

  const failed = records
    .filter((record) => record.state === "failed" && record.last_error)
    .sort((left, right) => activityTimestamp(right) - activityTimestamp(left));

  return {
    schema_version: "1.0",
    project_id: projectId,
    pending_count: pending.length,
    oldest_pending_age_ms: pendingAges.length > 0 ? Math.max(...pendingAges) : null,
    stale_count: pending.filter((record) => isIntakeStale(record.first_seen_at, now)).length,
    failed_retryable_count: pending.filter((record) => record.state === "failed" && record.retryable === true).length,
    failed_non_retryable_count: pending.filter((record) => record.state === "failed" && record.retryable === false).length,
    last_successful_intake_at: successful[0] ?? null,
    last_reconcile_at: activity.last_reconcile_at ?? null,
    last_direct_sweep_at: activity.last_direct_sweep_at ?? null,
    last_error_summary: failed[0]?.last_error ?? null
  };
}

function activityTimestamp(record: IntakeRecord): number {
  const value = Date.parse(record.last_attempt_at ?? record.first_seen_at);
  return Number.isFinite(value) ? value : 0;
}
