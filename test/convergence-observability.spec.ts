import { describe, expect, it, vi } from "vitest";
import {
  buildAlertRecord,
  commitClock,
  dispatchAlertDelivery,
  deliverAlert,
  dueAlerts,
  convergenceTelemetrySnapshot,
  monitoringNotificationPort,
  oldestPendingAgeMs,
  shouldOpenAlert,
  type AlertDelivery
} from "../src/convergence/observability";
import { unknownHealth } from "../src/convergence/health";
import { initialProgress } from "../src/convergence/journal";

describe("convergence observability", () => {
  it("never uses transaction time as publication time", () => {
    expect(commitClock(null, null, "2026-09-08T00:20:00.000Z")).toEqual({
      t0: null,
      first_observed_at: "2026-09-08T00:20:00.000Z",
      code: "commit_time_unknown"
    });
    expect(commitClock(null, {
      path: "immutable", size: 1, modifiedAt: "2026-09-08T00:00:00.000Z"
    }, "2026-09-08T00:20:00.000Z").t0).toBe("2026-09-08T00:00:00.000Z");
  });

  it("measures the oldest non-verified obligation from durable pending time", () => {
    const progress = initialProgress("PRJ-0003", "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["a".repeat(64)] = {
      id: "a".repeat(64), layer: "event", from_revision: 262,
      target: { revision: 263, projection_version: 3 }, incident: 1,
      state: "retry_wait", first_pending_at: "2026-09-08T00:10:00.000Z",
      next_attempt_at: "2026-09-08T00:21:00.000Z", failure_count: 1,
      last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
      code: "provider_timeout", lease_until: null, continuation: null
    };
    progress.obligations["b".repeat(64)] = {
      ...progress.obligations["a".repeat(64)], id: "b".repeat(64),
      state: "verified", first_pending_at: "2026-09-08T00:00:00.000Z",
      last_verified_at: "2026-09-08T00:15:00.000Z"
    };

    expect(oldestPendingAgeMs(progress, Date.parse("2026-09-08T00:20:00.000Z"))).toBe(600_000);
  });

  it("opens a stable incident for an exhausted layer without exposing payload data", async () => {
    const progress = initialProgress("PRJ-0003", "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["c".repeat(64)] = {
      id: "c".repeat(64), layer: "event", from_revision: 262,
      target: { revision: 263, projection_version: 3 }, incident: 6,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:21:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "provider_timeout", lease_until: null, continuation: null
    };
    expect(shouldOpenAlert(progress, Date.parse("2026-09-08T00:10:40.000Z"))).toBe(true);

    const alert = await buildAlertRecord({
      projectId: "PRJ-0003", layer: "event", incident: 6,
      createdAt: "2026-09-08T00:10:40.000Z", code: "provider_timeout",
      relativePath: ".project-os/projects/PRJ-0003/events/EVT-000263.json",
      expected: { revision: 263, identity: "EVT-000263", hash: null, projection_version: 3, root_hash: null },
      observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
      lastSuccessAt: null, deploymentSha: "a".repeat(40)
    });
    expect(alert).toMatchObject({
      schema_version: "1.0", project_id: "PRJ-0003", layers: ["event"],
      owner: "MaterializationGuard", code: "provider_timeout", deployment_sha: "a".repeat(40)
    });
    expect(alert.incident_id).toMatch(/^inc-[a-f0-9]{64}$/);
    expect(JSON.stringify(alert)).not.toContain("secret");
  });

  it("keeps a notification pending until a receiver explicitly acknowledges it", async () => {
    const alert = await buildAlertRecord({
      projectId: "PRJ-0003", layer: "event", incident: 6,
      createdAt: "2026-09-08T00:10:40.000Z", code: "provider_timeout",
      relativePath: ".project-os/projects/PRJ-0003/events/EVT-000263.json",
      expected: { revision: 263, identity: "EVT-000263", hash: null, projection_version: 3, root_hash: null },
      observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
      lastSuccessAt: null, deploymentSha: "a".repeat(40)
    });
    const delivery = await deliverAlert({
      async deliver(_alert, deliveryId) {
        expect(deliveryId).toBeNull();
        return { acknowledged: false, delivery_id: "delivery-258" };
      }
    }, alert, null, "2026-09-08T00:10:41.000Z");

    expect(delivery).toEqual({
      incident_id: alert.incident_id, state: "pending", delivery_id: "delivery-258",
      attempt_number: 1, last_attempt_at: "2026-09-08T00:10:41.000Z", acknowledged_at: null
    });
  });

  it("reserves an alert delivery before dispatch and keeps its id through a lost acknowledgement", async () => {
    const alert = await buildAlertRecord({
      projectId: "PRJ-9258", layer: "human_handoff", incident: 6,
      createdAt: "2026-09-08T00:10:40.000Z", code: "critical_pair_drift",
      relativePath: "convergence/human_handoff",
      expected: { revision: 258, identity: null, hash: null, projection_version: 3, root_hash: null },
      observed: { revision: 257, identity: null, hash: null, projection_version: 3, root_hash: null },
      lastSuccessAt: null, deploymentSha: "b".repeat(40)
    });
    const calls: string[] = [];
    const attempts: { delivery_id: string | null; attempt_number: number }[] = [];
    const journal = {
      async readNotification() { return null; },
      async reserveNotification(delivery: { delivery_id: string | null; attempt_number: number }) {
        calls.push("reserve");
        attempts.push(delivery);
      }
    };
    const previous = {
      incident: 6, layers: ["human_handoff" as const], created_at: alert.created_at,
      notification_pending: true, delivered_at: null, resolved_at: null,
      next_attempt_at: null, failure_count: 0
    };
    const first = await dispatchAlertDelivery({
      alert, previous, journal,
      nowMs: Date.parse("2026-09-08T00:10:41.000Z"),
      port: {
        async deliver(_alert, deliveryId) {
          calls.push("deliver");
          return { acknowledged: false, delivery_id: deliveryId };
        }
      }
    });
    expect(calls).toEqual(["reserve", "deliver"]);
    expect(first.notification_pending).toBe(true);

    const second = await dispatchAlertDelivery({
      alert, previous: first, journal,
      nowMs: Date.parse(first.next_attempt_at ?? ""),
      port: {
        async deliver(_alert, deliveryId) {
          return { acknowledged: true, delivery_id: deliveryId };
        }
      }
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.delivery_id).toBe(attempts[0]?.delivery_id);
    expect(second).toMatchObject({ notification_pending: false, delivered_at: first.next_attempt_at });
  });

  it("reuses a durable notification reservation when the progress checkpoint was lost", async () => {
    const alert = await buildAlertRecord({
      projectId: "PRJ-9258", layer: "human_handoff", incident: 6,
      createdAt: "2026-09-08T00:10:40.000Z", code: "critical_pair_drift",
      relativePath: "convergence/human_handoff",
      expected: { revision: 258, identity: null, hash: null, projection_version: 3, root_hash: null },
      observed: { revision: 257, identity: null, hash: null, projection_version: 3, root_hash: null },
      lastSuccessAt: null, deploymentSha: "b".repeat(40)
    });
    const reservations: AlertDelivery[] = [];
    const journal = {
      async readNotification(incidentId: string, attemptNumber: number) {
        return reservations.find((reservation) =>
          reservation.incident_id === incidentId && reservation.attempt_number === attemptNumber
        ) ?? null;
      },
      async reserveNotification(delivery: AlertDelivery) {
        reservations.push(delivery);
      }
    };
    const previous = {
      incident: 6, layers: ["human_handoff" as const], created_at: alert.created_at,
      notification_pending: true, delivered_at: null, resolved_at: null,
      next_attempt_at: null, failure_count: 0
    };

    await dispatchAlertDelivery({
      alert, previous, journal,
      nowMs: Date.parse("2026-09-08T00:10:41.000Z"),
      port: { async deliver() { throw new Error("lost_acknowledgement"); } }
    });
    const recovered = await dispatchAlertDelivery({
      alert, previous, journal,
      nowMs: Date.parse("2026-09-08T00:10:41.000Z"),
      port: {
        async deliver(_alert, deliveryId) {
          return { acknowledged: true, delivery_id: deliveryId };
        }
      }
    });

    expect(reservations).toHaveLength(1);
    expect(recovered).toMatchObject({ notification_pending: false });
  });

  it("uses the configured monitoring endpoint only when it returns an explicit acknowledgement", async () => {
    const alert = await buildAlertRecord({
      projectId: "PRJ-9258", layer: "event", incident: 6,
      createdAt: "2026-09-08T00:10:40.000Z", code: "provider_timeout",
      relativePath: "convergence/event",
      expected: { revision: 258, identity: null, hash: null, projection_version: 3, root_hash: null },
      observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
      lastSuccessAt: null, deploymentSha: "b".repeat(40)
    });
    const requests: Request[] = [];
    const port = monitoringNotificationPort({
      endpoint: "https://monitoring.example.test/project-os", token: "test-monitoring-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ acknowledged: true, delivery_id: "delivery-test" });
      }
    });

    await expect(port?.deliver(alert, "delivery-test")).resolves.toEqual({
      acknowledged: true, delivery_id: "delivery-test"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-monitoring-token");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("delivery-test");
  });

  it("bounds an unresponsive monitoring endpoint", async () => {
    vi.useFakeTimers();
    try {
      const alert = await buildAlertRecord({
        projectId: "PRJ-9258", layer: "event", incident: 6,
        createdAt: "2026-09-08T00:10:40.000Z", code: "provider_timeout",
        relativePath: "convergence/event",
        expected: { revision: 258, identity: null, hash: null, projection_version: 3, root_hash: null },
        observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
        lastSuccessAt: null, deploymentSha: "b".repeat(40)
      });
      const port = monitoringNotificationPort({
        endpoint: "https://monitoring.example.test/project-os", token: "test-monitoring-token",
        fetch: async () => new Promise<Response>(() => {})
      });
      const delivery = port?.deliver(alert, "delivery-timeout");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(delivery).resolves.toEqual({ acknowledged: false, delivery_id: "delivery-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a monitoring acknowledgement whose response body never arrives", async () => {
    vi.useFakeTimers();
    try {
      const alert = await buildAlertRecord({
        projectId: "PRJ-9258", layer: "event", incident: 6,
        createdAt: "2026-09-08T00:10:40.000Z", code: "provider_timeout",
        relativePath: "convergence/event",
        expected: { revision: 258, identity: null, hash: null, projection_version: 3, root_hash: null },
        observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
        lastSuccessAt: null, deploymentSha: "b".repeat(40)
      });
      const response = Response.json({ acknowledged: true, delivery_id: "delivery-body-timeout" });
      vi.spyOn(response, "json").mockImplementation(() => new Promise<unknown>(() => {}));
      const port = monitoringNotificationPort({
        endpoint: "https://monitoring.example.test/project-os", token: "test-monitoring-token",
        fetch: async () => response
      });

      const delivery = port?.deliver(alert, "delivery-body-timeout");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(delivery).resolves.toEqual({ acknowledged: false, delivery_id: "delivery-body-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a durable incident candidate for an exhausted human layer even while machines are current", async () => {
    const progress = initialProgress("PRJ-9258", "2026-09-08T00:00:00.000Z", "writer-1");
    progress.obligations["d".repeat(64)] = {
      id: "d".repeat(64), layer: "human_handoff", from_revision: 257,
      target: { revision: 258, projection_version: 3 }, incident: 6,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:15:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "critical_pair_drift", lease_until: null, continuation: null
    };
    const health = unknownHealth("PRJ-9258", "2026-09-08T00:10:40.000Z");
    for (const layer of ["canonical", "event", "receipt", "state", "manifest"] as const) {
      Object.assign(health.layers[layer], {
        state: "current", observation_complete: true,
        last_verified_at: "2026-09-08T00:10:40.000Z"
      });
    }
    health.layers.human_handoff.expected.revision = 258;
    health.layers.human_handoff.observed.revision = 257;

    await expect(dueAlerts(progress, health, Date.parse("2026-09-08T00:10:40.000Z"), "b".repeat(40)))
      .resolves.toMatchObject([{
        project_id: "PRJ-9258", layers: ["human_handoff"], code: "critical_pair_drift",
        expected: { revision: 258 }, observed: { revision: 257 }, deployment_sha: "b".repeat(40)
      }]);
  });

  it("emits the complete whitelisted SLO snapshot for an overdue human divergence", () => {
    const progress = initialProgress("PRJ-9258", "2026-09-08T00:00:00.000Z", "writer-1");
    progress.commit_accepted_at = "2026-09-08T00:00:00.000Z";
    progress.cursors["audit:commit_audit"] = JSON.stringify({
      started_at: "2026-09-08T00:04:00.000Z",
      cursor: null,
      completed_at: "2026-09-08T00:05:00.000Z"
    });
    progress.obligations["e".repeat(64)] = {
      id: "e".repeat(64), layer: "human_handoff", from_revision: 257,
      target: { revision: 258, projection_version: 3 }, incident: 6,
      state: "exhausted", first_pending_at: "2026-09-08T00:00:00.000Z",
      next_attempt_at: "2026-09-08T00:15:00.000Z", failure_count: 6,
      last_attempt_number: 6, last_closed_attempt_number: 6, last_verified_at: null,
      code: "critical_pair_drift", lease_until: null, continuation: null
    };
    const health = unknownHealth("PRJ-9258", "2026-09-08T00:00:00.000Z");
    health.layers.human_handoff.expected.revision = 258;
    health.layers.human_handoff.observed.revision = 257;
    health.layers.human_handoff.code = "critical_pair_drift";

    const metrics = convergenceTelemetrySnapshot({
      progress,
      health,
      nowMs: Date.parse("2026-09-08T00:10:40.000Z"),
      startedAtMs: Date.parse("2026-09-08T00:10:38.000Z"),
      providerCalls: 17,
      deploymentSha: "c".repeat(40),
      fleetLastSuccessAt: "2026-09-08T00:06:00.000Z",
      counters: {
        commit_observed: 1,
        obligations_verified: 0,
        retries: 1,
        exhaustions: 1,
        layer_conflicts: 0,
        handoff_failures: 1,
        freshness_rejections: 0,
        conditional_write_conflicts: 0
      }
    });

    expect(metrics.map((metric) => metric.name)).toEqual([
      "commit_observed", "obligations_verified", "retries", "exhaustions",
      "layer_conflicts", "handoff_failures", "freshness_rejections", "conditional_write_conflicts",
      "tranche_duration", "oldest_pending_seconds", "lag_revisions", "queue_depth",
      "due_without_alarm", "fleet_last_success_age", "audit_cursor_age"
    ]);
    expect(metrics.find((metric) => metric.name === "oldest_pending_seconds")).toMatchObject({
      kind: "gauge", value: 640,
      fields: {
        project_id: "PRJ-9258", target_revision: 258, observed_revision: 257,
        layer: "human_handoff", projection_version: 3, generation_id: null,
        transaction_id: null, event_id: null, attempt_number: 6,
        code: "critical_pair_drift", next_attempt_at: "2026-09-08T00:15:00.000Z",
        oldest_pending_at: "2026-09-08T00:00:00.000Z", deployment_sha: "c".repeat(40),
        provider_calls: 17, correlation_id: null
      }
    });
    expect(Object.keys(metrics[0]?.fields ?? {}).sort()).toEqual([
      "attempt_number", "code", "correlation_id", "deployment_sha", "event_id", "generation_id",
      "layer", "next_attempt_at", "observed_revision", "oldest_pending_at", "project_id",
      "projection_version", "provider_calls", "target_revision", "transaction_id"
    ]);
    expect(JSON.stringify(metrics)).not.toContain("Synthetic");
  });

  it("measures a converged slice from its server commit clock even without a retry obligation", () => {
    const progress = initialProgress("PRJ-9258", "2026-09-08T00:00:00.000Z", "writer-1");
    progress.commit_accepted_at = "2026-09-08T00:00:00.000Z";
    const health = unknownHealth("PRJ-9258", "2026-09-08T00:00:00.000Z");
    health.converged = true;

    const metrics = convergenceTelemetrySnapshot({
      progress,
      health,
      nowMs: Date.parse("2026-09-08T00:02:00.000Z"),
      startedAtMs: Date.parse("2026-09-08T00:01:59.000Z"),
      providerCalls: 8,
      deploymentSha: "f".repeat(40),
      counters: {
        commit_observed: 1,
        obligations_verified: 0,
        retries: 0,
        exhaustions: 0,
        layer_conflicts: 0,
        handoff_failures: 0,
        freshness_rejections: 0,
        conditional_write_conflicts: 0
      }
    });

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "commit_to_layer_verified", kind: "histogram", value: 120 })
    ]));
  });
});
