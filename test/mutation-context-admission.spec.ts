import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { MutationContextResponse } from "../src/admission/mutation-context";
import { encodeAdmission } from "../src/admission/transport";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineDocumentRoot, machineReceiptPath, machineStatePath, workspaceManagedDocumentPath } from "../src/dropbox/layout";
import { ExecutionJournal } from "../src/execution/journal";
import { sha256Text } from "../src/documents/hash";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";

const baseEnv = env as unknown as Env;
const signingKey = "synthetic-context-secret-for-vitest-only";

function strictEnv(projectId: string): Env {
  return {
    ...baseEnv,
    PROJECT_OS_LAYOUT_MODE: "v2",
    PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
    MUTATION_CONTEXT_SIGNING_KEY: signingKey,
    RULE_ADMISSION_SIGNING_KEY: signingKey
  };
}

function seed(mock: ReturnType<typeof installDropboxMock>, projectId: string, through: number) {
  const records = commitFixture(projectId, through);
  for (const record of records) {
    mock.files.set(machineCommitRecordPath(projectId, record.new_revision), `${JSON.stringify(record, null, 2)}\n`);
  }
  return records;
}

async function readContext(projectId: string, testEnv: Env) {
  return worker.fetch(new Request(`https://example.com/v1/projects/${projectId}/mutation-context`, {
    headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
  }), testEnv, createExecutionContext());
}

