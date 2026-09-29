import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import { machineTransactionRequestIntentPath } from "../src/persistence/layout";
import { governanceTx, ruleAt, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
const testEnv = env as unknown as Env;
beforeEach(() => { installDropboxMock(); });
afterEach(() => vi.restoreAllMocks());
it("serializes project governance through ordinary committed event/receipt persistence", async () => {
  const projectId = "PRJ-7101";
  const governanceToken = "project-rule-governance-dedicated-test-token";
  const signingKey = "project-rule-governance-context-signing-key";
  const stub = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(stub, (instance) => Object.assign((instance as any).env, {
    RULE_GOVERNANCE_TOKEN: governanceToken,
    MUTATION_CONTEXT_SIGNING_KEY: signingKey
  }));
  async function submit(tx: unknown) {
    const parsed = tx as { operation?: string };
    let body = tx;
    if (parsed.operation?.startsWith("rule.")) {
      const contextResponse = await stub.fetch("https://project-guard.internal/mutation-context", {
        headers: { authorization: `Bearer ${governanceToken}` }
      });
      expect(contextResponse.status).toBe(200);
      const { context } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
      body = encodeAdmission(tx as Parameters<typeof encodeAdmission>[0], context);
    }
    const response = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    return response;
  }
  const createResponse = await submit({ schema_version: "1.0", transaction_id: "TXN-RULE-PROJECT-CREATE", project_id: projectId,
    base_revision: 0, created_at: ruleAt, operation: "project.create", payload: { name: "Rules", slug: "rules", objective: "Verify governance", aliases: [] } });
  expect(createResponse.status).toBe(200);
  const tx = governanceTx("rule.propose", { rule: ruleFixture(projectId) }, 1, projectId);
  const proposeResponse = await submit(tx);
  expect(proposeResponse.status).toBe(200);
  const receipt = await proposeResponse.json();
  expect(receipt).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
  expect(await (await submit(tx)).json()).toEqual(receipt);
  const stale = governanceTx("rule.accept", { rule_id: "RULE-7101", version: 1 }, 1);
  const staleResponse = await submit(stale);
  expect(staleResponse.status).toBe(409);
  expect(await staleResponse.json()).toMatchObject({ error: "mutation_context_stale" });
});

it("rejects an ingress-signed local rule proposal before persisting its transaction intent", async () => {
  const projectId = "PRJ-7125";
  const ingressToken = "project-rule-governance-ingress-test-token";
  const signingKey = "project-rule-governance-context-signing-key";
  const mock = installDropboxMock();
  const stub = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(stub, (instance) => Object.assign((instance as any).env, {
    INGRESS_TOKEN: ingressToken,
    MUTATION_CONTEXT_SIGNING_KEY: signingKey
  }));

  const create = {
    schema_version: "1.0",
    transaction_id: "TXN-RULE-AUTHORITY-PROJECT-7125",
    project_id: projectId,
    base_revision: 0,
    created_at: ruleAt,
    operation: "project.create",
    payload: { name: "Rules authority", slug: "rules-authority", objective: "Require dedicated rule governance", aliases: [] }
  };
  const created = await stub.fetch("https://project-guard.internal/transaction", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create)
  });
  expect(await created.json()).toMatchObject({ status: "committed", new_revision: 1 });

  const contextResponse = await stub.fetch("https://project-guard.internal/mutation-context", {
    headers: { authorization: `Bearer ${ingressToken}` }
  });
  const { context } = await contextResponse.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
  const tx = governanceTx("rule.propose", { rule: ruleFixture(projectId) }, 1, projectId);
  const response = await stub.fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(tx, context))
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "LOCAL_GOVERNANCE_AUTHORITY_REQUIRED" });
  expect(mock.files.has(machineTransactionRequestIntentPath(projectId, tx.transaction_id))).toBe(false);

  await runInDurableObject(stub, (instance) => Object.assign((instance as any).env, { RULE_GOVERNANCE_TOKEN: ingressToken }));
  const sharedTokenContext = await stub.fetch("https://project-guard.internal/mutation-context", {
    headers: { authorization: `Bearer ${ingressToken}` }
  });
  const shared = await sharedTokenContext.json<{ context: Parameters<typeof encodeAdmission>[1] }>();
  if (!shared.context) throw new Error("Expected a signed ingress context");
  expect(shared.context.actor).toEqual({ actor_id: "ingress", authority: "ingress_token" });
  const sharedTokenResponse = await stub.fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(tx, shared.context))
  });
  expect(sharedTokenResponse.status).toBe(403);
  expect(mock.files.has(machineTransactionRequestIntentPath(projectId, tx.transaction_id))).toBe(false);
});
