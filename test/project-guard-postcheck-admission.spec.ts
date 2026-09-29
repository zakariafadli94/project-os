import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi, afterEach } from "vitest";
import type { Env } from "../src/env";
import { emptyProjectState } from "../src/domain/transitions";
import { ruleVersionSchema } from "../src/domain/rule-governance";
import { issueRuleAdmissionPermit } from "../src/admission/rule-admission";
import { ruleFixture } from "./helpers/rule-fixtures";

const testEnv = env as unknown as Env;
const projectId = "PRJ-9861";
const signingKey = "postcheck-admission-signing-key";
const hash = "a".repeat(64);
const testSigningKey = "postcheck-public-route-signing-key";
const ingressToken = "postcheck-public-route-ingress-token";
afterEach(() => vi.restoreAllMocks());

async function checkAdmission(check_id: string, check_stage: "post_execution" | "both", enforcement: "automatic" | "explicit_approval", operation = "package.replace") {
  const resource_type = operation === "artifact.write" ? "artifact" : "package";
  const rule = ruleVersionSchema.parse(ruleFixture("GLOBAL", {
    rule_id: "RULE-POSTCHECK-9861", status: "active", operations: [operation],
    resource_scope: { resource_types: [resource_type], zones: ["WORKING"] },
    check_id, parameters: {}, check_stage, enforcement, activation_evidence: ["server:qualified"]
  }));
  const state = emptyProjectState(projectId, "Postcheck", "postcheck");
  state.revision = 4;
  const normalized = {
    project_id: projectId, operation, request_hash: hash,
    resources: [{ resource_id: resource_type === "package" ? "PKG-9861" : "ART-9861", resource_type, zone: "WORKING", version: "1:" + hash }]
  };
  const stub = testEnv.PROJECT_GUARD.getByName(projectId + "-" + check_id + "-" + enforcement);
  return runInDurableObject(stub, async (instance) => {
    const target = instance as any;
    target.env.RULE_ADMISSION_SIGNING_KEY = signingKey;
    target.readGlobalGovernance = async () => ({ revision: 2, rules: { "RULE-POSTCHECK-9861@1": rule }, exceptions: {} });
    target.resolveServerObservations = async () => [];
    const permit = vi.fn(async (input: any) => issueRuleAdmissionPermit(input, signingKey, Date.now()));
    target.requestRulePermit = permit;
    let error: unknown;
    let proof: any;
    try { proof = await target.admitRules(state, normalized); } catch (caught) { error = caught; }
    return { error, proof, permit };
  });
}

it("refuses package approval rules before requesting a permit when a physical check cannot satisfy them", async () => {
  const result = await checkAdmission("verified_archive", "post_execution", "explicit_approval");
  expect(result.error).toMatchObject({ message: "RULE_POSTCHECK_ADAPTER_UNAVAILABLE" });
  expect(result.permit).not.toHaveBeenCalled();
  expect(result.proof).toBeUndefined();
});

it("rejects an artifact postcheck at ProjectGuard admission before permit or any later intent boundary", async () => {
  const result = await checkAdmission("verified_presence", "post_execution", "automatic", "artifact.write");
  expect(result.error).toMatchObject({ message: "RULE_POSTCHECK_ADAPTER_UNAVAILABLE" });
  expect(result.permit).not.toHaveBeenCalled();
  expect(result.proof).toBeUndefined();
});

it("admits only the exact automatic package check/stage tuples with a deferred proof", async () => {
  const result = await checkAdmission("valid_links", "post_execution", "automatic");
  expect(result.error).toBeUndefined();
  expect(result.permit).toHaveBeenCalledTimes(1);
  expect(result.proof).toMatchObject({ verdict: "allow", deferred_rules: [{ rule_id: "RULE-POSTCHECK-9861", version: 1 }] });
});
