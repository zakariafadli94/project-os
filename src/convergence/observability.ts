import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { convergenceIncidentPath } from "../persistence/layout";
import { sha256Canonical } from "../materialization/hash";
import { LAYERS, type AlertProgress, type ConvergenceHealth, type Evidence, type Layer, type Progress } from "./contract";
import { deterministicRetryJitter, nextRetryAt } from "./retry";

const MONITORING_DELIVERY_TIMEOUT_MS = 5_000;

export interface CommitClock {
  t0: string | null;
  first_observed_at: string;
  code: "commit_time_unknown" | null;
}

/**
 * The client supplied transaction timestamp is not evidence of server-side
 * publication. Prefer the durable acceptance timestamp, then immutable
 * provider metadata, and otherwise make the unknown state explicit.
 */
export function commitClock(
  acceptedAt: string | null,
  immutableMetadata: ProviderObjectMetadata | null,
  firstObservedAt: string
): CommitClock {
  const candidate = acceptedAt ?? immutableMetadata?.modifiedAt ?? null;
  const t0 = candidate !== null && Number.isFinite(Date.parse(candidate)) ? candidate : null;
  return {
    t0,
    first_observed_at: firstObservedAt,
    code: t0 === null ? "commit_time_unknown" : null
  };
}

/**
 * Pending age is calculated from the durable journal, not process-local
 * timers, so a Durable Object eviction cannot reset the incident clock.
 */
export function oldestPendingAgeMs(progress: Progress, nowMs: number): number {
  const pendingAt = Object.values(progress.obligations)
    .filter((obligation) => obligation.state !== "verified")
    .map((obligation) => Date.parse(obligation.first_pending_at))
    .filter(Number.isFinite);
  return pendingAt.length === 0 ? 0 : Math.max(0, nowMs - Math.min(...pendingAt));
}

export type ConvergenceMetricName =
  | "commit_observed"
  | "obligations_verified"
  | "retries"
  | "exhaustions"
  | "layer_conflicts"
  | "handoff_failures"
  | "freshness_rejections"
  | "conditional_write_conflicts"
  | "commit_to_layer_verified"
  | "tranche_duration"
  | "lag_revisions"
  | "oldest_pending_seconds"
  | "queue_depth"
  | "due_without_alarm"
  | "fleet_last_success_age"
  | "audit_cursor_age";

export interface ConvergenceTelemetryFields {
  project_id: string | null;
  target_revision: number | null;
  observed_revision: number | null;
  layer: Layer | null;
  projection_version: number | null;
  generation_id: string | null;
  transaction_id: string | null;
  event_id: string | null;
  attempt_number: number | null;
  code: string | null;
  next_attempt_at: string | null;
  oldest_pending_at: string | null;
  deployment_sha: string;
  provider_calls: number;
  correlation_id: string | null;
}

export interface ConvergenceMetric {
  schema_version: "1.0";
  name: ConvergenceMetricName;
  kind: "counter" | "histogram" | "gauge";
  value: number;
  labels: { layer: Layer | null; code: string | null; cause: string | null };
  fields: ConvergenceTelemetryFields;
}

/** The owner may export these structured samples to its monitoring backend. */
export interface ConvergenceTelemetry {
  emit(metric: ConvergenceMetric): void;
}

export interface ConvergenceTelemetrySnapshotInput {
  progress: Progress;
  health: ConvergenceHealth;
  nowMs: number;
  startedAtMs: number;
  providerCalls: number;
  deploymentSha: string;
  fleetLastSuccessAt?: string | null;
  correlationId?: string | null;
  counters: Record<Extract<ConvergenceMetricName,
    "commit_observed" | "obligations_verified" | "retries" | "exhaustions" | "layer_conflicts"
    | "handoff_failures" | "freshness_rejections" | "conditional_write_conflicts">, number>;
}

/**
 * Returns only the allowlisted telemetry shape.  It deliberately takes no
 * Error, Request, provider response, or payload object, so those values
 * cannot be accidentally spread into runtime logs or metric labels.
 */
