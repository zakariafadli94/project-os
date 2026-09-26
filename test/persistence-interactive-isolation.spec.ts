import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { machineCommitRecordPath } from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { isStoredPersistenceObservation, persistenceObservationStorageKey } from "../src/persistence/observation";
import { ProjectRepository } from "../src/persistence/repository";
import { installDropboxMock } from "./helpers/mock-dropbox";

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
