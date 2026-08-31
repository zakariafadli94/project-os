import { z } from "zod";
import { intakeIdFor, type IntakeHealthRecord, type IntakeRecord } from "../domain/intake";
import {
  machineIntakeHealthPath,
  machineIntakeRecordPath,
  machineIntakeRoot,
  machineReferralProvenancePath
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import { parseIntakeHealthRecord, parseIntakeRecord } from "../schema/intake";

export interface IntakeObservation {
  project_id: string;
  provider_id: string;
  object_id: string;
  revision_token: string;
  logical_input_path: string;
  observed_at: string;
}

export interface ReferralProvenanceRecord {
  schema_version: "1.0";
  referral_id: string;
  project_id: string;
  document_id: string;
  version_id: string;
  source_input_path: string;
  source_provider_id: string;
  source_object_id: string;
  source_revision_token: string;
  legacy_derived: boolean;
}

const provenanceSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  referral_id: z.string().regex(/^REF-[A-Z0-9-]{8,}$/),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  document_id: z.string().regex(/^DOC-[A-F0-9]{24}$/),
  version_id: z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/),
  source_input_path: z.string().min(1),
  source_provider_id: z.string().min(1),
  source_object_id: z.string().min(1),
  source_revision_token: z.string().min(1),
  legacy_derived: z.boolean()
});

const observationSchema = z.strictObject({
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  provider_id: z.string().min(1),
  object_id: z.string().min(1),
  revision_token: z.string().min(1),
  logical_input_path: z.string().min(1),
  observed_at: z.string().datetime({ offset: true })
});

export class IntakeRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
  }

  async beginObservation(input: IntakeObservation): Promise<IntakeRecord> {
    const observation = observationSchema.parse(input);
    const intakeId = await intakeIdFor(
      observation.project_id,
      observation.provider_id,
      observation.object_id,
      observation.revision_token
    );
    const record = parseIntakeRecord({
      schema_version: "1.0",
      intake_id: intakeId,
      project_id: observation.project_id,
      provider_id: observation.provider_id,
      object_id: observation.object_id,
      revision_token: observation.revision_token,
      logical_input_path: observation.logical_input_path,
      first_seen_at: observation.observed_at,
      attempt_count: 0,
      state: "observed"
    });
    const path = machineIntakeRecordPath(record.project_id, record.intake_id);

    try {
      await this.runtime.objects.createText(path, pretty(record));
      return record;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.read(record.project_id, record.intake_id);
      if (!existing || !sameObservation(existing, record)) {
        throw new Error(`Intake identity collision or contradictory observation: ${record.intake_id}`);
      }
      return existing;
    }
  }

  async read(projectId: string, intakeId: string): Promise<IntakeRecord | null> {
    const raw = await this.runtime.objects.readText(machineIntakeRecordPath(projectId, intakeId));
    if (raw === null) return null;
    const record = parseIntakeRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.intake_id !== intakeId) {
      throw new Error(`Intake record binding mismatch: ${projectId}/${intakeId}`);
    }
    return record;
  }

  async list(projectId: string): Promise<IntakeRecord[]> {
    const entries = await this.runtime.objects.listChildren(`${machineIntakeRoot(projectId)}/records`);
    const records: IntakeRecord[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const match = /^(INTAKE-[A-F0-9]{24})\.json$/.exec(entry.name);
      if (!match) continue;
      const record = await this.read(projectId, match[1]);
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.intake_id.localeCompare(right.intake_id));
  }

  async write(input: IntakeRecord): Promise<IntakeRecord> {
    const next = parseIntakeRecord(input);
    const current = await this.read(next.project_id, next.intake_id);
    if (!current) throw new Error(`Intake record does not exist: ${next.intake_id}`);
    assertSameIntakeIdentity(current, next);
    assertAllowedTransition(current, next);
    await this.runtime.objects.upsertText(
      machineIntakeRecordPath(next.project_id, next.intake_id),
      pretty(next)
    );
    return next;
  }

  async readHealth(projectId: string): Promise<IntakeHealthRecord | null> {
    const raw = await this.runtime.objects.readText(machineIntakeHealthPath(projectId));
    if (raw === null) return null;
    const health = parseIntakeHealthRecord(JSON.parse(raw));
    if (health.project_id !== projectId) {
      throw new Error(`Intake health binding mismatch: expected ${projectId}, got ${health.project_id}`);
    }
    return health;
  }

  async writeHealth(input: IntakeHealthRecord): Promise<IntakeHealthRecord> {
    const health = parseIntakeHealthRecord(input);
    await this.runtime.objects.upsertText(machineIntakeHealthPath(health.project_id), pretty(health));
    return health;
  }

  async readReferralProvenance(projectId: string, referralId: string): Promise<ReferralProvenanceRecord | null> {
    const raw = await this.runtime.objects.readText(machineReferralProvenancePath(projectId, referralId));
    if (raw === null) return null;
    const record = provenanceSchema.parse(JSON.parse(raw));
    if (record.project_id !== projectId || record.referral_id !== referralId) {
      throw new Error(`Referral provenance binding mismatch: ${projectId}/${referralId}`);
    }
    return record;
  }

  async writeReferralProvenance(input: ReferralProvenanceRecord): Promise<void> {
    const record = provenanceSchema.parse(input);
    const path = machineReferralProvenancePath(record.project_id, record.referral_id);
    const content = pretty(record);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readReferralProvenance(record.project_id, record.referral_id);
      if (!existing || pretty(existing) !== content) {
        throw new Error(`Immutable referral provenance conflict with different content: ${path}`);
      }
    }
  }
}

