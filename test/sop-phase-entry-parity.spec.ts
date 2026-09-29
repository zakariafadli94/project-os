import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import type { MutationContext } from "../src/admission/mutation-context";
import { createControlTowerServer } from "../src/control-tower/mcp";
import type { Transaction } from "../src/domain/transaction";
import { globalGovernancePath } from "../src/persistence/rule-governance-repository";
import { machineCommitRecordPath, machineTransactionPath } from "../src/persistence/layout";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
import worker from "../src/index";
import fallbackWorker from "../src/index-mutation-gate";
import { exportP256PublicJwk, encryptFallbackPayload, generateP256EcdhKeyPair, decryptFallbackPayload } from "../src/fallback/crypto";
import { parseFallbackEncryptedResponseJson, parseFallbackPublicKeyResponse } from "../src/fallback/contract";

const testEnv = env as unknown as Env;
const auth = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };

async function contextFor(projectId: string): Promise<MutationContext> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/mutation-context?include_state=false", { headers: auth }
  );
  expect(response.status).toBe(200);
  return (await response.json<{ context: MutationContext }>()).context;
}

async function fallbackSubmit(transaction: Transaction, context: MutationContext, exchangeId: string) {
  const keyResponse = await fallbackWorker.fetch(new Request("https://example.com/v1/fallback-ingress/key"), testEnv, createExecutionContext());
  const server = parseFallbackPublicKeyResponse(await keyResponse.json());
  const caller = await generateP256EcdhKeyPair();
  const envelope = encodeAdmission(transaction, context);
  const encrypted = await encryptFallbackPayload({
    key_id: server.key_id, request_id: exchangeId, operation: "transaction", direction: "client_to_server",
    sender_private_key: caller.privateKey, recipient_public_key: server.server_public_key,
    plaintext: new TextEncoder().encode(JSON.stringify({ operation: "transaction", request_id: exchangeId, admission_json: JSON.stringify(envelope) }))
  });
  const response = await fallbackWorker.fetch(new Request("https://example.com/v1/fallback-ingress", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ schema_version: "1.0", key_id: server.key_id, request_id: exchangeId, operation: "transaction",
      caller_public_key: await exportP256PublicJwk(caller.publicKey), ...encrypted })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const encryptedResponse = parseFallbackEncryptedResponseJson(await response.text());
  const plaintext = await decryptFallbackPayload({
    key_id: server.key_id, request_id: exchangeId, operation: "transaction", direction: "server_to_client",
    recipient_private_key: caller.privateKey, sender_public_key: server.server_public_key,
    iv: encryptedResponse.iv, ciphertext: encryptedResponse.ciphertext
  });
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, any>;
}

