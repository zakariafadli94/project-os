import { canonicalJson } from "../materialization/hash";
import {
  convergenceAttemptPath,
  convergenceIncidentPath,
  convergenceNotificationAttemptPath,
  convergenceProgressPath,
  machineConvergenceRoot
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { LAYERS, type AlertProgress, type AttemptReservation, type Obligation, type Progress } from "./contract";
import type { AlertDelivery, AlertRecord } from "./observability";

export class ConvergenceJournal {
  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly projectId: string
  ) {}

  async load(): Promise<{ progress: Progress; token: string } | null> {
    const path = convergenceProgressPath(this.projectId);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const progress = parseProgress(raw, this.projectId);
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata?.revisionToken) throw new Error("journal_progress_token_unavailable");
    return { progress, token: metadata.revisionToken };
  }

  async save(progress: Progress, expectedToken: string | null): Promise<string> {
    assertProgress(progress, this.projectId);
    const path = convergenceProgressPath(this.projectId);
    const content = `${canonicalJson(progress)}\n`;

    if (expectedToken === null) {
      try {
        await this.runtime.objects.createText(path, content);
      } catch (error) {
        const existing = await this.runtime.objects.readText(path);
        if (existing !== content) throw error;
      }
      const metadata = await this.runtime.objects.getMetadata(path);
      if (!metadata?.revisionToken) throw new Error("journal_progress_token_unavailable");
      return metadata.revisionToken;
    }

    const metadata = await this.runtime.conditionalWrite.writeTextConditional(path, content, expectedToken);
    if (!metadata.revisionToken) throw new Error("journal_progress_token_unavailable");
    return metadata.revisionToken;
  }

  async reserve(attempt: AttemptReservation): Promise<void> {
    assertAttempt(attempt, this.projectId);
    const path = convergenceAttemptPath(this.projectId, attempt.obligation_id, attempt.attempt_number);
    const content = `${canonicalJson(attempt)}\n`;
    try {
      await this.runtime.objects.createText(path, content);
      return;
    } catch (error) {
      const existing = await this.runtime.objects.readText(path);
      if (existing === content) return;
      if (existing !== null) throw new Error("journal_integrity_conflict");
      throw error;
    }
  }

  async readAttempt(obligationId: string, attemptNumber: number): Promise<AttemptReservation | null> {
    if (!/^[a-f0-9]{64}$/.test(obligationId) || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new Error("invalid_convergence_attempt_locator");
    }
    const raw = await this.runtime.objects.readText(
      convergenceAttemptPath(this.projectId, obligationId, attemptNumber)
    );
    return raw === null ? null : parseAttempt(raw, this.projectId);
  }

  async recordIncident(alert: AlertRecord): Promise<void> {
    if (alert.project_id !== this.projectId || !/^inc-[a-f0-9]{64}$/.test(alert.incident_id)) {
      throw new Error("journal_incident_binding_mismatch");
    }
    const path = convergenceIncidentPath(this.projectId, alert.incident_id);
    const content = `${canonicalJson(alert)}\n`;
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) throw error;
    }
  }

  async readIncident(incidentId: string): Promise<AlertRecord | null> {
    if (!/^inc-[a-f0-9]{64}$/.test(incidentId)) throw new Error("journal_incident_invalid");
    const raw = await this.runtime.objects.readText(convergenceIncidentPath(this.projectId, incidentId));
    if (raw === null) return null;
    return parseIncident(raw, this.projectId, incidentId);
  }

  async reserveNotification(delivery: AlertDelivery): Promise<void> {
    if (!/^inc-[a-f0-9]{64}$/.test(delivery.incident_id) || delivery.attempt_number < 1) {
      throw new Error("journal_notification_invalid");
    }
    const path = convergenceNotificationAttemptPath(this.projectId, delivery.incident_id, delivery.attempt_number);
    const content = `${canonicalJson(delivery)}\n`;
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) throw error;
    }
  }

  async readNotification(incidentId: string, attemptNumber: number): Promise<AlertDelivery | null> {
    if (!/^inc-[a-f0-9]{64}$/.test(incidentId) || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new Error("journal_notification_invalid");
    }
    const raw = await this.runtime.objects.readText(
      convergenceNotificationAttemptPath(this.projectId, incidentId, attemptNumber)
    );
    return raw === null ? null : parseNotification(raw, incidentId, attemptNumber);
  }

  async listAttempts(obligationId: string): Promise<AttemptReservation[]> {
    if (!/^[a-f0-9]{64}$/.test(obligationId)) throw new Error("invalid_convergence_obligation_id");
    const root = `${machineConvergenceRoot(this.projectId)}/attempts/${obligationId}`;
    const entries = await this.runtime.objects.listChildren(root);
    const attempts = await Promise.all(entries
      .filter((entry) => entry.kind === "file" && entry.path?.endsWith(".json"))
      .map(async (entry) => parseAttempt(await this.runtime.objects.readText(entry.path!), this.projectId)));
    return attempts.sort((left, right) => left.attempt_number - right.attempt_number);
  }
}

