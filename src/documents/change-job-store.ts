import type { ProviderChangeEntry } from "../persistence/provider/contract";
import type { RuleResource } from "../rules/contract";
import { sha256Text } from "./hash";

export type ManagedDocumentDetectionSource = "baseline" | "incremental" | "cursor_reset";

export interface ManagedDocumentChangeJobInput {
  job_id: string;
  change: ProviderChangeEntry;
  detection_source: ManagedDocumentDetectionSource;
  priority: number;
}

export interface ManagedDocumentChangeJob extends ManagedDocumentChangeJobInput {
  ordinal: number;
  attempts: number;
  last_error: string | null;
}

export interface ManagedDocumentChangeQuarantine {
  job_id: string;
  path: string;
  code: string;
  attempts: number;
  quarantined_at: string;
}

export interface ManagedDocumentDriftFinding {
  finding_id: string;
  job_id: string;
  path: string;
  change_kind: "file" | "folder" | "deleted";
  status: "expected_reconciled" | "unexpected_conflict" | "obsolete";
  code: string;
  request_id: string | null;
  resource: RuleResource | null;
  observed_at: string;
  opened_at: string;
}

export interface ManagedDocumentDriftFindingInput {
  finding_id: string;
  job_id: string;
  path: string;
  change_kind: "file" | "folder" | "deleted";
  status: ManagedDocumentDriftFinding["status"];
  code: string;
  request_id?: string;
  resource?: RuleResource;
  observed_at: string;
}

export interface ScheduledDocumentVerification {
  due: boolean;
  last_verified_at: string | null;
  next_verification_at: string | null;
  late_since: string | null;
}

export interface ManagedDocumentJobEligibilityCounts {
  executable: number;
  future: number;
  stopped: number;
  earliest_eligible_at: number | null;
}

export interface ManagedDocumentContinuation {
  slice_ordinal: number;
  pending: boolean;
  scheduled: boolean;
  next_wake_at: number | null;
  documents_priority_next: boolean;
  feed_retry_at: number | null;
  last_outcome: Record<string, unknown> | null;
}

export interface ManagedDocumentFeedFailureCheckpoint {
  failure_fingerprint: string;
  progress_fingerprint: string;
  consecutive_failures: number;
  total_attempts: number;
  stopped: boolean;
}

export interface ManagedDocumentPreludeFailureCheckpoint {
  failure_fingerprint: string;
  progress_fingerprint: string;
  consecutive_failures: number;
  total_attempts: number;
  stopped: boolean;
}

export interface RegisterManagedDocumentChangePageInput {
  expected_cursor: string | null;
  next_cursor: string;
  reset_cursor?: boolean;
  jobs: readonly ManagedDocumentChangeJobInput[];
}

export interface RegisterManagedDocumentChangePageResult {
  inserted: number;
  cursor_advanced: boolean;
}

interface ControlRow {
  [key: string]: SqlStorageValue;
  cursor: string | null;
}

