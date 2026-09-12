import worker from "../src/index";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { sha256Text } from "../src/documents/hash";
import { encodeAdmission } from "../src/admission/transport";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { qualificationEntries, type RuleQualificationEvidenceResolver } from "../src/rules/qualification";
import { createControlTowerServer } from "../src/control-tower/mcp";
const testEnv = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
it("applies a WORKING rule to a binary submitted through an accepted logical artifact route", async () => {
  const mock = installDropboxMock({ realContentHash: true });
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const create = await registry.fetch("https://internal/create", { method: "POST", body: JSON.stringify({ schema_version: "1.0", transaction_id: "TXN-ROUTED-RULE-0091", project_id: "PRJ-AUTO", base_revision: 0, operation: "project.create", created_at: "2026-09-12T10:00:00Z", payload: { name: "Routed", slug: "routed", aliases: [], objective: "Test" } }) });
  const project: any = await create.json();
  expect(project.status).toBe("committed");
  const guard = testEnv.PROJECT_GUARD.getByName(project.project_id);
  for (const [revision, operation, payload] of [
    [1, "decision.accept", { decision_id: "DEC-ROUTED0091", title: "Working binary", decision: "Route attachments to WORKING", reason: "accepted fixture", impacts: [] }],
    [2, "artifact.route.configure", { route_id: "ROUTE-ROUTED0091", source_prefix: "LOGICAL-ATTACHMENTS", target_prefix: "WORKING/attachments", exclusive: true, decision_ids: ["DEC-ROUTED0091"] }]
  ] as const) {
    const response = await guard.fetch("https://internal/transaction", { method: "POST", body: JSON.stringify(governanceTx(operation, payload, revision, project.project_id)) });
    expect(await response.json()).toMatchObject({ status: "committed" });
  }
  const signing = "routed-rule-signing-test-only";
  const environment = { ...testEnv, PROJECT_OS_LAYOUT_MODE: "v2", PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "on", PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [project.project_id]: "strict" }), MUTATION_CONTEXT_SIGNING_KEY: signing, RULE_ADMISSION_SIGNING_KEY: signing } as Env;
  await runInDurableObject(guard, instance => Object.assign((instance as any).env, environment));
  await runInDurableObject(registry, instance => {
    Object.assign((instance as any).env, { RULE_GOVERNANCE_TOKEN: "routed-rule-authority", RULE_ADMISSION_SIGNING_KEY: signing });
    (instance as unknown as { ruleQualificationResolver: RuleQualificationEvidenceResolver }).ruleQualificationResolver = { resolve: async ({ rule, requested_evidence_refs, now }) => ({ active_rules: [], evidence: { rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope, evidence_refs: requested_evidence_refs, accepted_source_refs: rule.source_refs, deployed_check_id: "expected_version", deployment_ref: "build:routed-test", check_evidence: { current_version: { status: "verified", evidence_ref: "canonical:current", verification_ref: "verified:current" } }, entry_coverage: [{ operation: "artifact.write", entries: [...qualificationEntries], evidence_refs: ["test:entries"] }], positive_test_refs: ["test:positive"], negative_test_refs: ["test:negative"], contradiction_scan_ref: "test:conflicts", historical_drift_ref: "test:drift", qualified_at: now, expires_at: new Date(Date.parse(now) + 60000).toISOString() } }) };
  });
  const rule = ruleFixture("GLOBAL", { rule_id: "RULE-ROUTED0091", operations: ["artifact.write"], resource_scope: { resource_types: ["artifact"], zones: ["WORKING"] }, check_id: "expected_version", parameters: { required: true } });
  for (const [revision, operation, payload] of [[0, "rule.propose", { rule }], [1, "rule.accept", { rule_id: rule.rule_id, version: 1 }], [2, "rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: ["server:qualified"] }]] as const) {
    const response = await registry.fetch("https://internal/governance/transaction", { method: "POST", headers: { authorization: "Bearer routed-rule-authority" }, body: JSON.stringify(governanceTx(operation, payload, revision, "GLOBAL")) });
    expect(await response.json()).toMatchObject({ status: "committed" });
  }
  const requestId = "ART-ROUTED-RULE-0091", content = "%PDF-1.7\nfixture\n%%EOF";
  const path = `/PROJECT_OS/.project-os/artifacts/staging/${requestId}/attachment.pdf`;
  const source = (await mock.writeExternal(path, content))!;
  const request = { request_id: requestId, project_id: project.project_id, relative_path: "LOGICAL-ATTACHMENTS/attachment.pdf", content_sha256: await sha256Text(content), mode: "create", source: { kind: "staged_provider_object", path, object_id: source.id, revision_token: source.rev, size: source.size, integrity: { algorithm: "dropbox-content-hash", value: source.content_hash } } };
  const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };
  const { context }: any = await (await worker.fetch(new Request(`https://example.com/v1/projects/${project.project_id}/mutation-context`, { headers }), environment, createExecutionContext())).json();
  const result = await worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers, body: JSON.stringify(encodeAdmission(request, context)) }), environment, createExecutionContext());
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ error: "EXPECTED_VERSION_REQUIRED" });
  expect(mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-routed/WORKING/attachments/attachment.pdf`)).toBe(false);
  expect(mock.files.has(path)).toBe(true);
  const direct = await guard.fetch("https://internal/artifact", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) });
  expect(direct.status).toBe(409);
  expect(await direct.json()).toMatchObject({ error: "EXPECTED_VERSION_REQUIRED" });
  const tower = createControlTowerServer(environment as unknown as Parameters<typeof createControlTowerServer>[0]) as any;
  const towerResult = await tower._registeredTools.project_os_submit_artifact.handler({ project_id: project.project_id, request });
  expect(towerResult.isError).toBe(true);
  expect(JSON.parse(towerResult.content[0].text)).toMatchObject({ error: "EXPECTED_VERSION_REQUIRED" });
  expect(mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-routed/WORKING/attachments/attachment.pdf`)).toBe(false);
});
