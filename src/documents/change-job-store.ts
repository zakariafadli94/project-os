import type { ProviderChangeEntry } from "../persistence/provider/contract";
import type { RuleResource } from "../rules/contract";

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
}

export class ManagedDocumentChangeJobStore {
  constructor(private readonly storage: DurableObjectStorage) {}

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

  markCompleted(jobId: string): void {
    assertJobId(jobId);
    this.storage.sql.exec(
      `UPDATE managed_document_change_jobs
       SET status = 'completed', attempts = attempts + 1, last_error = NULL
       WHERE job_id = ? AND status = 'pending'`,
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

  pendingCount(): number {
    return this.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM managed_document_change_jobs WHERE status = 'pending'"
    ).one().count;
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
