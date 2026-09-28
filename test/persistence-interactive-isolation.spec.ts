import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { machineCommitRecordPath } from "../src/persistence/layout";
import { workspaceProjectRoot } from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { isStoredPersistenceObservation, persistenceObservationStorageKey } from "../src/persistence/observation";
import { ProjectRepository } from "../src/persistence/repository";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { initialProgress } from "../src/convergence/journal";
import { MaterializationLedger } from "../src/materialization/ledger";
import { sha256Text } from "../src/documents/hash";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { AdmissionError } from "../src/admission/mutation-context";

const testEnv = env as unknown as Env;
const createdAt = "2026-09-26T09:00:00.000Z";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("interactive persistence isolation", () => {
  it("refuses a document publish at saturated capacity before writing or changing the head", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-9606";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const materializer = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const created = await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9606-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-saturation", slug: "interactive-saturation", aliases: [], objective: "Protect physical publish at capacity" }
    });
    await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(created);
    const content = "# Saturation review\n\nApproved physical version.\n";
    const workingResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "working.write", request_id: "DOCREQ-ISO9606WORK0001", project_id: projectId,
        logical_path: "strategy/review.md", content, content_sha256: await sha256Text(content), created_at: createdAt })
    });
    const working = await workingResponse.json<Record<string, any>>();
    expect(workingResponse.status).toBe(200);
    const reviewResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "review.promote", request_id: "DOCREQ-ISO9606REVIEW001", project_id: projectId,
        document_id: working.document_id, expected_version_id: working.version_id, created_at: createdAt })
    });
    const review = await reviewResponse.json<Record<string, any>>();
    expect(reviewResponse.status).toBe(200);

    const progress = initialProgress(projectId, new Date().toISOString(), "interactive-saturation-proof");
    progress.canonical_observed_revision = 1;
    const now = new Date().toISOString();
    progress.obligations = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return [id, {
        id, layer: "state", from_revision: 0,
        target: { revision: 2, projection_version: CURRENT_PROJECTION_VERSION },
        incident: 1, state: "pending", first_pending_at: now,
        next_attempt_at: null, failure_count: 0, last_attempt_number: 0,
        last_closed_attempt_number: 0, last_verified_at: null, code: null,
        lease_until: null, continuation: null
      }];
    }));
    const modes = JSON.stringify({ [projectId]: "repair" });
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
    await runInDurableObject(materializer, async (instance, state) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
      new MaterializationLedger(state.storage, projectId).restoreConvergenceCheckpoint(progress, "interactive-saturation-token");
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "publish", request_id: "DOCREQ-ISO9606PUBLISH001", project_id: projectId,
        document_id: working.document_id, expected_version_id: review.version_id, created_at: "2026-09-26T09:02:00.000Z" })
    });
    expect(response.status).toBe(503);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, "interactive-saturation")}/DELIVERABLES/strategy/review.md`)).toBe(false);
    await expect(guard.fetch(`https://project-guard.internal/document-status?document_id=${working.document_id}`).then((r) => r.json()))
      .resolves.toMatchObject({ document_id: working.document_id, review_version_id: review.version_id });
    expect(mock.files.has(`/PROJECT_OS/.project-os/projects/${projectId}/documents/requests/DOCREQ-ISO9606PUBLISH001/intent.json`)).toBe(false);

    const artifactContent = "# Saturated artifact\n";
    const artifact = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "ART-ISO-9606-SATURATED", project_id: projectId,
        relative_path: "evidence/saturated.md", content: artifactContent,
        content_sha256: await sha256Text(artifactContent), mode: "create" })
    });
    expect(artifact.status).toBe(503);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, "interactive-saturation")}/DELIVERABLES/evidence/saturated.md`)).toBe(false);
    expect(mock.files.has(`/PROJECT_OS/.project-os/artifacts/${projectId}/requests/ART-ISO-9606-SATURATED/intent.json`)).toBe(false);
  });

  it("commits independent work during suspended maintenance while physical publication still checks its exact provider", async () => {
    const mock = installDropboxMock();
    const projectId = "PRJ-9605";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const materializer = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const otherProjectId = "PRJ-9607";
    const otherGuard = testEnv.PROJECT_GUARD.getByName(otherProjectId);
    const otherMaterializer = testEnv.MATERIALIZATION_GUARD.getByName(otherProjectId);
    const created = await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9605-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-capacity", slug: "interactive-capacity", aliases: [], objective: "Admit independent work during maintenance" }
    });
    await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(created);
    const otherCreated = await submit(otherProjectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9607-CREATE", project_id: otherProjectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-independent", slug: "interactive-independent", aliases: [], objective: "Prove cross-project admission during maintenance" }
    });
    await new ProjectRepository(createProductionPersistence(testEnv, otherProjectId), "v2").writeReceipt(otherCreated);

    const originalContent = "# Commercial strategy\n\nReviewed version.\n";
    const workingResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "working.write", request_id: "DOCREQ-ISO9605WORK0001", project_id: projectId,
        logical_path: "strategy/commercial.md", content: originalContent, content_sha256: await sha256Text(originalContent), created_at: createdAt })
    });
    const working = await workingResponse.json<Record<string, any>>();
    expect(workingResponse.status).toBe(200);
    expect(working).toMatchObject({ status: "committed", stage: "working" });
    const reviewResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "review.promote", request_id: "DOCREQ-ISO9605REVIEW001", project_id: projectId,
        document_id: working.document_id, expected_version_id: working.version_id, created_at: createdAt })
    });
    const review = await reviewResponse.json<Record<string, any>>();
    expect(reviewResponse.status).toBe(200);
    expect(review).toMatchObject({ status: "committed", stage: "review" });
    const reviewPath = `${workspaceProjectRoot(projectId, "interactive-capacity")}/REVIEW/strategy/commercial.md`;
    await mock.writeExternal(reviewPath, "# Commercial strategy\n\nChanged after review.\n");
    const checkpoint = initialProgress(projectId, createdAt, "interactive-capacity-proof");
    checkpoint.canonical_observed_revision = 1;
    const otherCheckpoint = initialProgress(otherProjectId, createdAt, "interactive-other-project-proof");
    otherCheckpoint.canonical_observed_revision = 1;
    await runInDurableObject(materializer, (_instance, state) => {
      new MaterializationLedger(state.storage, projectId).restoreConvergenceCheckpoint(checkpoint, "interactive-capacity-token");
    });
    const modes = JSON.stringify({ [projectId]: "repair", [otherProjectId]: "repair" });
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
    await runInDurableObject(materializer, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
    await runInDurableObject(otherGuard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
    });
    await runInDurableObject(otherMaterializer, (instance, state) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
      new MaterializationLedger(state.storage, otherProjectId).restoreConvergenceCheckpoint(otherCheckpoint, "interactive-other-project-token");
    });

    let releaseMaintenance!: () => void;
    let enteredMaintenance!: () => void;
    const maintenance = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    const entered = new Promise<void>((resolve) => { enteredMaintenance = resolve; });
    let held!: Promise<void>;
    await runInDurableObject(materializer, async (instance) => {
      held = (instance as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> })
        .serialize(async () => { enteredMaintenance(); await maintenance; });
      await entered;
    });

    const submitAsync = (transaction: unknown) => guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify(transaction)
    });
    try {
      const first = await submitAsync({
        schema_version: "1.0", transaction_id: "TXN-ISO-9605-FIRST", project_id: projectId,
        base_revision: 1, operation: "task.create", created_at: "2026-09-26T09:01:00.000Z",
        payload: { task_id: "TASK-ISO9605PENDING", title: "Pending materialization" }
      });
      const firstBody = await first.json();
      expect(first.status, JSON.stringify(firstBody)).toBe(200);
      expect(firstBody).toMatchObject({ status: "committed", new_revision: 2 });

      const dependentPublication = await guard.fetch("https://project-guard.internal/document", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "publish", request_id: "DOCREQ-ISO9605PUBLISH001", project_id: projectId,
          document_id: working.document_id, expected_version_id: review.version_id, created_at: "2026-09-26T09:02:00.000Z" })
      });
      expect(dependentPublication.status).toBe(200);
      await expect(dependentPublication.json()).resolves.toMatchObject({
        status: "conflict", code: "PROVIDER_VERSION_CHANGED", document_id: working.document_id
      });
      const documentStatus = await guard.fetch(`https://project-guard.internal/document-status?document_id=${working.document_id}`);
      await expect(documentStatus.json()).resolves.toMatchObject({ document_id: working.document_id, review_version_id: review.version_id });
      expect(mock.files.has(`${workspaceProjectRoot(projectId, "interactive-capacity")}/DELIVERABLES/strategy/commercial.md`)).toBe(false);

      const canonicalProgress = await submitAsync({
        schema_version: "1.0", transaction_id: "TXN-ISO-9605-COMPLETE", project_id: projectId,
        base_revision: 2, operation: "task.complete", created_at: "2026-09-26T09:02:30.000Z",
        payload: { task_id: "TASK-ISO9605PENDING", result: "Canonical work may progress without an updated view" }
      });
      expect(canonicalProgress.status).toBe(200);
      await expect(canonicalProgress.json()).resolves.toMatchObject({ status: "committed", new_revision: 3 });

      const independent = await submitAsync({
        schema_version: "1.0", transaction_id: "TXN-ISO-9605-INDEPENDENT", project_id: projectId,
        base_revision: 3, operation: "task.create", created_at: "2026-09-26T09:03:00.000Z",
        payload: { task_id: "TASK-ISO9605INDEPENDENT", title: "Independent during maintenance" }
      });
      expect(independent.status).toBe(200);
      await expect(independent.json()).resolves.toMatchObject({ status: "committed", new_revision: 4 });

      const otherProjectWork = await otherGuard.fetch("https://project-guard.internal/transaction", {
        method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify({ schema_version: "1.0", transaction_id: "TXN-ISO-9607-INDEPENDENT", project_id: otherProjectId,
          base_revision: 1, operation: "task.create", created_at: "2026-09-26T09:04:00.000Z",
          payload: { task_id: "TASK-ISO9607INDEPENDENT", title: "Other project progresses during maintenance" } })
      });
      expect(otherProjectWork.status).toBe(200);
      await expect(otherProjectWork.json()).resolves.toMatchObject({ status: "committed", new_revision: 2 });
    } finally {
      releaseMaintenance();
      await held;
    }
  });

  it("retains exact staged work when the capacity reservation reply is lost and recovers it once", async () => {
    const projectId = "PRJ-9608";
    const mock = installDropboxMock();
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const materializer = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const created = await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9608-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-acquire-recovery", slug: "interactive-acquire-recovery", aliases: [], objective: "Recover after reservation response loss" }
    });
    await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(created);
    const checkpoint = initialProgress(projectId, createdAt, "interactive-acquire-recovery-proof");
    checkpoint.canonical_observed_revision = 1;
    const modes = JSON.stringify({ [projectId]: "repair" });
    await runInDurableObject(guard, (instance) => { (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes; });
    await runInDurableObject(materializer, (instance, state) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = modes;
      new MaterializationLedger(state.storage, projectId).restoreConvergenceCheckpoint(checkpoint, "interactive-acquire-recovery-token");
    });
    const request = {
      schema_version: "1.0", transaction_id: "TXN-ISO-9608-LOST-ACQUIRE", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: "2026-09-26T09:05:00.000Z",
      payload: { task_id: "TASK-ISO9608RECOVER", title: "Recover after reservation was committed" }
    };
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const original = (instance as any).assertCommitCapacity.bind(instance);
      const spy = vi.spyOn(instance as any, "assertCommitCapacity").mockImplementationOnce(async (...args: unknown[]) => {
        await original(...args);
        throw new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "unknown" });
      });
      restore = () => spy.mockRestore();
    });
    const response = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify(request)
    });
    expect(response.status).toBe(503);
    const staged = await runInDurableObject(guard, (instance) => (instance as any).ctx.storage.sql.exec(
      "SELECT request_json FROM request_recovery_payload WHERE kind = 'transaction' AND request_id = ?", request.transaction_id
    ).toArray());
    expect(staged).toHaveLength(1);
    expect(JSON.parse(staged[0].request_json).request).toEqual(request);
    restore();

    await runDurableObjectAlarm(guard);
    const recovered = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${request.transaction_id}`);
    await expect(recovered.json()).resolves.toMatchObject({ status: "committed", new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("status_remains_observable_during_navigation_and_lost_commit_response", async () => {
    const projectId = "PRJ-9601";
    const mock = installDropboxMock();
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const created = await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9601-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-isolation", slug: "interactive-isolation", aliases: [], objective: "Prove status availability during maintenance" }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });
    await new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2").writeReceipt(created);
    const contextResponse = await guard.fetch("https://project-guard.internal/context");
    const contextPage = await contextResponse.json<Record<string, any>>();
    expect(contextResponse.status).toBe(200);
    expect(contextPage).toMatchObject({ status: "ok", project_id: projectId, revision: 1, freshness: "verified" });
    expect(contextPage.context).not.toHaveProperty("token");

    const request = {
      schema_version: "1.0", transaction_id: "TXN-ISO-9601-TASK", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: "2026-09-26T09:01:00.000Z",
      payload: { task_id: "TASK-ISO9601", title: "Recover exact request after response loss" }
    };
    let releaseMaintenance!: () => void;
    const maintenance = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const spy = vi.spyOn(instance as any, "requestMaterializationSafely").mockImplementationOnce(async () => {
        await maintenance;
      });
      restore = () => spy.mockRestore();
    });

    const submission = guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    }).then(async (response) => {
      // Simulate the client losing a successful response after the server has
      // completed its canonical and maintenance work.
      await response.body?.cancel();
      throw new Error("simulated_lost_commit_response");
    });
    await vi.waitFor(() => expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true));
    let observed!: { status: number; body: Record<string, unknown> };
    let receiptObserved!: { status: number; body: Record<string, unknown> };
    let executionObserved!: { status: number; body: Record<string, unknown> };
    let cacheReceipt: unknown;
    let contextDuringMaintenance!: Response;
    try {
      contextDuringMaintenance = await guard.fetch("https://project-guard.internal/context");
      const status = await guard.fetch(
        `https://project-guard.internal/request-status?kind=transaction&request_id=${request.transaction_id}`
      );
      observed = { status: status.status, body: await status.json<Record<string, unknown>>() };
      cacheReceipt = await runInDurableObject(guard, async (instance) => {
        const cached = await (instance as any).readStoredRequestObservation(projectId, "transaction", request.transaction_id) as Response | null;
        return cached ? cached.json() : null;
      });
      const receipt = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${request.transaction_id}`);
      receiptObserved = { status: receipt.status, body: await receipt.json<Record<string, unknown>>() };
      const execution = await guard.fetch(`https://project-guard.internal/execution-status?kind=transaction&request_id=${request.transaction_id}`);
      executionObserved = { status: execution.status, body: await execution.json<Record<string, unknown>>() };
    } finally {
      releaseMaintenance();
      await expect(submission).rejects.toThrow("simulated_lost_commit_response");
      restore();
    }

    // The commit is already canonical; unrelated navigation/finalization work
    // must not turn its known status into READ_BUSY/unknown.
    expect(observed.status).toBe(200);
    expect(contextDuringMaintenance.status).toBe(200);
    expect(observed.body).toMatchObject({
      project_id: projectId, kind: "transaction", request_id: request.transaction_id,
      status: "committed", receipt: { status: "committed", new_revision: 2 }
    });
    expect(cacheReceipt).toMatchObject({ status: "committed", receipt: { transaction_id: request.transaction_id } });
    expect(receiptObserved).toMatchObject({ status: 200, body: { transaction_id: request.transaction_id, status: "committed", new_revision: 2 } });
    expect(executionObserved.status).toBe(503);
    expect(executionObserved.body).toMatchObject({ status: "unknown", code: "PROJECT_OS_READ_BUSY" });
    expect(executionObserved.body).not.toHaveProperty("finalization_ref");

    // A later runtime wake and an exact client retry are recovery, not a new
    // transaction. The immutable canonical history must remain at revision 2.
    await runDurableObjectAlarm(guard);
    const replay = await submit(projectId, request);
    expect(replay).toMatchObject({ status: "committed", new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
  });

  it("rejects a cached observation whose request identity does not match its lookup key", () => {
    const valid = {
      schema_version: "1.0", project_id: "PRJ-9602", kind: "transaction", request_id: "TXN-9602-A",
      observed_at: "2026-09-26T10:00:00.000Z", observation_sequence: 1, request_hash: "a".repeat(64),
      evidence_ref: "/canonical/commit.json", evidence_sha256: "b".repeat(64),
      response: { project_id: "PRJ-9602", kind: "transaction", request_id: "TXN-9602-A",
        status: "committed", observation: { project_id: "PRJ-9602", kind: "transaction", request_id: "TXN-9602-A" } }
    };
    expect(persistenceObservationStorageKey("transaction", "TXN-9602-A")).toContain("TXN-9602-A");
    expect(isStoredPersistenceObservation(valid, {
      project_id: "PRJ-9602", kind: "transaction", request_id: "TXN-9602-A"
    })).toBe(true);
    expect(isStoredPersistenceObservation({
      ...valid,
      response: { ...valid.response, request_id: "TXN-9602-OTHER" }
    }, { project_id: "PRJ-9602", kind: "transaction", request_id: "TXN-9602-A" })).toBe(false);
    expect(isStoredPersistenceObservation(valid, {
      project_id: "PRJ-9999", kind: "transaction", request_id: "TXN-9602-A"
    })).toBe(false);
  });

  it("keeps an admitted document request observable while its provider effect is still running", async () => {
    const projectId = "PRJ-9603";
    const mock = installDropboxMock();
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9603-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-document", slug: "interactive-document", aliases: [], objective: "Observe admitted document work" }
    });
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const original = (instance as any).executeManagedDocument.bind(instance);
      const spy = vi.spyOn(instance as any, "executeManagedDocument").mockImplementation(async (operation: unknown, state: unknown) => {
        await hold;
        return original(operation, state);
      });
      restore = () => spy.mockRestore();
    });
    const operation = {
      operation: "working.write", request_id: "DOCREQ-ISO-9603-WORK", project_id: projectId,
      logical_path: "strategy/current.md", content: "# Current\n", content_sha256: await import("../src/documents/hash").then(m => m.sha256Text("# Current\n")),
      created_at: "2026-09-26T10:01:00.000Z"
    };
    const submission = guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(operation)
    });
    try {
      await vi.waitFor(async () => {
        const intent = mock.files.has(`/PROJECT_OS/.project-os/projects/${projectId}/documents/requests/${operation.request_id}/intent.json`);
        expect(intent).toBe(true);
      });
      await runInDurableObject(guard, (instance) =>
        (instance as any).ctx.storage.delete(persistenceObservationStorageKey("document", operation.request_id))
      );
      const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${operation.request_id}`);
      const body = await response.json<Record<string, any>>();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: "admitted_uncommitted", receipt: null,
        observation: { status: "admitted_uncommitted", freshness: "verified", recovery: { durable_intent: true, state: "scheduled" } } });
      expect(body.observation).not.toHaveProperty("token");
    } finally {
      release();
      await submission;
      restore();
    }
  });

  it("keeps an admitted artifact request observable after its canonical mutation intent is recorded", async () => {
    const projectId = "PRJ-9604";
    installDropboxMock();
    await submit(projectId, {
      schema_version: "1.0", transaction_id: "TXN-ISO-9604-CREATE", project_id: projectId,
      base_revision: 0, operation: "project.create", created_at: createdAt,
      payload: { name: "interactive-artifact", slug: "interactive-artifact", aliases: [], objective: "Observe admitted artifact work" }
    });
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const content = "# Evidence\n";
    const request = {
      request_id: "ART-ISO-9604-EVIDENCE", project_id: projectId, relative_path: "evidence/current.md",
      content, content_sha256: await import("../src/documents/hash").then(m => m.sha256Text(content)), mode: "create"
    };
    const observed = await runInDurableObject(guard, async (instance) => {
      const spy = vi.spyOn(instance as any, "beginArtifactNavigationSource").mockImplementation(async () => {
        entered();
        await hold;
      });
      const submission = (instance as any).fetch(new Request("https://project-guard.internal/artifact", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
      })) as Promise<Response>;
      try {
        await started;
        const response = await (instance as any).readStoredRequestObservation(projectId, "artifact", request.request_id) as Response | null;
        const observed = response ? { status: response.status, body: await response.json<Record<string, any>>() } : null;
        release();
        const completed = await submission;
        expect(completed.status).toBe(200);
        return observed;
      } finally {
        release();
        spy.mockRestore();
      }
    });
    expect(observed?.status).toBe(200);
    expect(observed?.body).toMatchObject({ status: "admitted_uncommitted", receipt: null,
      observation: { status: "admitted_uncommitted", freshness: "stale", recovery: { durable_intent: true, state: "scheduled" } } });
  });
});
