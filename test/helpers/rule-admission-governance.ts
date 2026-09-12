import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../../src/env";
import { governanceTx, ruleFixture } from "./rule-fixtures";

/**
 * Installs an actual canonical global governance revision for strict-admission
 * transport tests.  The proposed rule remains unenforced, so it establishes
 * governance availability without granting a policy exemption.
 */
export async function bootstrapRuleAdmissionGovernance(testEnv: Env, signingKey: string, projectId?: string): Promise<void> {
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  await runInDurableObject(registry, (instance, ctx) => {
    ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'");
    ctx.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'");
    ctx.storage.sql.exec("DELETE FROM governance_events");
    const bindings = (instance as unknown as { env: Env }).env;
    bindings.RULE_GOVERNANCE_TOKEN = "rule-admission-test-authority";
    bindings.RULE_ADMISSION_SIGNING_KEY = signingKey;
  });
  if (projectId) await runInDurableObject(testEnv.PROJECT_GUARD.getByName(projectId), (instance) => {
    (instance as unknown as { env: Env }).env.RULE_ADMISSION_SIGNING_KEY = signingKey;
  });
  const response = await registry.fetch("https://registry-guard.internal/governance/transaction", {
    method: "POST",
    headers: { authorization: "Bearer rule-admission-test-authority", "content-type": "application/json" },
    body: JSON.stringify(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL"))
  });
  if (!response.ok) throw new Error(`Could not bootstrap canonical rule governance (${response.status})`);
}
