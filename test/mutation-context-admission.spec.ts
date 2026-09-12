import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { MutationContextResponse } from "../src/admission/mutation-context";
import { encodeAdmission } from "../src/admission/transport";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineReceiptPath, machineStatePath } from "../src/dropbox/layout";
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
});
