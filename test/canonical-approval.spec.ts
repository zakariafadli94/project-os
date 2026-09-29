import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { encodeAdmission } from "../src/admission/transport";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { runInDurableObject } from "cloudflare:test";
import { qualificationEntries, type ControlProbe } from "../src/rules/qualification";
import { sha256Text } from "../src/documents/hash";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { normalizeDocumentAdmission } from "../src/admission/operation-context";
import { issueMutationContext } from "../src/admission/mutation-context";
import { prepareApprovalTransition } from "../src/domain/approval";
import { evaluateRules } from "../src/rules/evaluator";
import { machineTransactionRequestIntentPath } from "../src/persistence/layout";

const grant = {
  schema_version: "1.0",
  transaction_id: "TXN-APPROVAL-GRANT-0001",
  project_id: "PRJ-8101",
  base_revision: 0,
  created_at: "2026-09-28T12:00:00.000Z",
  operation: "approval.grant",
  payload: {
    approval_id: "APR-EXACT-0001",
    actor_id: "ingress",
    rule_id: "RULE-PUBLISH-0001",
    rule_version: 1,
    rule_scope: { kind: "global" },
    resource_id: "DOC-0123456789ABCDEF01234567",
    resource_type: "document",
    resource_zone: "DOCUMENTS",
    resource_version: "VER-REQ-0123456789ABCDEF01234567",
    operation: "document.publish",
    expires_at: "2026-09-29T12:00:00.000Z"
  }
};
const testEnv = env as unknown as Env;
const at = "2026-09-29T12:00:00.000Z";

function exactApprovalFixtureProbes(rule: ReturnType<typeof ruleFixture>): ControlProbe[] {
  const cases: Extract<ControlProbe, { check_id: "exact_approval" }>['probe_case'][] = [
    "missing", "exact_live", "wrong_actor", "wrong_project", "wrong_rule_version", "wrong_resource_version", "wrong_operation", "expired", "revoked"
  ];
  return qualificationEntries.flatMap(entry => cases.map(probeCase => ({
    check_id: "exact_approval" as const,
    rule_id: rule.rule_id,
    rule_version: rule.version,
    project_id: "PRJ-8101",
    project_revision: 0,
    operation: "document.publish",
    entry,
    resource_id: "DOC-0123456789ABCDEF01234567",
    resource_type: "document",
    zone: "DOCUMENTS",
    resource_version: "VER-REQ-0123456789ABCDEF01234567",
    stage: "pre_admission" as const,
    verdict: probeCase === "exact_live" ? "allow" as const : "approval_required" as const,
    code: probeCase === "exact_live" ? "EXACT_APPROVAL_VERIFIED" : "EXACT_APPROVAL_REQUIRED",
    evidence_ref: `test:canonical-approval:${entry}:${probeCase}`,
    actor_id: "ingress",
    probe_case: probeCase,
    probe_source: "ephemeral_evaluator_vector" as const
  })));
}

