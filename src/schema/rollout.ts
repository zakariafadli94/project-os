import {
  assertWriterStageAtLeast,
  parseSchemaWriterStage,
  type SchemaWriterStage
} from "./writer-stage";

const ROLLOUT_STORAGE_VERSION = 1;

interface RolloutControlRow {
  [key: string]: SqlStorageValue;
  storage_version: number;
  frontier: string;
}

export interface SchemaRolloutStatus {
  storage_version: number;
  frontier: SchemaWriterStage;
}

export interface SchemaDiagnosticInput {
  projectId: string | null;
  family: string;
  encounteredVersion: string | null;
  semanticVersion: string;
  canonicalRevision: number | null;
  deploymentIdentity: string;
  failureClass: string;
  writerStage: SchemaWriterStage;
  frontier: SchemaWriterStage;
}

export function initializeSchemaRolloutStorage(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_rollout_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      storage_version INTEGER NOT NULL,
      frontier TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_rollout_control (singleton, storage_version, frontier)
    VALUES (1, ${ROLLOUT_STORAGE_VERSION}, 'v1_only');
  `);
}

export class SchemaRolloutState {
  constructor(private readonly storage: DurableObjectStorage) {}

  status(): SchemaRolloutStatus {
    const row = this.storage.sql.exec<RolloutControlRow>(
      "SELECT storage_version, frontier FROM schema_rollout_control WHERE singleton = 1"
    ).toArray()[0];
    if (!row) throw new Error("Schema rollout storage is not initialized");
    if (row.storage_version !== ROLLOUT_STORAGE_VERSION) {
      throw new Error(
        `Unsupported schema rollout storage version: ${row.storage_version}; current=${ROLLOUT_STORAGE_VERSION}`
      );
    }
    return {
      storage_version: row.storage_version,
      frontier: parseSchemaWriterStage(row.frontier)
    };
  }

  assertConfiguredStage(configured: SchemaWriterStage): void {
    const { frontier } = this.status();
    try {
      assertWriterStageAtLeast(configured, frontier);
    } catch {
      throw new Error(
        `Schema writer stage regression is forbidden after durable frontier ${frontier}: configured=${configured}`
      );
    }
  }

  noteDurableWrite(stage: SchemaWriterStage): void {
    const current = this.status().frontier;
    try {
      assertWriterStageAtLeast(stage, current);
    } catch {
      return;
    }
    if (stage === current) return;
    this.storage.sql.exec(
      "UPDATE schema_rollout_control SET frontier = ? WHERE singleton = 1",
      stage
    );
  }
}

export function schemaDiagnostic(input: SchemaDiagnosticInput) {
  return {
    project_id: input.projectId,
    family: input.family,
    encountered_version: input.encounteredVersion,
    semantic_version: input.semanticVersion,
    canonical_revision: input.canonicalRevision,
    deployment_identity: input.deploymentIdentity,
    failure_class: input.failureClass,
    active_writer_stage: input.writerStage,
    frontier: input.frontier
  };
}
