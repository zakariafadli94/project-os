import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../src/materialization/hash";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { buildAlertRecord, type AlertDelivery } from "../src/convergence/observability";
import { convergenceIncidentPath, convergenceNotificationAttemptPath, convergenceProgressPath } from "../src/persistence/layout";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

describe("convergence journal", () => {
  it("retains an immutable reservation across a new journal instance", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({
      appKey: "key",
      appSecret: "secret",
      refreshToken: "refresh"
    }));
    const journal = new ConvergenceJournal(runtime, "PRJ-9258");
    const obligationId = await sha256Canonical({ project: "PRJ-9258", layer: "head", from: 258, pv: 3, incident: 1 });
    const attempt = {
      schema_version: "1.0" as const,
      project_id: "PRJ-9258",
      obligation_id: obligationId,
      layer: "head" as const,
      from_revision: 258,
      target: { revision: 258, projection_version: 3 },
      attempt_number: 1,
      incident: 1,
      incarnation: "writer-1",
      reserved_at: "2026-09-08T00:00:00.000Z",
      lease_until: "2026-09-08T00:00:10.000Z"
    };

    await journal.save(initialProgress("PRJ-9258", attempt.reserved_at, attempt.incarnation), null);
    await journal.reserve(attempt);

    const coldJournal = new ConvergenceJournal(runtime, "PRJ-9258");
    await coldJournal.reserve(attempt);
    await expect(coldJournal.listAttempts(obligationId)).resolves.toEqual([attempt]);
    await expect(coldJournal.reserve({ ...attempt, incarnation: "writer-2" })).rejects.toThrow(
      "journal_integrity_conflict"
    );
  });

  it("rejects an incomplete external checkpoint instead of treating it as a recoverable progress state", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    await mock.writeExternal(convergenceProgressPath("PRJ-9258"), JSON.stringify({
      schema_version: "1.0",
      project_id: "PRJ-9258",
      incarnation: "writer-1"
    }));

    await expect(new ConvergenceJournal(runtime, "PRJ-9258").load()).rejects.toThrow("journal_progress_invalid");
  });

  it("rejects a checkpoint containing a truncated retry obligation", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const progress = initialProgress("PRJ-9258", "2026-09-08T00:00:00.000Z", "writer-1");
    await mock.writeExternal(convergenceProgressPath("PRJ-9258"), JSON.stringify({
      ...progress,
      obligations: { ["a".repeat(64)]: {} }
    }));

    await expect(new ConvergenceJournal(runtime, "PRJ-9258").load()).rejects.toThrow("journal_progress_invalid");
  });

  it("writes an immutable incident before any notification delivery", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const journal = new ConvergenceJournal(runtime, "PRJ-9258");
    const alert = await buildAlertRecord({
      projectId: "PRJ-9258", layer: "event", incident: 1,
      createdAt: "2026-09-08T00:10:00.000Z", code: "provider_timeout",
      relativePath: ".project-os/projects/PRJ-9258/events/EVT-000001.json",
      expected: { revision: 1, identity: "EVT-000001", hash: null, projection_version: 3, root_hash: null },
      observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
      lastSuccessAt: null, deploymentSha: "a".repeat(40)
    });

    await journal.recordIncident(alert);
    await journal.recordIncident(alert);

    const persisted = await runtime.objects.readText(convergenceIncidentPath("PRJ-9258", alert.incident_id));
    expect(JSON.parse(persisted ?? "null")).toEqual(alert);
  });

  it("records each notification attempt separately so a lost acknowledgement is recoverable", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const journal = new ConvergenceJournal(runtime, "PRJ-9258");
    const delivery: AlertDelivery = {
      incident_id: `inc-${"d".repeat(64)}`, state: "pending", delivery_id: "delivery-258",
      attempt_number: 2, last_attempt_at: "2026-09-08T00:12:00.000Z", acknowledged_at: null
    };

    await journal.reserveNotification(delivery);

    const persisted = await runtime.objects.readText(
      convergenceNotificationAttemptPath("PRJ-9258", delivery.incident_id, delivery.attempt_number)
    );
    expect(JSON.parse(persisted ?? "null")).toEqual(delivery);
  });
});