async function submitGovernance(transaction: unknown): Promise<Response> {
  return testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/governance/transaction", {
    method: "POST", headers: { authorization: "Bearer rule-admission-test-authority", "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
}

describe("canonical exact approvals", () => {
  it("accepts typed grant/revoke transactions but never trusts client provenance", () => {
    expect(parseTransaction(grant)).toMatchObject({ operation: "approval.grant", payload: grant.payload });
    expect(() => parseTransaction({
      ...grant,
      payload: { ...grant.payload, approved_by: "client-claimed-founder", granted_at: "2026-09-28T11:00:00.000Z" }
    })).toThrow();
  });

  it("refuses grant transitions without an in-process server authority capability", () => {
    const tx = parseTransaction(grant);
    const result = applyTransaction(emptyProjectState("PRJ-8101", "Approval fixture", "approval-fixture"), tx);
    expect(result).toMatchObject({ kind: "rejected", code: "APPROVAL_AUTHORITY_REQUIRED" });
  });

  it("binds publish admission to the canonical reviewed version when the request omits an expected version", async () => {
    const normalized = await normalizeDocumentAdmission({
      operation: "publish",
      request_id: "DOCREQ-PUBLISH-EXACT-0001",
      project_id: "PRJ-8101",
      document_id: "DOC-0123456789ABCDEF01234567",
      created_at: "2026-09-28T12:00:00.000Z"
    } as any, { canonical_resource_version: "VER-REQ-0123456789ABCDEF01234567" } as any);
    expect(normalized.resources[0]).toMatchObject({
      version: "VER-REQ-0123456789ABCDEF01234567",
      expected_version: "VER-REQ-0123456789ABCDEF01234567"
    });
    expect(normalized.canonical_resource_version).toBe(true);
  });

  it("derives grant and revoke provenance from the signed server actor and persists it in the canonical event", async () => {
    const state = emptyProjectState("PRJ-8101", "Approval fixture", "approval-fixture");
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const secret = "exact-approval-test-signing-key";
    const rule = ruleFixture("GLOBAL", {
      rule_id: "RULE-PUBLISH-0001", status: "active", operations: ["document.publish"],
      resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
      check_id: "exact_approval", enforcement: "explicit_approval", parameters: {}, activation_evidence: ["qualification:approval-test"]
    }) as any;
    const global = { revision: 4, rules: { "RULE-PUBLISH-0001@1": rule }, exceptions: {} } as any;
    const context = await issueMutationContext(state, secret, now, { actor_id: "control_tower", authority: "control_tower_operator" });
    const tx = parseTransaction(grant);
    const capability = await prepareApprovalTransition(state, tx, context, secret, global, now);
    const committed = applyTransaction(state, tx, { approvalTransition: capability });
    expect(committed).toMatchObject({ kind: "commit" });
    if (committed.kind !== "commit") return;
    expect(committed.state.approvals["APR-EXACT-0001"]).toMatchObject({
      approved_by: "control_tower", granted_at: "2026-09-28T12:00:00.000Z", status: "approved",
      evidence_refs: ["canonical:project/PRJ-8101/transaction/TXN-APPROVAL-GRANT-0001"],
      resource_type: "document", resource_zone: "DOCUMENTS"
    });
    expect(committed.event.payload.approval_record).toEqual(committed.state.approvals["APR-EXACT-0001"]);

    const revokeTx = parseTransaction({ ...grant, transaction_id: "TXN-APPROVAL-REVOKE-0001", base_revision: 1,
      operation: "approval.revoke", payload: { approval_id: "APR-EXACT-0001", reason: "Approval withdrawn" } });
    const revokeContext = await issueMutationContext(committed.state, secret, now + 1_000,
      { actor_id: "control_tower", authority: "control_tower_operator" });
    const revokeCapability = await prepareApprovalTransition(committed.state, revokeTx, revokeContext, secret, global, now + 1_000);
    const revoked = applyTransaction(committed.state, revokeTx, { approvalTransition: revokeCapability });
    expect(revoked).toMatchObject({ kind: "commit", state: { approvals: { "APR-EXACT-0001": { status: "revoked", revoked_by: "control_tower", revocation_reason: "Approval withdrawn" } } } });
    if (revoked.kind === "commit") expect(revoked.state.approvals["APR-EXACT-0001"]?.evidence_refs).toEqual(committed.state.approvals["APR-EXACT-0001"]?.evidence_refs);
  });

  it("only admits an approval matching actor, rule, operation, resource type, zone, and immutable version", async () => {
    const state = emptyProjectState("PRJ-8101", "Approval fixture", "approval-fixture");
    const rule = ruleFixture("GLOBAL", { rule_id: "RULE-PUBLISH-0001", status: "active", operations: ["document.publish"],
      resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] }, check_id: "exact_approval", enforcement: "explicit_approval", parameters: {}, activation_evidence: ["qualification:approval-test"] }) as any;
    const record = {
      approval_id: "APR-EXACT-0001", project_id: "PRJ-8101", actor_id: "ingress", approved_by: "control_tower",
      rule_id: "RULE-PUBLISH-0001", rule_version: 1, rule_scope: { kind: "global" },
      resource_id: "DOC-0123456789ABCDEF01234567", resource_type: "document", resource_zone: "DOCUMENTS",
      resource_version: "VER-REQ-0123456789ABCDEF01234567", operation: "document.publish", status: "approved",
      granted_at: "2026-09-28T11:00:00.000Z", expires_at: "2026-09-29T12:00:00.000Z",
      evidence_refs: ["canonical:project/PRJ-8101/transaction/TXN-APPROVAL-GRANT-0001"], grant_transaction_id: "TXN-APPROVAL-GRANT-0001"
    };
    const input = {
      actor: { actor_id: "ingress", authority: "ingress_token" }, project_id: state.project_id, operation: "document.publish",
      expected_project_revision: state.revision, stage: "pre_admission" as const, now: "2026-09-28T12:00:00.000Z", state,
      global_governance: { revision: 4, rules: { "RULE-PUBLISH-0001@1": rule }, exceptions: {} },
      resources: [{ resource_id: record.resource_id, resource_type: "document", zone: "DOCUMENTS", version: record.resource_version }],
      observations: [], approvals: [record]
    };
    const evaluation = await evaluateRules(input);
    expect(evaluation.results[0]).toMatchObject({ verdict: "allow", code: "EXACT_APPROVAL_VERIFIED" });
    expect((await evaluateRules({ ...input, approvals: [{ ...record, resource_zone: "REVIEW" }] })).results[0]).toMatchObject({ verdict: "approval_required" });
    expect((await evaluateRules({ ...input, approvals: [{ ...record, resource_type: "package" }] })).results[0]).toMatchObject({ verdict: "approval_required" });
    expect((await evaluateRules({ ...input, resources: [{ ...input.resources[0], version: "VER-REQ-111111111111111111111111" }] })).results[0]).toMatchObject({ verdict: "approval_required" });
  });

  it("uses the real ProjectGuard transaction boundary for Founder-only grants and refuses publish without a canonical head version", async () => {
    const mock = installDropboxMock();
    const signingKey = "canonical-approval-project-guard-test";
    const operatorToken = "canonical-approval-control-tower-test";
    const ingressToken = "canonical-approval-ingress-test";
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey);
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const exactRule = ruleFixture("GLOBAL", {
      rule_id: "RULE-PUBLISH-EXACT-0001", operations: ["document.publish"],
      resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
      check_id: "exact_approval", enforcement: "explicit_approval", parameters: {}, status: "draft", activation_evidence: []
    });
    const proposed = await submitGovernance(governanceTx("rule.propose", { rule: exactRule }, 1, "GLOBAL"));
    expect(proposed.ok).toBe(true);
    const accepted = await submitGovernance(governanceTx("rule.accept", { rule_id: exactRule.rule_id, version: 1 }, 2, "GLOBAL"));
    expect(accepted.ok).toBe(true);
    await runInDurableObject(registry, instance => {
      (instance as any).ruleQualificationResolver = { resolve: async ({ rule, requested_evidence_refs, now }: any) => ({
        active_rules: [], evidence: {
          rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope,
          evidence_refs: requested_evidence_refs, accepted_source_refs: rule.source_refs,
          deployed_check_id: "exact_approval", deployment_ref: "build:approval-boundary-test",
          check_evidence: { exact_server_approval: { status: "verified", evidence_ref: "canonical:approval-boundary", verification_ref: "verify:approval-boundary" } },
          entry_coverage: [{ operation: "document.publish", entries: [...qualificationEntries], evidence_refs: ["tests:approval-boundary"] }],
          positive_test_refs: ["test:approval-exact-match"], negative_test_refs: ["test:approval-scope-mismatch"],
          contradiction_scan_ref: "test:approval-conflicts", historical_drift_ref: "test:approval-drift",
          qualified_at: now, expires_at: new Date(Date.parse(now) + 60_000).toISOString()
        },
        audit: {
          catalogue_version: "test-only-exact-approval-fixture",
          catalogue_sha256: await sha256Text("test-only-exact-approval-fixture"),
          objects: [{ path: "test:canonical-approval", object_id: "test-object", revision_token: "test-revision", size: 1 }],
          directories: [],
          control_probes: exactApprovalFixtureProbes(rule),
          active_rules_sha256: await sha256Text("[]")
        }
      }) };
    });
    const activated = await submitGovernance(governanceTx("rule.activate", { rule_id: exactRule.rule_id, version: 1, activation_evidence: ["qualification:approval-integration"] }, 3, "GLOBAL"));
    expect(activated.ok, await activated.clone().text()).toBe(true);

    const createdResponse = await registry.fetch("https://registry-guard.internal/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "1.0", transaction_id: "TXN-APPROVAL-PROJECT-0001", project_id: "PRJ-AUTO", base_revision: 0,
        operation: "project.create", created_at: at, payload: { name: "Approval boundary", slug: "approval-boundary", aliases: [], objective: "Boundary fixture" } })
    });
    const created = await createdResponse.json<Receipt>();
    expect(created.status).toBe("committed");
    const projectId = created.project_id;
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, instance => Object.assign((instance as any).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey, RULE_ADMISSION_SIGNING_KEY: signingKey,
      CONTROL_TOWER_OPERATOR_TOKEN: operatorToken, INGRESS_TOKEN: ingressToken,
      INPUT_RECOVERY_OPERATOR_TOKEN: "canonical-approval-recovery-credential",
      MUTATION_GATE_OPERATOR_TOKEN: "canonical-approval-gate-credential",
      RULE_GOVERNANCE_TOKEN: "canonical-approval-governance-credential",
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
    }));

    const getContext = async (token: string) => (await guard.fetch("https://internal/mutation-context", { headers: { authorization: `Bearer ${token}` } })).json<any>();
    const missingHeadContext = (await getContext(ingressToken)).context;
    const missingHeadPublish = {
      operation: "publish", request_id: "DOCREQ-APPROVAL-NO-HEAD-0001", project_id: projectId,
      document_id: "DOC-0123456789ABCDEF01234567", created_at: at
    };
    const missingHeadResponse = await guard.fetch("https://internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(missingHeadPublish as any, missingHeadContext))
    });
    expect([409, 503]).toContain(missingHeadResponse.status);
    expect(await missingHeadResponse.json()).toMatchObject({ error: "EXACT_APPROVAL_RESOURCE_VERSION_UNAVAILABLE" });

    const workingContext = (await getContext(ingressToken)).context;
    const content = "# Exact approval boundary\n";
    const workingResponse = await guard.fetch("https://internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission({ operation: "working.write", request_id: "DOCREQ-APPROVAL-WORK-0001", project_id: projectId,
        logical_path: "approval-boundary.md", content, content_sha256: await sha256Text(content), created_at: at }, workingContext))
    });
    const working = await workingResponse.json<any>();
    expect(working).toMatchObject({ status: "committed", document_id: expect.any(String), version_id: expect.any(String) });
    const reviewContext = (await getContext(ingressToken)).context;
    const reviewResponse = await guard.fetch("https://internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission({ operation: "review.promote", request_id: "DOCREQ-APPROVAL-REVIEW-0001", project_id: projectId,
        document_id: working.document_id, expected_version_id: working.version_id, created_at: at }, reviewContext))
    });
    const review = await reviewResponse.json<any>();
    expect(review, JSON.stringify(review)).toMatchObject({ status: "committed", document_id: working.document_id, version_id: expect.any(String) });
    const status = await guard.fetch(`https://internal/document-status?document_id=${working.document_id}`).then(response => response.json<any>());
    expect(status.review_version_id).toBe(review.version_id);

    const tx = {
      ...grant, project_id: projectId, base_revision: created.new_revision, created_at: at,
      payload: { ...grant.payload, rule_id: exactRule.rule_id, actor_id: "ingress", resource_id: working.document_id,
        resource_version: review.version_id, expires_at: new Date(Date.now() + 86_400_000).toISOString() }
    };
    await runInDurableObject(guard, instance => {
      (instance as any).env.CONTROL_TOWER_OPERATOR_TOKEN = ingressToken;
    });
    const sharedContext = (await getContext(ingressToken)).context;
    expect(sharedContext.actor).toEqual({ actor_id: "ingress", authority: "ingress_token" });
    const sharedTokenGrant = { ...tx, transaction_id: "TXN-APPROVAL-SHARED-TOKEN-0001",
      payload: { ...tx.payload, approval_id: "APR-EXACT-SHARED-0001" } };
    const sharedTokenAttempt = await guard.fetch("https://internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission_version: "1.0", request: sharedTokenGrant, mutation_context: sharedContext })
    });
    expect(sharedTokenAttempt.status).toBe(403);
    expect(await sharedTokenAttempt.json()).toMatchObject({ error: "APPROVAL_AUTHORITY_REQUIRED" });
    expect(mock.files.has(machineTransactionRequestIntentPath(projectId, sharedTokenGrant.transaction_id))).toBe(false);
    expect((await guard.fetch("https://internal/receipt?kind=transaction&request_id=" + sharedTokenGrant.transaction_id + "&project_id=" + projectId)).status).toBe(404);
    for (const lowerCredential of ["canonical-approval-recovery-credential", "canonical-approval-gate-credential",
      "canonical-approval-governance-credential", signingKey]) {
      await runInDurableObject(guard, instance => {
        (instance as any).env.CONTROL_TOWER_OPERATOR_TOKEN = lowerCredential;
      });
      const collisionContext = (await getContext(lowerCredential)).context;
      expect(collisionContext.actor).not.toEqual({ actor_id: "control_tower", authority: "control_tower_operator" });
    }
    await runInDurableObject(guard, instance => {
      (instance as any).env.CONTROL_TOWER_OPERATOR_TOKEN = operatorToken;
    });

    const ingressContext = (await getContext(ingressToken)).context;
    const unauthorized = await guard.fetch("https://internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission_version: "1.0", request: tx, mutation_context: ingressContext })
    });
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({ error: "APPROVAL_AUTHORITY_REQUIRED" });
    expect((await guard.fetch(`https://internal/receipt?kind=transaction&request_id=${tx.transaction_id}&project_id=${projectId}`)).status).toBe(404);

    const founderContext = (await getContext(operatorToken)).context;
    const encoded = { admission_version: "1.0", request: tx, mutation_context: founderContext };
    const committedResponse = await guard.fetch("https://internal/transaction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encoded) });
    const committed = await committedResponse.json<Receipt>();
    expect(committed).toMatchObject({ status: "committed" });
    const grantedState = await getContext(operatorToken);
    expect(grantedState.canonical_state.approvals["APR-EXACT-0001"]).toMatchObject({ approved_by: "control_tower", status: "approved", grant_transaction_id: tx.transaction_id });
    expect(await guard.fetch("https://internal/transaction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encoded) }).then(r => r.json())).toEqual(committed);
    const changedPayload = { ...tx, payload: { ...tx.payload, expires_at: new Date(Date.now() + 172_800_000).toISOString() } };
    const changedReplay = await guard.fetch("https://internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admission_version: "1.0", request: changedPayload, mutation_context: founderContext })
    });
    expect(changedReplay.status).toBe(409);

    const freshContext = (await getContext(ingressToken)).context;
    const publish = {
      operation: "publish", request_id: "DOCREQ-APPROVAL-PUBLISH-0001", project_id: projectId,
      document_id: working.document_id, expected_version_id: review.version_id, created_at: at
    };
    const publishResponse = await guard.fetch("https://internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(publish as any, freshContext))
    });
    expect(await publishResponse.json()).toMatchObject({ status: "committed", document_id: working.document_id, version_id: expect.any(String) });
    const publishedStatus = await guard.fetch(`https://internal/document-status?document_id=${working.document_id}`).then(response => response.json<any>());
    expect(publishedStatus).toMatchObject({ published_version_id: expect.any(String) });
    expect(publishedStatus.review_version_id).toBeUndefined();

    const revokeContext = (await getContext(operatorToken)).context;
    const revokeTx = {
      schema_version: "1.0", transaction_id: "TXN-APPROVAL-REVOKE-PG-0001", project_id: projectId,
      base_revision: committed.new_revision, created_at: at, operation: "approval.revoke",
      payload: { approval_id: "APR-EXACT-0001", reason: "Test revocation" }
    };
    const revokedResponse = await guard.fetch("https://internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission_version: "1.0", request: revokeTx, mutation_context: revokeContext })
    });
    expect(await revokedResponse.json()).toMatchObject({ status: "committed" });
    expect((await getContext(operatorToken)).canonical_state.approvals["APR-EXACT-0001"]).toMatchObject({ status: "revoked", revocation_reason: "Test revocation", grant_transaction_id: tx.transaction_id });
  });
});