export function convergenceTelemetrySnapshot(input: ConvergenceTelemetrySnapshotInput): ConvergenceMetric[] {
  const pending = Object.values(input.progress.obligations)
    .filter((obligation) => obligation.state !== "verified")
    .sort((left, right) => Date.parse(left.first_pending_at) - Date.parse(right.first_pending_at));
  const focus = pending[0] ?? null;
  const targetRevision = Math.max(
    0,
    ...Object.values(input.progress.obligations).map((obligation) => obligation.target.revision),
    ...LAYERS.map((layer) => input.health.layers[layer].expected.revision ?? 0)
  ) || null;
  const observedRevision = Math.max(
    0,
    ...LAYERS.map((layer) => input.health.layers[layer].observed.revision ?? 0)
  ) || null;
  const focusLayer = focus?.layer ?? LAYERS.find((layer) => input.health.layers[layer].state !== "current") ?? null;
  const focusHealth = focusLayer === null ? null : input.health.layers[focusLayer];
  const oldestPendingAt = focus?.first_pending_at ?? null;
  const fields: ConvergenceTelemetryFields = {
    project_id: input.progress.project_id,
    target_revision: targetRevision,
    observed_revision: observedRevision,
    layer: focusLayer,
    projection_version: focus?.target.projection_version ?? focusHealth?.expected.projection_version ?? null,
    generation_id: null,
    transaction_id: null,
    event_id: null,
    attempt_number: focus?.last_attempt_number ?? null,
    code: focus?.code ?? focusHealth?.code ?? null,
    next_attempt_at: focus?.next_attempt_at ?? null,
    oldest_pending_at: oldestPendingAt,
    deployment_sha: input.deploymentSha,
    provider_calls: input.providerCalls,
    correlation_id: input.correlationId ?? null
  };
  const labels = {
    layer: fields.layer,
    code: fields.code,
    cause: fields.code
  };
  const sample = (
    name: ConvergenceMetricName,
    kind: ConvergenceMetric["kind"],
    value: number
  ): ConvergenceMetric => ({ schema_version: "1.0", name, kind, value, labels, fields });
  const metricNames = [
    "commit_observed",
    "obligations_verified",
    "retries",
    "exhaustions",
    "layer_conflicts",
    "handoff_failures",
    "freshness_rejections",
    "conditional_write_conflicts"
  ] as const;
  const metrics: ConvergenceMetric[] = metricNames.map((name) => sample(name, "counter", input.counters[name]));
  const durationSeconds = Math.max(0, input.nowMs - input.startedAtMs) / 1_000;
  metrics.push(sample("tranche_duration", "histogram", durationSeconds));
  // A slice which observes all layers as current is itself the verified
  // observation, even when it had no persisted retry obligation to close.
  // Otherwise retain the durable verification timestamp of the repaired layer.
  const verifiedAt = input.health.converged
    ? input.nowMs
    : Object.values(input.progress.obligations)
      .filter((obligation) => obligation.state === "verified" && obligation.last_verified_at !== null)
      .map((obligation) => Date.parse(obligation.last_verified_at as string))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0] ?? null;
  const commitAt = input.progress.commit_accepted_at === null
    ? null
    : Date.parse(input.progress.commit_accepted_at);
  if (verifiedAt !== null && commitAt !== null && Number.isFinite(commitAt)) {
    metrics.push(sample("commit_to_layer_verified", "histogram", Math.max(0, verifiedAt - commitAt) / 1_000));
  }
  const oldestPendingSeconds = oldestPendingAt === null ? 0 : oldestPendingAgeMs(input.progress, input.nowMs) / 1_000;
  metrics.push(sample("oldest_pending_seconds", "gauge", oldestPendingSeconds));
  metrics.push(sample(
    "lag_revisions",
    "gauge",
    targetRevision === null || observedRevision === null ? 0 : Math.max(0, targetRevision - observedRevision)
  ));
  metrics.push(sample("queue_depth", "gauge", pending.length));
  metrics.push(sample("due_without_alarm", "gauge", input.health.due_without_alarm ? 1 : 0));
  if (input.fleetLastSuccessAt !== undefined) {
    const fleetAt = input.fleetLastSuccessAt === null ? Number.NaN : Date.parse(input.fleetLastSuccessAt);
    metrics.push(sample(
      "fleet_last_success_age",
      "gauge",
      Number.isFinite(fleetAt) ? Math.max(0, input.nowMs - fleetAt) / 1_000 : -1
    ));
  }
  const auditAt = latestAuditCompletion(input.progress);
  if (auditAt !== undefined) {
    const parsedAuditAt = auditAt === null ? Number.NaN : Date.parse(auditAt);
    metrics.push(sample(
      "audit_cursor_age",
      "gauge",
      Number.isFinite(parsedAuditAt) ? Math.max(0, input.nowMs - parsedAuditAt) / 1_000 : -1
    ));
  }
  return metrics;
}