interface JobRow {
  [key: string]: SqlStorageValue;
  job_id: string;
  ordinal: number;
  change_json: string;
  detection_source: string;
  priority: number;
  attempts: number;
  last_error: string | null;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface DriftFindingRow {
  [key: string]: SqlStorageValue;
  finding_id: string;
  job_id: string;
  path: string;
  change_kind: string;
  status: string;
  code: string;
  request_id: string | null;
  resource_json: string | null;
  observed_at: string;
  opened_at: string;
}

interface ScheduledVerificationRow {
  [key: string]: SqlStorageValue;
  last_verified_at: string | null;
  next_verification_at: string | null;
  late_since: string | null;
}

interface SelectionControlRow {
  [key: string]: SqlStorageValue;
  cohort_max_ordinal: number | null;
  last_priority: number | null;
  last_ordinal: number | null;
}

interface JobFailureStateRow {
  [key: string]: SqlStorageValue;
  job_id: string;
  failure_fingerprint: string;
  progress_fingerprint: string;
  classification: string;
  consecutive_failures: number;
  next_attempt_at: number | null;
  stopped: number;
}

export type ManagedDocumentFailureClassification = "internal" | "unknown" | "provider_retryable" | "provider_blocked";
const NON_EXECUTABLE_RETRY_DEADLINE = Number.MAX_SAFE_INTEGER;

export interface ManagedDocumentFailureInput {
  failure_fingerprint: string;
  progress_fingerprint: string;
  classification: ManagedDocumentFailureClassification;
  now_ms: number;
  retry_after_ms?: number;
  finding_id?: string;
}

export interface ManagedDocumentFailureResult {
  consecutive_failures: number;
  attempts: number;
  stopped: boolean;
  next_attempt_at: number | null;
}

interface QuarantineRow extends Record<string, SqlStorageValue> {
  job_id: string;
  path: string;
  code: string;
  attempts: number;
  quarantined_at: string;
}

export function initializeManagedDocumentChangeJobSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS managed_document_change_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cursor TEXT
    );
    INSERT OR IGNORE INTO managed_document_change_control (singleton, cursor) VALUES (1, NULL);

    CREATE TABLE IF NOT EXISTS managed_document_change_jobs (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      change_json TEXT NOT NULL,
      detection_source TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_managed_document_change_jobs_pending
      ON managed_document_change_jobs(status, priority, ordinal);

    CREATE TABLE IF NOT EXISTS managed_document_change_selection_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cohort_max_ordinal INTEGER,
      last_priority INTEGER,
      last_ordinal INTEGER
    );
    INSERT OR IGNORE INTO managed_document_change_selection_control (
      singleton, cohort_max_ordinal, last_priority, last_ordinal
    ) VALUES (1, NULL, NULL, NULL);

    CREATE TABLE IF NOT EXISTS managed_document_change_continuation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      slice_ordinal INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
      scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1)),
      next_wake_at INTEGER,
      documents_priority_next INTEGER NOT NULL DEFAULT 0 CHECK (documents_priority_next IN (0, 1)),
      feed_retry_at INTEGER,
      last_outcome_json TEXT,
      feed_failure_state_json TEXT,
      prelude_failure_state_json TEXT
    );
    INSERT OR IGNORE INTO managed_document_change_continuation (singleton) VALUES (1);

    CREATE TABLE IF NOT EXISTS managed_document_change_job_failure_state (
      job_id TEXT PRIMARY KEY,
      failure_fingerprint TEXT NOT NULL,
      progress_fingerprint TEXT NOT NULL,
      classification TEXT NOT NULL CHECK (classification IN ('internal', 'unknown', 'provider_retryable', 'provider_blocked')),
      consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
      next_attempt_at INTEGER,
      stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_managed_document_change_job_failure_eligibility
      ON managed_document_change_job_failure_state(stopped, next_attempt_at);

    CREATE TABLE IF NOT EXISTS managed_document_change_quarantine (
      job_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      quarantined_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_document_drift_findings (
      finding_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      path TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('file', 'folder', 'deleted')),
      status TEXT NOT NULL CHECK (status IN ('expected_reconciled', 'unexpected_conflict', 'obsolete')),
      code TEXT NOT NULL,
      request_id TEXT,
      resource_json TEXT,
      observed_at TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_document_drift_findings_job
      ON managed_document_drift_findings(job_id);

    CREATE TABLE IF NOT EXISTS managed_document_drift_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_verified_at TEXT,
      next_verification_at TEXT,
      late_since TEXT
    );
    INSERT OR IGNORE INTO managed_document_drift_control (
      singleton, last_verified_at, next_verification_at, late_since
    ) VALUES (1, NULL, NULL, NULL);
  `);
  const continuationColumns = storage.sql.exec<{ [key: string]: SqlStorageValue; name: string }>(
    "PRAGMA table_info(managed_document_change_continuation)"
  ).toArray();
  if (!continuationColumns.some(column => column.name === "feed_failure_state_json")) {
    storage.sql.exec("ALTER TABLE managed_document_change_continuation ADD COLUMN feed_failure_state_json TEXT");
  }
  if (!continuationColumns.some(column => column.name === "prelude_failure_state_json")) {
    storage.sql.exec("ALTER TABLE managed_document_change_continuation ADD COLUMN prelude_failure_state_json TEXT");
  }
}

export class ManagedDocumentChangeJobStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  beginContinuationSlice(scheduled?: boolean, startedAt = Date.now()): ManagedDocumentContinuation {
    assertEpochMilliseconds(startedAt);
    const initialWake = startedAt + 1_000;
    assertEpochMilliseconds(initialWake);
    this.storage.sql.exec(`UPDATE managed_document_change_continuation
      SET slice_ordinal = slice_ordinal + 1, pending = 1, scheduled = COALESCE(?, scheduled),
          next_wake_at = CASE WHEN next_wake_at IS NULL OR next_wake_at > ? THEN ? ELSE next_wake_at END
      WHERE singleton = 1`,
      scheduled === undefined ? null : scheduled ? 1 : 0, initialWake, initialWake);
    return this.continuation();
  }

  continuation(): ManagedDocumentContinuation {
    const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; slice_ordinal: number; pending: number; scheduled: number; next_wake_at: number | null; documents_priority_next: number; feed_retry_at: number | null; last_outcome_json: string | null }>(
      "SELECT slice_ordinal, pending, scheduled, next_wake_at, documents_priority_next, feed_retry_at, last_outcome_json FROM managed_document_change_continuation WHERE singleton = 1"
    ).one();
    if (!Number.isSafeInteger(row.slice_ordinal) || row.slice_ordinal < 0
      || (row.pending !== 0 && row.pending !== 1)
      || (row.scheduled !== 0 && row.scheduled !== 1)
      || (row.documents_priority_next !== 0 && row.documents_priority_next !== 1)) throw new Error("Invalid managed document continuation");
    const timestamp = (value: number | null) => value === null ? null : safeEpoch(value);
    let lastOutcome: Record<string, unknown> | null = null;
    if (row.last_outcome_json !== null) {
      const parsed: unknown = JSON.parse(row.last_outcome_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid managed document continuation outcome");
      lastOutcome = parsed as Record<string, unknown>;
    }
    return { slice_ordinal: row.slice_ordinal, pending: row.pending === 1, scheduled: row.scheduled === 1,
      next_wake_at: timestamp(row.next_wake_at), documents_priority_next: row.documents_priority_next === 1,
      feed_retry_at: timestamp(row.feed_retry_at), last_outcome: lastOutcome };
  }

  finishContinuationSlice(input: {
    pending: boolean;
    next_wake_at: number | null;
    documents_priority_next: boolean;
    feed_retry_at: number | null;
    outcome: Record<string, unknown>;
  }): void {
    if (input.next_wake_at !== null) assertEpochMilliseconds(input.next_wake_at);
    if (input.feed_retry_at !== null) assertEpochMilliseconds(input.feed_retry_at);
    const json = JSON.stringify(input.outcome);
    if (json.length > 16_384) throw new Error("Managed document continuation outcome exceeds limit");
    this.storage.sql.exec(
      `UPDATE managed_document_change_continuation SET pending = ?, next_wake_at = ?, documents_priority_next = ?,
         feed_retry_at = ?, last_outcome_json = ? WHERE singleton = 1`,
      input.pending ? 1 : 0, input.next_wake_at, input.documents_priority_next ? 1 : 0,
      input.feed_retry_at, json
    );
  }

  async feedProgressFingerprint(semanticProgress: number): Promise<string> {
    if (!Number.isSafeInteger(semanticProgress) || semanticProgress < 0) throw new Error("Invalid managed document semantic progress");
    const counts = this.storage.sql.exec<{ [key: string]: SqlStorageValue; pending: number; completed: number; max_ordinal: number }>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(MAX(ordinal), 0) AS max_ordinal
       FROM managed_document_change_jobs`
    ).one();
    return sha256Text(JSON.stringify({ pending: counts.pending, completed: counts.completed, max_ordinal: counts.max_ordinal }));
  }

  feedFailureCheckpoint(): ManagedDocumentFeedFailureCheckpoint | null {
    const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; feed_failure_state_json: string | null }>(
      "SELECT feed_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
    ).one();
    if (row.feed_failure_state_json === null) return null;
    const parsed: unknown = JSON.parse(row.feed_failure_state_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid managed document feed failure checkpoint");
    const value = parsed as Record<string, unknown>;
    if (typeof value.failure_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.failure_fingerprint)
      || typeof value.progress_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.progress_fingerprint)
      || !Number.isSafeInteger(value.consecutive_failures) || (value.consecutive_failures as number) < 0 || (value.consecutive_failures as number) > 6
      || !Number.isSafeInteger(value.total_attempts) || (value.total_attempts as number) < 0
      || typeof value.stopped !== "boolean" || (value.stopped && value.consecutive_failures !== 6)) {
      throw new Error("Invalid managed document feed failure checkpoint");
    }
    return {
      failure_fingerprint: value.failure_fingerprint,
      progress_fingerprint: value.progress_fingerprint,
      consecutive_failures: value.consecutive_failures as number,
      total_attempts: value.total_attempts as number,
      stopped: value.stopped
    };
  }

  recordInternalFeedFailure(failureFingerprint: string, progressFingerprint: string): ManagedDocumentFeedFailureCheckpoint {
    if (!/^[a-f0-9]{64}$/.test(failureFingerprint) || !/^[a-f0-9]{64}$/.test(progressFingerprint)) {
      throw new Error("Invalid managed document feed failure fingerprint");
    }
    const previous = this.feedFailureCheckpoint();
    const identical = previous?.failure_fingerprint === failureFingerprint
      && previous.progress_fingerprint === progressFingerprint && previous.consecutive_failures > 0;
    const consecutiveFailures = identical ? Math.min(6, previous.consecutive_failures + 1) : 1;
    const checkpoint: ManagedDocumentFeedFailureCheckpoint = {
      failure_fingerprint: failureFingerprint,
      progress_fingerprint: progressFingerprint,
      consecutive_failures: consecutiveFailures,
      total_attempts: (previous?.total_attempts ?? 0) + 1,
      stopped: consecutiveFailures >= 6
    };
    this.writeFeedFailureCheckpoint(checkpoint);
    return checkpoint;
  }

  breakInternalFeedFailureStreak(): void {
    const previous = this.feedFailureCheckpoint();
    if (!previous || previous.consecutive_failures === 0) return;
    this.writeFeedFailureCheckpoint({ ...previous, consecutive_failures: 0, stopped: false });
  }

  private writeFeedFailureCheckpoint(checkpoint: ManagedDocumentFeedFailureCheckpoint): void {
    this.storage.sql.exec("UPDATE managed_document_change_continuation SET feed_failure_state_json = ? WHERE singleton = 1",
      JSON.stringify(checkpoint));
  }

  preludeFailureCheckpoint(): ManagedDocumentPreludeFailureCheckpoint | null {
    const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; prelude_failure_state_json: string | null }>(
      "SELECT prelude_failure_state_json FROM managed_document_change_continuation WHERE singleton = 1"
    ).one();
    if (row.prelude_failure_state_json === null) return null;
    const parsed: unknown = JSON.parse(row.prelude_failure_state_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid managed document prelude failure checkpoint");
    const value = parsed as Record<string, unknown>;
    if (typeof value.failure_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.failure_fingerprint)
      || typeof value.progress_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.progress_fingerprint)
      || !Number.isSafeInteger(value.consecutive_failures) || (value.consecutive_failures as number) < 0 || (value.consecutive_failures as number) > 6
      || !Number.isSafeInteger(value.total_attempts) || (value.total_attempts as number) < 0
      || typeof value.stopped !== "boolean" || (value.stopped && value.consecutive_failures !== 6)) {
      throw new Error("Invalid managed document prelude failure checkpoint");
    }
    return {
      failure_fingerprint: value.failure_fingerprint,
      progress_fingerprint: value.progress_fingerprint,
      consecutive_failures: value.consecutive_failures as number,
      total_attempts: value.total_attempts as number,
      stopped: value.stopped
    };
  }

  recordInternalPreludeFailure(failureFingerprint: string, progressFingerprint: string): ManagedDocumentPreludeFailureCheckpoint {
    if (!/^[a-f0-9]{64}$/.test(failureFingerprint) || !/^[a-f0-9]{64}$/.test(progressFingerprint)) {
      throw new Error("Invalid managed document prelude failure fingerprint");
    }
    const previous = this.preludeFailureCheckpoint();
    const identical = previous?.failure_fingerprint === failureFingerprint
      && previous.progress_fingerprint === progressFingerprint && previous.consecutive_failures > 0 && !previous.stopped;
    const consecutiveFailures = identical ? Math.min(6, previous.consecutive_failures + 1) : 1;
    const checkpoint: ManagedDocumentPreludeFailureCheckpoint = {
      failure_fingerprint: failureFingerprint,
      progress_fingerprint: progressFingerprint,
      consecutive_failures: consecutiveFailures,
      total_attempts: (previous?.total_attempts ?? 0) + 1,
      stopped: consecutiveFailures >= 6
    };
    this.writePreludeFailureCheckpoint(checkpoint);
    return checkpoint;
  }

  breakInternalPreludeFailureStreak(): void {
    const previous = this.preludeFailureCheckpoint();
    if (!previous || previous.consecutive_failures === 0) return;
    this.writePreludeFailureCheckpoint({ ...previous, consecutive_failures: 0, stopped: false });
  }

  private writePreludeFailureCheckpoint(checkpoint: ManagedDocumentPreludeFailureCheckpoint): void {
    this.storage.sql.exec("UPDATE managed_document_change_continuation SET prelude_failure_state_json = ? WHERE singleton = 1",
      JSON.stringify(checkpoint));
  }

  cursor(): string | null {
    return this.control().cursor;
  }

  resetCursor(): void {
    this.storage.sql.exec(
      "UPDATE managed_document_change_control SET cursor = NULL WHERE singleton = 1"
    );
  }

  registerPage(input: RegisterManagedDocumentChangePageInput): RegisterManagedDocumentChangePageResult {
    if (!input.next_cursor) throw new Error("Managed document provider page cursor is required");
    const beforeCursor = this.cursor();
    if (!input.reset_cursor && beforeCursor !== input.expected_cursor) {
      throw new Error(
        `Managed document cursor changed before page registration: expected=${input.expected_cursor ?? "<baseline>"} actual=${beforeCursor ?? "<baseline>"}`
      );
    }

    let inserted = 0;
    this.storage.transactionSync(() => {
      const current = this.cursor();
      if (!input.reset_cursor && current !== input.expected_cursor) {
        throw new Error(
          `Managed document cursor changed during page registration: expected=${input.expected_cursor ?? "<baseline>"} actual=${current ?? "<baseline>"}`
        );
      }

      for (const job of input.jobs) {
        assertJob(job);
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO managed_document_change_jobs (
             job_id, change_json, detection_source, priority, status, attempts, last_error
           ) VALUES (?, ?, ?, ?, 'pending', 0, NULL)`,
          job.job_id,
          JSON.stringify(job.change),
          job.detection_source,
          job.priority
        );
        inserted += this.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
      }

      this.storage.sql.exec(
        "UPDATE managed_document_change_control SET cursor = ? WHERE singleton = 1",
        input.next_cursor
      );
    });

    return {
      inserted,
      cursor_advanced: beforeCursor !== input.next_cursor
    };
  }

  pending(limit = 256): ManagedDocumentChangeJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(`Invalid managed document change job limit: ${limit}`);
    }
    return this.storage.sql.exec<JobRow>(
      `SELECT job_id, ordinal, change_json, detection_source, priority, attempts, last_error
       FROM managed_document_change_jobs
       WHERE status = 'pending'
       ORDER BY priority, ordinal
       LIMIT ?`,
      limit
    ).toArray().map(parseJobRow);
  }

  beginSelectionCohort(nowMs: number): number | null {
    assertEpochMilliseconds(nowMs);
    let cohortMax: number | null = null;
    this.storage.transactionSync(() => {
      let control = this.selectionControl();
      if (control.cohort_max_ordinal === null || !this.nextEligibleCandidate(control, nowMs)) {
        // A cohort only rolls at the start of a drain. It cannot wrap midway
        // through a batch, which prevents a job from being selected twice in
        // one batch and admits arrivals on the next drain.
        this.beginCohort(this.maximumOrdinal());
        control = this.selectionControl();
      }
      cohortMax = control.cohort_max_ordinal;
    });
    return cohortMax;
  }

  selectNextPending(cohortMaxOrdinal: number | null, nowMs: number): ManagedDocumentChangeJob | null {
    assertEpochMilliseconds(nowMs);
    if (cohortMaxOrdinal === null) return null;
    let selected: ManagedDocumentChangeJob | null = null;
    this.storage.transactionSync(() => {
      const control = this.selectionControl();
      if (control.cohort_max_ordinal !== cohortMaxOrdinal) return;
      const candidate = this.nextEligibleCandidate(control, nowMs);
      if (!candidate) return;
      // Advance immediately before the coordinator attempts this one job.
      this.advanceSelection(candidate.priority, candidate.ordinal);
      selected = parseJobRow(candidate);
    });
    return selected;
  }

  markCompleted(jobId: string): void {
    assertJobId(jobId);
    this.storage.sql.exec(
      `UPDATE managed_document_change_jobs
       SET status = 'completed', attempts = attempts + 1, last_error = NULL
       WHERE job_id = ? AND status = 'pending'`,
      jobId
    );
    this.storage.sql.exec(
      `UPDATE managed_document_change_job_failure_state
       SET consecutive_failures = 0, next_attempt_at = NULL
       WHERE job_id = ? AND stopped = 0`,
      jobId
    );
  }

  markFailed(jobId: string, message: string): void {
    assertJobId(jobId);
    this.storage.sql.exec(
      `UPDATE managed_document_change_jobs
       SET attempts = attempts + 1, last_error = ?
       WHERE job_id = ? AND status = 'pending'`,
      safeError(message),
      jobId
    );
  }

  recordFailure(
    job: ManagedDocumentChangeJob,
    message: string,
    input: ManagedDocumentFailureInput,
    quarantinedAt = new Date(input.now_ms).toISOString()
  ): ManagedDocumentFailureResult {
    assertJobId(job.job_id);
    assertSha256(input.failure_fingerprint);
    assertSha256(input.progress_fingerprint);
    assertEpochMilliseconds(input.now_ms);
    if (input.retry_after_ms !== undefined && (!Number.isFinite(input.retry_after_ms) || input.retry_after_ms < 0)) {
      throw new Error("Invalid managed document retry-after delay");
    }
    if (input.classification !== "internal" && input.classification !== "unknown"
      && input.classification !== "provider_retryable" && input.classification !== "provider_blocked") {
      throw new Error("Invalid managed document failure classification");
    }
    if (input.finding_id !== undefined && !/^DRIFT-[A-F0-9]{24}$/.test(input.finding_id)) {
      throw new Error("Invalid managed document stop finding id");
    }

    let result: ManagedDocumentFailureResult = { consecutive_failures: 1, attempts: job.attempts + 1, stopped: false, next_attempt_at: null };
    this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<JobFailureStateRow>(
        `SELECT job_id, failure_fingerprint, progress_fingerprint, classification,
                consecutive_failures, next_attempt_at, stopped
         FROM managed_document_change_job_failure_state WHERE job_id = ?`,
        job.job_id
      ).toArray()[0];
      if (previous?.stopped) {
        result = {
          consecutive_failures: previous.consecutive_failures,
          attempts: job.attempts,
          stopped: true,
          next_attempt_at: null
        };
        return;
      }

      const consecutive = previous
        && previous.failure_fingerprint === input.failure_fingerprint
        && previous.progress_fingerprint === input.progress_fingerprint
        && previous.classification === input.classification
        ? previous.consecutive_failures + 1
        : 1;
      const stopped = input.classification === "internal" && consecutive >= 6;
      const delay = stopped ? 0 : retryDelay(consecutive, input.retry_after_ms);
      const nextAttemptAt = stopped ? null : checkedAddMilliseconds(input.now_ms, delay);
      this.storage.sql.exec(
        `UPDATE managed_document_change_jobs
         SET attempts = attempts + 1, last_error = ?
         WHERE job_id = ? AND status = 'pending'`,
        safeError(message),
        job.job_id
      );
      const attempts = this.storage.sql.exec<{ [key: string]: SqlStorageValue; attempts: number }>(
        "SELECT attempts FROM managed_document_change_jobs WHERE job_id = ?",
        job.job_id
      ).one().attempts;

      this.storage.sql.exec(
        `INSERT INTO managed_document_change_job_failure_state (
           job_id, failure_fingerprint, progress_fingerprint, classification,
           consecutive_failures, next_attempt_at, stopped
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           failure_fingerprint = excluded.failure_fingerprint,
           progress_fingerprint = excluded.progress_fingerprint,
           classification = excluded.classification,
           consecutive_failures = excluded.consecutive_failures,
           next_attempt_at = excluded.next_attempt_at,
           stopped = excluded.stopped`,
        job.job_id,
        input.failure_fingerprint,
        input.progress_fingerprint,
        input.classification,
        consecutive,
        nextAttemptAt,
        stopped ? 1 : 0
      );

      if (stopped && input.finding_id) {
        this.storage.sql.exec(
          `INSERT INTO managed_document_drift_findings (
             finding_id, job_id, path, change_kind, status, code, request_id,
             resource_json, observed_at, opened_at
           ) VALUES (?, ?, ?, ?, 'unexpected_conflict', 'identical_internal_failure_limit', NULL, NULL, ?, ?)
           ON CONFLICT(finding_id) DO UPDATE SET
             status = excluded.status, code = excluded.code, observed_at = excluded.observed_at`,
          input.finding_id,
          job.job_id,
          job.change.path,
          job.change.kind,
          quarantinedAt,
          quarantinedAt
        );
      }
      result = { consecutive_failures: consecutive, attempts, stopped, next_attempt_at: nextAttemptAt };
    });
    return result;
  }

  private selectionControl(): SelectionControlRow {
    return this.storage.sql.exec<SelectionControlRow>(
      "SELECT cohort_max_ordinal, last_priority, last_ordinal FROM managed_document_change_selection_control WHERE singleton = 1"
    ).one();
  }

  private maximumOrdinal(): number | null {
    const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; maximum: number | null }>(
      "SELECT MAX(ordinal) AS maximum FROM managed_document_change_jobs"
    ).one();
    return row.maximum;
  }

  private beginCohort(maximum: number | null): void {
    this.storage.sql.exec(
      `UPDATE managed_document_change_selection_control
       SET cohort_max_ordinal = ?, last_priority = NULL, last_ordinal = NULL
       WHERE singleton = 1`,
      maximum
    );
  }

  private nextEligibleCandidate(control: SelectionControlRow, nowMs: number): JobRow | null {
    const maxOrdinal = control.cohort_max_ordinal;
    if (maxOrdinal === null) return null;
    const afterCursor = control.last_priority === null || control.last_ordinal === null
      ? "1 = 1"
      : "(j.priority > ? OR (j.priority = ? AND j.ordinal > ?))";
    const values: (string | number | null)[] = [maxOrdinal, NON_EXECUTABLE_RETRY_DEADLINE, nowMs];
    if (control.last_priority !== null && control.last_ordinal !== null) {
      values.push(control.last_priority, control.last_priority, control.last_ordinal);
    }
    const row = this.storage.sql.exec<JobRow>(
      `SELECT j.job_id, j.ordinal, j.change_json, j.detection_source, j.priority, j.attempts, j.last_error
       FROM managed_document_change_jobs AS j
       LEFT JOIN managed_document_change_job_failure_state AS f ON f.job_id = j.job_id
       WHERE j.status = 'pending' AND j.ordinal <= ?
         AND (f.job_id IS NULL OR (f.stopped = 0 AND (f.next_attempt_at IS NULL OR (f.next_attempt_at != ? AND f.next_attempt_at <= ?))))
         AND ${afterCursor}
       ORDER BY j.priority, j.ordinal LIMIT 1`,
      ...values
    ).toArray()[0];
    return row ?? null;
  }

  private advanceSelection(priority: number, ordinal: number): void {
    this.storage.sql.exec(
      `UPDATE managed_document_change_selection_control
       SET last_priority = ?, last_ordinal = ? WHERE singleton = 1`,
      priority,
      ordinal
    );
  }

  markQuarantined(job: ManagedDocumentChangeJob, code: string, quarantinedAt = new Date().toISOString()): void {
    assertJobId(job.job_id);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO managed_document_change_quarantine
           (job_id, path, code, attempts, quarantined_at) VALUES (?, ?, ?, ?, ?)`,
        job.job_id,
        job.change.path,
        safeError(code),
        job.attempts + 1,
        quarantinedAt
      );
      this.storage.sql.exec(
        `UPDATE managed_document_change_jobs
         SET status = 'completed', attempts = attempts + 1, last_error = ?
         WHERE job_id = ? AND status = 'pending'`,
        safeError(code),
        job.job_id
      );
    });
  }

  quarantines(): ManagedDocumentChangeQuarantine[] {
    return this.storage.sql.exec<QuarantineRow>(
      `SELECT job_id, path, code, attempts, quarantined_at
       FROM managed_document_change_quarantine ORDER BY quarantined_at, job_id`
    ).toArray();
  }

  pendingCount(): number {
    return this.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM managed_document_change_jobs WHERE status = 'pending'"
    ).one().count;
  }

  eligibilityCounts(nowMs: number): ManagedDocumentJobEligibilityCounts {
    assertEpochMilliseconds(nowMs);
    const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; executable: number; future: number; stopped: number; earliest: number | null }>(
      `SELECT
         COALESCE(SUM(CASE WHEN f.job_id IS NULL OR (f.stopped = 0 AND (f.next_attempt_at IS NULL OR (f.next_attempt_at != ? AND f.next_attempt_at <= ?))) THEN 1 ELSE 0 END), 0) AS executable,
         COALESCE(SUM(CASE WHEN f.job_id IS NOT NULL AND f.stopped = 0 AND f.next_attempt_at IS NOT NULL AND f.next_attempt_at != ? AND f.next_attempt_at > ? THEN 1 ELSE 0 END), 0) AS future,
         COALESCE(SUM(CASE WHEN f.stopped = 1 THEN 1 ELSE 0 END), 0) AS stopped,
         MIN(CASE WHEN f.stopped = 0 AND f.next_attempt_at IS NOT NULL AND f.next_attempt_at != ? AND f.next_attempt_at > ? THEN f.next_attempt_at ELSE NULL END) AS earliest
       FROM managed_document_change_jobs AS j
       LEFT JOIN managed_document_change_job_failure_state AS f ON f.job_id = j.job_id
       WHERE j.status = 'pending'`,
      NON_EXECUTABLE_RETRY_DEADLINE, nowMs,
      NON_EXECUTABLE_RETRY_DEADLINE, nowMs,
      NON_EXECUTABLE_RETRY_DEADLINE, nowMs
    ).one();
    return {
      executable: safeCount(row.executable),
      future: safeCount(row.future),
      stopped: safeCount(row.stopped),
      earliest_eligible_at: row.earliest === null ? null : safeEpoch(row.earliest)
    };
  }

  async readCheckpoint(now: string) {
    const nowMs = dateMs(now);
    // Capture existing rows synchronously before hashing; reporting never marks
    // a verification overdue, advances a cursor, or initializes a schema.
    const schedule = this.scheduledControl();
    for (const timestamp of Object.values(schedule)) if (timestamp !== null) dateMs(String(timestamp));
    const cursor = this.cursor();
    const counts = {
      pending_jobs: this.pendingCount(),
      pending_jobs_with_error: this.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM managed_document_change_jobs WHERE status = 'pending' AND last_error IS NOT NULL"
      ).one().count,
      quarantines: this.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM managed_document_change_quarantine").one().count,
      findings_by_status: Object.fromEntries(this.storage.sql.exec<{ [key: string]: SqlStorageValue; status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM managed_document_drift_findings GROUP BY status"
      ).toArray().filter(row => ["expected_reconciled", "unexpected_conflict", "obsolete"].includes(row.status))
        .map(row => [row.status, row.count]))
    };
    const quarantines = this.storage.sql.exec<QuarantineRow>(
      "SELECT job_id, path, code, attempts, quarantined_at FROM managed_document_change_quarantine ORDER BY quarantined_at DESC, job_id DESC LIMIT 5"
    ).toArray();
    const findings = this.storage.sql.exec<DriftFindingRow>(
      "SELECT finding_id, job_id, path, change_kind, status, code, observed_at, opened_at FROM managed_document_drift_findings ORDER BY observed_at DESC, finding_id DESC LIMIT 5"
    ).toArray();
    const nextMs = schedule.next_verification_at === null ? null : dateMs(schedule.next_verification_at);
    return {
      schedule: { ...schedule, due: nextMs === null || nowMs >= nextMs, overdue_by_ms: nextMs === null ? 0 : Math.max(0, nowMs - nextMs) },
      cursor: { present: cursor !== null, sha256: cursor === null ? null : await sha256Text(cursor) },
      counts,
      recent_quarantines: await Promise.all(quarantines.map(async row => ({
        job_id: assertJobId(row.job_id), path_sha256: await sha256Text(row.path), code: diagnosticCode(row.code),
        attempts: diagnosticAttempts(row.attempts), quarantined_at: new Date(dateMs(row.quarantined_at)).toISOString()
      }))),
      recent_findings: await Promise.all(findings.map(async row => {
        if (!/^DRIFT-[A-F0-9]{24}$/.test(row.finding_id)
          || !["expected_reconciled", "unexpected_conflict", "obsolete"].includes(row.status)
          || !["file", "folder", "deleted"].includes(row.change_kind)) throw new Error("Invalid document checkpoint finding");
        return { finding_id: row.finding_id, job_id: assertJobId(row.job_id), path_sha256: await sha256Text(row.path),
          change_kind: row.change_kind, status: row.status, code: diagnosticCode(row.code),
          observed_at: new Date(dateMs(row.observed_at)).toISOString(), opened_at: new Date(dateMs(row.opened_at)).toISOString() };
      }))
    };
  }

  recordDriftFinding(input: ManagedDocumentDriftFindingInput): void {
    assertFinding(input);
    this.storage.sql.exec(
      `INSERT INTO managed_document_drift_findings (
         finding_id, job_id, path, change_kind, status, code, request_id, resource_json, observed_at, opened_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finding_id) DO UPDATE SET
         status = excluded.status,
         code = excluded.code,
         request_id = excluded.request_id,
         resource_json = excluded.resource_json,
         observed_at = excluded.observed_at`,
      input.finding_id,
      input.job_id,
      input.path,
      input.change_kind,
      input.status,
      safeError(input.code),
      input.request_id ?? null,
      input.resource ? JSON.stringify(input.resource) : null,
      input.observed_at,
      input.observed_at
    );
  }

  driftFindings(): ManagedDocumentDriftFinding[] {
    return this.storage.sql.exec<DriftFindingRow>(
      `SELECT finding_id, job_id, path, change_kind, status, code, request_id, resource_json, observed_at, opened_at
       FROM managed_document_drift_findings ORDER BY opened_at, finding_id`
    ).toArray().map(parseDriftFinding);
  }

  driftFindingsForJob(jobId: string): ManagedDocumentDriftFinding[] {
    assertJobId(jobId);
    return this.storage.sql.exec<DriftFindingRow>(
      `SELECT finding_id, job_id, path, change_kind, status, code, request_id, resource_json, observed_at, opened_at
       FROM managed_document_drift_findings WHERE job_id = ? ORDER BY opened_at, finding_id`,
      jobId
    ).toArray().map(parseDriftFinding);
  }

  scheduledVerification(now: string): ScheduledDocumentVerification {
    const nowMs = dateMs(now);
    const current = this.scheduledControl();
    if (current.next_verification_at === null) {
      return { due: true, ...current };
    }
    const due = nowMs >= dateMs(current.next_verification_at);
    let lateSince = current.late_since;
    if (due && lateSince === null) {
      lateSince = current.next_verification_at;
      this.storage.sql.exec(
        "UPDATE managed_document_drift_control SET late_since = ? WHERE singleton = 1",
        lateSince
      );
    }
    return { due, ...current, late_since: lateSince };
  }

  completeScheduledVerification(now: string): void {
    const verifiedAt = new Date(dateMs(now)).toISOString();
    const next = new Date(dateMs(verifiedAt) + 86_400_000).toISOString();
    this.storage.sql.exec(
      `UPDATE managed_document_drift_control
       SET last_verified_at = ?, next_verification_at = ?, late_since = NULL
       WHERE singleton = 1`,
      verifiedAt,
      next
    );
  }

  private control(): ControlRow {
    return this.storage.sql.exec<ControlRow>(
      "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
    ).one();
  }

  private scheduledControl(): ScheduledVerificationRow {
    return this.storage.sql.exec<ScheduledVerificationRow>(
      "SELECT last_verified_at, next_verification_at, late_since FROM managed_document_drift_control WHERE singleton = 1"
    ).one();
  }
}

