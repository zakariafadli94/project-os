import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import { ExecutionJournal } from "../src/execution/journal";
import { machineTransactionRequestIntentPath } from "../src/persistence/layout";
import { sha256Text } from "../src/documents/hash";
import { qualificationEntries, type RuleQualificationEvidenceResolver } from "../src/rules/qualification";
import { governanceTx, exceptionFixture, ruleAt, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
const testEnv = env as unknown as Env;
let mock: ReturnType<typeof installDropboxMock>;
beforeEach(() => { mock = installDropboxMock(); });
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

it("applies only a live canonical exact exception at the ProjectGuard document boundary", async () => {
  const projectId = `PRJ-${Date.now()}`;
  const otherProjectId = `PRJ-${Date.now() + 1}`;
  const governanceToken = "project-rule-exception-g11-authority";
  const ingressToken = "project-rule-exception-g11-ingress";
  const signingKey = "project-rule-exception-g11-signing-key";
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  const otherGuard = testEnv.PROJECT_GUARD.getByName(otherProjectId);
  const now = () => new Date().toISOString();

  for (const [id, projectGuard] of [[projectId, guard], [otherProjectId, otherGuard]] as const) {
    const created = await projectGuard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: "1.0", transaction_id: `TXN-EXCEPTION-G11-${id.slice(-8)}`,
        project_id: id, base_revision: 0, operation: "project.create", created_at: now(),
        payload: { name: "Exception boundary", slug: `exception-${id.slice(-4)}`, aliases: [], objective: "Exercise exact rule exceptions" } })
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ status: "committed", new_revision: 1 });
    await runInDurableObject(projectGuard, (instance) => Object.assign((instance as any).env, {
      INGRESS_TOKEN: ingressToken,
      MUTATION_CONTEXT_SIGNING_KEY: signingKey,
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [id]: "strict" })
    }));
  }

  const rule = ruleFixture("GLOBAL", {
    rule_id: "RULE-EXCEPTION-G11", operations: ["review.promote", "document.publish"],
    resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
    check_id: "exact_approval", parameters: {}, enforcement: "explicit_approval", check_stage: "pre_admission"
  });
  const probes = (version: number) => rule.operations.flatMap((operation) => qualificationEntries.flatMap((entry) =>
    ["missing", "exact_live", "wrong_actor", "wrong_project", "wrong_rule_version", "wrong_resource_version", "wrong_operation", "expired", "revoked"].map((probeCase) => ({
      check_id: "exact_approval" as const, rule_id: rule.rule_id, rule_version: version, project_id: projectId,
      project_revision: 1, operation, entry, resource_id: "DOC-EXCEPTION-G11", resource_type: "document", zone: "DOCUMENTS",
      resource_version: "VER-REQ-EXCEPTION000000000001", stage: "pre_admission" as const, actor_id: "ingress",
      probe_case: probeCase as "missing" | "exact_live" | "wrong_actor" | "wrong_project" | "wrong_rule_version" | "wrong_resource_version" | "wrong_operation" | "expired" | "revoked",
      verdict: probeCase === "exact_live" ? "allow" as const : "approval_required" as const,
      code: probeCase === "exact_live" ? "EXACT_APPROVAL_VERIFIED" : "EXACT_APPROVAL_REQUIRED",
      evidence_ref: `test:control:${operation}:${entry}:${probeCase}`, probe_source: "ephemeral_evaluator_vector" as const
    }))));
  const qualificationResolver: RuleQualificationEvidenceResolver = {
    async resolve({ rule: activating, requested_evidence_refs, now: qualifiedAt }) {
      return {
        active_rules: [],
        evidence: {
          rule_id: activating.rule_id, rule_version: activating.version, rule_scope: activating.scope,
          evidence_refs: requested_evidence_refs, accepted_source_refs: activating.source_refs,
          deployed_check_id: "exact_approval", deployment_ref: "build:project-rule-exception-g11",
          check_evidence: { exact_server_approval: { status: "verified", evidence_ref: "test:approval", verification_ref: "test:approval-verification" } },
          entry_coverage: activating.operations.map((operation) => ({ operation, entries: [...qualificationEntries], evidence_refs: ["test:entry-coverage"] })),
          positive_test_refs: ["test:exact-live"], negative_test_refs: ["test:approval-required"],
          contradiction_scan_ref: "test:no-conflict", historical_drift_ref: "test:no-drift",
          qualified_at: qualifiedAt, expires_at: new Date(Date.parse(qualifiedAt) + 60_000).toISOString()
        },
        audit: {
          catalogue_version: "test", catalogue_sha256: "a".repeat(64),
          objects: [{ path: "/test/qualification.json", object_id: "test:qualification", revision_token: "test:revision", size: 1 }],
          directories: [], active_rules_sha256: "b".repeat(64), control_probes: probes(activating.version)
        }
      };
    }
  };
  await runInDurableObject(registry, (instance) => Object.assign((instance as any).env, {
    RULE_GOVERNANCE_TOKEN: governanceToken, RULE_ADMISSION_SIGNING_KEY: signingKey
  }));
  await runInDurableObject(registry, (instance) => {
    (instance as any).ruleQualificationResolver = qualificationResolver;
  });

  let governanceRevision = 0;
  const govern = async (operation: string, payload: unknown, createdAt = now()) => {
    const tx = { ...governanceTx(operation, payload, governanceRevision, "GLOBAL"), created_at: createdAt };
    const response = await registry.fetch("https://registry-guard.internal/governance/transaction", {
      method: "POST", headers: { authorization: `Bearer ${governanceToken}`, "content-type": "application/json" }, body: JSON.stringify(tx)
    });
    const receipt = await response.json<{ status: string; new_revision: number; error?: string; code?: string }>();
    expect(response.status).toBe(200);
    expect(receipt.status, JSON.stringify(receipt)).toBe("committed");
    governanceRevision = receipt.new_revision;
    return receipt;
  };
  await govern("rule.propose", { rule });
  await govern("rule.accept", { rule_id: rule.rule_id, version: 1 });
  await govern("rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: ["server:qualified"] });

  const contextFor = async (projectGuard: typeof guard) => {
    const response = await projectGuard.fetch("https://project-guard.internal/mutation-context", {
      headers: { authorization: `Bearer ${ingressToken}` }
    });
    expect(response.status).toBe(200);
    return (await response.json<{ context: Parameters<typeof encodeAdmission>[1] }>()).context;
  };
  const writeWorking = async (id: string, projectGuard: typeof guard) => {
    const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    const content = `exception fixture ${id} ${suffix}`;
    const request = { operation: "working.write", request_id: `DOCREQ-EXCEPTION-G11-W-${suffix}`,
      project_id: id === projectId ? projectId : otherProjectId, logical_path: `exception-${suffix}.md`, content,
      content_sha256: await sha256Text(content), created_at: now() };
    const response = await projectGuard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(request, await contextFor(projectGuard)))
    });
    const receipt = await response.json<{ status: string; document_id: string; version_id: string }>();
    expect(response.status).toBe(200);
    expect(receipt.status).toBe("committed");
    return receipt;
  };
  const promote = async (projectGuard: typeof guard, project: string, documentId: string, suffix: string) => {
    const requestId = `DOCREQ-EXCEPTION-G11-P-${suffix}`;
    const request = { operation: "review.promote", request_id: requestId,
      project_id: project, document_id: documentId, created_at: now() };
    const response = await projectGuard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(request, await contextFor(projectGuard)))
    });
    return { requestId, response, body: await response.json<Record<string, unknown>>() };
  };
  const expectNoReceipt = (requestId: string) => {
    expect([...mock.files.values()].some((raw) => raw.includes(requestId))).toBe(false);
  };
  const expectNoDocumentAdmission = async (projectGuard: typeof guard, project: string, requestId: string) => {
    await runInDurableObject(projectGuard, async (instance, ctx) => {
      const journal = new ExecutionJournal((instance as any).persistence, project, "document", requestId);
      expect(await journal.readAdmission()).toBeNull();
      expect(ctx.storage.sql.exec("SELECT request_id FROM document_requests WHERE request_id = ?", requestId).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT request_id FROM admission_proofs WHERE request_id = ?", requestId).toArray()).toEqual([]);
    });
    expectNoReceipt(requestId);
  };
  const grant = async (version: number, project: string, resourceId: string, operation: string, lifetimeMs = 60_000) => {
    const grantedAt = now();
    const exceptionId = `EXC-G11-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await govern("rule.exception.grant", { exception: exceptionFixture({
      exception_id: exceptionId,
      rule_id: rule.rule_id, rule_version: version, project_id: project,
      resources: [resourceId], operations: [operation], granted_at: grantedAt,
      expires_at: new Date(Date.parse(grantedAt) + lifetimeMs).toISOString()
    }) }, grantedAt);
    return exceptionId;
  };
  const exactDoc = await writeWorking(projectId, guard);
  const exactExceptionId = await grant(1, projectId, exactDoc.document_id, "review.promote");
  const exact = await promote(guard, projectId, exactDoc.document_id, "EXACT");
  expect(exact.response.status).toBe(200);
  expect(exact.body).toMatchObject({ status: "committed", stage: "review" });
  const storedProof = [...mock.files.entries()].map(([path, raw]) => {
    try { return [path, JSON.parse(raw) as Record<string, any>] as const; } catch { return null; }
  }).find((entry) => entry?.[0].includes("/executions/") && entry[0].endsWith("/admission.json")
    && entry[1].admission?.request_id === "DOCREQ-EXCEPTION-G11-P-EXACT");
  expect(storedProof?.[1].admission.results).toContainEqual(expect.objectContaining({
    code: "RULE_EXCEPTION_APPLIED", exception_id: exactExceptionId, evidence_refs: ["DEC-7102"],
    rule: { rule_id: rule.rule_id, version: 1, scope: { kind: "global" } }
  }));

  const operationMismatchId = "DOCREQ-EXCEPTION-G11-PUBLISH-01";
  const writesBeforeOperationMismatch = mock.uploadCalls.length;
  const operationMismatch = await guard.fetch("https://project-guard.internal/document", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission({ operation: "publish", request_id: operationMismatchId,
      project_id: projectId, document_id: exactDoc.document_id, created_at: now() }, await contextFor(guard)))
  });
  expect(operationMismatch.status).toBe(409);
  await expect(operationMismatch.json()).resolves.toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeOperationMismatch);
  await expectNoDocumentAdmission(guard, projectId, operationMismatchId);

  const resourceMismatchDoc = await writeWorking(projectId, guard);
  const resourceMismatchSuffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const writesBeforeResourceMismatch = mock.uploadCalls.length;
  const resourceMismatch = await promote(guard, projectId, resourceMismatchDoc.document_id, resourceMismatchSuffix);
  expect(resourceMismatch.response.status).toBe(409);
  expect(resourceMismatch.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeResourceMismatch);
  await expectNoDocumentAdmission(guard, projectId, resourceMismatch.requestId);

  const projectMismatchDoc = await writeWorking(otherProjectId, otherGuard);
  await grant(1, projectId, projectMismatchDoc.document_id, "review.promote");
  const writesBeforeProjectMismatch = mock.uploadCalls.length;
  const projectMismatch = await promote(otherGuard, otherProjectId, projectMismatchDoc.document_id, "OTHERPROJECT");
  expect(projectMismatch.response.status).toBe(409);
  expect(projectMismatch.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeProjectMismatch);
  await expectNoDocumentAdmission(otherGuard, otherProjectId, projectMismatch.requestId);

  const versionMismatchDoc = await writeWorking(projectId, guard);
  await grant(1, projectId, versionMismatchDoc.document_id, "review.promote");
  const successor = ruleFixture("GLOBAL", { ...rule, version: 2, supersedes: 1 });
  await govern("rule.propose", { rule: successor });
  await govern("rule.accept", { rule_id: successor.rule_id, version: 2 });
  await govern("rule.activate", { rule_id: successor.rule_id, version: 2, activation_evidence: ["server:qualified-v2"] });
  const writesBeforeVersionMismatch = mock.uploadCalls.length;
  const versionMismatch = await promote(guard, projectId, versionMismatchDoc.document_id, "OLDVERSION");
  expect(versionMismatch.response.status).toBe(409);
  expect(versionMismatch.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeVersionMismatch);
  await expectNoDocumentAdmission(guard, projectId, versionMismatch.requestId);

  const expiredDoc = await writeWorking(projectId, guard);
  await grant(2, projectId, expiredDoc.document_id, "review.promote", 500);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const writesBeforeExpired = mock.uploadCalls.length;
  const expired = await promote(guard, projectId, expiredDoc.document_id, "EXPIRED");
  expect(expired.response.status).toBe(409);
  expect(expired.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeExpired);
  await expectNoDocumentAdmission(guard, projectId, expired.requestId);

  const revokedDoc = await writeWorking(projectId, guard);
  const grantedAt = now();
  const revokedException = exceptionFixture({ exception_id: "EXC-G11-REVOKE-0001", rule_id: rule.rule_id,
    rule_version: 2, project_id: projectId, resources: [revokedDoc.document_id], operations: ["review.promote"],
    granted_at: grantedAt, expires_at: new Date(Date.parse(grantedAt) + 60_000).toISOString() });
  await govern("rule.exception.grant", { exception: revokedException }, grantedAt);
  await govern("rule.exception.revoke", { exception_id: revokedException.exception_id, reason: "Test revocation", revoked_by: "test" });
  const writesBeforeRevoked = mock.uploadCalls.length;
  const revoked = await promote(guard, projectId, revokedDoc.document_id, "REVOKED");
  expect(revoked.response.status).toBe(409);
  expect(revoked.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
  expect(mock.uploadCalls).toHaveLength(writesBeforeRevoked);
  await expectNoDocumentAdmission(guard, projectId, revoked.requestId);
});