describe("canonical mutation-context admission", () => {
  beforeEach(() => installDropboxMock());

  it("serves an authenticated context from canonical commits without claiming view freshness", async () => {
    const projectId = "PRJ-9981";
    const mock = installDropboxMock();
    seed(mock, projectId, 2);
    const testEnv = strictEnv(projectId);

    const unauthorized = await worker.fetch(
      new Request(`https://example.com/v1/projects/${projectId}/mutation-context`),
      testEnv,
      createExecutionContext()
    );
    expect(unauthorized.status).toBe(401);

    const response = await readContext(projectId, testEnv);
    expect(response.status).toBe(200);
    const body = await response.json<MutationContextResponse>();
    expect(body.context).toMatchObject({ project_id: projectId, canonical_revision: 2 });
    expect(body.canonical_state).toMatchObject({ project_id: projectId, revision: 2 });
    expect(body.views).toMatchObject({ status: "unknown", verified_at: null });
    expect(body.views.state).toContain("revision: 2");
    expect(body.views.handoff).toContain(projectId);
  });

  it("serves a context from a verified historical snapshot followed by recent commits", async () => {
    const projectId = "PRJ-9980";
    const mock = installDropboxMock();
    const records = commitFixture(projectId, 267);
    mock.files.set(machineStatePath(projectId), `${JSON.stringify(records[255].state, null, 2)}\n`);
    mock.files.set(machineCommitRecordPath(projectId, 256), `${JSON.stringify(records[255], null, 2)}\n`);
    for (const record of records.slice(256)) {
      mock.files.set(machineCommitRecordPath(projectId, record.new_revision), `${JSON.stringify(record, null, 2)}\n`);
    }

    const response = await readContext(projectId, strictEnv(projectId));

    expect(response.status).toBe(200);
    await expect(response.json<MutationContextResponse>()).resolves.toMatchObject({
      context: { project_id: projectId, canonical_revision: 267 },
      canonical_state: { project_id: projectId, revision: 267 }
    });
    expect(mock.uploadCalls).toEqual([]);
  });

  it("rejects strict mutations before durable business effects and accepts the fresh envelope", async () => {
    const projectId = "PRJ-9982";
    const mock = installDropboxMock();
    seed(mock, projectId, 1);
    const testEnv = strictEnv(projectId);
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-CONTEXT-9982-TASK-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-CONTEXT9982A", title: "Fresh canonical admission" }
    };

    const missing = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(transaction)
    }), testEnv, createExecutionContext());
    expect(missing.status).toBe(428);
    await expect(missing.json()).resolves.toEqual({ error: "mutation_context_missing" });
    expect(mock.files.has(machineReceiptPath(transaction.transaction_id))).toBe(false);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);

    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);
    const accepted = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(transaction, context))
    }), testEnv, createExecutionContext());
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "committed", new_revision: 2 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
  });

  it("does not reserve an intent on a refused strict admission, so a corrected request can proceed", async () => {
    const projectId = "PRJ-9983";
    const mock = installDropboxMock();
    seed(mock, projectId, 1);
    const testEnv = strictEnv(projectId);
    const original = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-CONTEXT-9983-TASK-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-CONTEXT9983A", title: "Original intent" }
    };
    const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" };

    const first = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST", headers, body: JSON.stringify(original)
    }), testEnv, createExecutionContext());
    expect(first.status).toBe(428);

    const changed = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...original, payload: { ...original.payload, title: "Rebound intent" } })
    }), testEnv, createExecutionContext());
    expect(changed.status).toBe(428);
    await expect(changed.json()).resolves.toEqual({ error: "mutation_context_missing" });

    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);
    const corrected = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission({ ...original, payload: { ...original.payload, title: "Corrected intent" } }, context))
    }), testEnv, createExecutionContext());
    expect(corrected.status).toBe(200);
    await expect(corrected.json()).resolves.toMatchObject({ status: "committed", new_revision: 2 });
  });

  it("forwards a fresh signed context to governed review-candidate promotion before recording its terminal result", async () => {
    const projectId = "PRJ-9976";
    const mock = installDropboxMock();
    seed(mock, projectId, 1);
    const testEnv = strictEnv(projectId);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
        MUTATION_CONTEXT_SIGNING_KEY: signingKey,
        RULE_ADMISSION_SIGNING_KEY: signingKey
      });
    });
    const promotion = {
      operation: "review_candidate.promote" as const,
      request_id: `DOCREQ-CONTEXT-PROMOTION-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`,
      project_id: projectId,
      candidate_request_id: "ART-REVIEW-CANDIDATE-9985",
      logical_path: "reports/final-report.pdf",
      expected_project_revision: 1,
      accepted: true as const,
      created_at: "2026-09-09T10:00:00.000Z"
    };

    const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" };
    const missing = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers,
      body: JSON.stringify(promotion)
    }), testEnv, createExecutionContext());
    expect(missing.status).toBe(428);
    await expect(missing.json()).resolves.toEqual({ error: "mutation_context_missing" });

    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();

    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const response = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission(promotion, context))
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      request_id: promotion.request_id,
      project_id: projectId,
      status: "conflict",
      code: "CANDIDATE_RECEIPT_NOT_COMMITTED"
    });
  });

  it("rejects a context when canonical state advances after the read", async () => {
    const projectId = "PRJ-9984";
    const mock = installDropboxMock();
    seed(mock, projectId, 1);
    const testEnv = strictEnv(projectId);
    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();

    const advanced = commitFixture(projectId, 2)[1];
    mock.files.set(machineCommitRecordPath(projectId, 2), `${JSON.stringify(advanced, null, 2)}\n`);
    const submitted = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-CONTEXT-9984-STALE-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-CONTEXT9984A", title: "Must refresh after advance" }
    };
    const metrics: unknown[] = [];
    const metricLog = vi.spyOn(console, "info").mockImplementation((message, metric) => {
      if (message === "Project OS convergence metric") metrics.push(metric);
    });

    const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(submitted, context))
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "mutation_context_stale" });
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "freshness_rejections",
        kind: "counter",
        value: 1,
        fields: expect.objectContaining({
          project_id: projectId,
          target_revision: 2,
          observed_revision: 1,
          code: "mutation_context_stale",
          deployment_sha: "unknown"
        })
      })
    ]));
    expect(JSON.stringify(metrics)).not.toContain("Must refresh after advance");
    metricLog.mockRestore();
  });

  it("reconciles a lagging V2 cache before verifying a newly issued context", async () => {
    const projectId = "PRJ-9986";
    const mock = installDropboxMock();
    const records = seed(mock, projectId, 2);
    const testEnv = strictEnv(projectId);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);

    // The public context reader discovers revision 2 from canonical commits,
    // while this worker's durable SQL cache is still at revision 1.
    await runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?)",
        JSON.stringify(records[0].state)
      );
    });
    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();
    expect(context).toMatchObject({ project_id: projectId, canonical_revision: 2 });
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" };
    const fresh = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-CONTEXT-9986-FRESH-0001",
      project_id: projectId,
      base_revision: 2,
      operation: "research.add" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { research_id: "RES-CONTEXT9986", title: "Fresh after catch-up", body: "Fresh context must verify against reconciled state." }
    };
    const accepted = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST", headers, body: JSON.stringify(encodeAdmission(fresh, context))
    }), testEnv, createExecutionContext());
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "committed", previous_revision: 2, new_revision: 3 });

    const stale = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission({ ...fresh, transaction_id: "TXN-CONTEXT-9986-STALE-0001", payload: { ...fresh.payload, research_id: "RES-CONTEXT9986S" } }, context))
    }), testEnv, createExecutionContext());
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "mutation_context_stale" });

    const refreshed = await readContext(projectId, testEnv);
    const { context: current } = await refreshed.json<MutationContextResponse>();
    const tampered = {
      ...current,
      actor: { ...current.actor, actor_id: "client-spoofed-actor" }
    };
    const rejected = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission({ ...fresh, transaction_id: "TXN-CONTEXT-9986-TAMPER-0001", base_revision: 3, payload: { ...fresh.payload, research_id: "RES-CONTEXT9986T" } }, tampered))
    }), testEnv, createExecutionContext());
    expect(rejected.status).toBe(428);
    await expect(rejected.json()).resolves.toEqual({ error: "mutation_context_invalid" });
    expect(mock.files.has(machineCommitRecordPath(projectId, 4))).toBe(false);
  });

  it("rebuilds a same-revision divergent V2 cache before verifying a fresh context", async () => {
    const projectId = "PRJ-9987";
    const mock = installDropboxMock();
    const records = seed(mock, projectId, 2);
    const testEnv = strictEnv(projectId);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const divergentState = structuredClone(records[1].state);
    divergentState.research = {};

    // The public reader reconstructs the immutable revision-2 commit, while
    // the local SQL cache claims revision 2 with different state content.
    await runInDurableObject(guard, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?)",
        JSON.stringify(divergentState)
      );
    });
    const contextResponse = await readContext(projectId, testEnv);
    const { context } = await contextResponse.json<MutationContextResponse>();
    expect(context).toMatchObject({ project_id: projectId, canonical_revision: 2 });
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-CONTEXT-9987-FRESH-0001",
      project_id: projectId,
      base_revision: 2,
      operation: "research.add" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { research_id: "RES-CONTEXT9987", title: "Rebuilt canonical cache", body: "Fresh context must use the immutable canonical state." }
    };
    const accepted = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(transaction, context))
    }), testEnv, createExecutionContext());

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "committed", previous_revision: 2, new_revision: 3 });
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(true);
  });

  it("rejects project A's signed context at project B's document boundary without reserving work, then admits B's own context", async () => {
    const projectA = "PRJ-9988";
    const projectB = "PRJ-9989";
    const mock = installDropboxMock();
    seed(mock, projectA, 1);
    const recordsB = seed(mock, projectB, 1);
    const testEnv = strictEnv(projectA);
    testEnv.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [projectA]: "strict", [projectB]: "strict" });
    const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" };
    for (const projectId of [projectA, projectB]) {
      await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, {
          PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
          MUTATION_CONTEXT_SIGNING_KEY: signingKey,
          RULE_ADMISSION_SIGNING_KEY: signingKey
        });
      });
    }

    const [contextAResponse, contextBResponse] = await Promise.all([
      readContext(projectA, testEnv),
      readContext(projectB, testEnv)
    ]);
    expect(contextAResponse.status).toBe(200);
    expect(contextBResponse.status).toBe(200);
    const { context: contextA } = await contextAResponse.json<MutationContextResponse>();
    const { context: contextB } = await contextBResponse.json<MutationContextResponse>();
    expect(contextA.project_id).toBe(projectA);
    expect(contextB.project_id).toBe(projectB);
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectB);

    const crossProjectRequest = {
      operation: "working.write" as const,
      request_id: "DOCREQ-CROSS-PROJECT-9988-0001",
      project_id: projectB,
      logical_path: "context/cross-project.md",
      content: "A's signed context must not authorize B.",
      content_sha256: await sha256Text("A's signed context must not authorize B."),
      created_at: "2026-09-09T10:00:00.000Z"
    };
    const uploadsBeforeRefusal = [...mock.uploadCalls];
    const refused = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission(crossProjectRequest, contextA))
    }), testEnv, createExecutionContext());
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "mutation_context_stale" });
    expect(mock.uploadCalls).toEqual(uploadsBeforeRefusal);
    expect(mock.files.has(`${machineDocumentRoot(projectB)}/requests/${crossProjectRequest.request_id}/intent.json`)).toBe(false);
    expect(mock.files.has(`${machineDocumentRoot(projectB)}/requests/${crossProjectRequest.request_id}/receipt.json`)).toBe(false);

    const guardB = testEnv.PROJECT_GUARD.getByName(projectB);
    const assertNoDurableWork = async (requestId: string) => {
      expect(mock.files.has(`${machineDocumentRoot(projectB)}/requests/${requestId}/intent.json`)).toBe(false);
      expect(mock.files.has(`${machineDocumentRoot(projectB)}/requests/${requestId}/receipt.json`)).toBe(false);
      expect(mock.uploadCalls).toEqual(uploadsBeforeRefusal);
      const durableState = await runInDurableObject(guardB, async (instance, ctx) => {
        const runtime = (instance as unknown as { persistence: ConstructorParameters<typeof ExecutionJournal>[0] }).persistence;
        return {
          admission: await new ExecutionJournal(runtime, projectB, "document", requestId).readAdmission(),
          documentRequest: ctx.storage.sql.exec("SELECT request_id FROM document_requests WHERE request_id = ?", requestId).toArray(),
          admissionProof: ctx.storage.sql.exec("SELECT request_id FROM admission_proofs WHERE kind = ? AND request_id = ?", "document", requestId).toArray()
        };
      });
      expect(durableState).toEqual({ admission: null, documentRequest: [], admissionProof: [] });
    };
    await assertNoDurableWork(crossProjectRequest.request_id);

    const forgedContextRequest = { ...crossProjectRequest, request_id: "DOCREQ-FORGED-CONTEXT-9988-0001" };
    const forgedContextEnvelope = {
      ...encodeAdmission(forgedContextRequest, contextA),
      mutation_context: { ...contextA, project_id: projectB }
    };
    const forgedContextResponse = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST", headers, body: JSON.stringify(forgedContextEnvelope)
    }), testEnv, createExecutionContext());
    expect(forgedContextResponse.status).toBe(428);
    await expect(forgedContextResponse.json()).resolves.toEqual({ error: "mutation_context_invalid" });
    await assertNoDurableWork(forgedContextRequest.request_id);

    const clientRulesetRequest = { ...crossProjectRequest, request_id: "DOCREQ-CLIENT-RULESET-9988-0001" };
    const clientRulesetEnvelope = {
      ...encodeAdmission(clientRulesetRequest, contextA),
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 1 }
    };
    const clientRulesetResponse = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST", headers, body: JSON.stringify(clientRulesetEnvelope)
    }), testEnv, createExecutionContext());
    expect(clientRulesetResponse.status).toBe(428);
    await expect(clientRulesetResponse.json()).resolves.toEqual({ error: "mutation_context_invalid" });
    await assertNoDurableWork(clientRulesetRequest.request_id);

    const clientPermitRequest = { ...crossProjectRequest, request_id: "DOCREQ-CLIENT-PERMIT-9988-0001" };
    const clientPermitEnvelope = {
      ...encodeAdmission(clientPermitRequest, contextA),
      permit: { project_id: projectB, ruleset: { digest: "b".repeat(64), rules: [] }, token: "client-selected" }
    };
    const clientPermitResponse = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST", headers, body: JSON.stringify(clientPermitEnvelope)
    }), testEnv, createExecutionContext());
    expect(clientPermitResponse.status).toBe(428);
    await expect(clientPermitResponse.json()).resolves.toEqual({ error: "mutation_context_invalid" });
    await assertNoDurableWork(clientPermitRequest.request_id);

    const acceptedRequest = { ...crossProjectRequest, request_id: "DOCREQ-CANONICAL-PROJECT-B-0001", logical_path: "context/canonical-project-b.md" };
    const accepted = await worker.fetch(new Request("https://example.com/v1/documents", {
      method: "POST",
      headers,
      body: JSON.stringify(encodeAdmission(acceptedRequest, contextB))
    }), testEnv, createExecutionContext());
    expect(accepted.status).toBe(200);
    const acceptedReceipt = await accepted.json<Record<string, unknown>>();
    expect(acceptedReceipt).toMatchObject({
      request_id: acceptedRequest.request_id,
      project_id: projectB,
      status: "committed"
    });
    const success = await runInDurableObject(guardB, async (instance, ctx) => {
      const runtime = (instance as unknown as { persistence: ConstructorParameters<typeof ExecutionJournal>[0] }).persistence;
      return {
        admission: await new ExecutionJournal(runtime, projectB, "document", acceptedRequest.request_id).readAdmission(),
        documentRequest: ctx.storage.sql.exec("SELECT request_id FROM document_requests WHERE request_id = ?", acceptedRequest.request_id).toArray()
      };
    });
    expect(success.admission?.admission).toMatchObject({ project_id: projectB, request_id: acceptedRequest.request_id, operation: "working.write" });
    expect(success.documentRequest).toHaveLength(1);
    const receiptPath = `${machineDocumentRoot(projectB)}/requests/${acceptedRequest.request_id}/receipt.json`;
    const durableReceipt = JSON.parse(mock.files.get(receiptPath)!) as { receipt_json: string };
    expect(JSON.parse(durableReceipt.receipt_json)).toEqual(acceptedReceipt);
    expect(mock.files.get(workspaceManagedDocumentPath(projectB, recordsB[0]!.state.slug, "working", acceptedRequest.logical_path)))
      .toBe(`---\nproject_id: ${projectB}\ndocument_id: ${String(acceptedReceipt.document_id)}\n---\n${acceptedRequest.content}`);
  });
});
