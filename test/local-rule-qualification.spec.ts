import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { parseTransaction, type Transaction } from "../src/domain/transaction";
import { applyRuleGovernance, globalGovernanceTransactionSchema } from "../src/domain/rule-governance";
import { eventIdForRevision } from "../src/domain/event";
import { evaluateRules } from "../src/rules/evaluator";
import { createProductionRuleQualificationResolver } from "../src/rules/production-qualification";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { RuleGovernanceRepository } from "../src/persistence/rule-governance-repository";
import { machineCommitRecordPath, machineRegistryJsonPath } from "../src/persistence/layout";
import { readProjectState, encodeProjectState } from "../src/schema/project-state";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { governanceTx, ruleFixture, ruleAt } from "./helpers/rule-fixtures";
import type { ProjectState } from "../src/domain/project-state";

afterEach(() => vi.restoreAllMocks());
const project = "PRJ-9751";
const context = (state: ProjectState) => ({ actor: { actor_id: "server", authority: "guard" }, project_id: project, operation: "artifact.write", expected_project_revision: state.revision, stage: "pre_admission" as const, now: ruleAt, state, global_governance: { revision: 1, rules: {}, exceptions: {} }, resources: [{ resource_id: "ART-LOCAL-QUALIFIED01", resource_type: "artifact", zone: "ARTIFACTS", version: "a".repeat(64), relative_path: "file.md" }], observations: [], approvals: [] });

