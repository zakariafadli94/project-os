import { expect, it } from "vitest";
import { issueMutationContext } from "../src/admission/mutation-context";
import {
  localGovernanceAuthorityForTransition,
  LOCAL_GOVERNANCE_ACTOR,
  prepareLocalGovernanceAuthority
} from "../src/domain/local-governance-authority";
import { emptyProjectState } from "../src/domain/transitions";
import { applyTransaction } from "../src/domain/transitions";
import { parseTransaction } from "../src/domain/transaction";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";

const projectId = "PRJ-7641";
const signingKey = "local-governance-authority-test-signing-key";
const nowMs = Date.parse("2026-09-29T12:00:00.000Z");

async function authorizedRuleProposal(actor: { actor_id: string; authority: string } = LOCAL_GOVERNANCE_ACTOR) {
  const state = emptyProjectState(projectId, "Governance", "governance");
  const tx = parseTransaction(governanceTx("rule.propose", { rule: ruleFixture(projectId) }, state.revision, projectId));
  const context = await issueMutationContext(state, signingKey, nowMs, actor);
  return { state, tx, context };
}

it("issues a capability for the dedicated signed authority and exact state/transaction pair", async () => {
  const { state, tx, context } = await authorizedRuleProposal();
  const capability = await prepareLocalGovernanceAuthority(state, tx, context, signingKey, nowMs);

  expect(localGovernanceAuthorityForTransition(capability, state, tx)).toBe(true);
  expect(localGovernanceAuthorityForTransition({}, state, tx)).toBe(false);
  expect(localGovernanceAuthorityForTransition(capability, { ...state, objective: "changed" }, tx)).toBe(false);
  expect(localGovernanceAuthorityForTransition(capability, state, { ...tx, transaction_id: "TXN-RULE-OTHER0001" })).toBe(false);
});

it.each([
  [{ actor_id: "ingress", authority: "ingress_token" }],
  [{ actor_id: "control_tower", authority: "control_tower_operator" }],
  [{ actor_id: "rule_governance", authority: "durable_object" }]
])("rejects ordinary or mismatched signed actors", async actor => {
  const { state, tx, context } = await authorizedRuleProposal(actor);
  await expect(prepareLocalGovernanceAuthority(state, tx, context, signingKey, nowMs))
    .rejects.toThrow("LOCAL_GOVERNANCE_AUTHORITY_REQUIRED");
});

it("rejects a context that is expired or not bound to the transaction revision", async () => {
  const { state, tx } = await authorizedRuleProposal();
  const expiredContext = await issueMutationContext(state, signingKey, nowMs - 300_001, LOCAL_GOVERNANCE_ACTOR);
  await expect(prepareLocalGovernanceAuthority(state, tx, expiredContext, signingKey, nowMs))
    .rejects.toThrow("mutation_context_expired");

  const staleTx = parseTransaction(governanceTx("rule.propose", { rule: ruleFixture(projectId) }, state.revision + 1, projectId));
  const freshContext = await issueMutationContext(state, signingKey, nowMs, LOCAL_GOVERNANCE_ACTOR);
  await expect(prepareLocalGovernanceAuthority(state, staleTx, freshContext, signingKey, nowMs))
    .rejects.toThrow("mutation_context_stale");
});

it("rejects a transaction for another project and non-governance operations", async () => {
  const { state, tx, context } = await authorizedRuleProposal();
  const otherProjectTx = parseTransaction(governanceTx("rule.propose", { rule: ruleFixture("PRJ-7642") }, state.revision, "PRJ-7642"));
  await expect(prepareLocalGovernanceAuthority(state, otherProjectTx, context, signingKey, nowMs))
    .rejects.toThrow("LOCAL_GOVERNANCE_PROJECT_MISMATCH");
  const ordinaryTx = parseTransaction({ ...tx, operation: "task.create", payload: { task_id: "TASK-7641", title: "ordinary" } });
  await expect(prepareLocalGovernanceAuthority(state, ordinaryTx, context, signingKey, nowMs))
    .rejects.toThrow("LOCAL_GOVERNANCE_OPERATION_INVALID");
});

it("refuses local rule changes without a server-issued governance capability", () => {
  const state = emptyProjectState(projectId, "Governance", "governance");
  const tx = parseTransaction(governanceTx("rule.propose", { rule: ruleFixture(projectId) }, state.revision, projectId));

  expect(applyTransaction(state, tx)).toMatchObject({
    kind: "rejected",
    code: "LOCAL_RULE_GOVERNANCE_AUTHORITY_REQUIRED"
  });
});
