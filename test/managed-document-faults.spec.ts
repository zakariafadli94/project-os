import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import type { ProjectState } from "../src/domain/project-state";
import type { ExecutionAdmission } from "../src/execution/contract";
import { encodeAdmission } from "../src/admission/transport";
import { AdmissionError } from "../src/admission/mutation-context";
import { sha256Text } from "../src/documents/hash";
import { sha256Canonical } from "../src/materialization/hash";
import { canonicalJson } from "../src/rules/contract";
import { machineDocumentRoot, machineDocumentVersionPath, workspaceManagedDocumentPath, workspaceProjectRoot } from "../src/persistence/layout";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { ManagedDocumentChangeJobStore } from "../src/documents/change-job-store";
import { ManagedDocumentRequestLedger } from "../src/documents/request-ledger";
import { createProductionPersistence } from "../src/persistence/production-factory";

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
  expectedVersionId?: string,
  logicalPath = "strategy/commercial.md"
) {
  return jsonCall(guard, {
    operation: "working.write",
    request_id: requestId,
    project_id: projectId,
    logical_path: logicalPath,
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

  it("retains a pinned review promotion across post-admission capacity refusal and resumes it from the alarm", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("CAPACITY-REVIEW-PROMOTE");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const contextSecret = "managed-review-promote-capacity-context-secret";
    const ruleSecret = "managed-review-promote-capacity-rule-secret";
    await bootstrapRuleAdmissionGovernance(testEnv, ruleSecret, created.project_id);
    const initial = await workingWrite(guard, created.project_id, "DOCREQ-REVIEW-PROMOTE-CAP-INITIAL-0001", "Pinned candidate awaiting review.");
    const staleInitial = await workingWrite(guard, created.project_id, "DOCREQ-REVIEW-PROMOTE-CAP-STALE-INITIAL-0001", "A second candidate for stale-pin verification.", undefined, "strategy/stale-review.md");
    await runInDurableObject(guard, (instance) => {
      const instanceEnv = (instance as unknown as { env: Env }).env;
      instanceEnv.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [created.project_id]: "strict" });
      instanceEnv.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [created.project_id]: "repair" });
      instanceEnv.MUTATION_CONTEXT_SIGNING_KEY = contextSecret;
      instanceEnv.RULE_ADMISSION_SIGNING_KEY = ruleSecret;
      vi.spyOn(instance as any, "assertCommitCapacity")
        .mockRejectedValueOnce(new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" }))
        .mockResolvedValue(undefined);
      vi.spyOn(instance as any, "releaseManagedDocumentCapacity").mockResolvedValue(true);
    });
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    });
    const { context: mutationContext } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    if (mutationContext === null) throw new Error("expected signed mutation context for pinned review promotion test");
    const request = {
      operation: "review.promote" as const,
      request_id: "DOCREQ-REVIEW-PROMOTE-CAP-0001",
      project_id: created.project_id,
      document_id: initial.document_id,
      expected_version_id: initial.version_id,
      created_at: at
    };
    const staleRequest = {
      operation: "review.promote" as const,
      request_id: "DOCREQ-REVIEW-PROMOTE-CAP-STALE-0001",
      project_id: created.project_id,
      document_id: staleInitial.document_id,
      expected_version_id: staleInitial.version_id,
      created_at: at
    };
    const exactJson = JSON.stringify(request);
    const originalCommit = ExecutionJournal.prototype.commit;
    const interruptedIds = new Set<string>();
    vi.spyOn(ExecutionJournal.prototype, "commit").mockImplementation(async function (
      this: ExecutionJournal,
      admission: Parameters<ExecutionJournal["commit"]>[0],
      plan: Parameters<ExecutionJournal["commit"]>[1]
    ) {
      const result = await originalCommit.call(this, admission, plan);
      if ((this.requestId === request.request_id || this.requestId === staleRequest.request_id)
        && !interruptedIds.has(this.requestId)) {
        interruptedIds.add(this.requestId);
        throw new Error("injected_after_pinned_review_promotion_admission");
      }
      return result;
    });

    const interruptedResponse = await documentCall(
      guard,
      encodeAdmission(request, mutationContext) as unknown as Record<string, unknown>
    );
    expect(interruptedResponse.status).toBe(503);
    const afterAdmission = await runInDurableObject(guard, async (_instance, durableState) => ({
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
        created.project_id, "document", request.request_id
      ).status(),
      admission: await new ExecutionJournal(
        (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
        created.project_id, "document", request.request_id
      ).readAdmission(),
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterAdmission.payload).toMatchObject({ request_json: exactJson, request_sha256: await sha256Text(exactJson) });
    expect(afterAdmission.marker).toEqual({ request_sha256: await sha256Text(exactJson), phase: "admission_write_attempted" });
    expect(afterAdmission.queued).toBe(false);
    expect(afterAdmission.progress).toMatchObject({ status: "admitted", sequence: 0, terminal: false });
    expect(afterAdmission.admission?.admission).toMatchObject({
      operation: "review.promote", project_id: created.project_id, request_id: request.request_id,
      request_hash: await sha256Canonical(request), verdict: "allow", actor: mutationContext.actor,
      resources: [expect.objectContaining({ resource_id: initial.document_id, resource_type: "document",
        zone: "DOCUMENTS", expected_version: initial.version_id })]
    });
    expect(afterAdmission.alarm).not.toBeNull();

    await runInDurableObject(guard, async (_instance, durableState) => durableState.storage.setAlarm(Date.now() - 1));
    await runDurableObjectAlarm(guard);
    const afterCapacityRefusal = await runInDurableObject(guard, async (_instance, durableState) => ({
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
      alarm: await durableState.storage.getAlarm()
    }));
    expect(afterCapacityRefusal.payload).toEqual({ request_json: exactJson, request_sha256: await sha256Text(exactJson) });
    expect(afterCapacityRefusal.marker).toEqual({ request_sha256: await sha256Text(exactJson), phase: "admission_write_attempted" });
    expect(afterCapacityRefusal.queued).toBe(true);
    expect(afterCapacityRefusal.alarm).not.toBeNull();
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`)).toBe(false);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBe(false);

    await runInDurableObject(guard, async (_instance, durableState) => {
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
      await durableState.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(guard);
    const afterRecovery = await runInDurableObject(guard, async (_instance, durableState) => ({
      queue: durableState.storage.sql.exec("SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id).toArray(),
      payload: durableState.storage.sql.exec("SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id).toArray(),
      marker: durableState.storage.sql.exec("SELECT request_id, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id).toArray(),
      failure: durableState.storage.sql.exec("SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id).toArray(),
      alarm: await durableState.storage.getAlarm()
    }));
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/intent.json`), JSON.stringify(afterRecovery)).toBe(true);
    expect(mock.files.has(`${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`)).toBe(true);
    const reviewPath = workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityreviewpromote", "review", "strategy/commercial.md");
    expect(mock.files.get(reviewPath)).toContain("Pinned candidate awaiting review.");
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityreviewpromote", "working", "strategy/commercial.md"))).toBe(false);
    expect(await new ExecutionJournal(
      (await import("../src/persistence/production-factory")).createProductionPersistence(testEnv, created.project_id),
      created.project_id, "document", request.request_id
    ).status()).toMatchObject({ status: "finalized", terminal: true });

    const staleResponse = await documentCall(
      guard,
      encodeAdmission(staleRequest, mutationContext) as unknown as Record<string, unknown>
    );
    expect(staleResponse.status).toBe(503);
    const newerVersionRequest = {
      operation: "working.write" as const,
      request_id: "DOCREQ-REVIEW-PROMOTE-CAP-STALE-WORK-0001",
      project_id: created.project_id,
      logical_path: "strategy/stale-review.md",
      content: "The working head advanced after review promotion admission.",
      content_sha256: await sha256Text("The working head advanced after review promotion admission."),
      expected_version_id: staleInitial.version_id,
      created_at: at
    };
    const advanced = await documentCall(
      guard,
      encodeAdmission(newerVersionRequest, mutationContext) as unknown as Record<string, unknown>
    );
    expect(advanced.status).toBe(200);
    const advancedReceipt = await advanced.json<any>();
    expect(advancedReceipt).toMatchObject({ status: "committed", version_id: expect.any(String) });
    expect(advancedReceipt.version_id).not.toBe(staleInitial.version_id);

    await runInDurableObject(guard, async (_instance, durableState) => durableState.storage.setAlarm(Date.now() - 1));
    await runDurableObjectAlarm(guard);
    const staleRecoveryState = await runInDurableObject(guard, async (_instance, durableState) => ({
      queue: durableState.storage.sql.exec("SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", staleRequest.request_id).toArray(),
      payload: durableState.storage.sql.exec("SELECT request_json FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", staleRequest.request_id).toArray(),
      marker: durableState.storage.sql.exec("SELECT request_id, phase FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", staleRequest.request_id).toArray(),
      failure: durableState.storage.sql.exec("SELECT stopped, count, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", staleRequest.request_id).toArray(),
      alarm: await durableState.storage.getAlarm()
    }));
    const stalePromotionEnvelope = JSON.parse(mock.files.get(
      `${machineDocumentRoot(created.project_id)}/requests/${staleRequest.request_id}/receipt.json`
    ) ?? "null");
    const stalePromotionReceipt = JSON.parse(stalePromotionEnvelope?.receipt_json ?? "null");
    expect(stalePromotionReceipt, JSON.stringify(staleRecoveryState)).toMatchObject({ status: "conflict", code: "STALE_DOCUMENT_VERSION" });
    expect(mock.files.get(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityreviewpromote", "working", "strategy/stale-review.md")))
      .toContain(newerVersionRequest.content);
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "managed-fault-capacityreviewpromote", "review", "strategy/stale-review.md")))
      .toBe(false);

    const unpinnedRequest = {
      operation: "review.promote" as const,
      request_id: "DOCREQ-REVIEW-PROMOTE-CAP-UNPINNED-0001",
      project_id: created.project_id,
      document_id: staleInitial.document_id,
      created_at: at
    };
    await runInDurableObject(guard, (instance) => {
      (instance as any).assertCommitCapacity.mockRejectedValueOnce(
        new AdmissionError("convergence_capacity_exceeded", 503, { reservation_outcome: "refused" })
      );
    });
    const unpinnedResponse = await documentCall(
      guard,
      encodeAdmission(unpinnedRequest, mutationContext) as unknown as Record<string, unknown>
    );
    expect(unpinnedResponse.status).toBe(503);
    const unpinnedRecovery = await runInDurableObject(guard, (_instance, durableState) => ({
      payload: durableState.storage.sql.exec("SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", unpinnedRequest.request_id).toArray(),
      marker: durableState.storage.sql.exec("SELECT request_id FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", unpinnedRequest.request_id).toArray(),
      queue: durableState.storage.sql.exec("SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", unpinnedRequest.request_id).toArray()
    }));
    expect(unpinnedRecovery).toEqual({ payload: [], marker: [], queue: [] });
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

  it.each([
    { name: "original request binding", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: true },
    { name: "same request ID on another project", projectId: "PRJ-0004", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "wrong admitted revision", expectedRevision: 517, current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "changed original index payload", expectedIndex: { basename: "00-CURRENT-INDEX.md" as const, object_id: "id:VI4Cv070g6AAAAAAAAA9TQ", revision_token: "0165cd03b6f4372000000037a835733", content_sha256: "4255d6800bbb675795a22443ed86dd0d9250198299dbe3c1fc1ecb6212bb6898" }, current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "strictly advanced, adopted, and unowned", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: true, crashAfterReceipt: true },
    { name: "already published at original source generation", current: { generation: 116, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: true, alreadyPublished: true, crashAfterReceipt: true },
    { name: "cross-request published receipt replay", current: { generation: 116, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: true, alreadyPublished: true, crashAfterReceipt: true, corruptReceiptReplay: true },
    { name: "publication proof unavailable", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false, publicationUnavailable: true },
    { name: "same generation", current: { generation: 116, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "source reversal", current: { generation: 115, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "not adopted", current: { generation: 127, adopted: false, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] }, settles: false },
    { name: "owned by another request", current: { generation: 127, adopted: true, adoption_request_id: "DOCREQ-OTHER-OWNER-0001", adoption_generation: 127, in_flight_writes: [] }, settles: false },
    { name: "ownerless but adoption fenced", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: 127, in_flight_writes: [] }, settles: false },
    { name: "in-flight head write", current: { generation: 127, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [{ resource_id: "head:DOC-000000000000000000000001", generation: 127, write_hash: "a".repeat(64) }] }, settles: false }
  ])("settles only when stopped navigation source is $name", async ({ name, current, settles, publicationUnavailable, crashAfterReceipt, alreadyPublished, corruptReceiptReplay, projectId, expectedRevision, expectedIndex }) => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const targetProjectId = projectId ?? "PRJ-0003";
    const targetRevision = expectedRevision ?? 516;
    const guard = testEnv.PROJECT_GUARD.getByName(targetProjectId);
    await runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM request_recovery WHERE kind = 'document' AND request_id = ?", "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4");
      durableState.storage.sql.exec("DELETE FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4");
      durableState.storage.sql.exec("DELETE FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4");
      durableState.storage.sql.exec("DELETE FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4");
      durableState.storage.sql.exec("DELETE FROM document_requests WHERE request_id = ?", "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4");
    });
    const request = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAV-AUTO-WORKING-S116-R516-G4",
      project_id: targetProjectId,
      zone: "WORKING" as const,
      expected_project_revision: targetRevision,
      expected_generation: 4,
      expected_index: expectedIndex ?? {
        basename: "00-CURRENT-INDEX.md" as const,
        object_id: "id:VI4Cv070g6AAAAAAAAA9TQ",
        revision_token: "0165cd03b6f4372000000037a835733",
        content_sha256: "3255d6800bbb675795a22443ed86dd0d9250198299dbe3c1fc1ecb6212bb6898"
      },
      created_at: "2026-10-02T21:56:41.654Z"
    };
    const requestHash = await sha256Canonical(request);
    if (targetProjectId === "PRJ-0003" && targetRevision === 516 && !expectedIndex) {
      expect(requestHash).toBe("736755ecdf6a616df576153fd4c64d6530673b68564ec70def3ee72e8ff81df2");
    }
    const state: ProjectState = {
      schema_version: "2.0", project_id: targetProjectId, name: "Original WORKING navigation", slug: "project-0003",
      aliases: [], objective: "fixture", framing: { scope: [], out_of_scope: [], success_criteria: [], stakeholders: [], open_questions: [] },
      discovery: { confirmed_findings: [], provisional_findings: [], unresolved_questions: [], next_exploration: [] },
      status: "active", revision: targetRevision, current_phase_id: null, artifact_routes: {}, local_rules: {},
      rule_exceptions: {}, approvals: {}, constraints: {}, tasks: {}, plan_phases: {}, decisions: {}, research: {},
      deliverables: {}, last_event_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-10-02T21:56:41.654Z"
    };
    const source = { generation: 116, adopted: true, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] };
    mock.files.set(`${machineDocumentRoot(targetProjectId)}/navigation-sources/state.json`, JSON.stringify({
      schema_version: "1.0", project_id: targetProjectId, state_revision: 2,
      zones: { WORKING: source, REVIEW: { ...source, generation: 0 }, DELIVERABLES: { ...source, generation: 0 } }
    }));
    const runtime = createProductionPersistence(testEnv, targetProjectId);
    const journal = new ExecutionJournal(runtime, targetProjectId, "document", request.request_id);
    const indexPath = workspaceManagedDocumentPath(targetProjectId, state.slug, "working", request.expected_index!.basename);
    const indexLogicalPath = `WORKING/${request.expected_index!.basename}`;
    const archiveLogicalPath = `ARCHIVES/NAVIGATION/WORKING/5-${request.expected_index!.content_sha256}.md`;
    const admission: ExecutionAdmission = {
      project_id: targetProjectId, request_id: request.request_id, kind: "document", operation: "navigation.reconcile",
      request_hash: requestHash, actor: { actor_id: "system:test", authority: "system" },
      resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "4" }],
      resource_effect_scopes: [{
        resource_id: "navigation:WORKING", resource_version: "4", provider_id: runtime.providerId,
        sources: [{ path: indexPath, logical_path: indexLogicalPath }],
        destinations: [{ path: indexPath, logical_path: indexLogicalPath }],
        preservation_copies: [{ path: `${workspaceProjectRoot(targetProjectId, state.slug)}/${archiveLogicalPath}`, logical_path: archiveLogicalPath }]
      }],
      global_revision: 1, project_revision: targetRevision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: targetRevision },
      verdict: "allow", results: [], gaps: [], deferred_rules: []
    };
    await journal.commit(admission, null);
    await new ManagedDocumentRequestLedger(runtime.objects).ensureIntent(targetProjectId, request.request_id, JSON.stringify(request));
    const frozenRecord = {
      schema_version: "1.0", project_id: targetProjectId, request_id: request.request_id,
      request_hash: requestHash, project_revision: targetRevision, state, state_hash: await sha256Canonical(state)
    };
    mock.files.set(`${machineDocumentRoot(targetProjectId)}/requests/${request.request_id}/navigation-admitted-state.json`, canonicalJson(frozenRecord));
    const root = await journal.root();
    const progress = {
      schema_version: "1.0", project_id: targetProjectId, request_id: request.request_id,
      request_hash: requestHash, target_generation: 5, index_basename: request.expected_index?.basename ?? "00-CURRENT.md",
      expected_index: request.expected_index, head_revision_token: null, cursor: "saved-source-116-cursor",
      page_count: 4, inventory_complete: false, snapshot_id: "source:116", verify_page: 4, verify_entry: 0,
      source_count: 0, source_ids: [], published_index: null, coverage_gaps: [], rendered_links: [],
      generated_sha256: null, legacy_archive_ref: null, valid_links_work: null, status: "adopting",
      receipt: null, postchecks: []
    };
    let provenPublication: NonNullable<Awaited<ReturnType<ZoneNavigationEngine["readVerifiedPublication"]>>> | undefined;
    if (alreadyPublished) {
      const index = request.expected_index!;
      const publishedReceipt = {
        schema_version: "1.0" as const, status: "committed" as const, project_id: targetProjectId,
        request_id: request.request_id, zone: "WORKING" as const, generation: 5,
        head_ref: `${machineDocumentRoot(targetProjectId)}/navigation/WORKING/head.json`,
        finalization_ref: "", index, source_snapshot_id: "source:116", source_count: 0, coverage_gaps: []
      };
      provenPublication = publishedReceipt;
      const certificate = {
        schema_version: "1.0", project_id: targetProjectId, request_id: request.request_id,
        request_hash: requestHash, zone: "WORKING", generation: 5, source_snapshot_id: "source:116",
        source_count: 0, index, coverage_gaps: [], generated_content_sha256: index.content_sha256, postchecks: []
      };
      publishedReceipt.finalization_ref = `${root}/navigation/finalizations/${await executionHash(certificate)}.json`;
      mock.files.set(publishedReceipt.finalization_ref, canonicalJson(certificate));
      mock.files.set(publishedReceipt.head_ref, canonicalJson({
        schema_version: "1.0", project_id: targetProjectId, zone: "WORKING", generation: 5,
        source_request_id: request.request_id, index, finalization_ref: publishedReceipt.finalization_ref,
        source_snapshot_id: "source:116", source_count: 0, coverage_gaps: []
      }));
      Object.assign(progress, {
        status: "finalized", inventory_complete: true, receipt: publishedReceipt,
        published_index: index, generated_sha256: index.content_sha256
      });
    }
    mock.files.set(`${root}/navigation-progress.json`, canonicalJson(progress));
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      mock.files.set(`${root}/navigation/snapshot/${pageNumber.toString().padStart(8, "0")}.json`, canonicalJson({
        schema_version: "1.0", page: pageNumber, project_id: targetProjectId,
        request_id: request.request_id, snapshot_id: "source:116", entries: [], gaps: []
      }));
    }
    const currentSource = { ...source, ...current };
    const currentSourcePath = `${machineDocumentRoot(targetProjectId)}/navigation-sources/state.json`;
    const currentSourceBytes = JSON.stringify({
      schema_version: "1.0", project_id: targetProjectId, state_revision: 3,
      zones: { WORKING: currentSource, REVIEW: { ...source, generation: 0 }, DELIVERABLES: { ...source, generation: 0 } }
    });
    mock.files.set(currentSourcePath, currentSourceBytes);
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    const failure = {
      fingerprint: "b".repeat(64), count: 6, stopped: 1,
      message: canonicalJson({ code: "identical_internal_failure_limit", classification: "internal", error_name: "Error",
        progress_sha256: "c".repeat(64), next_attempt_at: null })
    };
    await runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        request.request_id, requestJson, requestSha256
      );
      durableState.storage.sql.exec(
        `INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message)
         VALUES ('document', ?, ?, ?, ?, ?)`, request.request_id, failure.fingerprint, failure.count, failure.stopped, failure.message
      );
    });
    const beforeRecovery = await runInDurableObject(guard, (_instance, state) => ({
      payload: state.storage.sql.exec("SELECT request_id FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id).toArray().length,
      queue: state.storage.sql.exec("SELECT request_id FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id).toArray().length
    }));
    expect(beforeRecovery).toEqual({ payload: 1, queue: 0 });
    const clearFixtureRows = () => runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id);
      durableState.storage.sql.exec("DELETE FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id);
      durableState.storage.sql.exec("DELETE FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id);
      durableState.storage.sql.exec("DELETE FROM request_recovery_staged WHERE kind = 'document' AND request_id = ?", request.request_id);
      durableState.storage.sql.exec("DELETE FROM document_requests WHERE request_id = ?", request.request_id);
    });
    const materialization = testEnv.MATERIALIZATION_GUARD.getByName(targetProjectId);
    await runInDurableObject(materialization, async (_instance, state) => {
      await state.storage.delete(`navigation-work:${request.request_id}`);
      await state.storage.delete(`navigation-context:${request.request_id}`);
      await state.storage.put(`navigation-retry:${request.request_id}`, canonicalJson({ stopped: true, next_attempt_at: null }));
      await state.storage.deleteAlarm();
    });
    const workerBefore = await runInDurableObject(materialization, async (_instance, state) => ({
      retry: await state.storage.get<string>(`navigation-retry:${request.request_id}`),
      alarm: await state.storage.getAlarm()
    }));

    if (publicationUnavailable) {
      vi.spyOn(ZoneNavigationEngine.prototype, "readVerifiedPublication").mockRejectedValueOnce(new Error("proof_unavailable"));
    }
    if (alreadyPublished) {
      if (!provenPublication) throw new Error("expected seeded historical publication");
      vi.spyOn(ZoneNavigationEngine.prototype, "readVerifiedPublication").mockResolvedValue(provenPublication);
    }
    if (crashAfterReceipt) {
      await runInDurableObject(guard, (instance) => {
        vi.spyOn(instance as any, "storeCanonicalTerminalObservation").mockRejectedValueOnce(new Error("crash_after_receipt"));
      });
    }

    const progressBytes = mock.files.get(`${root}/navigation-progress.json`)!;
    const pageBytes = Array.from({ length: 4 }, (_, pageNumber) => mock.files.get(
      `${root}/navigation/snapshot/${pageNumber.toString().padStart(8, "0")}.json`
    )!);
    const settled = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { settleOneStaleWorkingNavigation(state: ProjectState): Promise<boolean> })
        .settleOneStaleWorkingNavigation(state));
    expect(settled).toBe(true);
    const receiptPath = `${machineDocumentRoot(targetProjectId)}/requests/${request.request_id}/receipt.json`;
    if (!settles) {
      expect(mock.files.has(receiptPath)).toBe(false);
      expect(await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{ fingerprint: string; count: number; stopped: number; message: string }>(
        "SELECT fingerprint, count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0])).toEqual(failure);
      expect(mock.files.get(currentSourcePath)).toBe(currentSourceBytes);
      expect(mock.files.get(`${root}/navigation-progress.json`)).toBe(progressBytes);
      expect(await runInDurableObject(materialization, async (_instance, state) => ({
        retry: await state.storage.get<string>(`navigation-retry:${request.request_id}`), alarm: await state.storage.getAlarm()
      }))).toEqual(workerBefore);
      await clearFixtureRows();
      return;
    }
    expect(mock.files.has(receiptPath)).toBe(true);
    const receiptRecord = JSON.parse(mock.files.get(receiptPath)!);
    const receipt = JSON.parse(receiptRecord.receipt_json);
    const receiptBytes = mock.files.get(receiptPath)!;
    expect(receipt).toMatchObject(alreadyPublished
      ? { status: "committed", execution_status: "pending", navigation_receipt: { source_snapshot_id: "source:116" } }
      : { status: "conflict", execution_status: "conflict", code: "navigation_snapshot_changed" });
    expect(receipt.recovery_settlement).toMatchObject({
      original_snapshot_id: "source:116", current_source_generation: alreadyPublished ? 116 : 127,
      result: alreadyPublished ? "already_published" : "snapshot_advanced",
      failure: { fingerprint: failure.fingerprint, count: 6, stopped: true,
        diagnostic: { code: "identical_internal_failure_limit", classification: "internal", error_name: "Error",
          progress_sha256: "c".repeat(64), next_attempt_at: null } }
    });
    if (crashAfterReceipt) {
      expect(await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec(
        "SELECT fingerprint, count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
      ).toArray()[0])).toEqual(failure);
      if (corruptReceiptReplay) {
        const corruptedRecord = JSON.parse(receiptBytes);
        const corruptedReceipt = JSON.parse(corruptedRecord.receipt_json);
        corruptedReceipt.navigation_receipt.request_id = "DOCREQ-NAV-OTHER-PUBLISHED-0001";
        corruptedRecord.receipt_json = JSON.stringify(corruptedReceipt);
        mock.files.set(receiptPath, JSON.stringify(corruptedRecord));
        await runInDurableObject(guard, (instance) =>
          (instance as unknown as { settleOneStaleWorkingNavigation(state: ProjectState): Promise<boolean> })
            .settleOneStaleWorkingNavigation(state));
        expect(await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec(
          "SELECT fingerprint, count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
        ).toArray()[0])).toEqual(failure);
        await clearFixtureRows();
        return;
      }
      await runInDurableObject(guard, (instance) =>
        (instance as unknown as { settleOneStaleWorkingNavigation(state: ProjectState): Promise<boolean> })
          .settleOneStaleWorkingNavigation(state));
      if (alreadyPublished) expect(ZoneNavigationEngine.prototype.readVerifiedPublication).toHaveBeenCalledTimes(2);
      expect(mock.files.get(receiptPath)).toBe(receiptBytes);
    }
    const remainingFailures = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec(
      "SELECT request_id FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
    ).toArray());
    expect(remainingFailures).toHaveLength(0);
    expect(mock.files.get(`${root}/navigation-progress.json`)).toBe(progressBytes);
    expect(Array.from({ length: 4 }, (_, pageNumber) => mock.files.get(
      `${root}/navigation/snapshot/${pageNumber.toString().padStart(8, "0")}.json`
    )!)).toEqual(pageBytes);
    expect(mock.files.get(currentSourcePath)).toBe(currentSourceBytes);
    expect(await runInDurableObject(guard, (instance) =>
      (instance as unknown as { settleOneStaleWorkingNavigation(state: ProjectState): Promise<boolean> })
        .settleOneStaleWorkingNavigation(state))).toBe(false);
    expect(mock.files.get(receiptPath)).toBe(receiptBytes);
    expect(await runInDurableObject(materialization, async (_instance, state) => ({
      retry: await state.storage.get<string>(`navigation-retry:${request.request_id}`),
      alarm: await state.storage.getAlarm()
    }))).toEqual(workerBefore);
    await clearFixtureRows();
  });

  it("exposes the project-local change checkpoint on a validated navigation status without changing state", async () => {
    const mock = installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("LOCAL-NAVIGATION-STATUS-CHECKPOINT");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const request = {
      operation: "navigation.reconcile" as const, request_id: "DOCREQ-NAV-STATUS-CHECKPOINT-0001",
      project_id: created.project_id, zone: "WORKING" as const, expected_project_revision: created.new_revision,
      expected_generation: 0, expected_index: null, created_at: at
    };
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        request.request_id, requestJson, requestSha256);
      state.storage.sql.exec("INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES ('document', ?, ?, 6, 1, ?)",
        request.request_id, "a".repeat(64), JSON.stringify({ code: "identical_internal_failure_limit", classification: "internal", error_name: "Error", progress_sha256: "b".repeat(64), next_attempt_at: null }));
      const jobs = new ManagedDocumentChangeJobStore(state.storage);
      jobs.registerPage({ expected_cursor: null, next_cursor: "secret-cursor-value", jobs: [] });
      jobs.completeScheduledVerification("2026-10-01T12:00:00.000Z");
      jobs.recordDriftFinding({ finding_id: `DRIFT-${"A".repeat(24)}`, job_id: `CHGJOB-${"A".repeat(24)}`,
        path: "/private/project-wide-path", change_kind: "deleted", status: "unexpected_conflict", code: "file_target_missing", observed_at: "2026-10-02T12:00:00.000Z" });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const before = await runInDurableObject(guard, async (_instance, state) => ({
      payload: state.storage.sql.exec("SELECT * FROM request_recovery_payload WHERE request_id = ?", request.request_id).toArray(),
      failures: state.storage.sql.exec("SELECT * FROM request_recovery_failures WHERE request_id = ?", request.request_id).toArray(),
      changes: ["managed_document_change_control", "managed_document_drift_control", "managed_document_change_jobs", "managed_document_change_quarantine", "managed_document_drift_findings"]
        .map(table => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
      alarm: await state.storage.getAlarm()
    }));
    const providerCallsDuringCheckpoint: number[] = [];
    const originalReadCheckpoint = ManagedDocumentChangeJobStore.prototype.readCheckpoint;
    vi.spyOn(ManagedDocumentChangeJobStore.prototype, "readCheckpoint").mockImplementation(async function (this: ManagedDocumentChangeJobStore, now: string) {
      const callsBefore = mock.providerCalls.length;
      const result = await originalReadCheckpoint.call(this, now);
      providerCallsDuringCheckpoint.push(mock.providerCalls.length - callsBefore);
      return result;
    });
    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.document_change_checkpoint).toMatchObject({ scope: "project", observation_scope: "local_only", read_only: true });
    expect(body.document_change_checkpoint.cursor.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.document_change_checkpoint.recent_findings).toHaveLength(1);
    expect(JSON.stringify(body.document_change_checkpoint)).not.toMatch(/secret-cursor-value|private-project-wide-path|identical_internal_failure_limit/);
    expect(providerCallsDuringCheckpoint).toEqual([0]);
    const after = await runInDurableObject(guard, async (_instance, state) => ({
      payload: state.storage.sql.exec("SELECT * FROM request_recovery_payload WHERE request_id = ?", request.request_id).toArray(),
      failures: state.storage.sql.exec("SELECT * FROM request_recovery_failures WHERE request_id = ?", request.request_id).toArray(),
      changes: ["managed_document_change_control", "managed_document_drift_control", "managed_document_change_jobs", "managed_document_change_quarantine", "managed_document_drift_findings"]
        .map(table => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
      alarm: await state.storage.getAlarm()
    }));
    expect(after).toEqual(before);
    expect(mock.calls.length).toBeGreaterThan(0);

    const nonNavigation = {
      operation: "working.write" as const, request_id: "DOCREQ-NAV-STATUS-CONTROL-0001", project_id: created.project_id,
      logical_path: "strategy/status-control.md", content: "private non-navigation request", content_sha256: await sha256Text("private non-navigation request"), created_at: at
    };
    const malformedNavigation = {
      operation: "navigation.reconcile" as const, request_id: "DOCREQ-NAV-STATUS-MALFORMED-0001", project_id: created.project_id,
      zone: "WORKING" as const, expected_project_revision: created.new_revision, expected_generation: 0, expected_index: null, created_at: at
    };
    const nonNavigationJson = JSON.stringify(nonNavigation);
    const nonNavigationHash = await sha256Text(nonNavigationJson);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        nonNavigation.request_id, nonNavigationJson, nonNavigationHash);
      state.storage.sql.exec("INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        malformedNavigation.request_id, JSON.stringify(malformedNavigation), "f".repeat(64));
    });
    for (const requestId of [nonNavigation.request_id, malformedNavigation.request_id, "DOCREQ-NAV-STATUS-NO-LOCAL-INTENT-0001"]) {
      const control = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
      expect(control.status).toBe(200);
      expect((await control.json<any>()).document_change_checkpoint).toBeUndefined();
    }
    const mismatchedScope = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}&project_id=PRJ-9999`);
    expect(mismatchedScope.status).toBe(404);
    const unavailableRequest = {
      ...request, request_id: "DOCREQ-NAV-STATUS-UNAVAILABLE-0001"
    };
    const unavailableJson = JSON.stringify(unavailableRequest);
    const unavailableHash = await sha256Text(unavailableJson);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        unavailableRequest.request_id, unavailableJson, unavailableHash);
    });
    vi.spyOn(ExecutionJournal.prototype, "status").mockRejectedValueOnce(new Error("provider_busy"));
    const unavailable = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${unavailableRequest.request_id}`);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json<any>()).document_change_checkpoint).toBeUndefined();
  });

  it("exposes a project checkpoint beside a terminal navigation receipt only when local request hash matches validated execution", async () => {
    installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("LOCAL-NAVIGATION-TERMINAL-CHECKPOINT");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const admissionSecret = "terminal-navigation-checkpoint-admission";
    await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }),
      MUTATION_CONTEXT_SIGNING_KEY: "terminal-navigation-checkpoint-context",
      RULE_ADMISSION_SIGNING_KEY: admissionSecret
    }));
    await bootstrapRuleAdmissionGovernance(testEnv, admissionSecret, created.project_id);
    const request = {
      operation: "navigation.reconcile" as const, request_id: "DOCREQ-NAV-TERMINAL-CHECKPOINT-0001",
      project_id: created.project_id, zone: "WORKING" as const, expected_project_revision: created.new_revision,
      expected_generation: 0, expected_index: null, created_at: at
    };
    const requestJson = JSON.stringify(request);
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const admitted = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(admitted.status).toBe(202);
    const journal = new ExecutionJournal(createProductionPersistence(testEnv, created.project_id), created.project_id, "document", request.request_id);
    const receiptPath = `${machineDocumentRoot(created.project_id)}/requests/${request.request_id}/receipt.json`;
    await journal.recordReceipt("conflict", receiptPath);
    const receipt = {
      operation: "navigation.reconcile", request_id: request.request_id, project_id: created.project_id,
      status: "conflict", execution_status: "conflict", code: "navigation_snapshot_changed"
    };
    const ledger = new ManagedDocumentRequestLedger(createProductionPersistence(testEnv, created.project_id).objects);
    await ledger.writeReceipt(created.project_id, request.request_id, requestJson, JSON.stringify(receipt));
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO document_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)",
        request.request_id, requestJson, JSON.stringify(receipt));
      state.storage.sql.exec("DELETE FROM request_recovery_payload WHERE kind = 'document' AND request_id = ?", request.request_id);
      state.storage.sql.exec("DELETE FROM request_recovery WHERE kind = 'document' AND request_id = ?", request.request_id);
    });

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.status).toBe("conflict");
    expect(body.execution.request_hash).toBe(await sha256Canonical(request));
    expect(body.receipt).toEqual(receipt);
    expect(body.document_change_checkpoint).toMatchObject({ scope: "project", observation_scope: "local_only", read_only: true });

    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("UPDATE document_requests SET receipt_json = ? WHERE request_id = ?",
        JSON.stringify({ ...receipt, request_id: "DOCREQ-NAV-OTHER-0001" }), request.request_id);
    });
    const mismatchedReceipt = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect((await mismatchedReceipt.json<any>()).document_change_checkpoint).toBeUndefined();

    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("UPDATE document_requests SET request_json = ? WHERE request_id = ?",
        JSON.stringify({ ...request, expected_generation: 1 }), request.request_id);
      state.storage.sql.exec("UPDATE document_requests SET receipt_json = ? WHERE request_id = ?",
        JSON.stringify(receipt), request.request_id);
    });
    const mismatchedIntent = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect((await mismatchedIntent.json<any>()).document_change_checkpoint).toBeUndefined();

    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests WHERE request_id = ?", request.request_id);
    });
    const prunedIntent = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect((await prunedIntent.json<any>()).document_change_checkpoint).toBeUndefined();
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

  it("exposes only the bounded SQL failure identity and preserves stopped recovery history", async () => {
    installDropboxMock({ faults, immutableRevisions: true });
    const created = await createProject("LOCAL-RECOVERY-FAILURE-IDENTITY");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-LOCAL-FAILURE-IDENTITY-0001",
      project_id: created.project_id,
      logical_path: "strategy/failure-identity.md",
      content: "Keep this private request body out of recovery identity.",
      content_sha256: await sha256Text("Keep this private request body out of recovery identity."),
      created_at: at
    };
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    const originalFailure = {
      fingerprint: "b".repeat(64),
      count: 6,
      stopped: 1,
      message: JSON.stringify({
        code: "identical_internal_failure_limit",
        classification: "internal",
        error_name: "Error",
        progress_sha256: "c".repeat(64),
        external_progress_sha256: "d".repeat(64),
        next_attempt_at: null
      })
    };
    await runInDurableObject(guard, async (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES ('document', ?, ?, ?)",
        request.request_id, requestJson, requestSha256
      );
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES ('document', ?, ?, ?, ?, ?)",
        request.request_id, originalFailure.fingerprint, originalFailure.count, originalFailure.stopped, originalFailure.message
      );
      durableState.storage.sql.exec(
        "INSERT INTO document_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)",
        request.request_id, requestJson, JSON.stringify({ status: "pending" })
      );
    });
    vi.spyOn(ExecutionJournal.prototype, "status").mockRejectedValue(new Error("provider_busy"));

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(response.status).toBe(503);
    const body = await response.json<any>();
    expect(body.local_recovery_diagnostic.failure_identity).toEqual({
      fingerprint: "b".repeat(64),
      classification: "internal",
      error_name: "Error",
      progress_sha256: "c".repeat(64),
      external_progress_sha256: "d".repeat(64)
    });
    expect(JSON.stringify(body.local_recovery_diagnostic)).not.toContain(request.content);
    const persistedAfter = await runInDurableObject(guard, (_instance, durableState) =>
      durableState.storage.sql.exec<{ fingerprint: string; count: number; stopped: number; message: string }>(
        "SELECT fingerprint, count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?",
        request.request_id
      ).one()
    );
    expect(persistedAfter).toEqual(originalFailure);
  });

  it.each([
    ["malformed fingerprint", "fingerprint", "not-a-hash"],
    ["unsupported classification", "classification", "mystery"],
    ["unsafe error name", "error_name", "Error\nprivate-detail"],
    ["unknown error name", "error_name", "PrivateProviderError"],
    ["malformed progress hash", "progress_sha256", "not-a-hash"],
    ["malformed external progress hash", "external_progress_sha256", "not-a-hash"]
  ])("omits malformed failure identity fields (%s)", async (label, field, invalidValue) => {
    installDropboxMock({ faults, immutableRevisions: true });
    const caseId = String(label).toUpperCase().replace(/[^A-Z0-9]+/g, "-");
    const created = await createProject(`LOCAL-RECOVERY-FAILURE-IDENTITY-INVALID-${caseId}`);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const requestId = `DOCREQ-FAILURE-IDENTITY-INVALID-${caseId}-0001`;
    const diagnostic: Record<string, unknown> = {
      code: "identical_internal_failure_limit",
      classification: "internal",
      error_name: "Error",
      progress_sha256: "c".repeat(64),
      next_attempt_at: null
    };
    if (field !== "fingerprint") diagnostic[field as string] = invalidValue;
    const message = JSON.stringify(diagnostic);
    await runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES ('document', ?, ?, 6, 1, ?)",
        requestId, field === "fingerprint" ? invalidValue : "b".repeat(64), message
      );
    });
    vi.spyOn(ExecutionJournal.prototype, "status").mockRejectedValue(new Error("provider_busy"));

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    expect(response.status).toBe(503);
    const body = await response.json<any>();
    expect(body.local_recovery_diagnostic).not.toHaveProperty("failure_identity");
    expect(JSON.stringify(body.local_recovery_diagnostic)).not.toContain("private-detail");
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