/** Reads completed audit timestamps from the typed audit cursors only. */
function latestAuditCompletion(progress: Progress): string | null | undefined {
  const completed: string[] = [];
  let sawAuditCursor = false;
  for (const [name, raw] of Object.entries(progress.cursors)) {
    if (!name.startsWith("audit:")) continue;
    sawAuditCursor = true;
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw) as { completed_at?: unknown };
      if (typeof value.completed_at === "string" && Number.isFinite(Date.parse(value.completed_at))) {
        completed.push(value.completed_at);
      }
    } catch {
      // A malformed technical cursor is represented as an unknown age, not a
      // fabricated timestamp.
    }
  }
  if (completed.length === 0) return sawAuditCursor ? null : undefined;
  return completed.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

/**
 * Monitoring must never become a new availability dependency for convergence.
 * A sink error is intentionally contained after the immutable journal has
 * remained the source of truth for the slice.
 */
export function publishConvergenceTelemetry(
  telemetry: ConvergenceTelemetry | undefined,
  input: ConvergenceTelemetrySnapshotInput
): void {
  if (!telemetry) return;
  for (const metric of convergenceTelemetrySnapshot(input)) {
    try {
      telemetry.emit(metric);
    } catch {
      // A telemetry outage is represented by durable incidents, not by
      // interrupting the repair owner or leaking sink-specific diagnostics.
    }
  }
}

/**
 * Cloudflare captures structured Worker logs as a monitoring source. This is
 * useful for metrics export, but is deliberately not an alert acknowledgement
 * channel and therefore cannot satisfy the rollout ACK gate by itself.
 */
export function workerLogConvergenceTelemetry(): ConvergenceTelemetry {
  return {
    emit(metric) {
      console.info("Project OS convergence metric", metric);
    }
  };
}

/** Emits one safe counter for a rejected strict-admission attempt. */
export function freshnessRejectionMetric(input: {
  projectId: string;
  targetRevision: number | null;
  observedRevision: number | null;
  code: string;
  deploymentSha: string;
}): ConvergenceMetric {
  const fields: ConvergenceTelemetryFields = {
    project_id: input.projectId,
    target_revision: input.targetRevision,
    observed_revision: input.observedRevision,
    layer: "canonical",
    projection_version: null,
    generation_id: null,
    transaction_id: null,
    event_id: null,
    attempt_number: null,
    code: input.code,
    next_attempt_at: null,
    oldest_pending_at: null,
    deployment_sha: input.deploymentSha,
    provider_calls: 0,
    correlation_id: null
  };
  return {
    schema_version: "1.0",
    name: "freshness_rejections",
    kind: "counter",
    value: 1,
    labels: { layer: "canonical", code: input.code, cause: input.code },
    fields
  };
}

/** The fleet is global, so its safe telemetry deliberately has no project ID. */
export function fleetLastSuccessMetric(input: {
  lastSuccessAt: string | null;
  nowMs: number;
  deploymentSha: string;
}): ConvergenceMetric {
  const parsed = input.lastSuccessAt === null ? Number.NaN : Date.parse(input.lastSuccessAt);
  const code = Number.isFinite(parsed) ? null : "fleet_success_unknown";
  const fields: ConvergenceTelemetryFields = {
    project_id: null,
    target_revision: null,
    observed_revision: null,
    layer: "scheduler",
    projection_version: null,
    generation_id: null,
    transaction_id: null,
    event_id: null,
    attempt_number: null,
    code,
    next_attempt_at: null,
    oldest_pending_at: null,
    deployment_sha: input.deploymentSha,
    provider_calls: 0,
    correlation_id: null
  };
  return {
    schema_version: "1.0",
    name: "fleet_last_success_age",
    kind: "gauge",
    value: Number.isFinite(parsed) ? Math.max(0, input.nowMs - parsed) / 1_000 : -1,
    labels: { layer: "scheduler", code, cause: code },
    fields
  };
}

export interface AlertRecord {
  schema_version: "1.0";
  project_id: string;
  incident_id: string;
  incident: number;
  layers: Layer[];
  created_at: string;
  code: string;
  relative_path: string;
  expected: Evidence;
  observed: Evidence;
  last_success_at: string | null;
  owner: "MaterializationGuard";
  diagnostic_path: string;
  deployment_sha: string;
}