function parseJobRow(row: JobRow): ManagedDocumentChangeJob {
  const detectionSource = row.detection_source;
  if (detectionSource !== "baseline" && detectionSource !== "incremental" && detectionSource !== "cursor_reset") {
    throw new Error(`Invalid managed document change job detection source: ${detectionSource}`);
  }
  const change = JSON.parse(row.change_json) as ProviderChangeEntry;
  return {
    job_id: assertJobId(row.job_id),
    ordinal: row.ordinal,
    change,
    detection_source: detectionSource,
    priority: row.priority,
    attempts: row.attempts,
    last_error: row.last_error
  };
}

function assertJob(job: ManagedDocumentChangeJobInput): void {
  assertJobId(job.job_id);
  if (!Number.isSafeInteger(job.priority) || job.priority < 0 || job.priority > 100) {
    throw new Error(`Invalid managed document change job priority: ${job.priority}`);
  }
  if (!job.change || typeof job.change.path !== "string" || !job.change.path.startsWith("/")) {
    throw new Error(`Invalid managed document provider change for job ${job.job_id}`);
  }
}

function assertFinding(value: ManagedDocumentDriftFindingInput): void {
  if (!/^DRIFT-[A-F0-9]{24}$/.test(value.finding_id)) throw new Error(`Unsafe managed document drift finding id: ${value.finding_id}`);
  assertJobId(value.job_id);
  if (!value.path.startsWith("/") || !value.code || !value.observed_at || Number.isNaN(Date.parse(value.observed_at))) {
    throw new Error("Invalid managed document drift finding");
  }
  if (value.change_kind !== "file" && value.change_kind !== "folder" && value.change_kind !== "deleted") {
    throw new Error("Invalid managed document drift change kind");
  }
  if (value.status !== "expected_reconciled" && value.status !== "unexpected_conflict" && value.status !== "obsolete") {
    throw new Error("Invalid managed document drift status");
  }
}

