import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { machineCommitRecordPath, machineReceiptPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import {
  assertCapacity,
  admissionModeForProject,
  convergenceModeForProject,
  parseProjectModes,
  rolloutBlockers,
  type RolloutEvidence
} from "../src/convergence/rollout";

describe("convergence rollout gates", () => {
  it("blocks activation without full transport and a compatible rollback reader", () => {
    const evidence: RolloutEvidence = {
      reader_compatible: true, single_writer: true, fencing_proven: true,
      registry_continuation_proven: true, notification_ack_proven: true,
      transport_complete: false, capacity_qualified: true, recovery_qualified: true,
      compatible_stable_ready: false
    };
    expect(rolloutBlockers(evidence)).toEqual(["compatible_stable_ready", "transport_complete"]);
  });

  it("requires a notification acknowledgement by default and defers only that evidence explicitly", () => {
    const evidence: RolloutEvidence = {
      reader_compatible: true, single_writer: true, fencing_proven: true,
      registry_continuation_proven: true, notification_ack_proven: false,
      transport_complete: false, capacity_qualified: true, recovery_qualified: true,
      compatible_stable_ready: false
    };

    expect(rolloutBlockers(evidence)).toEqual([
      "compatible_stable_ready", "notification_ack_proven", "transport_complete"
    ]);
    expect(rolloutBlockers(evidence, "deferred")).toEqual([
      "compatible_stable_ready", "transport_complete"
    ]);
    expect(rolloutBlockers({ ...evidence, recovery_qualified: false }, "deferred"))
      .toEqual(["compatible_stable_ready", "recovery_qualified", "transport_complete"]);
  });

  it("defaults every project to observation-safe modes and rejects unknown configuration", () => {
    expect(parseProjectModes(undefined, ["PRJ-0003"], ["off", "observe", "repair"], "off"))
      .toEqual({ "PRJ-0003": "off" });
    expect(() => parseProjectModes('{"PRJ-0003":"unsafe"}', ["PRJ-0003"], ["off", "observe", "repair"], "off"))
      .toThrow("invalid_project_mode");
  });

  it("rejects new commits when the qualified continuation envelope is unavailable", () => {
    expect(() => assertCapacity({
      queued_outputs: 3, oldest_pending_seconds: 601,
      continuation_available: false, within_qualified_envelope: true
    })).toThrow(expect.objectContaining({ code: "convergence_capacity_exceeded", status: 503 }));
  });

  it("rejects a repair-mode commit before allocating a revision when continuation is missing", async () => {
    const projectId = "PRJ-9977";
    const mock = installDropboxMock();
    const testEnv = env as unknown as Env;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const create = {
      schema_version: "1.0",
      transaction_id: "TXN-ROLLOUT-9977-CREATE-0001",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { name: "Capacity floor", slug: "capacity-floor", aliases: [], objective: "Reject overloaded commits" }
    };
    expect((await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create)
    })).status).toBe(200);

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const pendingAt = new Date().toISOString();
    const progress = initialProgress(projectId, pendingAt, "capacity-floor");
    progress.obligations["b".repeat(64)] = {
      id: "b".repeat(64), layer: "human_handoff", from_revision: 0,
      target: { revision: 1, projection_version: 3 }, incident: 1,
      state: "retry_wait", first_pending_at: pendingAt,
      next_attempt_at: new Date(Date.now() + 300_000).toISOString(), failure_count: 1,
      last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
      code: "human_write_failed", lease_until: null, continuation: null
    };
    await journal.save(progress, null);
    await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    const blocked = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ROLLOUT-9977-TASK-0002",
        project_id: projectId,
        base_revision: 1,
        operation: "task.create",
        created_at: "2026-09-09T10:01:00.000Z",
        payload: { task_id: "TASK-9977", title: "Must not allocate" }
      })
    });

    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toEqual({ error: "convergence_capacity_exceeded" });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
    expect(mock.files.has(machineReceiptPath("TXN-ROLLOUT-9977-TASK-0002"))).toBe(false);

    await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const admitted = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ROLLOUT-9977-TASK-0003",
        project_id: projectId,
        base_revision: 1,
        operation: "task.create",
        created_at: "2026-09-09T10:02:00.000Z",
        payload: { task_id: "TASK-9978", title: "Continuation retained" }
      })
    });
    expect(admitted.status).toBe(200);
    await expect(admitted.json()).resolves.toMatchObject({ status: "committed", new_revision: 2 });
  });

  it("keeps production repair off unless a syntactically valid per-project mode opts in", () => {
    expect(convergenceModeForProject(undefined, "PRJ-0003")).toBe("off");
    expect(convergenceModeForProject('{"PRJ-0003":"repair"}', "PRJ-0003")).toBe("repair");
    expect(() => convergenceModeForProject('{"wrong":"repair"}', "PRJ-0003")).toThrow("invalid_project_mode");
    expect(admissionModeForProject(undefined, "PRJ-0003")).toBe("observe");
    expect(admissionModeForProject('{"PRJ-0003":"strict"}', "PRJ-0003")).toBe("strict");
    expect(() => admissionModeForProject('{"PRJ-0003":"bypass"}', "PRJ-0003"))
      .toThrow("invalid_project_mode");
  });

  it("does not downgrade a project after strict admission has protected a mutation", async () => {
    const projectId = "PRJ-9990";
    const mock = installDropboxMock();
    const record = commitFixture(projectId, 1)[0];
    const testEnv = env as unknown as Env;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const content = "# strict admission floor";
    const artifact = {
      request_id: "ART-ROLLOUT-STRICT-FLOOR-9990",
      project_id: projectId,
      relative_path: "strict-admission-floor.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    const submit = () => guard.fetch("https://project-guard.internal/artifact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifact)
    });

    await runInDurableObject(guard, (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?)",
        JSON.stringify(record.state)
      );
      (instance as unknown as { env: Env }).env.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({
        [projectId]: "strict"
      });
      (instance as unknown as { env: Env }).env.MUTATION_CONTEXT_SIGNING_KEY = "synthetic-context-secret-for-vitest-only";
    });
    expect((await submit()).status).toBe(428);
    const admissionFloor = await runInDurableObject(guard, (_instance, state) =>
      state.storage.sql.exec<{ strict: number }>("SELECT strict FROM admission_floor WHERE singleton = 1").toArray()[0]
    );
    expect(admissionFloor).toEqual({ strict: 1 });

    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({
        [projectId]: "observe"
      });
    });
    expect((await submit()).status).toBe(428);
    expect([...mock.files.keys()].some((path) => path.endsWith("/strict-admission-floor.md"))).toBe(false);
  });

  it("reports read-only convergence health in observe mode without repairing outputs", async () => {
    const projectId = "PRJ-9991";
    const mock = installDropboxMock();
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);
    const beforePaths = [...mock.files.keys()].sort();
    const testEnv = env as unknown as Env;
    const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "observe"
      });
    });

    const response = await guard.fetch("https://materialization-guard.internal/status");
    expect(response.status).toBe(200);
    const status = await response.json<{ convergence: { layers: { canonical: { state: string; expected: { revision: number | null } } } } }>();
    expect(status.convergence.layers.canonical).toMatchObject({ state: "current", expected: { revision: 1 } });
    expect([...mock.files.keys()].sort()).toEqual(beforePaths);
  });

  it("reports pending after one bounded admin materialization slice", async () => {
    installDropboxMock();
    const emittedMetrics: unknown[] = [];
    const metricLog = vi.spyOn(console, "info").mockImplementation((message, metric) => {
      if (message === "Project OS convergence metric") emittedMetrics.push(metric);
    });
    const testEnv = env as unknown as Env;
    const projectId = "PRJ-9988";
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-ROLLOUT-9988-CREATE-0001",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { name: "Bounded rollout", slug: "bounded-rollout", aliases: [], objective: "One slice" }
    };
    const committed = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction)
    });
    expect(committed.status).toBe(200);

    const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    const response = await guard.fetch(
      "https://materialization-guard.internal/materialize",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "workspace-v2" }) }
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId, revision: 1, materialized: false, status: "pending"
    });
    expect(emittedMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "tranche_duration",
        fields: expect.objectContaining({ project_id: projectId, provider_calls: expect.any(Number) })
      }),
      expect.objectContaining({ name: "queue_depth", kind: "gauge" })
    ]));
    metricLog.mockRestore();
    await runDurableObjectAlarm(guard);
    expect((await guard.fetch("https://materialization-guard.internal/status")).status).toBe(200);
  });

  it("refuses an admin writer slice when the V2 convergence writer is not in repair mode", async () => {
    const mock = installDropboxMock();
    const testEnv = env as unknown as Env;
    const projectId = "PRJ-9990";
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);

    const response = await testEnv.MATERIALIZATION_GUARD.getByName(projectId).fetch(
      "https://materialization-guard.internal/materialize",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "workspace-v2" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "convergence_writer_inactive", project_id: projectId, mode: "off"
    });
    expect([...mock.files.keys()].some((path) => path.includes("/WORKSPACE/PROJECTS/PRJ-9990-"))).toBe(false);
  });

  it("does not rearm the legacy writer alarm for a V2 project outside repair mode", async () => {
    const projectId = "PRJ-9992";
    const testEnv = env as unknown as Env;
    const mock = installDropboxMock();
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);
    const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);

    const requested = await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: 3 })
    });
    expect(requested.status).toBe(200);

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const alarmAt = await runInDurableObject(guard, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).toBeNull();
  });

  it("keeps the persisted human retry deadline when repair is activated", async () => {
    const projectId = "PRJ-9989";
    const slug = "alarm-retry";
    const testEnv = env as unknown as Env;
    installDropboxMock();
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    await runInDurableObject(registry, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '9989' WHERE key = 'next_project_number'");
    });
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-ROLLOUT-9989-CREATE-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { name: "Alarm retry", slug, aliases: [], objective: "Preserve retry deadline" }
    };
    const committed = await registry.fetch("https://registry-guard.internal/create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction)
    });
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toMatchObject({ status: "committed", project_id: projectId });

    const retryAt = new Date(Date.now() + 2_000).toISOString();
    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const progress = initialProgress(projectId, new Date().toISOString(), "rollout-retry");
    progress.canonical_observed_revision = 1;
    progress.active = { revision: 1, projection_version: 3 };
    progress.next_alarm_at = retryAt;
    progress.obligations["a".repeat(64)] = {
      id: "a".repeat(64), layer: "human_handoff", from_revision: 0,
      target: { revision: 1, projection_version: 3 }, incident: 1,
      state: "retry_wait", first_pending_at: new Date().toISOString(),
      next_attempt_at: retryAt, failure_count: 1,
      last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
      code: "human_write_failed", lease_until: null, continuation: null
    };
    await journal.save(progress, null);

    const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch(
      "https://materialization-guard.internal/materialize",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "workspace-v2" }) }
    );

    expect((await journal.load())?.progress.next_alarm_at).toBe(retryAt);
    const alarmAt = await runInDurableObject(guard, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt ?? 0).toBeGreaterThanOrEqual(Date.now() + 1_500);
  });

  it("rearms a persisted convergence continuation when fleet reconciliation finds no legacy work", async () => {
    const projectId = "PRJ-9987";
    const testEnv = env as unknown as Env;
    installDropboxMock();
    const record = commitFixture(projectId, 1)[0]!;
    const persistence = createProductionPersistence(testEnv, projectId);
    const repository = new ProjectRepository(persistence, "v2");
    await repository.writeCommitRecord(record);

    const journal = new ConvergenceJournal(persistence, projectId);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const progress = initialProgress(projectId, new Date().toISOString(), "fleet-rearm");
    progress.canonical_observed_revision = 1;
    progress.active = { revision: 1, projection_version: 3 };
    progress.next_alarm_at = retryAt;
    progress.obligations["f".repeat(64)] = {
      id: "f".repeat(64), layer: "human_handoff", from_revision: 0,
      target: { revision: 1, projection_version: 3 }, incident: 1,
      state: "retry_wait", first_pending_at: new Date().toISOString(),
      next_attempt_at: retryAt, failure_count: 1,
      last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
      code: "human_write_failed", lease_until: null, continuation: null
    };
    await journal.save(progress, null);

    const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    await runInDurableObject(guard, async (instance, state) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
      await state.storage.deleteAlarm();
    });

    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const alarmAt = await runInDurableObject(guard, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt ?? 0).toBeGreaterThanOrEqual(Date.parse(retryAt) - 100);
  });
});