it.each(["1.0", "2.0"])("keeps legacy %s local activation readable but unavailable to evaluation", async schema_version => {
  const state = emptyProjectState(project, "Local", "local");
  state.local_rules["RULE-LOCAL01@1"] = { ...ruleFixture(project, { rule_id: "RULE-LOCAL01", status: "active", check_id: "allowed_destination", parameters: { allowed_zones: ["ARTIFACTS"] }, operations: ["artifact.write"], resource_scope: { resource_types: ["artifact"], zones: ["ARTIFACTS"] }, activation_evidence: ["legacy:unchecked"] }) } as any;
  const decoded = readProjectState({ ...state, schema_version }).state;
  expect(decoded.local_rules["RULE-LOCAL01@1"].status).toBe("active");
  expect(await evaluateRules(context(decoded))).toMatchObject({ verdict: "unavailable", code: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
});

async function fixture() {
  const mock = installDropboxMock();
  const environment = { ...env, PROJECT_OS_LAYOUT_MODE: "v2", PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [project]: "strict" }), CF_VERSION_METADATA: { id: "local-qualified-build", tag: `git-${"a".repeat(40)}` } } as unknown as Env;
  const runtime = createProductionPersistence(environment);
  const gtx = globalGovernanceTransactionSchema.parse(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL"));
  const global = applyRuleGovernance({ rules: {}, exceptions: {} }, gtx, "GLOBAL");
  if (global.kind !== "commit") throw new Error("global fixture invalid");
  const receipt = (tx: { project_id: string; transaction_id: string; created_at: string }, revision: number) => ({ schema_version: "1.0" as const, project_id: tx.project_id, transaction_id: tx.transaction_id, status: "committed" as const, previous_revision: revision - 1, new_revision: revision, event_id: eventIdForRevision(revision), committed_at: tx.created_at });
  await new RuleGovernanceRepository(runtime).write({ ...global.state, revision: 1, journal: { [gtx.transaction_id]: { transaction: gtx, receipt: receipt(gtx, 1), event: { schema_version: "1.0", event_id: eventIdForRevision(1), project_id: "GLOBAL", revision: 1, transaction_id: gtx.transaction_id, type: gtx.operation, timestamp: gtx.created_at, payload: gtx.payload } } } }, null);
  let state: ProjectState | null = null;
  const transact = async (operation: string, payload: unknown, options?: unknown) => {
    const tx = parseTransaction(governanceTx(operation, payload, state?.revision ?? 0, project));
    const result = (applyTransaction as any)(state, tx, options);
    if (result.kind !== "commit") throw new Error(JSON.stringify(result));
    state = result.state;
    await mock.writeExternal(machineCommitRecordPath(project, state!.revision), JSON.stringify({ schema_version: "1.0", project_id: project, previous_revision: tx.base_revision, new_revision: state!.revision, transaction: tx, state, event: result.event, receipt: receipt(tx, state!.revision) }));
    return { tx, state: state! };
  };
  await transact("project.create", { name: "Local", slug: "local", aliases: [], objective: "Local qualification" });
  await transact("decision.accept", { decision_id: "DEC-LOCAL01", title: "Accepted scope", decision: "WORKING only", reason: "Accepted test source", impacts: [] });
  await transact("artifact.route.configure", { route_id: "ROUTE-LOCAL01", source_prefix: "LOGICAL", target_prefix: "WORKING/files", exclusive: true, decision_ids: ["DEC-LOCAL01"] });
  await mock.writeExternal(machineRegistryJsonPath(), JSON.stringify({ schema_version: "1.0", projects: [{ project_id: project, slug: "local", status: "active" }] }));
  const rule = ruleFixture(project, { rule_id: "RULE-LOCAL01", source_refs: [machineCommitRecordPath(project, 2)], operations: ["artifact.write"], resource_scope: { resource_types: ["artifact"], zones: ["WORKING", "ARTIFACTS"] }, parameters: { allowed_zones: ["WORKING"] } });
  await transact("rule.propose", { rule });
  await transact("rule.accept", { rule_id: rule.rule_id, version: 1 });
  const tx = parseTransaction(governanceTx("rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: [machineCommitRecordPath(project, 5)] }, 5, project));
  return { mock, runtime, rule, state: state!, tx, transact, resolver: createProductionRuleQualificationResolver(runtime, environment) };
}
async function helpers() { return vi.importActual<any>("../src/rules/local-rule-qualification"); }

it("persists a production-qualified local attestation and preserves it through both schema writers", async () => {
  const f = await fixture(), h = await helpers();
  const capability = await h.prepareLocalRuleActivation(f.state, f.tx, f.resolver, ruleAt);
  const result = (applyTransaction as any)(f.state, f.tx, { localRuleActivation: capability });
  expect(result.kind).toBe("commit");
  expect(result.state.local_rule_qualifications["RULE-LOCAL01@1"].qualification.proof.audit).toBeDefined();
  for (const stage of ["v1_only", "core_v2"] as const) {
    const decoded = readProjectState(encodeProjectState(result.state, stage)).state;
    expect(await h.validateLocalRuleAuthority(decoded)).toBeNull();
    expect(await evaluateRules(context(decoded))).toMatchObject({ verdict: "deny", code: "DESTINATION_FORBIDDEN" });
  }
});

it("refuses forged capabilities, transaction reuse and non-production resolvers", async () => {
  const f = await fixture(), h = await helpers();
  await expect(h.prepareLocalRuleActivation(f.state, f.tx, { resolve: async () => null }, ruleAt)).rejects.toThrow("LOCAL_RULE_QUALIFICATION_UNAVAILABLE");
  const capability = await h.prepareLocalRuleActivation(f.state, f.tx, f.resolver, ruleAt);
  for (const [tx, token] of [[{ ...f.tx, transaction_id: "TXN-LOCAL-OTHER-0001" }, capability], [f.tx, JSON.parse(JSON.stringify(capability))]]) {
    expect((applyTransaction as any)(f.state, tx, { localRuleActivation: token })).toMatchObject({ kind: "rejected", code: "LOCAL_RULE_QUALIFICATION_MISMATCH" });
  }
});

it.each(["proof", "rule", "project"])("detects canonical local attestation tampering: %s", async attack => {
  const f = await fixture(), h = await helpers();
  const capability = await h.prepareLocalRuleActivation(f.state, f.tx, f.resolver, ruleAt);
  const result = (applyTransaction as any)(f.state, f.tx, { localRuleActivation: capability });
  const state = structuredClone(result.state);
  if (attack === "proof") state.local_rule_qualifications["RULE-LOCAL01@1"].qualification.proof.evidence.negative_test_refs = ["forged"];
  if (attack === "rule") state.local_rules["RULE-LOCAL01@1"].parameters.allowed_zones = ["ARTIFACTS"];
  if (attack === "project") state.project_id = "PRJ-9752";
  expect(await h.validateLocalRuleAuthority(state)).toMatchObject({ verdict: "unavailable", code: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
});

it("requalifies a successor without granting authority to the historical active version", async () => {
  const f = await fixture(), h = await helpers();
  const legacy = await f.transact("rule.activate", f.tx.payload);
  expect(await h.validateLocalRuleAuthority(legacy.state)).toMatchObject({ code: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
  await f.transact("rule.propose", { rule: { ...f.rule, version: 2, supersedes: 1 } });
  const accepted = await f.transact("rule.accept", { rule_id: f.rule.rule_id, version: 2 });
  const tx = parseTransaction(governanceTx("rule.activate", { rule_id: f.rule.rule_id, version: 2, activation_evidence: [machineCommitRecordPath(project, accepted.state.revision)] }, accepted.state.revision, project));
  const capability = await h.prepareLocalRuleActivation(accepted.state, tx, f.resolver, ruleAt);
  expect((applyTransaction as any)({ ...accepted.state, name: "Changed after qualification" }, tx, { localRuleActivation: capability })).toMatchObject({ kind: "rejected", code: "LOCAL_RULE_QUALIFICATION_MISMATCH" });
  const result = (applyTransaction as any)(accepted.state, tx, { localRuleActivation: capability });
  expect(result.kind).toBe("commit");
  expect(result.state.local_rules["RULE-LOCAL01@1"].status).toBe("superseded");
  expect(result.state.local_rule_qualifications["RULE-LOCAL01@1"]).toBeUndefined();
  expect(await h.validateLocalRuleAuthority(result.state)).toBeNull();
  expect(await evaluateRules(context(result.state))).toMatchObject({ verdict: "deny", code: "DESTINATION_FORBIDDEN" });
});
