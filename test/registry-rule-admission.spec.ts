import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { verifyRuleAdmissionPermit, type RuleAdmissionPermit } from "../src/admission/rule-admission";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
let registryName: string;
const stub = () => testEnv.REGISTRY_GUARD.getByName(registryName);
const input = {
  actor: { actor_id: "project_guard", authority: "internal" },
  project_id: "PRJ-8101",
  operation: "artifact.write",
  resources: [{ resource_id: "ART-81010000", resource_type: "artifact", zone: "DELIVERABLES", version: "a".repeat(64), relative_path: "DELIVERABLES/a.md" }],
  request_hash: "c".repeat(64),
  global_revision: 1,
  ruleset: { digest: "d".repeat(64), rules: [], global_revision: 1, project_revision: 4 }
};

describe("RegistryGuard rule admission", () => {
  beforeEach(() => { installDropboxMock(); registryName = `rule-admission-${crypto.randomUUID()}`; });
  afterEach(() => vi.restoreAllMocks());

  it("issues a short-lived signed permit only for the current global governance revision", async () => {
    const governance = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    await runInDurableObject(stub(), instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      bindings.RULE_GOVERNANCE_TOKEN = "rule-admission-authority";
      bindings.RULE_ADMISSION_SIGNING_KEY = "synthetic-rule-admission-secret-for-vitest-only";
    });
    const activated = await stub().fetch("https://registry-guard.internal/governance/transaction", { method: "POST", headers: { authorization: "Bearer rule-admission-authority", "content-type": "application/json" }, body: JSON.stringify(governance) });
    expect(await activated.json()).toMatchObject({ status: "committed" });

    const response = await stub().fetch("https://registry-guard.internal/rule-admission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    const permit = await response.json<RuleAdmissionPermit>();
    await expect(verifyRuleAdmissionPermit(permit, input, testEnv.RULE_ADMISSION_SIGNING_KEY!, Date.now())).resolves.toBeUndefined();

    const stale = await stub().fetch("https://registry-guard.internal/rule-admission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, global_revision: 0, ruleset: { ...input.ruleset, global_revision: 0 } }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "global_governance_stale" });
  });
});
