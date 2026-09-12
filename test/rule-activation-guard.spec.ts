import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { qualificationEntries, type QualificationEvidence, type RuleQualificationEvidenceResolver } from "../src/rules/qualification";
const testEnv = env as unknown as Env;
beforeEach(() => { installDropboxMock(); });
afterEach(() => vi.restoreAllMocks());

describe("Guard activation qualification", () => {
  const modes = ["missing", "outage", "inexact", "qualified", "missing_check", "unchecked_check"];
  it.each(["project", "global"].flatMap(scope => modes.map(mode => ({ scope, mode }))))("qualifies activation with server-only evidence: $scope / $mode", async ({ scope, mode }) => {
    const project = scope === "global" ? "GLOBAL" : `PRJ-${7201 + modes.indexOf(mode)}`;
    const stub = scope === "global" ? testEnv.REGISTRY_GUARD.getByName(`qualification-${crypto.randomUUID()}`) : testEnv.PROJECT_GUARD.getByName(project);
    if (scope === "global") await runInDurableObject(stub as any, instance => { (instance as unknown as { env: Env }).env.RULE_GOVERNANCE_TOKEN = "qualification-test-only"; });
    // A project guard only accepts its constructor-owned production resolver.
    // Supplying this synthetic resolver therefore tests that it cannot
    // manufacture local authority; it remains useful for Registry cases.
    if (mode !== "missing") await runInDurableObject(stub as any, instance => {
      (instance as unknown as { ruleQualificationResolver: RuleQualificationEvidenceResolver }).ruleQualificationResolver = { resolve: async request => {
        if (mode === "outage") throw new Error("Canonical evidence unavailable");
        const check_evidence: QualificationEvidence["check_evidence"] = mode === "missing_check" ? {} : mode === "unchecked_check" ? { current_version: { status: "unchecked" } } : { current_version: { status: "verified", evidence_ref: "version:qualified", verification_ref: "verification:qualified" } };
        return { active_rules: [], evidence: {
          rule_id: request.rule.rule_id, rule_version: mode === "inexact" ? 99 : request.rule.version, rule_scope: request.rule.scope,
          evidence_refs: request.requested_evidence_refs, accepted_source_refs: request.rule.source_refs, deployed_check_id: "expected_version", deployment_ref: "build:qualified",
          check_evidence,
          entry_coverage: [{ operation: "artifact.write", entries: [...qualificationEntries], evidence_refs: ["coverage:qualified"] }], positive_test_refs: ["test:positive"], negative_test_refs: ["test:negative"], contradiction_scan_ref: "scan:qualified", historical_drift_ref: "drift:qualified",
          qualified_at: request.now, expires_at: new Date(Date.parse(request.now) + 60_000).toISOString()
        } };
      } };
    });
    async function submit(operation: string, payload: unknown, revision: number) {
      return stub.fetch(`https://guard.internal/${scope === "global" ? "governance/transaction" : "transaction"}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer qualification-test-only" },
        body: JSON.stringify(governanceTx(operation, payload, revision, project))
      });
    }
    let base = 0;
    if (scope === "project") {
      expect(await (await submit("project.create", { name: "Qualification", slug: "qualification", objective: "Test", aliases: [] }, 0)).json()).toMatchObject({ status: "committed" });
      base = 1;
    }
    expect(await (await submit("rule.propose", { rule: ruleFixture(project, { operations: ["artifact.write"], check_id: "expected_version", parameters: { required: true } }) }, base)).json()).toMatchObject({ status: "committed" });
    expect(await (await submit("rule.accept", { rule_id: "RULE-7101", version: 1 }, base + 1)).json()).toMatchObject({ status: "committed" });
    const response = await submit("rule.activate", { rule_id: "RULE-7101", version: 1, activation_evidence: ["self-declared:qualified"] }, base + 2);
    const expectedError = scope === "project"
      ? mode === "missing" ? "QUALIFICATION_EVIDENCE_UNAVAILABLE" : "LOCAL_RULE_QUALIFICATION_UNAVAILABLE"
      : mode === "inexact" ? "QUALIFICATION_SCOPE_MISMATCH" : mode === "missing_check" ? "QUALIFICATION_CHECK_EVIDENCE_MISMATCH" : mode === "unchecked_check" ? "QUALIFICATION_CHECK_EVIDENCE_UNAVAILABLE" : "QUALIFICATION_EVIDENCE_UNAVAILABLE";
    expect(response.status).toBe(scope === "project" ? 503 : mode === "qualified" ? 200 : ["inexact", "missing_check"].includes(mode) ? 409 : 503);
    expect(await response.json()).toMatchObject(scope === "global" && mode === "qualified" ? { status: "committed" } : { error: expectedError });
    const status = scope === "global"
      ? (await (await stub.fetch("https://guard.internal/governance")).json() as any).rules["RULE-7101@1"].status
      : await runInDurableObject(stub as any, instance => (instance as any).loadState().local_rules["RULE-7101@1"].status);
    expect(status).toBe(scope === "global" && mode === "qualified" ? "active" : "accepted_unenforced");
  });
});
