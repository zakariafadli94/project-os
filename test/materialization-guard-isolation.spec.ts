import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { commitFixture, seedCommits } from "./helpers/convergence-fixture";
import type { SliceBudget } from "../src/convergence/contract";
import { ExecutionJournal } from "../src/execution/journal";
import { navigationWorkRefSchema } from "../src/domain/zone-navigation";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { sha256Canonical } from "../src/materialization/hash";
import { MaterializationLedger } from "../src/materialization/ledger";
import { canonicalJson } from "../src/rules/contract";
import { ProviderOperationError } from "../src/persistence/provider/errors";

const testEnv = env as unknown as Env;
const at = "2026-09-02T07:20:00+01:00";

function materializationNamespace(): DurableObjectNamespace {
  const namespace = (testEnv as unknown as {
    MATERIALIZATION_GUARD?: DurableObjectNamespace;
  }).MATERIALIZATION_GUARD;
  if (!namespace) throw new Error("MATERIALIZATION_GUARD binding missing");
  return namespace;
}

async function createProject(projectId: string, slug: string, transactionId: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: slug,
        slug,
        aliases: [],
        objective: "Verify isolated materialization ownership"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  // This fixture addresses MaterializationGuard in isolation.  Production
  // finalizes the receipt through RegistryGuard before repair convergence can
  // consume the commit; reproduce that canonical precondition here.
  await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(receipt);
  return receipt;
}