export interface AlertInput {
  projectId: string;
  layer: Layer;
  incident: number;
  createdAt: string;
  code: string;
  relativePath: string;
  expected: Evidence;
  observed: Evidence;
  lastSuccessAt: string | null;
  deploymentSha: string;
}

export interface NotificationPort {
  deliver(alert: AlertRecord, deliveryId: string | null): Promise<{
    acknowledged: boolean;
    delivery_id: string | null;
  }>;
}

export interface MonitoringNotificationConfig {
  endpoint: string | undefined;
  token: string | undefined;
  fetch?: typeof globalThis.fetch;
}

/**
 * A deployment may opt into any HTTPS monitoring receiver that implements the
 * narrow ACK contract. Missing configuration deliberately leaves delivery
 * pending; it never turns a console log into a qualified acknowledgement.
 */
export function monitoringNotificationPort(config: MonitoringNotificationConfig): NotificationPort | undefined {
  if (!config.endpoint || !config.token) return undefined;
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:") throw new Error("monitoring_endpoint_must_use_https");
  const send = config.fetch ?? globalThis.fetch;
  return {
    async deliver(alert, deliveryId) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("monitoring_delivery_timeout"));
        }, MONITORING_DELIVERY_TIMEOUT_MS);
      });
      try {
        const response = await Promise.race([
          send(url.toString(), {
            method: "POST",
            headers: {
              "authorization": `Bearer ${config.token}`,
              "content-type": "application/json",
              "idempotency-key": deliveryId ?? alert.incident_id
            },
            body: JSON.stringify(alert),
            signal: controller.signal
          }),
          deadline
        ]);
        if (!response.ok) return { acknowledged: false, delivery_id: deliveryId };
        let body: unknown;
        try {
          // The response body is still part of the monitoring interaction.
          // Keep the original deadline active until its ACK is fully parsed.
          body = await Promise.race([response.json(), deadline]);
        } catch {
          return { acknowledged: false, delivery_id: deliveryId };
        }
        if (!body || typeof body !== "object") return { acknowledged: false, delivery_id: deliveryId };
        const acknowledgement = body as { acknowledged?: unknown; delivery_id?: unknown };
        const returnedId = typeof acknowledgement.delivery_id === "string" ? acknowledgement.delivery_id : null;
        return {
          acknowledged: acknowledgement.acknowledged === true && returnedId === (deliveryId ?? alert.incident_id),
          delivery_id: returnedId ?? deliveryId
        };
      } catch {
        return { acknowledged: false, delivery_id: deliveryId };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
  };
}

export interface AlertDelivery {
  incident_id: string;
  state: "pending" | "acknowledged";
  delivery_id: string | null;
  attempt_number: number;
  last_attempt_at: string;
  acknowledged_at: string | null;
}

export interface NotificationReservationPort {
  reserveNotification(delivery: AlertDelivery): Promise<void>;
  readNotification(incidentId: string, attemptNumber: number): Promise<AlertDelivery | null>;
}

/** An alert is required after 600 seconds, or immediately for terminal states. */
export function shouldOpenAlert(progress: Progress, nowMs: number): boolean {
  return Object.values(progress.obligations).some((obligation) =>
    obligation.state === "exhausted"
    || obligation.state === "blocked"
    || nowMs - Date.parse(obligation.first_pending_at) > 600_000
  );
}

/**
 * Derives only the incident payload that is safe to persist or send. The
 * caller owns immutable persistence and delivery; this keeps an unavailable
 * monitoring integration from hiding a durable convergence failure.
 */
export async function dueAlerts(
  progress: Progress,
  health: ConvergenceHealth,
  nowMs: number,
  deploymentSha: string
): Promise<AlertRecord[]> {
  const createdAt = new Date(nowMs).toISOString();
  const alerts: AlertRecord[] = [];
  for (const obligation of Object.values(progress.obligations)) {
    if (obligation.state === "verified") continue;
    const overdue = nowMs - Date.parse(obligation.first_pending_at) > 600_000;
    if (obligation.state !== "exhausted" && obligation.state !== "blocked" && !overdue) continue;
    const layer = health.layers[obligation.layer];
    alerts.push(await buildAlertRecord({
      projectId: progress.project_id,
      layer: obligation.layer,
      incident: obligation.incident,
      createdAt,
      code: obligation.code ?? "convergence_pending",
      relativePath: `convergence/${obligation.layer}`,
      expected: layer.expected,
      observed: layer.observed,
      lastSuccessAt: layer.last_verified_at,
      deploymentSha
    }));
  }
  return alerts;
}

