import type { MaterializationGenerationRef, ProjectionOutputEvidence } from "../domain/materialization";
import type { Progress } from "../convergence/contract";
import { parseProgress } from "../convergence/journal";
import type { RuleResource } from "../rules/contract";

export interface MaterializationTargetRequest {
  revision: number;
  projection_version: number;
}

export interface MaterializationTarget extends MaterializationTargetRequest {
  coalesced_revisions: number[];
}

/** A persistent final-observation obligation for the exact published index. */
export type FinalVerificationItem = {
  key: string;
  expected: "present";
  evidence: ProjectionOutputEvidence;
} | {
  key: string;
  expected: "absent";
  evidence: ProjectionOutputEvidence;
};

export interface MaterializationRepairScanCheckpoint {
  canonical_revision: number;
  cursor: string | null;
  scan_complete: boolean;
  best_candidate: MaterializationGenerationRef | null;
  chain_state?: {
    phase: "discover" | "apply";
    refs: MaterializationGenerationRef[];
    chain_depths: number[];
    cursor_ref: MaterializationGenerationRef | null;
    apply_index: number;
    outputs: Record<string, ProjectionOutputEvidence>;
  };
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
  active_immutable_revision: number | null;
  active_verification_epoch: number;
  active_final_verification_json: string;
  repair_scan_json: string;
  active_managed_zones_ready: number;
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

interface ConvergenceCheckpointRow {
  [key: string]: SqlStorageValue;
  progress_json: string;
  provider_token: string;
}

export interface CapacityReservation {
  request_id: string;
  request_hash: string;
  reservation_kind: "transaction" | "document" | "artifact";
  output_cost: number;
  canonical_revision: number;
  target_revision: number | null;
  operation: string;
  resources: RuleResource[];
  dependency_classification: "resource_bound" | "unknown";
  state: "reserved" | "committed" | "handed_off";
  created_at: string;
}

export interface CapacityLedgerSnapshot {
  status: MaterializationLedgerStatus;
  progress: Progress | null;
  provider_token: string | null;
  reservations: CapacityReservation[];
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
      active_immutable_revision INTEGER,
      active_verification_epoch INTEGER NOT NULL DEFAULT 0,
      active_final_verification_json TEXT NOT NULL DEFAULT '[]',
      repair_scan_json TEXT NOT NULL DEFAULT '',
      active_managed_zones_ready INTEGER NOT NULL DEFAULT 0,
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
      verification_epoch INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS convergence_checkpoint (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      progress_json TEXT NOT NULL,
      provider_token TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS convergence_attempts (
      obligation_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      reservation_json TEXT NOT NULL,
      PRIMARY KEY(obligation_id, attempt_number)
    );

    CREATE TABLE IF NOT EXISTS capacity_reservations (
      request_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      reservation_kind TEXT NOT NULL CHECK(reservation_kind IN ('transaction', 'document', 'artifact')),
      output_cost INTEGER NOT NULL CHECK(output_cost > 0),
      canonical_revision INTEGER NOT NULL,
      target_revision INTEGER,
      operation TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      dependency_classification TEXT NOT NULL CHECK(dependency_classification IN ('resource_bound', 'unknown')),
      state TEXT NOT NULL CHECK(state IN ('reserved', 'committed', 'handed_off')),
      created_at TEXT NOT NULL
    );
  `);
  try {
    storage.sql.exec("ALTER TABLE materialization_control ADD COLUMN active_immutable_revision INTEGER");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    storage.sql.exec("ALTER TABLE materialization_control ADD COLUMN active_verification_epoch INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    storage.sql.exec("ALTER TABLE materialization_control ADD COLUMN active_final_verification_json TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    storage.sql.exec("ALTER TABLE materialization_control ADD COLUMN repair_scan_json TEXT NOT NULL DEFAULT ''");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    storage.sql.exec("ALTER TABLE materialization_control ADD COLUMN active_managed_zones_ready INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    storage.sql.exec("ALTER TABLE materialization_attempt_outputs ADD COLUMN verification_epoch INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
}

export class MaterializationLedger {
  constructor(private readonly storage: DurableObjectStorage, private readonly boundProjectId?: string) {}

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
      if (row.active_status === "failed") {
        this.storage.sql.exec(
          `UPDATE materialization_control
           SET active_verification_epoch = active_verification_epoch + 1,
               active_final_verification_json = '[]',
               active_status = 'running', last_error = NULL
           WHERE singleton = 1`
        );
      }
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
      row.head_revision !== null
      && row.head_projection_version === row.requested_projection_version
      && row.requested_revision > row.head_revision + 1
    ) {
      // A persisted coalescence tail from an interrupted older writer is not
      // sufficient evidence: every revision after the verified head must be
      // represented before a newer target is published.
      coalesced = uniqueSorted([
        ...coalesced,
        ...integerRange(row.head_revision + 1, row.requested_revision - 1)
      ]);
    }

    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM materialization_attempt_outputs");
      this.storage.sql.exec(
        `UPDATE materialization_control
         SET active_revision = ?, active_projection_version = ?, active_coalesced_json = ?, active_immutable_revision = NULL,
             active_verification_epoch = active_verification_epoch + 1, active_final_verification_json = '[]',
             active_managed_zones_ready = 0,
             active_status = 'running', last_error = NULL
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
         output_key, revision, projection_version, relative_path, input_hash, content_hash, source_revision, verification_epoch, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified')
       ON CONFLICT(output_key) DO UPDATE SET
         revision = excluded.revision,
         projection_version = excluded.projection_version,
         relative_path = excluded.relative_path,
         input_hash = excluded.input_hash,
         content_hash = excluded.content_hash,
         source_revision = excluded.source_revision,
         verification_epoch = excluded.verification_epoch,
         status = excluded.status`,
      key,
      row.active_revision,
      row.active_projection_version,
      evidence.relative_path,
      evidence.input_hash,
      evidence.content_hash,
      evidence.source_revision,
      row.active_verification_epoch
    );
  }

  managedZoneBootstrapReady(): boolean {
    const row = this.control();
    return row.active_revision !== null && row.active_managed_zones_ready === 1;
  }

  markManagedZoneBootstrapReady(): void {
    if (this.control().active_revision === null) {
      throw new Error("Cannot mark managed zones ready without an active target");
    }
    this.storage.sql.exec(
      "UPDATE materialization_control SET active_managed_zones_ready = 1 WHERE singleton = 1"
    );
  }

  attemptOutputs(): Map<string, ProjectionOutputEvidence> {
    const row = this.control();
    if (row.active_revision === null || row.active_projection_version === null) return new Map();
    const rows = this.storage.sql.exec<OutputRow>(
      `SELECT output_key, relative_path, input_hash, content_hash, source_revision
       FROM materialization_attempt_outputs
       WHERE revision = ? AND projection_version = ? AND verification_epoch = ? AND status = 'verified'
       ORDER BY output_key`,
      row.active_revision,
      row.active_projection_version,
      row.active_verification_epoch
    ).toArray();
    return outputMap(rows);
  }

  finalVerificationActive(): boolean {
    const row = this.control();
    return row.active_revision !== null && row.active_status === "verifying";
  }

  beginFinalVerification(items: readonly FinalVerificationItem[]): void {
    const row = this.control();
    if (row.active_revision === null || row.active_projection_version === null) {
      throw new Error("Cannot begin final materialization verification without an active target");
    }
    if (row.active_status === "verifying") return;
    const pending = normalizeFinalVerificationItems(items);
    if (pending.length === 0) {
      throw new Error("Final materialization verification requires at least one changed output");
    }
    this.storage.sql.exec(
      `UPDATE materialization_control
       SET active_status = 'verifying', active_final_verification_json = ?
       WHERE singleton = 1`,
      JSON.stringify(pending)
    );
  }

  narrowFinalVerification(items: readonly FinalVerificationItem[]): void {
    const row = this.control();
    if (row.active_status !== "verifying") return;
    const desired = normalizeFinalVerificationItems(items);
    if (desired.length === 0) {
      throw new Error("Final materialization verification requires at least one changed output");
    }
    const desiredKeys = new Set(desired.map((item) => item.key));
    const pending = parseFinalVerificationItems(row.active_final_verification_json);
    if (!pending.some((item) => !desiredKeys.has(item.key))) return;
    this.storage.sql.exec(
      "UPDATE materialization_control SET active_final_verification_json = ? WHERE singleton = 1",
      JSON.stringify(desired)
    );
  }

  finalVerificationPending(): FinalVerificationItem[] {
    const row = this.control();
    if (row.active_status !== "verifying") return [];
    return parseFinalVerificationItems(row.active_final_verification_json);
  }

  completeFinalVerification(keys: readonly string[]): void {
    const row = this.control();
    if (row.active_revision === null || row.active_status !== "verifying") {
      throw new Error("Cannot complete final materialization verification without an active verification pass");
    }
    const completed = new Set(keys);
    const remaining = parseFinalVerificationItems(row.active_final_verification_json)
      .filter((item) => !completed.has(item.key));
    this.storage.sql.exec(
      "UPDATE materialization_control SET active_final_verification_json = ? WHERE singleton = 1",
      JSON.stringify(remaining)
    );
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

  immutableDerivativesThrough(): number | null {
    return this.control().active_immutable_revision;
  }

  markImmutableDerivativesThrough(revision: number): void {
    const row = this.control();
    if (row.active_revision === null || !parseRevisionList(row.active_coalesced_json).includes(revision)) {
      throw new Error("Immutable derivative checkpoint does not match active coalesced revision");
    }
    if (row.active_immutable_revision !== null && revision <= row.active_immutable_revision) return;
    this.storage.sql.exec(
      "UPDATE materialization_control SET active_immutable_revision = ? WHERE singleton = 1",
      revision
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
             active_coalesced_json = '[]', active_immutable_revision = NULL, active_final_verification_json = '[]',
             active_managed_zones_ready = 0,
             active_status = NULL, last_error = NULL
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
             active_coalesced_json = '[]', active_immutable_revision = NULL, active_final_verification_json = '[]',
             active_managed_zones_ready = 0,
             active_status = NULL, last_error = NULL
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

  readConvergenceCheckpoint(): { progress: Progress; token: string } | null {
    const row = this.storage.sql.exec<ConvergenceCheckpointRow>(
      "SELECT progress_json, provider_token FROM convergence_checkpoint WHERE singleton = 1"
    ).toArray()[0];
    if (!row) return null;
    const progress = this.parseLocalProgress(row.progress_json);
    return { progress, token: row.provider_token };
  }

  capacitySnapshot(): CapacityLedgerSnapshot {
    const checkpoint = this.storage.sql.exec<ConvergenceCheckpointRow>(
      "SELECT progress_json, provider_token FROM convergence_checkpoint WHERE singleton = 1"
    ).toArray()[0];
    const reservations = this.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      request_id: string;
      request_hash: string;
      reservation_kind: CapacityReservation["reservation_kind"];
      output_cost: number;
      canonical_revision: number;
      target_revision: number | null;
      operation: string;
      resources_json: string;
      dependency_classification: CapacityReservation["dependency_classification"];
      state: CapacityReservation["state"];
      created_at: string;
    }>("SELECT request_id, request_hash, reservation_kind, output_cost, canonical_revision, target_revision, operation, resources_json, dependency_classification, state, created_at FROM capacity_reservations ORDER BY target_revision, request_id")
      .toArray();
    return {
      status: this.status(),
      progress: checkpoint ? this.parseLocalProgress(checkpoint.progress_json) : null,
      provider_token: checkpoint?.provider_token ?? null,
      reservations: reservations.map((row) => ({
        request_id: row.request_id,
        request_hash: row.request_hash,
        reservation_kind: row.reservation_kind,
        output_cost: row.output_cost,
        canonical_revision: row.canonical_revision,
        target_revision: row.target_revision,
        operation: row.operation,
        resources: JSON.parse(row.resources_json) as RuleResource[],
        dependency_classification: row.dependency_classification,
        state: row.state,
        created_at: row.created_at
      }))
    };
  }

  withCapacityReservation<T>(
    evaluate: (snapshot: CapacityLedgerSnapshot) => { value: T; reservation?: Omit<CapacityReservation, "state"> }
  ): T {
    let result!: T;
    this.storage.transactionSync(() => {
      const evaluated = evaluate(this.capacitySnapshot());
      result = evaluated.value;
      if (evaluated.reservation) {
        const reservation = evaluated.reservation;
        const existing = this.capacitySnapshot().reservations.find((item) => item.request_id === reservation.request_id);
        if (existing) {
          if (existing.request_hash !== reservation.request_hash
            || existing.reservation_kind !== reservation.reservation_kind
            || existing.output_cost !== reservation.output_cost
            || existing.canonical_revision !== reservation.canonical_revision
            || existing.target_revision !== reservation.target_revision
            || existing.operation !== reservation.operation
            || existing.dependency_classification !== reservation.dependency_classification
            || JSON.stringify(existing.resources) !== JSON.stringify(reservation.resources)) {
            throw new Error("capacity_reservation_identity_conflict");
          }
        } else {
          this.storage.sql.exec(
            `INSERT INTO capacity_reservations (request_id, request_hash, reservation_kind, output_cost, canonical_revision, target_revision, operation, resources_json, dependency_classification, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
            reservation.request_id,
            reservation.request_hash,
            reservation.reservation_kind,
            reservation.output_cost,
            reservation.canonical_revision,
            reservation.target_revision,
            reservation.operation,
            JSON.stringify(reservation.resources),
            reservation.dependency_classification,
            reservation.created_at
          );
        }
      }
    });
    return result;
  }

  transitionCapacityReservation(
    requestId: string,
    requestHash: string,
    from: CapacityReservation["state"],
    to: CapacityReservation["state"] | "released"
  ): void {
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ [key: string]: SqlStorageValue; request_hash: string; state: string }>(
        "SELECT request_hash, state FROM capacity_reservations WHERE request_id = ?", requestId
      ).toArray()[0];
      if (!row) return;
      if (row.request_hash !== requestHash) throw new Error("capacity_reservation_state_conflict");
      if (to === "released") {
        if (row.state !== from) throw new Error("capacity_reservation_state_conflict");
      } else {
        const rank = { reserved: 0, committed: 1, handed_off: 2 } as const;
        if (rank[row.state as CapacityReservation["state"]] >= rank[to]) return;
        if (row.state !== from) throw new Error("capacity_reservation_state_conflict");
      }
      if (to === "released") this.storage.sql.exec("DELETE FROM capacity_reservations WHERE request_id = ?", requestId);
      else this.storage.sql.exec("UPDATE capacity_reservations SET state = ? WHERE request_id = ?", to, requestId);
    });
  }

  private parseLocalProgress(raw: string): Progress {
    const value = JSON.parse(raw) as { project_id?: unknown };
    const projectId = this.boundProjectId ?? (typeof value.project_id === "string" ? value.project_id : "");
    if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("capacity_checkpoint_project_binding_unavailable");
    return parseProgress(raw, projectId);
  }

  readRepairScanCheckpoint(canonicalRevision: number): MaterializationRepairScanCheckpoint | null {
    const raw = this.control().repair_scan_json;
    if (!raw) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const checkpoint = value as Record<string, unknown>;
    if (checkpoint.canonical_revision !== canonicalRevision || !Number.isSafeInteger(canonicalRevision)
      || typeof checkpoint.scan_complete !== "boolean"
      || (checkpoint.cursor !== null && (typeof checkpoint.cursor !== "string" || checkpoint.cursor.length === 0))) return null;
    const candidate = checkpoint.best_candidate;
    if (candidate !== null && (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !Number.isSafeInteger((candidate as Record<string, unknown>).target_revision)
      || !Number.isSafeInteger((candidate as Record<string, unknown>).projection_version))) return null;
    return checkpoint as unknown as MaterializationRepairScanCheckpoint;
  }

  writeRepairScanCheckpoint(checkpoint: MaterializationRepairScanCheckpoint): void {
    if (!Number.isSafeInteger(checkpoint.canonical_revision) || checkpoint.canonical_revision < 0
      || (checkpoint.cursor !== null && checkpoint.cursor.length > 16_384)
      || (!checkpoint.scan_complete && checkpoint.cursor === null)
      || (checkpoint.best_candidate !== null
        && (!Number.isSafeInteger(checkpoint.best_candidate.target_revision)
          || !Number.isSafeInteger(checkpoint.best_candidate.projection_version)))) {
      throw new Error("Invalid materialization repair-scan checkpoint");
    }
    this.storage.sql.exec("UPDATE materialization_control SET repair_scan_json = ? WHERE singleton = 1", JSON.stringify(checkpoint));
  }

  clearRepairScanCheckpoint(): void {
    this.storage.sql.exec("UPDATE materialization_control SET repair_scan_json = '' WHERE singleton = 1");
  }

  restoreConvergenceCheckpoint(progress: Progress, token: string): void {
    if (!token) throw new Error("Convergence checkpoint requires a provider token");
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO convergence_checkpoint (singleton, progress_json, provider_token)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           progress_json = excluded.progress_json,
           provider_token = excluded.provider_token`,
        JSON.stringify(progress),
        token
      );
      for (const reservation of this.capacitySnapshot().reservations) {
        const targetRevision = reservation.target_revision;
        if (reservation.reservation_kind !== "transaction" || reservation.state !== "handed_off"
          || targetRevision === null || targetRevision > progress.canonical_observed_revision) continue;
        const pendingThroughTarget = Object.values(progress.obligations).some((obligation) =>
          obligation.target.revision >= targetRevision && obligation.state !== "verified"
        );
        if (!pendingThroughTarget) {
          this.storage.sql.exec("DELETE FROM capacity_reservations WHERE request_id = ?", reservation.request_id);
        }
      }
    });
  }

  private control(): ControlRow {
    return this.storage.sql.exec<ControlRow>(
      `SELECT head_revision, head_projection_version, requested_revision, requested_projection_version,
              active_revision, active_projection_version, active_coalesced_json, active_immutable_revision,
              active_verification_epoch, active_final_verification_json, repair_scan_json, active_managed_zones_ready, active_status, last_error
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

function normalizeFinalVerificationItems(items: readonly FinalVerificationItem[]): FinalVerificationItem[] {
  const byKey = new Map<string, FinalVerificationItem>();
  for (const item of items) {
    if (!item.key || (item.expected !== "present" && item.expected !== "absent")) {
      throw new Error("Invalid materialization final verification state");
    }
    if (byKey.has(item.key)) {
      throw new Error(`Duplicate materialization final verification item: ${item.key}`);
    }
    byKey.set(item.key, {
      key: item.key,
      expected: item.expected,
      evidence: { ...item.evidence }
    });
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function parseFinalVerificationItems(raw: string): FinalVerificationItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid materialization final verification state");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid materialization final verification state");
  return normalizeFinalVerificationItems(parsed.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid materialization final verification state");
    const candidate = value as {
      key?: unknown;
      expected?: unknown;
      evidence?: Partial<ProjectionOutputEvidence>;
    };
    const evidence = candidate.evidence;
    if (
      typeof candidate.key !== "string"
      || (candidate.expected !== "present" && candidate.expected !== "absent")
      || !evidence
      || typeof evidence.relative_path !== "string"
      || typeof evidence.input_hash !== "string"
      || typeof evidence.content_hash !== "string"
      || !Number.isSafeInteger(evidence.source_revision)
    ) {
      throw new Error("Invalid materialization final verification state");
    }
    return {
      key: candidate.key,
      expected: candidate.expected,
      evidence: {
        relative_path: evidence.relative_path,
        input_hash: evidence.input_hash,
        content_hash: evidence.content_hash,
        source_revision: evidence.source_revision
      }
    } as FinalVerificationItem;
  }));
}

function integerRange(start: number, end: number): number[] {
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