describe("MaterializationGuard isolation boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])("attributes a provider failure to its navigation request (retryable=%s)", async (retryable) => {
    const requestId = `DOCREQ-NAV-PROVIDER-${retryable ? "RETRY" : "BLOCK"}-3992`;
    const ref = { project_id: "PRJ-3992", request_id: requestId };
    const report = vi.fn(async () => undefined);
    let slices = 0;
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId: "PRJ-3992", layoutMode: "v2", env: testEnv,
      ledger: { capacitySnapshot: () => ({}) },
      ctx: { storage: {
        list: async () => new Map([[`navigation-work:${requestId}`, "queued"]]),
        getAlarm: async () => Date.now() + 1_000,
        setAlarm: async () => undefined
      } },
      capacityHasPendingWork: () => false,
      serialize: async (operation: () => Promise<unknown>) => (++slices === 1 ? operation() : false),
      runNavigationWorkSlice: async function (this: { selectedNavigationWorkRef?: unknown }) {
        this.selectedNavigationWorkRef = ref;
        throw new ProviderOperationError("provider failed", retryable, { providerId: "dropbox", status: retryable ? 503 : 403 });
      },
      reportNavigationWorkFailure: report
    }) as MaterializationGuard;
    await guard.alarm();
    expect(report).toHaveBeenCalledWith(ref, retryable ? "navigation_provider_temporary" : "navigation_provider_blocked");
  });

  it("reports a navigation worker's durable retry state without starting work", async () => {
    const projectId = "PRJ-3991";
    const requestId = "DOCREQ-NAVIGATION-STATUS-3991001";
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put(`navigation-work:${requestId}`, "queued");
      await state.storage.put(`navigation-retry:${requestId}`, JSON.stringify({ stopped: true, next_attempt_at: null }));
    });
    const response = await guard.fetch(new Request(`https://materialization-guard.internal/navigation-work-status?request_id=${requestId}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      project_id: projectId, request_id: requestId, queued: true, stopped: true, next_attempt_at: null
    });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get(`navigation-work:${requestId}`)).toBe("queued");
    });
  });

  it("does not queue capacity or diagnostics reads behind maintenance I/O", async () => {
    installDropboxMock();
    const projectId = "PRJ-3913";
    const progress = initialProgress(projectId, at, "capacity-empty-proof");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      new MaterializationLedger(state.storage).restoreConvergenceCheckpoint(progress, "capacity-token-0");
    });
    let entered!: () => void;
    let release!: () => void;
    const enteredMaintenance = new Promise<void>((resolve) => { entered = resolve; });
    const maintenance = new Promise<void>((resolve) => { release = resolve; });
    let held!: Promise<void>;
    await runInDurableObject(guard, async (instance) => {
      held = (instance as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> })
        .serialize(async () => { entered(); await maintenance; });
      await enteredMaintenance;
    });

    try {
      for (const path of ["/capacity", "/diagnostic-status"]) {
        let finished = false;
        const read = guard.fetch(new Request(`https://materialization-guard.internal${path}`))
          .then((response) => { finished = true; return response; });
        await vi.waitFor(() => expect(finished).toBe(true), { timeout: 150 });
        const response = await read;
        if (path === "/capacity") {
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toMatchObject({
            queued_outputs: 0, oldest_pending_seconds: 0,
            continuation_available: true, within_qualified_envelope: true
          });
        } else {
          expect(response.status).toBe(503);
          await expect(response.json()).resolves.toMatchObject({ status: "unavailable", freshness: "unknown" });
        }
      }
    } finally {
      release();
      await held;
    }
  });

  it("fails closed when capacity cannot prove a current baseline", async () => {
    installDropboxMock();
    const absent = await materializationNamespace().getByName("PRJ-3914")
      .fetch(new Request("https://materialization-guard.internal/capacity"));
    expect(absent.status).toBe(503);
    await expect(absent.json()).resolves.toMatchObject({
      status: "unavailable", freshness: "unknown"
    });

    const projectId = "PRJ-3915";
    const mock = installDropboxMock();
    const records = commitFixture(projectId, 2);
    seedCommits(mock, records);
    const stale = initialProgress(projectId, at, "capacity-stale-proof");
    stale.canonical_observed_revision = 1;
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      new MaterializationLedger(state.storage).restoreConvergenceCheckpoint(stale, "capacity-token-1");
    });
    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        request_id: "TXN-CAPACITY-STALE-0001",
        request_hash: "a".repeat(64),
        canonical_revision: 2,
        operation: "task.create",
        dependency_classification: "resource_bound",
        resources: [{ resource_id: "TASK-CAP1001", resource_type: "task", zone: "PROJECT", version: "2" }]
      })
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable", freshness: "unknown"
    });
  });

  it("counts finalization after 347 already verified plan outputs instead of treating them as queued", async () => {
    const projectId = "PRJ-3940";
    const guard = materializationNamespace().getByName(projectId);
    const progress = initialProgress(projectId, at, "capacity-active-plan-verified");
    await runInDurableObject(guard, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      ledger.restoreConvergenceCheckpoint(progress, "capacity-token-active-plan");
      ledger.requestTarget({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION });
      ledger.beginNextTarget();
      const writes = Array.from({ length: 347 }, (_, index) => {
        const key = `task:TSK-${index.toString().padStart(8, "0")}`;
        const hash = index.toString(16).padStart(64, "0").slice(-64);
        const evidence = { relative_path: `TASKS/${key}.md`, input_hash: hash, content_hash: hash, source_revision: 1 };
        ledger.recordVerifiedOutput(key, evidence);
        return { key, input_hash: hash, content_hash: hash, source_revision: 1 };
      });
      ledger.checkpointActiveWorkPlan({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION, writes, removals: [] });
      const evidence = { relative_path: "STATE.md", input_hash: "a".repeat(64), content_hash: "a".repeat(64), source_revision: 1 };
      ledger.beginFinalVerification([{ key: "global:STATE", expected: "present", evidence }]);
      ledger.completeFinalVerification(["global:STATE"]);
    });

    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ queued_outputs: 1, within_qualified_envelope: true });
  });

  it("rejects 201 unverified active writes and does not estimate an uncompiled request from baseline size", async () => {
    const projectId = "PRJ-3941";
    const guard = materializationNamespace().getByName(projectId);
    const progress = initialProgress(projectId, at, "capacity-active-plan-pending");
    progress.canonical_observed_revision = 1;
    await runInDurableObject(guard, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      ledger.restoreConvergenceCheckpoint(progress, "capacity-token-active-plan-pending");
      ledger.restoreExternalBaseline({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION },
        new Map(Array.from({ length: 497 }, (_, index) => [`task:TSK-${index}`, {
          relative_path: `TASKS/${index}.md`, input_hash: "a".repeat(64), content_hash: "a".repeat(64), source_revision: 1
        }])));
      ledger.requestTarget({ revision: 2, projection_version: CURRENT_PROJECTION_VERSION });
      ledger.beginNextTarget();
      const writes = Array.from({ length: 250 }, (_, index) => {
        const key = `task:TSK-PENDING-${index}`;
        const hash = index.toString(16).padStart(64, "0").slice(-64);
        if (index < 49) ledger.recordVerifiedOutput(key, {
          relative_path: `TASKS/${key}.md`, input_hash: hash, content_hash: hash, source_revision: 2
        });
        return { key, input_hash: hash, content_hash: hash, source_revision: 2 };
      });
      ledger.checkpointActiveWorkPlan({ target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION, writes, removals: [] });
      expect(ledger.status()).toMatchObject({ active_work_plan_state: "ready",
        active_work: { remaining_write_count: 201, remaining_action_count: 201 } });
    });

    const makeReservation = (id: string) => new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, request_id: id, request_hash: "b".repeat(64),
        canonical_revision: 2, operation: "task.create", dependency_classification: "resource_bound",
        resources: [{ resource_id: id, resource_type: "task", zone: "PROJECT", version: "0" }] })
    });
    const overLimit = await guard.fetch(makeReservation("TXN-CAPACITY-REMAINING-0001"));
    expect(overLimit.status).toBe(503);
    await expect(overLimit.json()).resolves.toMatchObject({ error: "convergence_capacity_exceeded",
      reason: "queued_outputs_exceeded", queued_outputs: 201 });

    const requestedOnlyId = "PRJ-3942";
    const requestedOnly = materializationNamespace().getByName(requestedOnlyId);
    await runInDurableObject(requestedOnly, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      ledger.restoreConvergenceCheckpoint(initialProgress(requestedOnlyId, at, "capacity-uncompiled-request"), "capacity-token-uncompiled-request");
      ledger.restoreExternalBaseline({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION },
        new Map(Array.from({ length: 497 }, (_, index) => [`task:TSK-${index}`, {
          relative_path: `TASKS/${index}.md`, input_hash: "a".repeat(64), content_hash: "a".repeat(64), source_revision: 1
        }])));
      ledger.requestTarget({ revision: 2, projection_version: CURRENT_PROJECTION_VERSION });
    });
    const unknownRequest = await requestedOnly.fetch(new Request("https://materialization-guard.internal/capacity"));
    expect(unknownRequest.status).toBe(503);
    await expect(unknownRequest.json()).resolves.toMatchObject({ error: "capacity_proof_unavailable" });
  });

  it("fails closed when an active legacy target has no exact durable plan", async () => {
    const projectId = "PRJ-3943";
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      ledger.restoreConvergenceCheckpoint(initialProgress(projectId, at, "capacity-active-plan-missing"), "capacity-token-active-plan-missing");
      ledger.requestTarget({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION });
      ledger.beginNextTarget();
    });
    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "capacity_proof_unavailable" });
  });

  it("accounts for an uncompiled requested target only through a contiguous handed-off admission chain", async () => {
    const projectId = "PRJ-3945";
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      const progress = initialProgress(projectId, at, "capacity-uncompiled-chain");
      progress.canonical_observed_revision = 1;
      ledger.restoreConvergenceCheckpoint(progress, "capacity-token-uncompiled-chain");
      ledger.restoreExternalBaseline({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, new Map());
      ledger.requestTarget({ revision: 3, projection_version: CURRENT_PROJECTION_VERSION });
      for (const revision of [2, 3]) {
        const requestId = `TXN-CAPACITY-CHAIN-${revision}`;
        const requestHash = String(revision).repeat(64).slice(0, 64);
        ledger.withCapacityReservation((snapshot) => ({ value: undefined, reservation: {
          request_id: requestId, request_hash: requestHash, reservation_kind: "transaction", output_cost: 1,
          canonical_revision: revision - 1, target_revision: revision, operation: "task.create", resources: [],
          dependency_classification: "unknown", created_at: new Date().toISOString()
        } }));
        ledger.transitionCapacityReservation(requestId, requestHash, "reserved", "handed_off");
      }
    });

    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pending_uncompiled_targets: 1, queued_outputs: 1, within_qualified_envelope: true
    });
  });

  it("keeps final-verification backlog over 200 outside the qualified envelope", async () => {
    const projectId = "PRJ-3944";
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      const ledger = new MaterializationLedger(state.storage);
      ledger.restoreConvergenceCheckpoint(initialProgress(projectId, at, "capacity-final-verification"), "capacity-token-final-verification");
      ledger.requestTarget({ revision: 1, projection_version: CURRENT_PROJECTION_VERSION });
      ledger.beginNextTarget();
      ledger.checkpointActiveWorkPlan({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION, writes: [], removals: [] });
      const pending = Array.from({ length: 201 }, (_, index) => ({
        key: `global:FINAL-${index}`, expected: "present" as const,
        evidence: { relative_path: `FINAL-${index}.md`, input_hash: "a".repeat(64), content_hash: "b".repeat(64), source_revision: 1 }
      }));
      ledger.beginFinalVerification(pending);
    });

    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, request_id: "TXN-CAPACITY-FINAL-0001", request_hash: "c".repeat(64),
        canonical_revision: 1, operation: "task.create", dependency_classification: "resource_bound",
        resources: [{ resource_id: "TXN-CAPACITY-FINAL-0001", resource_type: "task", zone: "PROJECT", version: "0" }] })
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "convergence_capacity_exceeded",
      reason: "queued_outputs_exceeded", queued_outputs: 202 });
  });

  it("arms bounded reconstruction for an unknown reservation without admitting non-create work", async () => {
    installDropboxMock();
    const projectId = "PRJ-3917";
    const guard = materializationNamespace().getByName(projectId);
    const response = await guard.fetch(new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        request_id: "TXN-CAPACITY-COLD-0001",
        request_hash: "e".repeat(64),
        canonical_revision: 1,
        operation: "task.create",
        dependency_classification: "resource_bound",
        resources: [{ resource_id: "TASK-COLD-0001", resource_type: "task", zone: "PROJECT", version: "1" }]
      })
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", freshness: "unknown" });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    const degradedProjectId = "PRJ-3919";
    const degradedGuard = materializationNamespace().getByName(degradedProjectId);
    await runInDurableObject(degradedGuard, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO convergence_checkpoint (singleton, progress_json, provider_token) VALUES (1, ?, '')",
        JSON.stringify(initialProgress(degradedProjectId, at, "capacity-missing-token"))
      );
    });
    const degraded = await degradedGuard.fetch(new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: degradedProjectId,
        request_id: "TXN-CAPACITY-NOTOKEN-0001",
        request_hash: "c".repeat(64),
        canonical_revision: 0,
        operation: "project.create",
        dependency_classification: "resource_bound",
        resources: [{ resource_id: "TXN-CAPACITY-NOTOKEN-0001", resource_type: "project", zone: "PROJECT", version: "0" }]
      })
    }));
    expect(degraded.status).toBe(503);
    await runInDurableObject(degradedGuard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("admits and exactly replays only the zero-state project-create bootstrap reservation", async () => {
    installDropboxMock();
    const projectId = "PRJ-3918";
    const guard = materializationNamespace().getByName(projectId);
    const request = (requestId: string, hash: string, operation: string, revision: number) => new Request(
      "https://materialization-guard.internal/capacity-reservation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId, request_id: requestId, request_hash: hash,
          canonical_revision: revision, operation,
          dependency_classification: "resource_bound",
          resources: [{ resource_id: requestId, resource_type: "project", zone: "PROJECT", version: String(revision) }]
        })
      }
    );
    const first = await guard.fetch(request("TXN-CREATE-COLD-0001", "f".repeat(64), "project.create", 0));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "admitted", canonical_revision: 0 });

    const replay = await guard.fetch(request("TXN-CREATE-COLD-0001", "f".repeat(64), "project.create", 0));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ status: "reserved", queued_outputs: 1 });

    const competing = await guard.fetch(request("TXN-CREATE-COLD-0002", "a".repeat(64), "project.create", 0));
    expect(competing.status).toBe(503);
    const nonCreate = await guard.fetch(request("TXN-CREATE-COLD-0003", "b".repeat(64), "task.create", 0));
    expect(nonCreate.status).toBe(503);
  });

  it("atomically reserves capacity at the limit and replays only the exact request", async () => {
    installDropboxMock();
    const projectId = "PRJ-3916";
    const guard = materializationNamespace().getByName(projectId);
    const progress = initialProgress(projectId, at, "capacity-boundary-proof");
    const recent = new Date().toISOString();
    progress.obligations = Object.fromEntries(Array.from({ length: 199 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return [id, {
        id, layer: "state", from_revision: 0,
        target: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION },
        incident: 1, state: "pending", first_pending_at: recent,
        next_attempt_at: null, failure_count: 0, last_attempt_number: 0,
        last_closed_attempt_number: 0, last_verified_at: null, code: null,
        lease_until: null, continuation: null
      }];
    }));
    await runInDurableObject(guard, async (_instance, state) => {
      new MaterializationLedger(state.storage).restoreConvergenceCheckpoint(progress, "capacity-token-199");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const makeRequest = (requestId: string, requestHash: string) => new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId, request_id: requestId, request_hash: requestHash,
        canonical_revision: 0, operation: "task.create",
        dependency_classification: "resource_bound",
        resources: [{ resource_id: requestId, resource_type: "task", zone: "PROJECT", version: "0" }]
      })
    });
    const pair = await Promise.all([
      guard.fetch(makeRequest("TXN-CAPACITY-BOUNDARY-0001", "b".repeat(64))),
      guard.fetch(makeRequest("TXN-CAPACITY-BOUNDARY-0002", "d".repeat(64)))
    ]);
    expect(pair.map((response) => response.status).sort()).toEqual([200, 503]);
    const winnerIndex = pair[0]!.status === 200 ? 0 : 1;
    const winnerId = winnerIndex === 0 ? "TXN-CAPACITY-BOUNDARY-0001" : "TXN-CAPACITY-BOUNDARY-0002";
    const winnerHash = winnerIndex === 0 ? "b".repeat(64) : "d".repeat(64);
    const replay = await guard.fetch(makeRequest(winnerId, winnerHash));
    expect(replay.status).toBe(200);
    const changed = await guard.fetch(makeRequest(winnerId, "c".repeat(64)));
    expect(changed.status).toBe(409);
    const competing = pair[1 - winnerIndex]!;
    await expect(competing.json()).resolves.toMatchObject({ error: "convergence_capacity_exceeded", reason: "queued_outputs_exceeded" });
  });

  it("counts an in-flight document reservation without globally blocking independent work", async () => {
    const projectId = "PRJ-3931";
    const guard = materializationNamespace().getByName(projectId);
    const progress = initialProgress(projectId, at, "capacity-physical-proof");
    await runInDurableObject(guard, async (_instance, state) => {
      new MaterializationLedger(state.storage).restoreConvergenceCheckpoint(progress, "capacity-token-physical");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const makeRequest = (input: Record<string, unknown>) => new Request("https://materialization-guard.internal/capacity-reservation", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId, canonical_revision: 0, ...input })
    });
    const documentResource = { resource_id: "DOC-1123456789ABCDEF01234567", resource_type: "document", zone: "DELIVERABLES", version: "VER-1123456789ABCDEF01234567" };
    const document = await guard.fetch(makeRequest({
      request_id: "DOCREQ-CAP-PHYS-0001", request_hash: "a".repeat(64), operation: "document.publish",
      reservation_kind: "document", output_cost: 1, dependency_classification: "resource_bound", resources: [documentResource]
    }));
    expect(document.status).toBe(200);

    const independent = await guard.fetch(makeRequest({
      request_id: "TXN-CAP-PHYS-INDEP-0001", request_hash: "b".repeat(64), operation: "task.create",
      dependency_classification: "resource_bound", resources: [{ resource_id: "TSK-1123456789ABCDEF01234567", resource_type: "task", zone: "PROJECT", version: "0" }]
    }));
    expect(independent.status).toBe(200);

    // A committed independent revision can advance the canonical proof while
    // the physical document effect remains in flight. Reacquiring the same
    // document request must stay idempotent even though its current revision
    // hint is newer than the one recorded at first acquire.
    progress.canonical_observed_revision = 1;
    await runInDurableObject(guard, (_instance, state) => {
      new MaterializationLedger(state.storage).restoreConvergenceCheckpoint(progress, "capacity-token-physical-1");
    });
    const sameEffectReplay = await guard.fetch(makeRequest({
      request_id: "DOCREQ-CAP-PHYS-0001", request_hash: "a".repeat(64), canonical_revision: 1,
      operation: "document.publish", reservation_kind: "document", output_cost: 1,
      dependency_classification: "resource_bound", resources: [documentResource]
    }));
    expect(sameEffectReplay.status).toBe(200);
    await expect(sameEffectReplay.json()).resolves.toMatchObject({ status: "reserved", queued_outputs: 1 });

    const sameDocument = await guard.fetch(makeRequest({
      request_id: "TXN-CAP-PHYS-DEP-0001", request_hash: "c".repeat(64), canonical_revision: 1, operation: "document.publish",
      dependency_classification: "resource_bound", resources: [documentResource]
    }));
    expect(sameDocument.status).toBe(503);
    await expect(sameDocument.json()).resolves.toMatchObject({ error: "dependency_pending" });
  });

  it("durably acknowledges exact navigation work while the MG serialization queue is held", async () => {
    const projectId = "PRJ-3925";
    const requestId = "DOCREQ-NAVIGATION-WORKING-3925001";
    const authorityRef = `${await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", requestId).root()}/admission.json`;
    const ref = navigationWorkRefSchema.parse({
      project_id: projectId, request_id: requestId, zone: "WORKING", expected_generation: 0,
      source_snapshot_id: "source:0", authority_ref: authorityRef, request_hash: "a".repeat(64)
    });
    const stored = new Map<string, string>();
    let alarm: number | null = null;
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: string) => { stored.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => { alarm = time; },
      list: async ({ prefix, limit }: { prefix: string; limit?: number }) => new Map([...stored.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit))
    };
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId, env: testEnv, queue: Promise.resolve(), queueDepth: 0,
      ctx: { id: { name: projectId }, storage }
    }) as MaterializationGuard;
    let entered!: () => void;
    let release!: () => void;
    const enteredMaintenance = new Promise<void>((resolve) => { entered = resolve; });
    const maintenance = new Promise<void>((resolve) => { release = resolve; });
    const held = (guard as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> }).serialize(async () => {
        entered();
        await maintenance;
      });
    await enteredMaintenance;

    try {
      const first = await guard.fetch(new Request("https://materialization-guard.internal/navigation-work", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ref)
      }));
      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ status: "scheduled", request_id: requestId });
      const replay = await guard.fetch(new Request("https://materialization-guard.internal/navigation-work", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ref)
      }));
      expect(replay.status).toBe(202);
      const changed = await guard.fetch(new Request("https://materialization-guard.internal/navigation-work", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ref, request_hash: "b".repeat(64) })
      }));
      expect(changed.status).toBe(409);
    } finally {
      release();
      await held;
    }

    expect(JSON.parse(stored.get(`navigation-work:${requestId}`)!)).toEqual(ref);
    expect(alarm).not.toBeNull();
  });

  it("retains the navigation wake when convergence becomes idle", async () => {
    const projectId = "PRJ-3926";
    const requestId = "DOCREQ-NAVIGATION-WORKING-3926001";
    const retryAt = Date.now() + 5_000;
    const ref = navigationWorkRefSchema.parse({
      project_id: projectId, request_id: requestId, zone: "WORKING", expected_generation: 0,
      source_snapshot_id: "source:0",
      authority_ref: `${await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", requestId).root()}/admission.json`,
      request_hash: "a".repeat(64)
    });
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, async (instance, state) => {
      await state.storage.put(`navigation-work:${requestId}`, JSON.stringify(ref));
      await state.storage.put(`navigation-retry:${requestId}`, JSON.stringify({ stopped: false, next_attempt_at: new Date(retryAt).toISOString() }));
      await state.storage.deleteAlarm();
      await (instance as unknown as { scheduleConvergenceContinuation(moreWork: boolean, nextAlarmAt: string | null): Promise<void> })
        .scheduleConvergenceContinuation(false, null);
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThanOrEqual(retryAt - 10);
      const slice = await (instance as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> }).serialize(() =>
        (instance as unknown as { runNavigationWorkSlice(): Promise<unknown> }).runNavigationWorkSlice()
      );
      expect(slice).toBeNull();
      expect(await state.storage.getAlarm()).toBe(alarm);
    });
  });

  it("routes a catalog rebuild to its bounded worker without adopting or publishing an index", async () => {
    const projectId = "PRJ-3929";
    const requestId = "DOCREQ-CATALOG-REBUILD-3929001";
    const ref = navigationWorkRefSchema.parse({
      project_id: projectId, request_id: requestId, zone: "REVIEW", expected_generation: 4,
      source_snapshot_id: "source:4", authority_ref: `authority:${requestId}`, request_hash: "a".repeat(64)
    });
    const state = commitFixture(projectId, 1)[0]!.state;
    const request = {
      operation: "navigation.reconcile", project_id: projectId, request_id: requestId, zone: "REVIEW",
      expected_project_revision: 1, expected_generation: 4, expected_source_generation: 4, expected_index: null,
      purpose: "compact_catalog_rebuild",
      expected_catalog_manifest: { object_id: "id:manifest", revision_token: "rev:manifest", content_sha256: "b".repeat(64) },
      created_at: at
    };
    const stored = new Map<string, string>([
      [`navigation-work:${requestId}`, canonicalJson(ref)],
      [`navigation-context:${requestId}`, canonicalJson({
        schema_version: "1.0", ref, request, admission: {}, state,
        state_hash: await sha256Canonical(state)
      })]
    ]);
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: string) => { stored.set(key, value); },
      list: async ({ prefix, limit, startAfter }: { prefix: string; limit?: number; startAfter?: string }) =>
        new Map([...stored.entries()].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).slice(0, limit))
    };
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId, env: testEnv, queue: Promise.resolve(), queueDepth: 0,
      ctx: { id: { name: projectId }, storage }
    }) as MaterializationGuard;
    vi.spyOn(ZoneNavigationSources.prototype, "readState").mockResolvedValue({ generation: 4, adopted: true, in_flight_resource_ids: [] } as never);
    const adoption = vi.spyOn(ZoneNavigationSources.prototype, "beginAdoption");
    const ordinary = vi.spyOn(ZoneNavigationEngine.prototype, "reconcile");
    const rebuild = vi.spyOn(ZoneNavigationEngine.prototype as any, "prepareCompactCatalogRebuild")
      .mockResolvedValue({ status: "pending", cursor: "catalog:1" });

    const result = await (guard as unknown as { runNavigationWorkSlice(): Promise<unknown> }).runNavigationWorkSlice();
    expect(result).toMatchObject({ ref, publish: false });
    expect(rebuild).toHaveBeenCalledOnce();
    expect(adoption).not.toHaveBeenCalled();
    expect(ordinary).not.toHaveBeenCalled();
  });

  it("rotates actual navigation slices across nonterminal jobs and skips a backed-off head", async () => {
    const projectId = "PRJ-3928";
    const now = Date.now();
    let alarmAt: number | null = null;
    const stored = new Map<string, string>();
    const state = commitFixture(projectId, 1)[0]!.state;
    const zones = ["DELIVERABLES", "REVIEW", "WORKING"] as const;
    const ids = ["DOCREQ-A-FIRST-3928001", "DOCREQ-B-SECOND-3928002", "DOCREQ-C-THIRD-3928003"];
    for (const [index, zone] of zones.entries()) {
      const requestId = ids[index]!;
      const requestHash = String.fromCharCode(97 + index).repeat(64);
      const ref = navigationWorkRefSchema.parse({
        project_id: projectId, request_id: requestId, zone, expected_generation: 0,
        source_snapshot_id: "source:0", authority_ref: `authority:${requestId}`, request_hash: requestHash
      });
      const request = {
        operation: "navigation.reconcile", project_id: projectId, request_id: requestId, zone,
        expected_project_revision: 1, expected_generation: 0, expected_index: null, created_at: "2026-09-26T00:00:00.000Z"
      };
      const frozenState = { ...state, project_id: projectId };
      const context = {
        schema_version: "1.0", ref, request, admission: {}, state: frozenState,
        state_hash: await sha256Canonical(frozenState)
      };
      stored.set(`navigation-work:${requestId}`, canonicalJson(ref));
      stored.set(`navigation-context:${requestId}`, canonicalJson(context));
    }
    stored.set(`navigation-retry:${ids[0]}`, JSON.stringify({ stopped: false, next_attempt_at: new Date(now + 60_000).toISOString() }));
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: string) => { stored.set(key, value); },
      delete: async (key: string) => { stored.delete(key); },
      getAlarm: async () => alarmAt,
      setAlarm: async (value: number) => { alarmAt = value; },
      deleteAlarm: async () => { alarmAt = null; },
      list: async ({ prefix, limit, startAfter }: { prefix: string; limit?: number; startAfter?: string }) => {
        const all = [...stored.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
        const after = startAfter ? all.filter(([key]) => key > startAfter) : all;
        return new Map(after.slice(0, limit));
      }
    };
    const makeGuard = (environment: Env = testEnv) => Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId, env: environment, queue: Promise.resolve(), queueDepth: 0, wakeScheduleQueue: undefined,
      layoutMode: "v2", notifyProjectGuardOfCurrentHead: async () => true,
      ledger: { capacitySnapshot: () => ({ status: { active: null, requested: null }, progress: null, reservations: [] }) },
      ctx: { id: { name: projectId }, storage }
    }) as MaterializationGuard;
    let guard = makeGuard();
    const seen: string[] = [];
    vi.spyOn(ZoneNavigationSources.prototype, "readState").mockResolvedValue({ generation: 0, adopted: true, in_flight_resource_ids: [] } as never);
    vi.spyOn(ZoneNavigationEngine.prototype, "reconcile").mockImplementation(async (request) => {
      seen.push(request.request_id);
      return { status: "pending" } as never;
    });
    await guard.alarm();
    await guard.alarm();
    await guard.alarm();
    expect(seen).toEqual([ids[1], ids[2], ids[1]]);
    expect(stored.get(`navigation-retry:${ids[0]}`)).toBeDefined();

    const retryAt = Date.parse(JSON.parse(stored.get(`navigation-retry:${ids[0]}`)!).next_attempt_at);
    for (const requestId of ids.slice(1)) {
      stored.delete(`navigation-work:${requestId}`);
      stored.delete(`navigation-context:${requestId}`);
    }
    await (guard as unknown as { scheduleConvergenceContinuation(moreWork: boolean, nextAlarmAt: string | null): Promise<void> })
      .scheduleConvergenceContinuation(false, null);
    expect(alarmAt).toBeGreaterThanOrEqual(retryAt);

    for (const requestId of ids.slice(1)) {
      const i = ids.indexOf(requestId);
      const zone = zones[i]!;
      const requestHash = String.fromCharCode(97 + i).repeat(64);
      const ref = navigationWorkRefSchema.parse({
        project_id: projectId, request_id: requestId, zone, expected_generation: 0,
        source_snapshot_id: "source:0", authority_ref: `authority:${requestId}`, request_hash: requestHash
      });
      const request = {
        operation: "navigation.reconcile", project_id: projectId, request_id: requestId, zone,
        expected_project_revision: 1, expected_generation: 0, expected_index: null, created_at: "2026-09-26T00:00:00.000Z"
      };
      const frozenState = { ...state, project_id: projectId };
      stored.set(`navigation-work:${requestId}`, canonicalJson(ref));
      stored.set(`navigation-context:${requestId}`, canonicalJson({
        schema_version: "1.0", ref, request, admission: {}, state: frozenState,
        state_hash: await sha256Canonical(frozenState)
      }));
    }
    stored.delete(`navigation-retry:${ids[0]}`);
    guard = makeGuard();
    await guard.alarm();
    guard = makeGuard(); // A new instance must resume from the durable cursor.
    await guard.alarm();
    await guard.alarm();
    expect(seen.slice(3)).toEqual([ids[2], ids[0], ids[1]]);

    stored.delete(`navigation-work:${ids[0]}`);
    stored.delete(`navigation-context:${ids[0]}`);
    stored.delete(`navigation-work:${ids[2]}`);
    stored.delete(`navigation-context:${ids[2]}`);
    await guard.alarm();
    expect(seen.at(-1)).toBe(ids[1]);

    const reported: string[] = [];
    const failureEnv = {
      PROJECT_GUARD: {
        getByName: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            const report = JSON.parse(String(init.body)) as { request_id: string };
            reported.push(report.request_id);
            return Response.json({ project_id: projectId, request_id: report.request_id, status: "retry", next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
          }
        })
      }
    } as unknown as Env;
    vi.spyOn(ZoneNavigationEngine.prototype, "reconcile").mockRejectedValue(new Error("synthetic navigation failure"));
    guard = makeGuard(failureEnv);
    await guard.alarm();
    expect(reported).toEqual([ids[1]]);
  });

  it("does not overwrite an enqueue wake with a stale backoff scan", async () => {
    const projectId = "PRJ-3929";
    const oldRequestId = "DOCREQ-NAVIGATION-WORKING-3929001";
    const newRequestId = "DOCREQ-NAVIGATION-WORKING-3929002";
    const retryAt = Date.now() + 60_000;
    const oldRef = navigationWorkRefSchema.parse({
      project_id: projectId, request_id: oldRequestId, zone: "WORKING", expected_generation: 0,
      source_snapshot_id: "source:0", authority_ref: "authority:old", request_hash: "a".repeat(64)
    });
    const newRef = navigationWorkRefSchema.parse({
      ...oldRef, request_id: newRequestId,
      authority_ref: `${await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", newRequestId).root()}/admission.json`,
      request_hash: "b".repeat(64)
    });
    const stored = new Map<string, string>([
      [`navigation-work:${oldRequestId}`, canonicalJson(oldRef)],
      [`navigation-retry:${oldRequestId}`, canonicalJson({ stopped: false, next_attempt_at: new Date(retryAt).toISOString() })]
    ]);
    let alarm: number | null = null;
    let listCalls = 0;
    let reachedWakeSnapshot!: () => void;
    let releaseWakeSnapshot!: () => void;
    const wakeSnapshot = new Promise<void>((resolve) => { reachedWakeSnapshot = resolve; });
    const snapshotRelease = new Promise<void>((resolve) => { releaseWakeSnapshot = resolve; });
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: string) => { stored.set(key, value); },
      delete: async (key: string) => { stored.delete(key); },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => { alarm = time; },
      deleteAlarm: async () => { alarm = null; },
      list: async ({ prefix, limit, startAfter }: { prefix: string; limit?: number; startAfter?: string }) => {
        const all = [...stored.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
        const after = startAfter ? all.filter(([key]) => key > startAfter) : all;
        const snapshot = new Map(after.slice(0, limit));
        listCalls += 1;
        if (listCalls === 2) {
          reachedWakeSnapshot();
          await snapshotRelease;
        }
        return snapshot;
      }
    };
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId, env: testEnv, queue: Promise.resolve(), queueDepth: 0, wakeScheduleQueue: undefined,
      ctx: { id: { name: projectId }, storage }
    }) as MaterializationGuard;
    const slice = (guard as unknown as { runNavigationWorkSlice(): Promise<unknown> }).runNavigationWorkSlice();
    await wakeSnapshot;

    let enqueueFinished = false;
    const enqueue = guard.fetch(new Request("https://materialization-guard.internal/navigation-work", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(newRef)
    })).then((response) => { enqueueFinished = true; return response; });
    await vi.waitFor(() => expect(enqueueFinished).toBe(true), { timeout: 30 }).catch(() => undefined);
    const enqueueWasBlockedByWakeLock = !enqueueFinished;
    releaseWakeSnapshot();
    const [response] = await Promise.all([enqueue, slice]);

    expect(response.status).toBe(202);
    expect(enqueueWasBlockedByWakeLock).toBe(true);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(retryAt);
  });

  it("keeps a navigation wake enqueued after the scheduler snapshot without losing convergence backoff", async () => {
    const projectId = "PRJ-3927";
    const requestId = "DOCREQ-NAVIGATION-WORKING-3927001";
    const retryAt = Date.now() + 60_000;
    const ref = navigationWorkRefSchema.parse({
      project_id: projectId, request_id: requestId, zone: "WORKING", expected_generation: 0,
      source_snapshot_id: "source:0",
      authority_ref: `${await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", requestId).root()}/admission.json`,
      request_hash: "a".repeat(64)
    });
    const stored = new Map<string, string>();
    let alarm: number | null = null;
    let reachedSchedulerAlarm!: () => void;
    let releaseSchedulerAlarm!: () => void;
    const schedulerAlarmReached = new Promise<void>((resolve) => { reachedSchedulerAlarm = resolve; });
    const schedulerAlarmRelease = new Promise<void>((resolve) => { releaseSchedulerAlarm = resolve; });
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: string) => { stored.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        if (time === retryAt) {
          reachedSchedulerAlarm();
          await schedulerAlarmRelease;
        }
        alarm = time;
      },
      deleteAlarm: async () => { alarm = null; },
      list: async ({ prefix, limit }: { prefix: string; limit?: number }) => new Map([...stored.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit))
    };
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId, env: testEnv, ctx: { id: { name: projectId }, storage }
    }) as MaterializationGuard;
    const scheduler = (guard as unknown as { scheduleConvergenceContinuation(moreWork: boolean, nextAlarmAt: string | null): Promise<void> })
      .scheduleConvergenceContinuation(true, new Date(retryAt).toISOString());
    await schedulerAlarmReached;

    let enqueueFinished = false;
    const enqueue = guard.fetch(new Request("https://materialization-guard.internal/navigation-work", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ref)
    })).then((response) => { enqueueFinished = true; return response; });
    await vi.waitFor(() => expect(enqueueFinished).toBe(true), { timeout: 30 }).catch(() => undefined);
    const enqueueWasBlockedByScheduler = !enqueueFinished;
    releaseSchedulerAlarm();
    const [response] = await Promise.all([enqueue, scheduler]);

    expect(response.status).toBe(202);
    expect(stored.get(`navigation-work:${requestId}`)).toBeDefined();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(retryAt);
    expect(enqueueWasBlockedByScheduler).toBe(true);

    stored.delete(`navigation-work:${requestId}`);
    alarm = null;
    await (guard as unknown as { scheduleConvergenceContinuation(moreWork: boolean, nextAlarmAt: string | null): Promise<void> })
      .scheduleConvergenceContinuation(true, new Date(retryAt).toISOString());
    expect(alarm).toBeGreaterThanOrEqual(retryAt);
  });

  it("checkpoints canonical commit reconstruction and never returns a partial state as current", async () => {
    const projectId = "PRJ-3910";
    const commits = commitFixture(projectId, 8);
    let reads: number[] = [];
    const repository = {
      readProjectState: async () => null,
      readCommitRecord: async (_project: string, revision: number) => {
        reads.push(revision);
        return commits[revision - 1] ?? null;
      }
    };
    let startChecks = 0;
    const partialBudget: SliceBudget = {
      deadline_ms: Date.now() + 25_000,
      calls_left: 32,
      now: () => Date.now(),
      signal: new AbortController().signal,
      beforeHttp: () => undefined,
      canStartEffect: () => ++startChecks <= 2
    };
    const guard = materializationNamespace().getByName(projectId);
    const partial = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { canonicalState(repo: unknown, budget: SliceBudget): Promise<unknown> })
        .canonicalState(repository, partialBudget)
    );

    expect(partial).toMatchObject({ complete: false, state: null });
    expect(reads).toEqual([1, 2]);

    reads = [];
    const resumed = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { canonicalState(repo: unknown): Promise<unknown> })
        .canonicalState(repository)
    );
    expect(resumed).toMatchObject({ complete: true, state: { project_id: projectId, revision: 8 } });
    expect(reads).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps bounded canonical diagnostics read-only when reconstruction is incomplete", async () => {
    const projectId = "PRJ-3911";
    const writes: string[] = [];
    const guard = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId,
      ctx: { storage: {
        get: async () => undefined,
        put: async () => { writes.push("put"); },
        delete: async () => { writes.push("delete"); },
        setAlarm: async () => { writes.push("alarm"); }
      } }
    }) as MaterializationGuard;
    const commits = commitFixture(projectId, 4);
    let reads = 0;
    const repository = {
      readProjectState: async () => null,
      readCommitRecord: async (_project: string, revision: number) => {
        reads += 1;
        return commits[revision - 1] ?? null;
      }
    };
    let checks = 0;
    const budget: SliceBudget = {
      deadline_ms: Date.now() + 25_000, calls_left: 32, now: () => Date.now(),
      signal: new AbortController().signal, beforeHttp: () => undefined,
      canStartEffect: () => ++checks <= 2
    };
    const result = await (guard as unknown as {
      canonicalState(repo: unknown, budget: SliceBudget, persist: boolean): Promise<unknown>;
      canonicalStatePendingResponse(schedule: boolean): Promise<Response>;
    }).canonicalState(repository, budget, false) as { complete: boolean; state: unknown };
    const response = await (guard as unknown as {
      canonicalStatePendingResponse(schedule: boolean): Promise<Response>;
    }).canonicalStatePendingResponse(false);

    expect(result).toEqual({ complete: false, state: null });
    expect(reads).toBe(2);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ reason: "canonical_state_reconstruction_pending" });
    expect(writes).toEqual([]);
  });

  it("exposes a separate MATERIALIZATION_GUARD Durable Object binding", () => {
    expect(materializationNamespace()).toBeDefined();
  });

  it("rejects cross-project target requests", async () => {
    const response = await materializationNamespace().getByName("PRJ-3902").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3903",
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(409);
  });

  it("rejects invalid materialization targets", async () => {
    const response = await materializationNamespace().getByName("PRJ-3904").fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "PRJ-3904",
          revision: -1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(400);
  });

  it("accepts a target without synchronously writing human workspace output", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3906";
    const receipt = await createProject(projectId, "target-handoff", "TXN-MATISO-3906-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const workspaceRoot = workspaceProjectRoot(projectId, "target-handoff");
    const filesBefore = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));

    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          revision: 1,
          projection_version: CURRENT_PROJECTION_VERSION
        })
      }
    );
    expect(response.status).toBe(200);

    const filesAfter = [...mock.files.keys()].filter((path) => path.startsWith(workspaceRoot));
    expect(filesAfter).toEqual(filesBefore);
  });

  it("owns projection execution in the separate MaterializationGuard alarm", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3905";
    const receipt = await createProject(projectId, "materialization-alarm", "TXN-MATISO-3905-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    const response = await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        revision: 1,
        projection_version: CURRENT_PROJECTION_VERSION
      })
    });
    expect(response.status).toBe(200);
    for (let slice = 0; slice < 32; slice += 1) {
      expect(await runDurableObjectAlarm(guard)).toBe(true);
      if (mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))) break;
    }
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(true);
  });

  it("reports a verified repair canary as current after its writer becomes idle", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3912";
    await createProject(projectId, "repair-current", "TXN-MATISO-3912-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        revision: 1,
        projection_version: CURRENT_PROJECTION_VERSION
      })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId,
      revision: 1,
      materialized: true,
      status: "current"
    });
  });

  it("keeps a retry wake when a verified head cannot notify ProjectGuard", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3917";
    await createProject(projectId, "finalization-retry", "TXN-MATISO-3917-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [projectId]: "repair" });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);
    await runInDurableObject(guard, async (instance, state) => {
      await state.storage.deleteAlarm();
      vi.spyOn(instance as any, "notifyProjectGuardOfCurrentHead").mockRejectedValue(new Error("temporary_project_guard_unavailable"));
    });

    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("notifies ProjectGuard from a legacy alarm even when the synchronous materialization left no queued target", async () => {
    const guard = materializationNamespace().getByName("PRJ-3918");
    let notify!: ReturnType<typeof vi.fn>;
    await runInDurableObject(guard, async (instance, state) => {
      (instance as any).layoutMode = "legacy";
      (instance as any).coordinatorForSlice = () => ({
        coordinator: { runNext: async () => ({ completed: false, more_work: false }) }
      });
      notify = vi.spyOn(instance as any, "notifyProjectGuardOfCurrentHead").mockResolvedValue(true);
      await state.storage.setAlarm(Date.now() + 1_000);
    });

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(notify).toHaveBeenCalled();
  });

  it("notifies ProjectGuard from an idle V2 alarm so a published head finalizes its covered receipts", async () => {
    const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
      projectId: "PRJ-3919",
      layoutMode: "v2",
      env: {},
      ledger: { capacitySnapshot: () => ({ status: { active: null, requested: null }, progress: null, reservations: [] }) },
      ctx: { storage: {
        get: async () => undefined,
        list: async () => new Map(),
        getAlarm: async () => null,
        setAlarm: vi.fn(async () => undefined)
      } },
      queue: Promise.resolve()
    }) as MaterializationGuard;
    const notify = vi.spyOn(materialization as any, "notifyProjectGuardOfCurrentHead").mockResolvedValue(true);

    await materialization.alarm();

    expect(notify).toHaveBeenCalledOnce();
  });

  it("keeps an idle verified canary current when bounded verification reads are slow", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3913";
    await createProject(projectId, "repair-slow-current", "TXN-MATISO-3913-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 200));
    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ materialized: true, status: "current" });
  });

  it("closes stale human work after the current durable head is verified", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3914";
    await createProject(projectId, "repair-stale-human", "TXN-MATISO-3914-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(true);

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "retry_wait",
      next_attempt_at: at,
      code: "human_internal_failure"
    };
    saved.progress.requested = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);

    const reconciled = await guard.fetch("https://materialization-guard.internal/reconcile", {
      method: "POST"
    });
    expect(reconciled.status).toBe(200);
    const acknowledged = await journal.load();
    expect(acknowledged?.progress).toMatchObject({ requested: null, active: null, next_alarm_at: null });

    const response = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ materialized: true, status: "current" });
    const repaired = await journal.load();
    expect(repaired?.progress).toMatchObject({ requested: null, active: null, next_alarm_at: null });
    expect(Object.values(repaired?.progress.obligations ?? {}).every((obligation) => obligation.state === "verified")).toBe(true);

    mock.files.delete(machineMaterializationHeadPath(projectId));
    const withoutProviderHead = await guard.fetch("https://materialization-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });
    expect([200, 202]).toContain(withoutProviderHead.status);
    const withoutProviderHeadBody = await withoutProviderHead.json<{ materialized: boolean; status: string }>();
    if (withoutProviderHeadBody.materialized) {
      expect(mock.files.has(machineMaterializationHeadPath(projectId))).toBe(true);
      expect(withoutProviderHeadBody.status).toBe("current");
    }
  });

  it("does not acknowledge a warm head when a current view has drifted at the provider", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3920";
    const slug = "repair-warm-drift";
    await createProject(projectId, slug, "TXN-MATISO-3920-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1], state: "retry_wait", next_attempt_at: at, code: "human_internal_failure"
    };
    saved.progress.requested = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);
    await mock.writeExternal(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`, "external drift after proof");

    let failedClosed = false;
    try {
      await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    } catch (error) {
      failedClosed = error instanceof Error && /current-view verification failed/i.test(error.message);
    }
    expect(failedClosed).toBe(true);

    const after = await journal.load();
    expect(after?.progress.obligations[human[0]]).toMatchObject({
      state: "retry_wait", code: "human_internal_failure", next_attempt_at: at
    });
    expect(after?.progress).toMatchObject({
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION },
      active: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
    expect(mock.files.get(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe("external drift after proof");
  });

  it("retires a covered blocked human obligation before rearming a newer canonical target", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3916";
    await createProject(projectId, "repair-covered-human", "TXN-MATISO-3916-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const persistence = createProductionPersistence(testEnv, projectId);
    const repository = new ProjectRepository(persistence, "v2");
    await repository.writeCommitRecord(commitFixture(projectId, 2)[1]!);
    const journal = new ConvergenceJournal(persistence, projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff" && obligation.target.revision === 1);
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "blocked",
      next_attempt_at: null,
      code: "identical_internal_failure_limit",
      failure_count: 6
    };
    const futureProjectionId = "c".repeat(64);
    saved.progress.obligations[futureProjectionId] = {
      ...human[1],
      id: futureProjectionId,
      target: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION + 1 },
      state: "blocked",
      next_attempt_at: null,
      code: "future_projection_not_materialized"
    };
    const olderFutureProjectionId = "d".repeat(64);
    saved.progress.obligations[olderFutureProjectionId] = {
      ...human[1],
      id: olderFutureProjectionId,
      target: { revision: 0, projection_version: CURRENT_PROJECTION_VERSION + 1 },
      state: "blocked",
      next_attempt_at: null,
      code: "older_future_projection_not_materialized"
    };
    saved.progress.canonical_observed_revision = 2;
    saved.progress.active = { revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.requested = { revision: 2, projection_version: CURRENT_PROJECTION_VERSION };
    saved.progress.next_alarm_at = null;
    await journal.save(saved.progress, saved.token);

    const recordPath = machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION);
    const originalRecord = mock.files.get(recordPath);
    expect(originalRecord).toBeDefined();
    if (!originalRecord) throw new Error("missing materialization record");
    const corruptRecord = JSON.parse(originalRecord) as Record<string, unknown>;
    corruptRecord.source_event_id = "EVT-999999";
    mock.files.set(recordPath, JSON.stringify(corruptRecord));
    await expect(guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" }))
      .rejects.toThrow("Materialization resume point canonical binding mismatch");
    expect((await journal.load())?.progress.obligations[human[0]].state).toBe("blocked");

    mock.files.set(recordPath, originalRecord);
    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const repaired = await journal.load();
    expect(repaired?.progress.obligations[human[0]]).toMatchObject({
      state: "verified",
      code: null,
      next_attempt_at: null,
      continuation: null
    });
    expect(repaired?.progress.obligations[futureProjectionId]).toMatchObject({
      state: "blocked",
      code: "future_projection_not_materialized"
    });
    expect(repaired?.progress.obligations[olderFutureProjectionId]).toMatchObject({
      state: "blocked",
      code: "older_future_projection_not_materialized"
    });
    expect(repaired?.progress.requested).toEqual({
      revision: 2,
      projection_version: CURRENT_PROJECTION_VERSION
    });
    expect(repaired?.progress.active?.revision).not.toBe(1);
  });

  it("requeues the current projection version even when an older obligation is still pending", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3915";
    await createProject(projectId, "repair-stale-generation", "TXN-MATISO-3915-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [projectId]: "repair"
      });
    });
    await guard.fetch("https://materialization-guard.internal/request-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    for (let slice = 0; slice < 64; slice += 1) {
      if (!await runDurableObjectAlarm(guard)) break;
    }

    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    const saved = await journal.load();
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("missing convergence journal");
    const human = Object.entries(saved.progress.obligations)
      .find(([, obligation]) => obligation.layer === "human_handoff");
    expect(human).toBeDefined();
    if (!human) throw new Error("missing human obligation");
    saved.progress.obligations[human[0]] = {
      ...human[1],
      state: "retry_wait",
      next_attempt_at: at,
      code: "generation_or_head_not_current"
    };
    saved.progress.requested = null;
    saved.progress.active = null;
    saved.progress.next_alarm_at = at;
    await journal.save(saved.progress, saved.token);
    mock.files.delete(machineMaterializationHeadPath(projectId));

    const response = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const repaired = await journal.load();
    expect(repaired?.progress.requested).toEqual({
      revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION
    });
  });

  it("reconciles and reports projection status from canonical machine state", async () => {
    installDropboxMock();
    const projectId = "PRJ-3907";
    const receipt = await createProject(projectId, "materialization-status", "TXN-MATISO-3907-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const guard = materializationNamespace().getByName(projectId);
    const status = await guard.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("reports unverified convergence health instead of inferring it from the head", async () => {
    installDropboxMock();
    const projectId = "PRJ-3910";
    await createProject(projectId, "convergence-health", "TXN-MATISO-3910-CREATE");

    const response = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/status",
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      convergence: {
        schema_version: "1.0",
        project_id: projectId,
        converged: false,
        layers: { human_handoff: { state: "unknown" } }
      }
    });
  });

  it("inspects a pending projection without scheduling or reconciling it", async () => {
    installDropboxMock();
    const projectId = "PRJ-3911";
    await createProject(projectId, "diagnostic-read-only", "TXN-MATISO-3911-CREATE");
    const guard = materializationNamespace().getByName(projectId);
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    const response = await guard.fetch(
      "https://materialization-guard.internal/diagnostic-status",
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      diagnostic: {
        read_only: true,
        final_verification_pending_count: 0,
        managed_zones_ready: false
      }
    });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("hands a committed canonical revision to MaterializationGuard automatically", async () => {
    installDropboxMock();
    const projectId = "PRJ-3909";
    const receipt = await createProject(projectId, "automatic-handoff", "TXN-MATISO-3909-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    const status = await materializationNamespace().getByName(projectId).fetch(
      "https://materialization-guard.internal/status",
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      project_id: projectId,
      canonical_revision: 1,
      requested: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }
    });
  });

  it("keeps projection hot state out of ProjectGuard", async () => {
    installDropboxMock();
    const projectId = "PRJ-3908";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "project-guard-canonical-only", "TXN-MATISO-3908-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const materializationTables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_%' ORDER BY name"
      ).toArray();
      expect(materializationTables).toEqual([]);
    });
  });

  it("does not let ProjectGuard own projection alarms", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-3901";
    const projectGuard = testEnv.PROJECT_GUARD.getByName(projectId);

    const receipt = await createProject(projectId, "materialization-isolation", "TXN-MATISO-3901-CREATE");
    expect(receipt).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(projectGuard, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(projectGuard)).toBe(true);
    expect(
      mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))
    ).toBe(false);
  });
});