function assertJobId(value: string): string {
  if (!/^CHGJOB-[A-F0-9]{24}$/.test(value)) {
    throw new Error(`Unsafe managed document change job id: ${value}`);
  }
  return value;
}

function safeError(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid managed document failure fingerprint");
}

function assertEpochMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid managed document retry timestamp");
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid managed document eligibility count");
  return value;
}

function safeEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid managed document eligibility timestamp");
  return value;
}

function retryDelay(consecutiveFailures: number, retryAfterMs?: number): number {
  const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 8);
  const defaultDelay = Math.min(300_000, 1_000 * (2 ** exponent));
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return defaultDelay;
  const rounded = Math.ceil(retryAfterMs);
  if (!Number.isSafeInteger(rounded)) return NON_EXECUTABLE_RETRY_DEADLINE;
  return Math.max(defaultDelay, rounded);
}

function checkedAddMilliseconds(nowMs: number, delayMs: number): number {
  const next = nowMs + delayMs;
  if (Number.isSafeInteger(next) && next >= nowMs) return next;
  return NON_EXECUTABLE_RETRY_DEADLINE;
}

function parseDriftFinding(row: DriftFindingRow): ManagedDocumentDriftFinding {
  const value: ManagedDocumentDriftFindingInput = {
    finding_id: row.finding_id,
    job_id: row.job_id,
    path: row.path,
    change_kind: row.change_kind as ManagedDocumentDriftFinding["change_kind"],
    status: row.status as ManagedDocumentDriftFinding["status"],
    code: row.code,
    ...(row.request_id ? { request_id: row.request_id } : {}),
    ...(row.resource_json ? { resource: JSON.parse(row.resource_json) as RuleResource } : {}),
    observed_at: row.observed_at
  };
  assertFinding(value);
  return { ...value, request_id: value.request_id ?? null, resource: value.resource ?? null, opened_at: row.opened_at };
}

function dateMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid scheduled document verification timestamp");
  return parsed;
}

function diagnosticCode(value: string): string | null {
  return ["directory_used_as_file_target", "mutation_candidate_evidence_conflict", "file_target_missing",
    "navigation_index_external_change", "PACKAGE_CURRENT_INDEX_SNAPSHOT", "PACKAGE_UNEXPECTED_MUTATION",
    "PACKAGE_UNEXPECTED_DISAPPEARANCE", "PACKAGE_NAVIGATION_UNAVAILABLE", "PACKAGE_EXPECTED_WRITE",
    "PACKAGE_EXPECTED_DELETE", "PACKAGE_EXPECTED_EFFECT_DIVERGED", "identical_internal_failure_limit"].includes(value) ? value : null;
}

function diagnosticAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid document checkpoint attempts");
  }
  return value;
}