/**
 * Incident IDs deliberately exclude payloads and client supplied text. This
 * makes retries idempotent and prevents sensitive content entering telemetry.
 */
export async function buildAlertRecord(input: AlertInput): Promise<AlertRecord> {
  const fingerprint = await sha256Canonical({
    project_id: input.projectId,
    layer: input.layer,
    incident: input.incident,
    relative_path: input.relativePath
  });
  const incidentId = `inc-${fingerprint}`;
  return {
    schema_version: "1.0",
    project_id: input.projectId,
    incident_id: incidentId,
    incident: input.incident,
    layers: [input.layer],
    created_at: input.createdAt,
    code: input.code,
    relative_path: input.relativePath,
    expected: input.expected,
    observed: input.observed,
    last_success_at: input.lastSuccessAt,
    owner: "MaterializationGuard",
    diagnostic_path: convergenceIncidentPath(input.projectId, incidentId),
    deployment_sha: input.deploymentSha
  };
}

export async function deliverAlert(
  port: NotificationPort,
  alert: AlertRecord,
  previous: AlertDelivery | null,
  now: string
): Promise<AlertDelivery> {
  const result = await port.deliver(alert, previous?.delivery_id ?? null);
  return {
    incident_id: alert.incident_id,
    state: result.acknowledged ? "acknowledged" : "pending",
    delivery_id: result.delivery_id ?? previous?.delivery_id ?? null,
    attempt_number: (previous?.attempt_number ?? 0) + 1,
    last_attempt_at: now,
    acknowledged_at: result.acknowledged ? now : null
  };
}

/**
 * The immutable incident and a durable send reservation both precede the
 * monitoring side effect. The generated delivery id remains stable across an
 * ambiguous or lost acknowledgement, so a receiver can deduplicate retries.
 */
export async function dispatchAlertDelivery(input: {
  alert: AlertRecord;
  previous: AlertProgress;
  journal: NotificationReservationPort;
  port: NotificationPort | undefined;
  nowMs: number;
}): Promise<AlertProgress> {
  const { alert, previous, journal, port, nowMs } = input;
  if (!previous.notification_pending || previous.resolved_at !== null) return previous;
  if (previous.next_attempt_at !== null && Date.parse(previous.next_attempt_at) > nowMs) return previous;

  const now = new Date(nowMs).toISOString();
  const attemptNumber = previous.failure_count + 1;
  // With no receiver there is no external effect to reserve. Keep the alert
  // pending without spending provider calls on an impossible delivery.
  if (!port) return pendingAlertProgress(previous, alert.incident_id, attemptNumber, nowMs);
  const candidate: AlertDelivery = {
    incident_id: alert.incident_id,
    state: "pending",
    delivery_id: `delivery-${alert.incident_id}`,
    attempt_number: attemptNumber,
    last_attempt_at: now,
    acknowledged_at: null
  };
  const persisted = await journal.readNotification(alert.incident_id, attemptNumber);
  if (persisted && (persisted.delivery_id !== candidate.delivery_id || persisted.state !== "pending")) {
    throw new Error("journal_notification_binding_conflict");
  }
  const reservation = persisted ?? candidate;
  if (!persisted) await journal.reserveNotification(reservation);
  try {
    const delivery = await deliverAlert(port, alert, reservation, now);
    if (delivery.state === "acknowledged") {
      return {
        ...previous,
        notification_pending: false,
        delivered_at: now,
        next_attempt_at: null
      };
    }
  } catch {
    // The reservation above remains the durable proof for a lost response.
  }
  return pendingAlertProgress(previous, alert.incident_id, attemptNumber, nowMs);
}

async function pendingAlertProgress(
  previous: AlertProgress,
  incidentId: string,
  attemptNumber: number,
  nowMs: number
): Promise<AlertProgress> {
  const failureCount = previous.failure_count + 1;
  const retry = nextRetryAt({
    nowMs,
    failureCount,
    jitter: await deterministicRetryJitter(incidentId.slice("inc-".length), attemptNumber),
    retryAfterMs: 0
  });
  return {
    ...previous,
    notification_pending: true,
    next_attempt_at: retry.at,
    failure_count: failureCount
  };
}
