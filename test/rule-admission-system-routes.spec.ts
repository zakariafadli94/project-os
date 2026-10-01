import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineStatePath } from "../src/dropbox/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { ruleFixture } from "./helpers/rule-fixtures";
import { globalGovernancePath } from "../src/persistence/rule-governance-repository";
import { ruleVersionSchema } from "../src/domain/rule-governance";
import { ExecutionJournal } from "../src/execution/journal";
import worker from "../src/index";

const testEnv = env as unknown as Env;
const signingKey = "system-route-rule-admission-secret";

async function strictGuard(projectId: string) {
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record)}\n`);
  mock.files.set(machineStatePath(projectId), `${JSON.stringify(record.state)}\n`);
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
      MUTATION_CONTEXT_SIGNING_KEY: "system-route-context-secret",
      RULE_ADMISSION_SIGNING_KEY: signingKey
    });
  });
  return { guard, mock };
}

describe("strict system mutation routes", () => {
  it("does not let a legacy repair body fall through to ungated reconciliation", async () => {
    const projectId = "PRJ-8188";
    const { guard } = await strictGuard(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_ADMISSION_PROJECT_MODES = undefined;
    });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        operation: "project.repair",
        request_id: "REPAIR-8188",
        base_revision: 1,
        diagnosed_drift_refs: ["server:drift-8188"],
        resources: [{ resource_id: "DOC-8188", resource_type: "document", zone: "WORKING", version: "V1" }],
        action: { kind: "resume_committed", original_kind: "document", original_request_id: "DOCREQ-8188", effect_plan_hash: "a".repeat(64) }
      })
    });

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({ error: "mutation_context_missing" });
  });

  it("suspends a legacy route when a previously initialized global governance snapshot disappears", async () => {
    const projectId = "PRJ-8189";
    const { guard, mock } = await strictGuard(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_ADMISSION_PROJECT_MODES = undefined;
    });
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);
    mock.files.delete(globalGovernancePath);

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "GLOBAL_GOVERNANCE_UNAVAILABLE" });
  });

  it("does not let an observe-rollout project bypass an applicable active local rule", async () => {
    const projectId = "PRJ-8190";
    const mock = installDropboxMock();
    const record = commitFixture(projectId, 1)[0]!;
    const active = ruleVersionSchema.parse(ruleFixture(projectId, {
      rule_id: "RULE-REPAIR-8190",
      status: "active",
      activation_evidence: ["server:qualified"],
      operations: ["project.repair"],
      resource_scope: { resource_types: ["project"], zones: ["DOCUMENTS"] },
      check_id: "exact_approval",
      parameters: {}
    }));
    record.state.local_rules = { [`${active.rule_id}@${active.version}`]: active };
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record)}\n`);
    mock.files.set(machineStatePath(projectId), `${JSON.stringify(record.state)}\n`);
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        MUTATION_CONTEXT_SIGNING_KEY: "system-route-context-secret",
        RULE_ADMISSION_SIGNING_KEY: signingKey
      });
    });
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
  });

  it("applies the same active project.repair rule before effects on both supported routes and exposes no public repair bypass", async () => {
    const projectId = "PRJ-8194";
    const { guard, mock } = await strictGuard(projectId);
    const record = commitFixture(projectId, 1)[0]!;
    const active = ruleVersionSchema.parse(ruleFixture(projectId, {
      rule_id: "RULE-REPAIR-8194",
      status: "active",
      activation_evidence: ["server:qualified"],
      operations: ["project.repair"],
      resource_scope: { resource_types: ["project"], zones: ["DOCUMENTS", "MATERIALIZATION"] },
      check_id: "exact_approval",
      parameters: {}
    }));
    record.state.local_rules = { [`${active.rule_id}@${active.version}`]: active };
    mock.files.set(machineCommitRecordPath(projectId, 1), `${JSON.stringify(record)}\n`);
    mock.files.set(machineStatePath(projectId), `${JSON.stringify(record.state)}\n`);
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);
    const baselineCalls = mock.calls.length;
    const baselineFiles = new Map(mock.files);
    const revision = record.state.revision;
    const routes = [
      { path: "/reconcile-documents", kind: "document-reconcile", requestId: `document-reconcile@${revision}` },
      { path: "/reconcile-materialization", kind: "materialization", requestId: `/reconcile@${revision}` }
    ] as const;

    const outcomes: Array<{
      status: number;
      body: Record<string, unknown>;
      kind: "document-reconcile" | "materialization";
      requestId: string;
    }> = [];
    for (const route of routes) {
      const response = await guard.fetch(`https://project-guard.internal${route.path}`, { method: "POST" });
      outcomes.push({ status: response.status, body: await response.json<Record<string, unknown>>(), ...route });
    }

    expect(outcomes.map(({ status }) => status)).toEqual([503, 503]);
    expect(outcomes[0]!.body).toMatchObject({
      error: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE",
      rule: { rule_id: active.rule_id, version: active.version, scope: active.scope }
    });
    expect(outcomes[1]!.body).toMatchObject({
      error: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE",
      rule: { rule_id: active.rule_id, version: active.version, scope: active.scope }
    });
    expect((outcomes[1]!.body as { rule: unknown }).rule).toEqual((outcomes[0]!.body as { rule: unknown }).rule);
    expect(mock.calls.slice(baselineCalls).filter((call) => /files\/(upload|move_v2|copy_v2|delete_v2|create_folder_v2)/.test(call))).toEqual([]);
    expect([...mock.files]).toEqual([...baselineFiles]);

    await runInDurableObject(guard, async (instance, ctx) => {
      const runtime = (instance as unknown as { persistence: ConstructorParameters<typeof ExecutionJournal>[0] }).persistence;
      for (const route of outcomes) {
        expect(await new ExecutionJournal(runtime, projectId, route.kind, route.requestId).readAdmission()).toBeNull();
        expect(ctx.storage.sql.exec(
          "SELECT request_id FROM admission_proofs WHERE kind = ? AND request_id = ?",
          route.kind, route.requestId
        ).toArray()).toEqual([]);
        expect(ctx.storage.sql.exec(
          "SELECT request_id FROM document_requests WHERE request_id = ?",
          route.requestId
        ).toArray()).toEqual([]);
        expect(ctx.storage.sql.exec(
          "SELECT request_id FROM artifact_requests WHERE request_id = ?",
          route.requestId
        ).toArray()).toEqual([]);
        expect(ctx.storage.sql.exec(
          "SELECT transaction_id FROM transactions WHERE transaction_id = ?",
          route.requestId
        ).toArray()).toEqual([]);
      }
    });

    const publicRepair = await worker.fetch(new Request(`https://example.com/v1/projects/${projectId}/repair`, {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, operation: "project.repair" })
    }), testEnv, createExecutionContext());
    expect(publicRepair.status).toBe(404);
    expect(mock.calls.slice(baselineCalls).filter((call) => /files\/(upload|move_v2|copy_v2|delete_v2|create_folder_v2)/.test(call))).toEqual([]);
    expect([...mock.files]).toEqual([...baselineFiles]);
  });

  it("fails closed before recovery, document reconciliation, or materialization forwarding when governance is unavailable", async () => {
    const projectId = "PRJ-8191";
    const { guard, mock } = await strictGuard(projectId);
    const baseline = mock.calls.length;

    for (const path of ["/recover-inputs", "/reconcile-documents", "/reconcile-materialization", "/materialize"]) {
      const response = await guard.fetch(`https://project-guard.internal${path}`, { method: "POST" });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: "GLOBAL_GOVERNANCE_UNAVAILABLE" });
    }
    expect(mock.calls.slice(baseline).filter((call) => /files\/(upload|move|copy|delete_v2|create_folder_v2)/.test(call))).toEqual([]);
  });

  it("uses the common Registry-issued admission path for an available recovery operation", async () => {
    const projectId = "PRJ-8192";
    const { guard } = await strictGuard(projectId);
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const response = await guard.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ project_id: projectId, scanned: 0 });
  });

  it("does not mistake a scheduled document scan body for a typed business repair", async () => {
    const projectId = "PRJ-8193";
    const { guard } = await strictGuard(projectId);
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey, projectId);

    const response = await guard.fetch(
      "https://project-guard.internal/reconcile-documents?scheduled=1",
      { method: "POST", body: " " }
    );

    expect(response.status).toBe(200);
  });
});
