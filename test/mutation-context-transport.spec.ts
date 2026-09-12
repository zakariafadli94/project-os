import { describe, expect, it } from "vitest";
import { decodeAdmission, encodeAdmission } from "../src/admission/transport";
import { AdmissionError, issueMutationContext } from "../src/admission/mutation-context";
import { commitFixture } from "./helpers/convergence-fixture";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import mutationGateWorker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { machineCommitRecordPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { MutationGateService } from "../src/mutation-gate/service";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const testEnv = env as unknown as Env;

async function seedCandidate(record: ReturnType<typeof commitFixture>[number], path: string): Promise<void> {
  const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
  const metadata = await runtime.objects.getMetadata(path);
  if (!metadata) throw new Error("candidate_fixture_missing");
  // Fixture creation is not an implicit strict project.repair authorization.
  // Transport assertions below still exercise the real authenticated route.
  await new MutationGateService(runtime, "enforce").captureExternalCandidate(record.state, path, metadata, "incremental");
}

describe("mutation context transport", () => {
  it("round-trips the exact request and signed context without adding claims", async () => {
    const state = commitFixture("PRJ-9258", 1)[0].state;
    const context = await issueMutationContext(state, "synthetic-context-secret-for-vitest-only", 0);
    const request = { transaction_id: "TXN-TRANSPORT-000001", base_revision: 1 };

    expect(decodeAdmission(encodeAdmission(request, context), (value) => value as typeof request))
      .toEqual({ admission_version: "1.0", request, mutation_context: context });
  });

  it("rejects a truncated or extended envelope instead of downgrading it to legacy", () => {
    const parse = (value: unknown) => value;
    expect(() => decodeAdmission({ admission_version: "1.0", request: {} }, parse))
      .toThrow(AdmissionError);
    expect(() => decodeAdmission({ admission_version: "1.0", request: {}, mutation_context: null, bypass: true }, parse))
      .toThrow("mutation_context_invalid");
  });

  it("keeps legacy requests explicit with a null context", () => {
    expect(decodeAdmission({ transaction_id: "TXN-LEGACY-0000001" }, (value) => value))
      .toEqual({ admission_version: "1.0", request: { transaction_id: "TXN-LEGACY-0000001" }, mutation_context: null });
  });

  it("requires fresh context and permits exact replay for strict mutation-candidate resolution", async () => {
    const projectId = "PRJ-9986";
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-context-secret-for-vitest-only", projectId);
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const candidatePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9986-synthetic-convergence/ARTIFACTS/strict-context.md";
    await mock.writeExternal(candidatePath, "# strict candidate context");
    await seedCandidate(record, candidatePath);
    const candidates = await (await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" }))
      .json<{ candidates: Array<{ candidate_id: string }> }>();
    expect(candidates.candidates).toHaveLength(1);

    const resolution = {
      operation: "candidate.reject" as const,
      resolution_id: "MUTRES-ABCDEF0123456789ABCDEF01",
      project_id: projectId,
      candidate_id: candidates.candidates[0]!.candidate_id
    };
    const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" };
    const missing = await mutationGateWorker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST", headers, body: JSON.stringify(resolution)
    }), testEnv, createExecutionContext());
    expect(missing.status).toBe(428);
    await expect(missing.json()).resolves.toEqual({ error: "mutation_context_missing" });

    const contextResponse = await worker.fetch(new Request(`https://example.com/v1/projects/${projectId}/mutation-context`, {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());
    expect(contextResponse.status).toBe(200);
    const { context } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const accepted = await mutationGateWorker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST", headers, body: JSON.stringify(encodeAdmission(resolution, context))
    }), testEnv, createExecutionContext());
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "committed", action: "reject" });

    const replay = await mutationGateWorker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST", headers, body: JSON.stringify(resolution)
    }), testEnv, createExecutionContext());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ status: "committed", action: "reject" });
  });

  it("forwards fresh context to strict working adoption", async () => {
    const projectId = "PRJ-9987";
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-context-secret-for-vitest-only", projectId);
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const content = "# strict working candidate";
    const candidatePath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9987-synthetic-convergence/DELIVERABLES/strict-working.md";
    await mock.writeExternal(candidatePath, content);
    await seedCandidate(record, candidatePath);
    const candidates = await (await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" }))
      .json<{ candidates: Array<{ candidate_id: string }> }>();
    expect(candidates.candidates).toHaveLength(1);

    const contextResponse = await worker.fetch(new Request(`https://example.com/v1/projects/${projectId}/mutation-context`, {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());
    expect(contextResponse.status).toBe(200);
    const { context } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
    const resolution = {
      operation: "candidate.adopt_working" as const,
      resolution_id: "MUTRES-ABCDEF0123456789ABCDEF02",
      project_id: projectId,
      candidate_id: candidates.candidates[0]!.candidate_id,
      document_request: {
        operation: "working.write" as const,
        request_id: "DOCREQ-CONTEXT-WORKING-9987",
        project_id: projectId,
        logical_path: "recovered/strict-working.md",
        content,
        content_sha256: await sha256Text(content),
        created_at: "2026-09-09T10:00:00.000Z"
      }
    };

    const response = await mutationGateWorker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(resolution, context))
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "committed", action: "adopt_as_working" });
  });

  it("preserves the signed context from incoming storage through execution", async () => {
    const projectId = "PRJ-9986";
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, "synthetic-context-secret-for-vitest-only", projectId);
    const record = commitFixture(projectId, 1)[0];
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record, null, 2)}\n`);
    const context = await issueMutationContext(record.state, "synthetic-context-secret-for-vitest-only", Date.now());
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-INCOMING-CONTEXT-9986-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create" as const,
      created_at: "2026-09-09T10:00:00.000Z",
      payload: { task_id: "TASK-INCOMING9986A", title: "Preserved incoming context" }
    };
    const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
    mock.files.set(incoming, JSON.stringify(encodeAdmission(transaction, context)));

    const response = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);
  });
});