export async function legacyReferralIdFor(
  projectId: string,
  providerId: string,
  objectId: string
): Promise<string> {
  if (!projectId || !providerId || !objectId) {
    throw new Error("Legacy referral identity requires project, provider and object identity");
  }
  const bytes = new TextEncoder().encode(`${projectId}\n${providerId}\n${objectId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `REF-LEGACY-${hex.slice(0, 24)}`;
}

function sameObservation(left: IntakeRecord, right: IntakeRecord): boolean {
  return left.project_id === right.project_id
    && left.provider_id === right.provider_id
    && left.object_id === right.object_id
    && left.revision_token === right.revision_token
    && left.logical_input_path === right.logical_input_path;
}

function assertSameIntakeIdentity(current: IntakeRecord, next: IntakeRecord): void {
  if (!sameObservation(current, next) || current.first_seen_at !== next.first_seen_at) {
    throw new Error(`Intake identity fields are immutable: ${current.intake_id}`);
  }
  if (next.attempt_count < current.attempt_count) {
    throw new Error(`Intake attempt_count cannot decrease: ${current.intake_id}`);
  }
}

function assertAllowedTransition(current: IntakeRecord, next: IntakeRecord): void {
  if (current.state === "ingested" || current.state === "duplicate") {
    if (pretty(current) === pretty(next)) return;
    throw new Error(`Intake terminal state cannot transition: ${current.state} -> ${next.state}`);
  }

  if (current.state === "failed" && current.retryable !== true) {
    if (next.state === "failed") return;
    throw new Error(`Non-retryable intake failure is terminal for automatic transition: ${current.intake_id}`);
  }

  if (current.state === "failed" && current.retryable === true) {
    if (next.state !== "processing" && next.state !== "failed") {
      throw new Error(`Retryable failed intake must resume through processing: failed -> ${next.state}`);
    }
    return;
  }

  const allowed = current.state === "observed"
    ? new Set(["observed", "processing", "failed"])
    : new Set(["processing", "failed", "ingested", "duplicate"]);
  if (!allowed.has(next.state)) {
    throw new Error(`Invalid intake transition: ${current.state} -> ${next.state}`);
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