export function initialProgress(projectId: string, now: string, incarnation: string): Progress {
  return {
    schema_version: "1.0",
    project_id: projectId,
    incarnation,
    lease_until: now,
    canonical_observed_revision: 0,
    baseline_revision: 0,
    baseline_kind: "commit",
    event_verified_through: 0,
    receipt_verified_through: 0,
    missing_event_ids: [],
    missing_receipt_ids: [],
    active: null,
    requested: null,
    parked: [],
    obligations: {},
    effects: {},
    partial_outputs: {},
    cursors: {},
    last_queue: "human",
    next_alarm_at: null,
    alerts: {},
    first_observed_at: now,
    commit_accepted_at: null,
    last_error_code: null
  };
}

function parseProgress(raw: string, projectId: string): Progress {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_progress_invalid_json");
  }
  assertProgress(value, projectId);
  return value;
}

function parseAttempt(raw: string | null, projectId: string): AttemptReservation {
  if (raw === null) throw new Error("journal_attempt_missing");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_attempt_invalid_json");
  }
  assertAttempt(value, projectId);
  return value;
}

function parseIncident(raw: string, projectId: string, incidentId: string): AlertRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_incident_invalid_json");
  }
  if (!isRecord(value)) throw new Error("journal_incident_invalid");
  const incident = value as Partial<AlertRecord>;
  if (
    incident.schema_version !== "1.0"
    || incident.project_id !== projectId
    || incident.incident_id !== incidentId
    || !isNonNegativeInteger(incident.incident)
    || !isStringArray(incident.layers)
    || typeof incident.created_at !== "string"
    || typeof incident.code !== "string"
    || typeof incident.relative_path !== "string"
    || incident.owner !== "MaterializationGuard"
    || typeof incident.diagnostic_path !== "string"
    || typeof incident.deployment_sha !== "string"
  ) throw new Error("journal_incident_invalid");
  return incident as AlertRecord;
}

function parseNotification(raw: string, incidentId: string, attemptNumber: number): AlertDelivery {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_notification_invalid_json");
  }
  if (!isRecord(value)) throw new Error("journal_notification_invalid");
  const delivery = value as Partial<AlertDelivery>;
  if (
    delivery.incident_id !== incidentId
    || delivery.attempt_number !== attemptNumber
    || (delivery.state !== "pending" && delivery.state !== "acknowledged")
    || !isNullableString(delivery.delivery_id)
    || typeof delivery.last_attempt_at !== "string"
    || !isNullableString(delivery.acknowledged_at)
  ) throw new Error("journal_notification_invalid");
  return delivery as AlertDelivery;
}

