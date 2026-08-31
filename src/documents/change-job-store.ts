import type { ProviderChangeEntry } from "../persistence/provider/contract";

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

  private control(): ControlRow {
    return this.storage.sql.exec<ControlRow>(
      "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
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

function assertJobId(value: string): string {
  if (!/^CHGJOB-[A-F0-9]{24}$/.test(value)) {
    throw new Error(`Unsafe managed document change job id: ${value}`);
  }
  return value;
}

function safeError(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 2_000);
}
