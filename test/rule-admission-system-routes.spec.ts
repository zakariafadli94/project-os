import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineStatePath } from "../src/dropbox/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { ruleFixture } from "./helpers/rule-fixtures";
import { globalGovernancePath } from "../src/persistence/rule-governance-repository";
import { ruleVersionSchema } from "../src/domain/rule-governance";

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
});