function assertProgress(value: unknown, projectId: string): asserts value is Progress {
  if (!value || typeof value !== "object") throw new Error("journal_progress_invalid");
  const progress = value as Partial<Progress>;
  if (progress.schema_version !== "1.0" || progress.project_id !== projectId || typeof progress.incarnation !== "string") {
    throw new Error("journal_progress_binding_mismatch");
  }
  if (
    typeof progress.lease_until !== "string"
    || !isNonNegativeInteger(progress.canonical_observed_revision)
    || !isNonNegativeInteger(progress.baseline_revision)
    || (progress.baseline_kind !== "commit" && progress.baseline_kind !== "pre_commit001")
    || !isNonNegativeInteger(progress.event_verified_through)
    || !isNonNegativeInteger(progress.receipt_verified_through)
    || !isStringArray(progress.missing_event_ids)
    || !isStringArray(progress.missing_receipt_ids)
    || !isTargetOrNull(progress.active)
    || !isTargetOrNull(progress.requested)
    || !Array.isArray(progress.parked)
    || !progress.parked.every(isTarget)
    || !isObligations(progress.obligations)
    || !isEffects(progress.effects)
    || !isRecord(progress.partial_outputs)
    || !isNullableStringRecord(progress.cursors)
    || (progress.last_queue !== "machine" && progress.last_queue !== "human")
    || !isNullableString(progress.next_alarm_at)
    || !isAlerts(progress.alerts)
    || typeof progress.first_observed_at !== "string"
    || !isNullableString(progress.commit_accepted_at)
    || !isNullableString(progress.last_error_code)
  ) throw new Error("journal_progress_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTarget(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.revision)
    && isNonNegativeInteger(value.projection_version)
    && value.projection_version >= 1;
}

function isTargetOrNull(value: unknown): boolean {
  return value === null || isTarget(value);
}

function isNullableStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isNullableString);
}

function isEffects(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((effect) => {
    if (!isRecord(effect)) return false;
    return typeof effect.id === "string"
      && typeof effect.path === "string"
      && isNullableString(effect.destination)
      && (effect.kind === "create" || effect.kind === "replace" || effect.kind === "delete" || effect.kind === "move")
      && isNullableString(effect.object_id)
      && isNullableString(effect.expected_token)
      && isNullableString(effect.desired_hash)
      && isNullableString(effect.authorized_previous_hash)
      && (effect.state === "prepared" || effect.state === "uncertain" || effect.state === "verified" || effect.state === "neutralized" || effect.state === "blocked")
      && isNullableString(effect.verified_token);
  });
}

function isObligations(value: unknown): value is Record<string, Obligation> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([id, obligation]) => {
    if (!/^[a-f0-9]{64}$/.test(id) || !isRecord(obligation)) return false;
    return obligation.id === id
      && typeof obligation.layer === "string"
      && (LAYERS as readonly string[]).includes(obligation.layer)
      && isNonNegativeInteger(obligation.from_revision)
      && isTarget(obligation.target)
      && isNonNegativeInteger(obligation.incident)
      && obligation.incident >= 1
      && (obligation.state === "pending" || obligation.state === "running" || obligation.state === "retry_wait" || obligation.state === "exhausted" || obligation.state === "blocked" || obligation.state === "verified")
      && typeof obligation.first_pending_at === "string"
      && isNullableString(obligation.next_attempt_at)
      && isNonNegativeInteger(obligation.failure_count)
      && isNonNegativeInteger(obligation.last_attempt_number)
      && isNonNegativeInteger(obligation.last_closed_attempt_number)
      && isNullableString(obligation.last_verified_at)
      && isNullableString(obligation.code)
      && isNullableString(obligation.lease_until)
      && isNullableString(obligation.continuation);
  });
}

function isAlerts(value: unknown): value is Record<string, AlertProgress> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([incidentId, alert]) => {
    if (!/^inc-[a-f0-9]{64}$/.test(incidentId) || !isRecord(alert)) return false;
    return isNonNegativeInteger(alert.incident)
      && alert.incident >= 1
      && Array.isArray(alert.layers)
      && alert.layers.every((layer) => typeof layer === "string" && (LAYERS as readonly string[]).includes(layer))
      && typeof alert.created_at === "string"
      && typeof alert.notification_pending === "boolean"
      && isNullableString(alert.delivered_at)
      && isNullableString(alert.resolved_at)
      && isNullableString(alert.next_attempt_at)
      && isNonNegativeInteger(alert.failure_count);
  });
}

function assertAttempt(value: unknown, projectId: string): asserts value is AttemptReservation {
  if (!value || typeof value !== "object") throw new Error("journal_attempt_invalid");
  const attempt = value as Partial<AttemptReservation>;
  if (
    attempt.schema_version !== "1.0"
    || attempt.project_id !== projectId
    || !attempt.obligation_id?.match(/^[a-f0-9]{64}$/)
    || !Number.isSafeInteger(attempt.attempt_number)
    || !attempt.target
  ) {
    throw new Error("journal_attempt_binding_mismatch");
  }
}
