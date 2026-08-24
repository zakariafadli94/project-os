import type { ProjectionOutputEvidence } from "../domain/materialization";

export interface MaterializationTargetRequest {
  revision: number;
  projection_version: number;
}

export interface MaterializationTarget extends MaterializationTargetRequest {
  coalesced_revisions: number[];
}

export interface MaterializationLedgerStatus {
  head: MaterializationTargetRequest | null;
  requested: MaterializationTargetRequest | null;
  active: MaterializationTarget | null;
  active_status: string | null;
  last_error: string | null;
  output_count: number;
  attempt_output_count: number;
}

interface ControlRow {
  [key: string]: SqlStorageValue;
  head_revision: number | null;
  head_projection_version: number | null;
  requested_revision: number | null;
  requested_projection_version: number | null;
  active_revision: number | null;
  active_projection_version: number | null;
  active_coalesced_json: string;
  active_status: string | null;
  last_error: string | null;
}

interface OutputRow {
  [key: string]: SqlStorageValue;
  output_key: string;
  relative_path: string;
  input_hash: string;
  content_hash: string;
  source_revision: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

export function initializeMaterializationSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS materialization_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      head_revision INTEGER,
      head_projection_version INTEGER,
      requested_revision INTEGER,
      requested_projection_version INTEGER,
      active_revision INTEGER,
      active_projection_version INTEGER,
      active_coalesced_json TEXT NOT NULL DEFAULT '[]',
      active_status TEXT,
      last_error TEXT
    );
    INSERT OR IGNORE INTO materialization_control (singleton) VALUES (1);

    CREATE TABLE IF NOT EXISTS materialization_outputs (
      output_key TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_revision INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS materialization_attempt_outputs (
      output_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      projection_version INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

export class MaterializationLedger {
  constructor(private readonly storage: DurableObjectStorage) {}

  requestTarget(target: MaterializationTargetRequest): void {
    validateTarget(target);
    const row = this.control();

    if (
      row.active_revision !== null
      && row.active_projection_version === target.projection_version
      && target.revision <= row.active_revision
    ) return;

    if (row.head_projection_version !== null) {
      if (target.projection_version < row.head_projection_version) return;
      if (
        target.projection_version === row.head_projection_version
        && row.head_revision !== null
        && target.revision <= row.head_revision
        && row.active_revision === null
      ) return;
    }

    let coalesced = row.active_revision === null ? parseRevisionList(row.active_coalesced_json) : [];
    if (row.requested_revision !== null && row.requested_projection_version !== null) {
      if (target.projection_version < row.requested_projection_version) return;
      if (target.projection_version === row.requested_projection_version) {
        if (target.revision <= row.requested_revision) return;
        if (row.active_revision === null) {
          coalesced = uniqueSorted([
            ...coalesced,
            ...integerRange(row.requested_revision, target.revision - 1)
          ]);
        }
      } else if (row.active_revision === null) {
        coalesced = [];
      }
    }

    this.storage.sql.exec(
      `UPDATE materialization_control
       SET requested_revision = ?, requested_projection_version = ?, active_coalesced_json = CASE WHEN active_revision IS NULL THEN ? ELSE active_coalesced_json END
       WHERE singleton = 1`,
      target.revision,
      target.projection_version,
      JSON.stringify(coalesced)
    );
  }

  beginNextTarget(): MaterializationTarget | null {
    const row = this.control();
    if (row.active_revision !== null && row.active_projection_version !== null) {
      return {
        revision: row.active_revision,
        projection_version: row.active_projection_version,
        coalesced_revisions: parseRevisionList(row.active_coalesced_json)
      };
    }
    if (row.requested_revision === null || row.requested_projection_version === null) return null;

    if (
      row.head_revision === row.requested_revision
      && row.head_projection_version === row.requested_projection_version
    ) {
      this.storage.sql.exec(
        `UPDATE materialization_control
         SET requested_revision = NULL, requested_projection_version = NULL, active_coalesced_json = '[]'
         WHERE singleton = 1`
      );
      return null;
    }

    let coalesced = parseRevisionList(row.active_coalesced_json);
    if (
      coalesced.length === 0
      && row.head_revision !== null
      && row.head_projection_version === row.requested_projection_version
      && row.requested_revision > row.head_revision + 1
    ) {
      coalesced = integerRange(row.head_revision + 1, row.requested_revision - 1);
    }

    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM materialization_attempt_outputs");
      this.storage.sql.exec(
        `UPDATE materialization_control
         SET active_revision = ?, active_projection_version = ?, active_coalesced_json = ?, active_status = 'running', last_error = NULL
         WHERE singleton = 1`,
        row.requested_revision,
        row.requested_projection_version,
        JSON.stringify(coalesced)
      );
    });

    return {
      revision: row.requested_revision,
      projection_version: row.requested_projection_version,
      coalesced_revisions: coalesced
    };
  }

  recordVerifiedOutput(key: string, evidence: ProjectionOutputEvidence): void {
    const row = this.control();
    if (row.active_revision === null || row.active_projection_version === null) {
      throw new Error("Cannot record materialization output without an active target");
    }
    this.storage.sql.exec(
      `INSERT INTO materialization_attempt_outputs (
         output_key, revision, projection_version, relative_path, input_hash, content_hash, source_revision, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified')
       ON CONFLICT(output_key) DO UPDATE SET
         revision = excluded.revision,
         projection_version = excluded.projection_version,
         relative_path = excluded.relative_path,
         input_hash = excluded.input_hash,
         content_hash = excluded.content_hash,
         source_revision = excluded.source_revision,
         status = excluded.status`,
      key,
      row.active_revision,
      row.active_projection_version,
      evidence.relative_path,
      evidence.input_hash,
      evidence.content_hash,
      evidence.source_revision
    );
  }

  attemptOutputs(): Map<string, ProjectionOutputEvidence> {
    const row = this.control();
    if (row.active_revision === null || row.active_projection_version === null) return new Map();
    const rows = this.storage.sql.exec<OutputRow>(
      `SELECT output_key, relative_path, input_hash, content_hash, source_revision
       FROM materialization_attempt_outputs
       WHERE revision = ? AND projection_version = ? AND status = 'verified'
       ORDER BY output_key`,
      row.active_revision,
      row.active_projection_version
    ).toArray();
    return outputMap(rows);
  }

  baselineOutputs(): Map<string, ProjectionOutputEvidence> {
    return outputMap(this.storage.sql.exec<OutputRow>(
      `SELECT output_key, relative_path, input_hash, content_hash, source_revision
       FROM materialization_outputs ORDER BY output_key`
    ).toArray());
  }

  failActive(message: string): void {
    if (this.control().active_revision === null) return;
    this.storage.sql.exec(
      `UPDATE materialization_control SET active_status = 'failed', last_error = ? WHERE singleton = 1`,
      message
    );
  }

  completeTarget(input: {
    revision: number;
    projection_version: number;
    outputs: ReadonlyMap<string, ProjectionOutputEvidence>;
    removed_outputs: readonly string[];
  }): void {
    validateTarget(input);
    const row = this.control();
    if (row.active_revision !== input.revision || row.active_projection_version !== input.projection_version) {
      throw new Error("Materialization completion does not match active target");
    }

    this.storage.transactionSync(() => {
      for (const key of input.removed_outputs) {
        this.storage.sql.exec("DELETE FROM materialization_outputs WHERE output_key = ?", key);
      }
      for (const [key, evidence] of input.outputs) {
        upsertBaseline(this.storage, key, evidence);
      }

      const requestedSatisfied = row.requested_revision !== null
        && row.requested_projection_version !== null
        && (
          row.requested_projection_version < input.projection_version
          || (
            row.requested_projection_version === input.projection_version
            && row.requested_revision <= input.revision
          )
        );

      this.storage.sql.exec(
        `UPDATE materialization_control
         SET head_revision = ?, head_projection_version = ?,
             requested_revision = CASE WHEN ? THEN NULL ELSE requested_revision END,
             requested_projection_version = CASE WHEN ? THEN NULL ELSE requested_projection_version END,
             active_revision = NULL, active_projection_version = NULL,
             active_coalesced_json = '[]', active_status = NULL, last_error = NULL
         WHERE singleton = 1`,
        input.revision,
        input.projection_version,
        requestedSatisfied ? 1 : 0,
        requestedSatisfied ? 1 : 0
      );
      this.storage.sql.exec("DELETE FROM materialization_attempt_outputs");
    });
  }

  restoreExternalBaseline(
    head: MaterializationTargetRequest,
    outputs: ReadonlyMap<string, ProjectionOutputEvidence>
  ): void {
    validateTarget(head);
    const row = this.control();
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM materialization_outputs");
      for (const [key, evidence] of outputs) upsertBaseline(this.storage, key, evidence);

      const requestedSatisfied = row.requested_revision !== null
        && row.requested_projection_version !== null
        && (
          row.requested_projection_version < head.projection_version
          || (
            row.requested_projection_version === head.projection_version
            && row.requested_revision <= head.revision
          )
        );

      this.storage.sql.exec(
        `UPDATE materialization_control
         SET head_revision = ?, head_projection_version = ?,
             requested_revision = CASE WHEN ? THEN NULL ELSE requested_revision END,
             requested_projection_version = CASE WHEN ? THEN NULL ELSE requested_projection_version END,
             active_revision = NULL, active_projection_version = NULL,
             active_coalesced_json = '[]', active_status = NULL, last_error = NULL
         WHERE singleton = 1`,
        head.revision,
        head.projection_version,
        requestedSatisfied ? 1 : 0,
        requestedSatisfied ? 1 : 0
      );
      this.storage.sql.exec("DELETE FROM materialization_attempt_outputs");
    });
  }

  status(): MaterializationLedgerStatus {
    const row = this.control();
    const output_count = this.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM materialization_outputs"
    ).one().count;
    const attempt_output_count = this.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM materialization_attempt_outputs WHERE status = 'verified'"
    ).one().count;
    return {
      head: pair(row.head_revision, row.head_projection_version),
      requested: pair(row.requested_revision, row.requested_projection_version),
      active: row.active_revision !== null && row.active_projection_version !== null
        ? {
            revision: row.active_revision,
            projection_version: row.active_projection_version,
            coalesced_revisions: parseRevisionList(row.active_coalesced_json)
          }
        : null,
      active_status: row.active_status,
      last_error: row.last_error,
      output_count,
      attempt_output_count
    };
  }

  private control(): ControlRow {
    return this.storage.sql.exec<ControlRow>(
      `SELECT head_revision, head_projection_version, requested_revision, requested_projection_version,
              active_revision, active_projection_version, active_coalesced_json, active_status, last_error
       FROM materialization_control WHERE singleton = 1`
    ).one();
  }
}

