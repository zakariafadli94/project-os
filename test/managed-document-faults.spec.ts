import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { encodeAdmission } from "../src/admission/transport";
import { AdmissionError } from "../src/admission/mutation-context";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentRoot, machineDocumentVersionPath, workspaceManagedDocumentPath } from "../src/persistence/layout";
import { ExecutionJournal } from "../src/execution/journal";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";

const testEnv = env as unknown as Env;
const at = "2026-08-25T01:05:00+01:00";

async function createProject(suffix = "0001"): Promise<Receipt> {
  const tag = suffix.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-MANAGED-FAULT-${tag}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: tag === "0001" ? "Managed fault" : `Managed fault ${tag}`,
        slug: tag === "0001" ? "managed-fault" : `managed-fault-${tag.toLowerCase()}`,
        aliases: [],
        objective: "Prove recovery after provider CAS"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status, JSON.stringify(receipt)).toBe("committed");
  return receipt;
}

async function documentCall(guard: DurableObjectStub, body: Record<string, unknown>) {
  return guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function jsonCall(guard: DurableObjectStub, body: Record<string, unknown>) {
  const response = await documentCall(guard, body);
  return response.json<any>();
}

async function workingWrite(
  guard: DurableObjectStub,
  projectId: string,
  requestId: string,
  content: string,
  expectedVersionId?: string
) {
  return jsonCall(guard, {
    operation: "working.write",
    request_id: requestId,
    project_id: projectId,
    logical_path: "strategy/commercial.md",
    content,
    content_sha256: await sha256Text(content),
    ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
    created_at: at
  });
}

async function publishVersionId(requestId: string): Promise<string> {
  const digest = await sha256Text(`${requestId}\npublished`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

describe("managed document crash recovery", () => {
  let faults: DropboxMockFault[];

  beforeEach(() => { faults = []; });
  afterEach(() => vi.restoreAllMocks());

  it("replays the same publish after Dropbox CAS succeeded but immutable version persistence failed", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const v1 = await workingWrite(guard, created.project_id, "DOCREQ-FAULT-WORK-0001", "published v1");
    const review1 = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-FAULT-REVIEW-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: v1.version_id,
      created_at: at
    });
    const published1 = await jsonCall(guard, {
      operation: "publish",
      request_id: "DOCREQ-FAULT-PUBLISH-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review1.version_id,
      created_at: at
    });
    expect(published1.status).toBe("committed");

    const reopened = await jsonCall(guard, {
      operation: "reopen",
      request_id: "DOCREQ-FAULT-REOPEN-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: published1.version_id,
      created_at: at
    });
    const v2 = await workingWrite(
      guard,
      created.project_id,
      "DOCREQ-FAULT-WORK-0002",
      "published v2 after crash",
      reopened.version_id
    );
    const review2 = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-FAULT-REVIEW-0002",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: v2.version_id,
      created_at: at
    });

    const publishRequestId = "DOCREQ-FAULT-PUBLISH-0002";
    const expectedPublishedVersionId = await publishVersionId(publishRequestId);
    const versionPath = machineDocumentVersionPath(created.project_id, v1.document_id, expectedPublishedVersionId);
    faults.push({
      endpoint: "/2/files/upload",
      path: versionPath,
      occurrence: 1,
      status: 409,
      error_summary: "path/conflict/file/injected_version_write_after_provider_cas"
    });

    const publishBody = {
      operation: "publish",
      request_id: publishRequestId,
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review2.version_id,
      created_at: at
    };

    try {
      await documentCall(guard, publishBody);
    } catch {
      // The injected non-retryable ledger failure is expected to escape the first attempt.
    }

    const publishedPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-managed-fault/DELIVERABLES/strategy/commercial.md`;
    expect(mock.files.get(publishedPath)).toContain("published v2 after crash");
    expect(mock.files.has(versionPath)).toBe(false);

    const replayResponse = await documentCall(guard, publishBody);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      status: "committed",
      document_id: v1.document_id,
      version_id: expectedPublishedVersionId,
      stage: "published"
    });
    expect(mock.files.has(versionPath)).toBe(true);
  });

  it("recovers a governed working write after admission persisted but before recovery queue and intent", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGE-AFTER-ADMISSION");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-fault-context-secret";
    const ruleSecret = "managed-document-fault-rule-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    expect(contextResponse.status).toBe(200);
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-FAULT-STAGED-BEFORE-ADMISSION-0001",
      project_id: created.project_id,
      logical_path: "strategy/recovered.md",
      content: "Recover from the admitted request without resubmission.",
      content_sha256: await sha256Text("Recover from the admitted request without resubmission."),
      created_at: at
    };
    const body = encodeAdmission(request, mutationContext);
    const originalCommit = ExecutionJournal.prototype.commit;
    let interrupted = false;
    vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if (this.requestId === request.request_id && !interrupted) {
        interrupted = true;
        throw new Error("injected_after_complete_execution_journal");
      }
      return result;
    });

    const interruptedResponse = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(interruptedResponse.status).toBe(503);
    const staged = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      alarm: await durableState.storage.getAlarm()
    }));
    expect(staged.payload?.request_json).toBe(JSON.stringify(request));
    expect(staged.payload?.request_sha256).toBe(await sha256Text(JSON.stringify(request)));
    expect(staged.queued).toBe(false);
    expect(staged.alarm).not.toBeNull();
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);

    await runDurableObjectAlarm(guard);

    const visiblePath = workspaceManagedDocumentPath(created.project_id, "managed-fault-stageafteradmission", "working", request.logical_path);
    expect(mock.files.get(visiblePath)).toContain(request.content);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(true);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBe(true);
    const recovered = await runInDurableObject(guard, (_instance, durableState) => ({
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      payload: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0
    }));
    expect(recovered).toEqual({ queued: false, payload: false, marker: false });
  });

  it("recovers a pinned governed review write after admission persisted but before recovery queue and intent", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGE-REVIEW-AFTER-ADMISSION");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const ruleSecret = "managed-review-stage-rule-secret";
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const initialContent = "Review candidate before the exact pinned update.";
    const initial = await workingWrite(guard, created.project_id, "DOCREQ-REVIEW-STAGE-INITIAL-0001", initialContent);
    const review = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-REVIEW-STAGE-PROMOTE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: initial.version_id,
      created_at: at
    });
    expect(review.status).toBe("committed");

    const contextSecret = "managed-review-stage-context-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    expect(contextResponse.status).toBe(200);
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "review.write" as const,
      request_id: "DOCREQ-REVIEW-STAGE-UPDATE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: review.version_id,
      created_at: at,
      content: "Recover this exact review candidate update once.",
      content_sha256: await sha256Text("Recover this exact review candidate update once."),
    };
    const exactJson = JSON.stringify(request);
    const originalCommit = ExecutionJournal.prototype.commit;
    let interrupted = false;
    vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if (this.requestId === request.request_id && !interrupted) {
        interrupted = true;
        throw new Error("injected_after_complete_review_execution_journal");
      }
      return result;
    });

    const interruptedResponse = await documentCall(
      guard,
      encodeAdmission(request, mutationContext) as unknown as Record<string, unknown>
    );
    expect(interruptedResponse.status).toBe(503);
    const pending = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_sha256: string; phase: string }>(
        "SELECT request_sha256, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      progress: await new ExecutionJournal(
        (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
        created.project_id,
        "document",
        request.request_id
      ).status()
    }));
    expect(pending.payload).toEqual({ request_json: exactJson, request_sha256: await sha256Text(exactJson) });
    expect(pending.marker).toEqual({ request_sha256: await sha256Text(exactJson), phase: "admission_write_attempted" });
    expect(pending.queued).toBe(false);
    expect(pending.progress).toMatchObject({ status: "admitted", sequence: 0, terminal: false });
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
    const reviewPath = workspaceManagedDocumentPath(created.project_id, "managed-fault-stagereviewafteradmission", "review", "strategy/commercial.md");
    const beforeRecovery = mock.files.get(reviewPath);

    await runInDurableObject(guard, (instance) => {
      const instanceEnv = (instance as unknown as { env: Env }).env;
      instanceEnv.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [created.project_id]: "repair" });
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }))
        .mockResolvedValue(undefined);
    });
    await runDurableObjectAlarm(guard);
    const afterCapacityWait = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_sha256: string; phase: string }>(
        "SELECT request_sha256, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      failure: durableState.storage.sql.exec<{ stopped: number; count: number; message: string }>(
        "SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterCapacityWait.payload).toEqual({ request_json: exactJson, request_sha256: await sha256Text(exactJson) });
    expect(afterCapacityWait.marker).toEqual({ request_sha256: await sha256Text(exactJson), phase: "admission_write_attempted" });
    expect(afterCapacityWait.queued).toBe(true);
    expect(afterCapacityWait.failure).toMatchObject({ stopped: 0, count: 1 });
    expect(JSON.parse(afterCapacityWait.failure!.message)).toMatchObject({ code: "convergence_capacity_exceeded" });
    expect(afterCapacityWait.alarm).not.toBeNull();
    expect(mock.files.get(reviewPath)).toBe(beforeRecovery);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);

    await runInDurableObject(guard, (_instance, durableState) => {
      const failure = durableState.storage.sql.exec<{ message: string }>(
        "SELECT message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0]!;
      const diagnostic = JSON.parse(failure.message);
      diagnostic.next_attempt_at = new Date(0).toISOString();
      durableState.storage.sql.exec(
        "UPDATE request_recovery_failures SET message = ? WHERE kind = 'document' AND request_id = ?",
        JSON.stringify(diagnostic), request.request_id
      );
    });
    await runDurableObjectAlarm(guard);
    const afterCapacityRetry = await runInDurableObject(guard, async (_instance, durableState) => ({
      failure: durableState.storage.sql.exec<{ stopped: number; count: number; message: string }>(
        "SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterCapacityRetry.failure).toBeNull();
    expect(afterCapacityRetry.queued).toBe(false);
    expect(mock.files.get(reviewPath)).not.toBe(beforeRecovery);
    expect(mock.files.get(reviewPath)).toContain(request.content);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(true);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBe(true);
    const recovered = await runInDurableObject(guard, (_instance, durableState) => ({
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      payload: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0
    }));
    expect(recovered).toEqual({ queued: false, payload: false, marker: false });
  });

  it("does not make an unpinned governed review write eligible for staged automatic recovery", async () => {
    installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGE-UNPINNED-REVIEW");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-unpinned-review-context-secret";
    const ruleSecret = "managed-unpinned-review-rule-secret";
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const initial = await workingWrite(guard, created.project_id, "DOCREQ-UNPINNED-REVIEW-INITIAL-0001", "Review candidate before unpinned request.");
    expect(initial).toMatchObject({ status: "committed", document_id: expect.any(String), version_id: expect.any(String) });
    const review = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-UNPINNED-REVIEW-PROMOTE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: initial.version_id,
      created_at: at
    });
    expect(review.status).toBe("committed");
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    })).json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "review.write" as const,
      request_id: "DOCREQ-UNPINNED-REVIEW-UPDATE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      created_at: at,
      content: "Do not recover this request against a moving review head.",
      content_sha256: await sha256Text("Do not recover this request against a moving review head.")
    };
    const originalCommit = ExecutionJournal.prototype.commit;
    vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if (this.requestId === request.request_id) throw new Error("injected_after_unpinned_review_admission");
      return result;
    });
    const response = await documentCall(guard, encodeAdmission(request, context) as unknown as Record<string, unknown>);
    expect(response.status, await response.clone().text()).toBe(503);
    const recovery = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      progress: await new ExecutionJournal(
        (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
        created.project_id,
        "document",
        request.request_id
      ).status()
    }));
    expect(recovery.payload).toBe(0);
    expect(recovery.marker).toBe(0);
    expect(recovery.queued).toBe(0);
    expect(recovery.progress).toMatchObject({ status: "admitted", sequence: 0, terminal: false });
    expect(review.version_id).toBeDefined();
  });

  it("conflicts a staged pinned review write when its expected review version advances before recovery", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGE-REVIEW-STALE-VERSION");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-stale-review-context-secret";
    const ruleSecret = "managed-stale-review-rule-secret";
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const initial = await workingWrite(guard, created.project_id, "DOCREQ-STALE-REVIEW-INITIAL-0001", "Review candidate before stale request.");
    expect(initial).toMatchObject({ status: "committed", document_id: expect.any(String), version_id: expect.any(String) });
    const review = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-STALE-REVIEW-PROMOTE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: initial.version_id,
      created_at: at
    });
    expect(review.status).toBe("committed");
    expect(mock.files.has(machineDocumentVersionPath(created.project_id, initial.document_id, review.version_id))).toBe(true);
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    })).json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "review.write" as const,
      request_id: "DOCREQ-STALE-REVIEW-UPDATE-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: review.version_id,
      created_at: at,
      content: "This pinned write must not retarget a newer review candidate.",
      content_sha256: await sha256Text("This pinned write must not retarget a newer review candidate.")
    };
    const originalCommit = ExecutionJournal.prototype.commit;
    let interrupted = false;
    const journalCommitSpy = vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if (this.requestId === request.request_id && !interrupted) {
        interrupted = true;
        throw new Error("injected_after_pinned_review_admission");
      }
      return result;
    });
    const interruptedResponse = await documentCall(guard, encodeAdmission(request, context) as unknown as Record<string, unknown>);
    expect(interruptedResponse.status, await interruptedResponse.clone().text()).toBe(503);
    journalCommitSpy.mockRestore();

    const newerRequest = {
      operation: "review.write",
      request_id: "DOCREQ-STALE-REVIEW-NEWER-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: review.version_id,
      created_at: at,
      content: "A newer request owns the advanced review candidate.",
      content_sha256: await sha256Text("A newer request owns the advanced review candidate.")
    };
    const newerResponse = await documentCall(guard, encodeAdmission(newerRequest, context) as unknown as Record<string, unknown>);
    const newer = await newerResponse.json<any>();
    expect(newerResponse.status, JSON.stringify(newer)).toBe(200);
    expect(newer.status).toBe("committed");
    const reviewPath = workspaceManagedDocumentPath(created.project_id, "managed-fault-stagereviewstaleversion", "review", "strategy/commercial.md");
    const newerContent = mock.files.get(reviewPath);
    expect(newerContent).toContain("A newer request owns the advanced review candidate.");

    await runDurableObjectAlarm(guard);

    expect(mock.files.get(reviewPath)).toBe(newerContent);
    expect(mock.files.get(reviewPath)).not.toContain(request.content);
    const receiptPath = `${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`;
    const savedReceipt = JSON.parse(mock.files.get(receiptPath)!);
    expect(JSON.parse(savedReceipt.receipt_json)).toMatchObject({ status: "conflict", code: "STALE_DOCUMENT_VERSION" });
  });

  it("retains an admitted working write through capacity waits and completes the same request once capacity returns", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("CAPACITY-WAIT-RECOVERY");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-capacity-context-secret";
    const ruleSecret = "managed-document-capacity-rule-secret";
    await runInDurableObject(guard, (instance) => {
      const instanceEnv = (instance as unknown as { env: Env }).env;
      instanceEnv.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [created.project_id]: "strict" });
      instanceEnv.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [created.project_id]: "repair" });
      instanceEnv.MUTATION_CONTEXT_SIGNING_KEY = contextSecret;
      instanceEnv.RULE_ADMISSION_SIGNING_KEY = ruleSecret;
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-CAPACITY-WAIT-RECOVERY-0001",
      project_id: created.project_id,
      logical_path: "strategy/capacity-wait.md",
      content: "Keep this exact admitted write pending until capacity returns.",
      content_sha256: await sha256Text("Keep this exact admitted write pending until capacity returns."),
      created_at: at
    };
    const exactJson = JSON.stringify(request);
    const exactHash = await sha256Text(exactJson);
    const firstResponse = await documentCall(
      guard,
      encodeAdmission(request, mutationContext) as unknown as Record<string, unknown>
    );
    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toMatchObject({
      status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED"
    });

    const afterRefusal = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      journal: await new ExecutionJournal(
        (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
        created.project_id,
        "document",
        request.request_id
      ).status(),
      intentExists: mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`),
      effectExists: mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacitywaitrecovery", "working", request.logical_path)),
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterRefusal.payload).toEqual({ request_json: exactJson, request_sha256: exactHash });
    expect(afterRefusal.queued).toBe(true);
    expect(afterRefusal.journal).toMatchObject({ status: "admitted", sequence: 0, terminal: false });
    expect(afterRefusal.intentExists).toBe(false);
    expect(afterRefusal.effectExists).toBe(false);
    expect(afterRefusal.alarm).not.toBeNull();

    await runInDurableObject(guard, async (instance) => {
      const capacityRefusal = new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await (instance as any).recordRecoveryFailure("document", request.request_id, capacityRefusal, "a".repeat(64));
      }
    });
    const afterSixCapacityWaits = await runInDurableObject(guard, (_instance, durableState) => ({
      failure: durableState.storage.sql.exec<{ stopped: number; count: number; message: string }>(
        "SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0
    }));
    expect(afterSixCapacityWaits.queued).toBe(true);
    expect(afterSixCapacityWaits.failure).toMatchObject({ stopped: 0, count: 6 });
    expect(JSON.parse(afterSixCapacityWaits.failure?.message ?? "{}")).toMatchObject({
      code: "convergence_capacity_exceeded", classification: "provider_temporary"
    });

    await runInDurableObject(guard, async (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id);
      durableState.storage.sql.exec("DELETE FROM request_recovery_cursor WHERE singleton = 1");
      await durableState.storage.setAlarm(Date.now() - 1);
    });
    await runInDurableObject(guard, async (instance) => (instance as any).alarm());

    const visiblePath = workspaceManagedDocumentPath(created.project_id, "managed-fault-capacitywaitrecovery", "working", request.logical_path);
    expect(mock.files.get(visiblePath)).toContain(request.content);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(true);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBe(true);
    const settled = await runInDurableObject(guard, (_instance, durableState) => ({
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      payload: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length
    }));
    expect(settled).toEqual({ queued: 0, payload: 0 });
  });

  it("does not retain runnable recovery for a ruleless working write refused before execution admission", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("CAPACITY-RULELESS-REFUSAL");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const ruleSecret = "managed-document-ruleless-capacity-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_CONVERGENCE_PROJECT_MODES: JSON.stringify({ [created.project_id]: "repair" }),
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }));
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-CAPACITY-RULELESS-REFUSAL-0001",
      project_id: created.project_id,
      logical_path: "strategy/ruleless-capacity.md",
      content: "A capacity refusal without an execution allow proof cannot become runnable.",
      content_sha256: await sha256Text("A capacity refusal without an execution allow proof cannot become runnable."),
      created_at: at
    };

    const response = await documentCall(guard, request as unknown as Record<string, unknown>);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "convergence_capacity_exceeded" });
    const state = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      queue: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      admission: await new ExecutionJournal(
        (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
        created.project_id,
        "document",
        request.request_id
      ).readAdmission()
    }));
    expect(state).toEqual({ payload: 0, marker: 0, queue: 0, admission: null });
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityrulelessrefusal", "working", request.logical_path))).toBe(false);
  });

  it("demotes an admitted request to staged-only recovery when capacity refusal cannot observe its journal proof", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("CAPACITY-UNKNOWN-PROOF");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-unknown-capacity-context-secret";
    const ruleSecret = "managed-document-unknown-capacity-rule-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        PROJECT_OS_CONVERGENCE_PROJECT_MODES: JSON.stringify({ [created.project_id]: "repair" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }));
      vi.spyOn(instance as any, "documentWriteAdmissionStatus")
        .mockRejectedValueOnce(new Error("injected_admission_observation_unavailable"));
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-CAPACITY-UNKNOWN-PROOF-0001",
      project_id: created.project_id,
      logical_path: "strategy/capacity-proof-unknown.md",
      content: "Do not run this request until the immutable allow proof is observable.",
      content_sha256: await sha256Text("Do not run this request until the immutable allow proof is observable."),
      created_at: at
    };
    const exactJson = JSON.stringify(request);
    const exactHash = await sha256Text(exactJson);
    const response = await documentCall(
      guard,
      encodeAdmission(request, mutationContext) as unknown as Record<string, unknown>
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED" });
    const recovery = await runInDurableObject(guard, (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_sha256: string; phase: string }>(
        "SELECT request_sha256, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queue: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length
    }));
    expect(recovery).toEqual({
      payload: { request_json: exactJson, request_sha256: exactHash },
      marker: { request_sha256: exactHash, phase: "admission_write_attempted" },
      queue: 0
    });
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityunknownproof", "working", request.logical_path))).toBe(false);
  });

  it("keeps exact bytes staged when capacity refusal follows staged promotion but the proof read turns absent", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGED-PROMOTION-CAPACITY-UNKNOWN");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-promoted-capacity-context-secret";
    const ruleSecret = "managed-document-promoted-capacity-rule-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-STAGED-PROMOTION-CAPACITY-UNKNOWN-0001",
      project_id: created.project_id,
      logical_path: "strategy/promoted-capacity.md",
      content: "Retain exact bytes if the already-proven admission becomes temporarily unobservable.",
      content_sha256: await sha256Text("Retain exact bytes if the already-proven admission becomes temporarily unobservable."),
      created_at: at
    };
    const exactJson = JSON.stringify(request);
    const exactHash = await sha256Text(exactJson);
    const body = encodeAdmission(request, mutationContext);
    const originalCommit = ExecutionJournal.prototype.commit;
    let interrupted = false;
    vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if (this.requestId === request.request_id && !interrupted) {
        interrupted = true;
        throw new Error("injected_after_complete_execution_journal");
      }
      return result;
    });
    const interruptedResponse = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(interruptedResponse.status).toBe(503);

    const journalReads = { count: 0 };
    const originalReadAdmission = ExecutionJournal.prototype.readAdmission;
    vi.spyOn(ExecutionJournal.prototype, "readAdmission").mockImplementation(async function (this: ExecutionJournal) {
      if (this.requestId === request.request_id) {
        journalReads.count += 1;
        if (journalReads.count === 3) return null;
      }
      return originalReadAdmission.call(this);
    });
    await runInDurableObject(guard, async (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({
        [created.project_id]: "repair"
      });
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }));
      await (instance as any).alarm();
    });

    expect(journalReads.count).toBe(3);
    const recovery = await runInDurableObject(guard, (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_sha256: string; phase: string }>(
        "SELECT request_sha256, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queue: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length
    }));
    expect(recovery).toEqual({
      payload: { request_json: exactJson, request_sha256: exactHash },
      marker: { request_sha256: exactHash, phase: "admission_write_attempted" },
      queue: 0
    });
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-stagedpromotioncapacityunknown", "working", request.logical_path))).toBe(false);
  });

  it("keeps a staged write blocked when the admission exists but initial execution progress does not", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("STAGE-MISSING-PROGRESS");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-missing-progress-context-secret";
    const ruleSecret = "managed-document-missing-progress-rule-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-FAULT-MISSING-INITIAL-PROGRESS-0001",
      project_id: created.project_id,
      logical_path: "strategy/blocked.md",
      content: "Do not execute without its initial journal progress.",
      content_sha256: await sha256Text("Do not execute without its initial journal progress."),
      created_at: at
    };
    const body = encodeAdmission(request, mutationContext);
    const originalImmutable = (ExecutionJournal.prototype as any).immutable as (path: string, value: unknown) => Promise<void>;
    let admissionCreated = false;
    vi.spyOn(ExecutionJournal.prototype as any, "immutable").mockImplementation(async function (this: ExecutionJournal, path: unknown, value: unknown) {
      const objectPath = typeof path === "string" ? path : "";
      if (this.requestId !== request.request_id) return originalImmutable.call(this, objectPath, value);
      if (objectPath.endsWith("/admission.json")) {
        await originalImmutable.call(this, objectPath, value);
        admissionCreated = true;
        return;
      }
      if (admissionCreated && objectPath.endsWith("/progress.json")) throw new Error("injected_between_admission_and_initial_progress");
      return originalImmutable.call(this, objectPath, value);
    });

    const interruptedResponse = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(interruptedResponse.status).toBe(503);
    const journal = new ExecutionJournal(
      (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
      created.project_id,
      "document",
      request.request_id
    );
    const root = await journal.root();
    expect(mock.files.has(`${root}/admission.json`)).toBe(true);
    expect(mock.files.has(`${root}/progress.json`)).toBe(false);

    await runDurableObjectAlarm(guard);

    const recovery = await runInDurableObject(guard, (_instance, durableState) => ({
      staged: durableState.storage.sql.exec<{ request_json: string }>(
        "SELECT request_json FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0]?.request_json ?? null,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0,
      failure: durableState.storage.sql.exec<{ stopped: number; message: string }>(
        "SELECT stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null
    }));
    expect(recovery.staged).toBe(JSON.stringify(request));
    expect(recovery.marker).toBe(1);
    expect(recovery.queued).toBe(false);
    expect(recovery.failure).toMatchObject({ stopped: 1 });
    expect(JSON.parse(recovery.failure?.message ?? "{}")).toMatchObject({ code: "execution_progress_unavailable" });
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-stagemissingprogress", "working", request.logical_path))).toBe(false);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
  });

  it("leaves a Materialization Guard-owned navigation payload alone on a Project Guard alarm", async () => {
    installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("MG-NAVIGATION-HANDOFF");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const request = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAV-MG-HANDOFF-0001",
      project_id: created.project_id,
      zone: "WORKING" as const,
      expected_project_revision: created.new_revision,
      expected_generation: 0,
      expected_index: null,
      created_at: at
    };
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    await runInDurableObject(guard, async (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        request.request_id, requestJson, requestSha256
      );
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", request.request_id
      );
      // Materialization Guard acknowledgement transfers navigation ownership
      // by deleting the PG queue row while preserving its exact payload.
      durableState.storage.sql.exec(
        "DELETE FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      );
      await durableState.storage.setAlarm(Date.now() + 1_000);
    });

    await runDurableObjectAlarm(guard);

    const handoff = await runInDurableObject(guard, (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).toArray()[0] ?? null,
      queueRows: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      stagedMarkers: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length
    }));
    expect(handoff).toEqual({
      payload: { request_json: requestJson, request_sha256: requestSha256 },
      queueRows: 0,
      stagedMarkers: 0
    });
  });

  it("adds a local-only diagnostic to an unknown canonical request-status response", async () => {
    installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("LOCAL-RECOVERY-DIAGNOSTIC");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-LOCAL-DIAGNOSTIC-0001",
      project_id: created.project_id,
      logical_path: "strategy/local-diagnostic.md",
      content: "Do not expose this staged content in diagnostics.",
      content_sha256: await sha256Text("Do not expose this staged content in diagnostics."),
      created_at: at
    };
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    const failure = {
      code: "diagnostic_retry",
      classification: "provider_temporary",
      error_name: "ProviderOperationError",
      progress_sha256: "a".repeat(64),
      next_attempt_at: nextAttemptAt
    };
    const alarmAt = Date.now() + 60_000;
    await runInDurableObject(guard, async (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        request.request_id, requestJson, requestSha256
      );
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_staged (kind, request_id, request_sha256, phase) VALUES ('document', ?, ?, 'admission_write_attempted')",
        request.request_id, requestSha256
      );
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES ('document', ?, ?, 2, 0, ?)",
        request.request_id, "b".repeat(64), JSON.stringify(failure)
      );
      durableState.storage.sql.exec(
        "INSERT INTO document_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)",
        request.request_id, requestJson, JSON.stringify({ status: "pending" })
      );
      await durableState.storage.setAlarm(alarmAt);
    });
    vi.spyOn(ExecutionJournal.prototype, "status").mockRejectedValue(new Error("provider_busy"));

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(response.status).toBe(503);
    const body = await response.json<any>();
    expect(body.status).toBe("unknown");
    expect(body.local_recovery_diagnostic).toMatchObject({
      scope: "local_only",
      payload_present: true,
      payload_hash_valid: true,
      staged_marker_matches_payload: true,
      queue_present: false,
      failure_stopped: false,
      failure_attempts: 2,
      failure_code: "diagnostic_retry",
      failure_next_attempt_at: nextAttemptAt,
      alarm_readable: true,
      alarm_at: new Date(alarmAt).toISOString(),
      local_receipt_present: true,
      local_observation_present: false
    });
    expect(JSON.stringify(body.local_recovery_diagnostic)).not.toContain(request.content);
  });

  it("does not stage a refused write and hash-cleans only a pre-admission staged payload", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("ADMISSION-REFUSAL-STAGED-CLEANUP");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-document-refusal-context-secret";
    const ruleSecret = "managed-document-refusal-rule-secret";
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: contextSecret,
        RULE_ADMISSION_SIGNING_KEY: ruleSecret
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-FAULT-REFUSAL-STAGED-CLEANUP-0001",
      project_id: created.project_id,
      logical_path: "strategy/refused.md",
      content: "A refusal must have no staged retry.",
      content_sha256: await sha256Text("A refusal must have no staged retry."),
      created_at: at
    };
    const body = encodeAdmission(request, mutationContext);

    let denyAdmission = true;
    await runInDurableObject(guard, (instance) => {
      const originalAdmitRules = (instance as any).admitRules.bind(instance) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(instance as any, "admitRules").mockImplementation((...args: unknown[]) => denyAdmission
        ? Promise.reject(new AdmissionError("RULE_ADMISSION_STALE", 409))
        : originalAdmitRules(...args));
    });
    const denied = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(denied.status).toBe(409);
    const afterDenial = await runInDurableObject(guard, async (_instance, durableState) => ({
      staged: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterDenial).toEqual({ staged: 0, queued: 0, alarm: null });
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-admissionrefusalstagedcleanup", "working", request.logical_path))).toBe(false);

    denyAdmission = false;
    vi.spyOn(ExecutionJournal.prototype, "commit")
      .mockRejectedValueOnce(new Error("execution_plan_invalid"))
      .mockRejectedValue(new Error("injected_ambiguous_admission_create"));
    const deterministicRefusal = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(deterministicRefusal.status).toBe(503);
    const afterDeterministicRefusal = await runInDurableObject(guard, (_instance, durableState) => ({
      staged: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      marker: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length
    }));
    expect(afterDeterministicRefusal).toEqual({ staged: 0, marker: 0, queued: 0 });

    const interrupted = await documentCall(guard, body as unknown as Record<string, unknown>);
    expect(interrupted.status).toBe(503);
    const staged = await runInDurableObject(guard, async (_instance, durableState) => ({
      payload: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_sha256: string; phase: string }>(
        "SELECT request_sha256, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length > 0
    }));
    const exactJson = JSON.stringify(request);
    const exactHash = await sha256Text(exactJson);
    expect(staged).toEqual({ payload: { request_json: exactJson, request_sha256: exactHash }, marker: { request_sha256: exactHash, phase: "admission_write_attempted" }, queued: false });

    await runInDurableObject(guard, async (instance) => {
      await (instance as any).stageRequestRecoveryPayload("document", request.request_id, exactJson, true, true);
    });
    const afterExactRetryStage = await runInDurableObject(guard, (_instance, durableState) => durableState.storage.sql.exec<{ phase: string }>(
      "SELECT phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
    ).toArray()[0] ?? null);
    expect(afterExactRetryStage).toEqual({ phase: "admission_write_attempted" });

    const changedRequest = { ...request, content: "A conflicting retry must not replace the staged bytes." };
    changedRequest.content_sha256 = await sha256Text(changedRequest.content);
    const changed = await documentCall(guard, encodeAdmission(changedRequest, mutationContext) as unknown as Record<string, unknown>);
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    const afterConflict = await runInDurableObject(guard, (_instance, durableState) => durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
      "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
    ).toArray()[0] ?? null);
    expect(afterConflict).toEqual({ request_json: exactJson, request_sha256: exactHash });

    await runDurableObjectAlarm(guard);
    const afterCleanup = await runInDurableObject(guard, async (_instance, durableState) => ({
      staged: durableState.storage.sql.exec<{ request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null,
      marker: durableState.storage.sql.exec<{ request_id: string; phase: string }>(
        "SELECT request_id, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null,
      queued: durableState.storage.sql.exec(
        "SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray().length,
      failure: durableState.storage.sql.exec<{ stopped: number; count: number; message: string }>(
        "SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0] ?? null,
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterCleanup.staged).toEqual({ request_json: exactJson, request_sha256: exactHash });
    expect(afterCleanup.marker).toEqual({ request_id: request.request_id, phase: "admission_write_attempted" });
    expect(afterCleanup.queued).toBe(0);
    expect(afterCleanup.failure).toMatchObject({ stopped: 0, count: 1 });
    expect(JSON.parse(afterCleanup.failure?.message ?? "{}")).toMatchObject({ code: "document_admission_observation_pending" });
    expect(afterCleanup.alarm).not.toBeNull();
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-admissionrefusalstagedcleanup", "working", request.logical_path))).toBe(false);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
  });
});