it.each(["API", "CT", "IN", "FB", "GI"] as const)("qualifies coherent phase completion and checks a fresh refusal/allow through %s", async (entry) => {
  const mock = installDropboxMock();
  const suffix = entry;
  const signingKey = "sop-phase-parity-signing-key";
  await bootstrapRuleAdmissionGovernance(testEnv, signingKey);
  const create: Transaction = {
    schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-CREATE-${suffix}`, project_id: "PRJ-AUTO", base_revision: 0,
    operation: "project.create", created_at: "2026-09-29T12:00:00.000Z",
    payload: { name: `Phase parity ${suffix}`, slug: `phase-parity-${suffix.toLowerCase()}`, aliases: [], objective: "Qualify coherent phase completion across entries" }
  };
  const createResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(create)
  }), testEnv, createExecutionContext());
  expect(createResponse.status).toBe(200);
  const created = await createResponse.json<{ project_id: string; status: string }>();
  expect(created.status).toBe("committed");
  const projectId = created.project_id;

  const submitBeforeStrict = async (transaction: Transaction) => {
    const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(transaction)
    }), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "committed" });
  };
  await submitBeforeStrict({ schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-DECISION-${suffix}`, project_id: projectId,
    base_revision: 1, operation: "decision.accept", created_at: "2026-09-29T12:01:00.000Z",
    payload: { decision_id: `DEC-PHASEPARITY${suffix}`, title: "Phase completion policy", decision: "Complete phases only when ready",
      reason: "Accepted qualification source", impacts: [] } });
  await submitBeforeStrict({ schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-PHASE-${suffix}`, project_id: projectId,
    base_revision: 2, operation: "plan.phase.create", created_at: "2026-09-29T12:02:00.000Z",
    payload: { phase_id: `PHASE-${suffix}0001`, title: "Ready phase" } });
  await submitBeforeStrict({ schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-TASK-${suffix}`, project_id: projectId,
    base_revision: 3, operation: "task.create", created_at: "2026-09-29T12:03:00.000Z",
    payload: { task_id: `TASK-${suffix}0001`, title: "Finish prerequisite", phase_id: `PHASE-${suffix}0001` } });

  const registryResponse = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/registry");
  const registryState = await registryResponse.json<{ projects: Array<{ project_id: string }> }>();
  const strictProjectModes = Object.fromEntries(registryState.projects.map(project => [project.project_id, "strict"]));
  const environment = { ...testEnv, RULE_GOVERNANCE_TOKEN: "phase-parity-governance-authority",
    RULE_ADMISSION_SIGNING_KEY: signingKey, CF_VERSION_METADATA: { id: "phase-parity-worker", tag: `git-${"c".repeat(40)}` },
    PROJECT_OS_LAYOUT_MODE: "v2", PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify(strictProjectModes) } as Env;
  await bootstrapRuleAdmissionGovernance(environment, signingKey, projectId);
  await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), instance => Object.assign((instance as any).env, environment));
  await runInDurableObject(testEnv.REGISTRY_GUARD.getByName("global"), instance => Object.assign((instance as any).env, environment));

  const rule = ruleFixture("GLOBAL", {
    rule_id: `RULE-SOP-PHASE-PARITY-${suffix}`, source_refs: [machineCommitRecordPath(projectId, 2)],
    title: "Require a ready canonical phase", operations: ["plan.phase.complete"],
    resource_scope: { resource_types: ["plan"], zones: ["PROJECT"] }, check_id: "coherent_phase", parameters: {},
    enforcement: "automatic", check_stage: "pre_admission"
  });
  const governance = (operation: string, payload: unknown, revision: number) => governanceTx(operation, payload, revision, "GLOBAL");
  const governanceSubmit = (transaction: unknown) => testEnv.REGISTRY_GUARD.getByName("global").fetch("https://internal/governance/transaction", {
    method: "POST", headers: { authorization: `Bearer ${environment.RULE_GOVERNANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(await (await governanceSubmit(governance("rule.propose", { rule }, 1))).json()).toMatchObject({ status: "committed" });
  const acceptRule = governance("rule.accept", { rule_id: rule.rule_id, version: 1 }, 2);
  expect(await (await governanceSubmit(acceptRule)).json()).toMatchObject({ status: "committed" });
  const activation = await governanceSubmit(governance("rule.activate", { rule_id: rule.rule_id, version: 1,
    activation_evidence: [`${globalGovernancePath}#transaction=${acceptRule.transaction_id}`] }, 3));
  expect(activation.status, await activation.clone().text()).toBe(200);
  const activationReceipt = await activation.json<Record<string, any>>();
  expect(activationReceipt.status).toBe("committed");
  const governanceState = JSON.parse(mock.files.get(globalGovernancePath)!);
  expect(governanceState.rules[`${rule.rule_id}@1`].status).toBe("active");
  expect(governanceState.journal[activationReceipt.transaction_id].qualification.proof.audit.control_probes.length).toBeGreaterThan(0);

  const submitEntry = async (transaction: Transaction): Promise<{ httpStatus: number; body: Record<string, any> }> => {
    if (entry === "API") {
      const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
        method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(encodeAdmission(transaction, await contextFor(projectId)))
      }), environment, createExecutionContext());
      return { httpStatus: response.status, body: await response.json<Record<string, any>>() };
    }
    if (entry === "CT") {
      const result = await (createControlTowerServer(environment as any, { read: true, mutate: true }) as any)
        ._registeredTools.project_os_submit_transaction.handler({ project_id: projectId, request: transaction });
      return { httpStatus: result.isError ? 409 : 200, body: JSON.parse(result.content[0].text) };
    }
    if (entry === "IN") {
      mock.files.set(machineTransactionPath("incoming", transaction.transaction_id), JSON.stringify(transaction));
      const processResponse = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", { method: "POST", headers: auth }), environment, createExecutionContext());
      expect(processResponse.status).toBe(200);
      expect(await processResponse.json()).toMatchObject({ processed: 1, failed: 0 });
      const rejectedPath = machineTransactionPath("rejected", transaction.transaction_id);
      if (mock.files.has(rejectedPath)) return { httpStatus: 409, body: JSON.parse(mock.files.get(rejectedPath)!) };
      const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
        `https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`, { headers: auth }
      );
      return { httpStatus: 200, body: await response.json<Record<string, any>>() };
    }
    if (entry === "FB") {
      const result = await fallbackSubmit(transaction, await contextFor(projectId), `fallback-sop-phase-parity-${suffix.toLowerCase()}-${transaction.transaction_id.slice(-8).toLowerCase()}`);
      return { httpStatus: Number(result.response_status), body: result.receipt as Record<string, any> };
    }
    const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission_version: "1.0", request: transaction, mutation_context: await contextFor(projectId) })
    });
    return { httpStatus: response.status, body: await response.json<Record<string, any>>() };
  };
  const blockedRequest = (transactionId: string): Transaction => ({ schema_version: "1.0", transaction_id: transactionId, project_id: projectId,
    base_revision: 4, operation: "plan.phase.complete", created_at: "2026-09-29T12:04:00.000Z", payload: { phase_id: `PHASE-${suffix}0001` } });
  const blocked = await submitEntry(blockedRequest(`TXN-SOP-PHASE-PARITY-BLOCKED-${suffix}`));
  expect(blocked.httpStatus).toBe(409);
  expect(blocked.body.error ?? blocked.body.code).toBe("PHASE_HAS_UNFINISHED_TASKS");
  if (blocked.body.detail) expect(blocked.body.detail).toMatchObject({ rule: { rule_id: rule.rule_id, version: 1 }, expected: expect.any(String), observed: expect.any(String), required_action: expect.any(String) });
  expect((await contextFor(projectId)).canonical_revision).toBe(4);

  const taskComplete: Transaction = { schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-TASK-DONE-${suffix}`, project_id: projectId,
    base_revision: 4, operation: "task.complete", created_at: "2026-09-29T12:05:00.000Z",
    payload: { task_id: `TASK-${suffix}0001`, result: "Prerequisite complete" } };
  const taskResponse = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(taskComplete, await contextFor(projectId)))
  }), environment, createExecutionContext());
  expect(await taskResponse.json()).toMatchObject({ status: "committed", new_revision: 5 });
  const governanceAfterTask = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/governance");
  expect(governanceAfterTask.status, await governanceAfterTask.clone().text()).toBe(200);

  const completion: Transaction = { schema_version: "1.0", transaction_id: `TXN-SOP-PHASE-PARITY-COMPLETE-${suffix}`, project_id: projectId,
    base_revision: 5, operation: "plan.phase.complete", created_at: "2026-09-29T12:06:00.000Z", payload: { phase_id: `PHASE-${suffix}0001` } };
  const admitted = await submitEntry(completion);
  expect(admitted.httpStatus, JSON.stringify(admitted.body)).toBe(200);
  expect(admitted.body).toMatchObject({ status: "committed", transaction_id: completion.transaction_id, new_revision: 6 });

  const state = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/mutation-context?include_state=true", { headers: auth });
  expect((await state.json<any>()).canonical_state).toMatchObject({ revision: 6, current_phase_id: null, plan_phases: { [`PHASE-${suffix}0001`]: { status: "completed" } } });
});