function upsertBaseline(storage: DurableObjectStorage, key: string, evidence: ProjectionOutputEvidence): void {
  storage.sql.exec(
    `INSERT INTO materialization_outputs (output_key, relative_path, input_hash, content_hash, source_revision)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(output_key) DO UPDATE SET
       relative_path = excluded.relative_path,
       input_hash = excluded.input_hash,
       content_hash = excluded.content_hash,
       source_revision = excluded.source_revision`,
    key,
    evidence.relative_path,
    evidence.input_hash,
    evidence.content_hash,
    evidence.source_revision
  );
}

function outputMap(rows: OutputRow[]): Map<string, ProjectionOutputEvidence> {
  return new Map(rows.map((row) => [
    row.output_key,
    {
      relative_path: row.relative_path,
      input_hash: row.input_hash,
      content_hash: row.content_hash,
      source_revision: row.source_revision
    }
  ]));
}

function validateTarget(target: MaterializationTargetRequest): void {
  if (!Number.isSafeInteger(target.revision) || target.revision < 0) {
    throw new Error(`Invalid materialization target revision: ${target.revision}`);
  }
  if (!Number.isSafeInteger(target.projection_version) || target.projection_version < 1) {
    throw new Error(`Invalid materialization target projection version: ${target.projection_version}`);
  }
}

function pair(revision: number | null, projectionVersion: number | null): MaterializationTargetRequest | null {
  return revision !== null && projectionVersion !== null
    ? { revision, projection_version: projectionVersion }
    : null;
}

function parseRevisionList(raw: string): number[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid materialization coalesced revision state");
  const values = parsed.map((value) => Number(value));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Invalid materialization coalesced revision state");
  }
  return uniqueSorted(values);
}

function integerRange(start: number, end: number): number[] {
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
