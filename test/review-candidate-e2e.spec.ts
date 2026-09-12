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
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
const testEnv = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
it("qualified canonical REVIEW rule authorizes submission with the legacy capability off", async () => {
  const mock = installDropboxMock({ realContentHash: true });
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const create = await registry.fetch("https://internal/create", { method: "POST", body: JSON.stringify({ schema_version: "1.0", transaction_id: "TXN-REVIEW-RULE-0091", project_id: "PRJ-AUTO", base_revision: 0, operation: "project.create", created_at: "2026-09-12T10:00:00Z", payload: { name: "Governed Review", slug: "governed-review", aliases: [], objective: "Test" } }) });
  const project: any = await create.json();
  const signing = "review-rule-signing-test-only";
  const environment = { ...testEnv, PROJECT_OS_LAYOUT_MODE: "v2", PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [project.project_id]: "strict" }), MUTATION_CONTEXT_SIGNING_KEY: signing, RULE_ADMISSION_SIGNING_KEY: signing } as Env;
  const guard = testEnv.PROJECT_GUARD.getByName(project.project_id);
  await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, { ...environment, PROJECT_OS_MUTATION_GATE_MODE: "observe", PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE: "off", PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY: undefined }));
  await runInDurableObject(registry, (instance) => {
    Object.assign((instance as any).env, { RULE_GOVERNANCE_TOKEN: "review-rule-authority", RULE_ADMISSION_SIGNING_KEY: signing });
    (instance as unknown as { ruleQualificationResolver: RuleQualificationEvidenceResolver }).ruleQualificationResolver = { resolve: async ({ rule, requested_evidence_refs, now }) => ({ active_rules: [], evidence: { rule_id: rule.rule_id, rule_version: rule.version, rule_scope: rule.scope, evidence_refs: requested_evidence_refs, accepted_source_refs: rule.source_refs, deployed_check_id: "expected_version", deployment_ref: "build:review-rule-test", check_evidence: { current_version: { status: "verified", evidence_ref: "canonical:current-version", verification_ref: "verify:current-version" } }, entry_coverage: [{ operation: "artifact.write", entries: [...qualificationEntries], evidence_refs: ["tests:all-entries"] }], positive_test_refs: ["test:positive"], negative_test_refs: ["test:negative"], contradiction_scan_ref: "test:no-conflicts", historical_drift_ref: "test:drift", qualified_at: now, expires_at: new Date(Date.parse(now) + 60000).toISOString() } }) };
  });
  const rule = ruleFixture("GLOBAL", { rule_id: "RULE-REVIEW-0091", operations: ["artifact.write"], resource_scope: { resource_types: ["artifact"], zones: ["REVIEW"] }, check_id: "expected_version", parameters: { required: false } });
  for (const [revision, operation, payload] of [[0, "rule.propose", { rule }], [1, "rule.accept", { rule_id: rule.rule_id, version: 1 }], [2, "rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: ["server:qualified"] }]] as const) {
    const result = await registry.fetch("https://internal/governance/transaction", { method: "POST", headers: { authorization: "Bearer review-rule-authority" }, body: JSON.stringify(governanceTx(operation, payload, revision, "GLOBAL")) });
    expect(await result.json()).toMatchObject({ status: "committed" });
  }
  const requestId = "ART-REVIEW-RULE-0091", content = "%PDF-1.7\nexample\n%%EOF";
  const sourcePath = `/PROJECT_OS/.project-os/artifacts/staging/${requestId}/example.pdf`;
  const source = (await mock.writeExternal(sourcePath, content))!;
  const request = { request_id: requestId, project_id: project.project_id, operation: "REVIEW_CANDIDATE", base_revision: project.new_revision, relative_path: "example.pdf", media_type: "application/pdf", content_sha256: await sha256Text(content), mode: "create", source: { kind: "staged_provider_object", provider_id: "dropbox", path: sourcePath, object_id: source.id, revision_token: source.rev, size: source.size, integrity: { algorithm: "dropbox-content-hash", value: source.content_hash } } };
  const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };
  const contextResponse = await worker.fetch(new Request(`https://example.com/v1/projects/${project.project_id}/mutation-context`, { headers }), environment, createExecutionContext());
  const { context }: any = await contextResponse.json();
  const result = await worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers, body: JSON.stringify(encodeAdmission(request, context)) }), environment, createExecutionContext());
  expect(await result.json()).toMatchObject({ status: "committed", operation: "REVIEW_CANDIDATE", accepted: false, published: false });
  expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-governed-review/REVIEW/CANDIDATES/${requestId}/example.pdf`)).toBe(content);
});
it("commits a review attachment with explicit evidence, no managed head, and exact replay after disablement", async () => {
  const mock = installDropboxMock({realContentHash: true});
  await bootstrapRuleAdmissionGovernance(testEnv, "review-candidate-legacy-governance");
  const created = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://internal/create", {
    method: "POST", body: JSON.stringify({ schema_version: "1.0", transaction_id: "TXN-REVIEW-PROJECT-0001", project_id: "PRJ-AUTO", base_revision: 0,
      operation: "project.create", created_at: "2026-09-07T10:00:00Z", payload: { name: "Review", slug: "review", aliases: [], objective: "Test" } })
  });
  const project = await created.json<{project_id: string; new_revision: number}>();
  const guard = testEnv.PROJECT_GUARD.getByName(project.project_id);
  const requestId = "ART-REVIEW-E2E-0001", text = "%PDF-1.7\nexample\n%%EOF";
  const sourcePath = `/PROJECT_OS/.project-os/artifacts/staging/${requestId}/example.pdf`;
  const source = (await mock.writeExternal(sourcePath, text))!;
  const request = { request_id: requestId, project_id: project.project_id, operation: "REVIEW_CANDIDATE", base_revision: project.new_revision,
    relative_path: "example.pdf", media_type: "application/pdf", content_sha256: await sha256Text(text), mode: "create",
    source: { kind: "staged_provider_object", provider_id: "dropbox", path: sourcePath, object_id: source.id, revision_token: source.rev, size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash } } };
  // Test-only environment injection exercises the actual Durable Object boundary.
  await runInDurableObject(guard, instance => {
    Object.assign((instance as unknown as {env: Env}).env, {
      PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE: "scoped",
      PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY: JSON.stringify({ issued_at: new Date(Date.now()-1000).toISOString(), expires_at: new Date(Date.now()+60000).toISOString(), requests: [request] })
    });
  });
  const response = await guard.fetch("https://internal/artifact", {method: "POST", body: JSON.stringify(request)});
  const receipt = await response.json();
  expect(receipt, JSON.stringify(receipt)).toMatchObject({status: "committed", operation: "REVIEW_CANDIDATE", accepted: false, published: false, final_observation: {provider_id: "dropbox"}});
  const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-review/REVIEW/CANDIDATES/${requestId}/example.pdf`;
  expect(mock.files.get(path)).toBe(text);
  expect(mock.files.has(sourcePath)).toBe(false);
  await guard.fetch("https://internal/reconcile-documents", {method: "POST"});
  expect([...mock.files.keys()].filter(x => x.includes("/documents/heads/"))).toHaveLength(0);
  await runInDurableObject(guard, instance => { (instance as unknown as {env: Env}).env.PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE = "off"; });
  const replay = await guard.fetch("https://internal/artifact", {method: "POST", body: JSON.stringify(request)});
  expect(await replay.json()).toEqual(receipt);
  await runInDurableObject(guard, (_instance, state) => { state.storage.sql.exec("DELETE FROM artifact_requests WHERE request_id = ?", requestId); });
  const publicReplay = await worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers: {authorization: `Bearer ${testEnv.INGRESS_TOKEN}`}, body: JSON.stringify(request) }), testEnv, createExecutionContext());
  expect(await publicReplay.json()).toEqual(receipt);
  mock.files.set(`/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`, JSON.stringify(request));
  const inboxReplay = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {method:"POST", headers:{authorization:`Bearer ${testEnv.INGRESS_TOKEN}`}}), testEnv, createExecutionContext());
  expect(await inboxReplay.json()).toMatchObject({processed:1,failed:0});
});
it("refuses a review request directly at ProjectGuard when no capability exists", async () => {
  installDropboxMock();
  await bootstrapRuleAdmissionGovernance(testEnv, "review-candidate-legacy-governance");
  const {candidate} = await import("./helpers/review-candidate");
  const guard = testEnv.PROJECT_GUARD.getByName("PRJ-0002");
  await runInDurableObject(guard, instance => { (instance as unknown as {env: Env}).env.PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE = "off"; });
  const result = await guard.fetch("https://internal/artifact", {method: "POST", body: JSON.stringify(candidate)});
  expect(await result.json()).toMatchObject({status: "rejected", code: "REVIEW_CANDIDATE_DISABLED"});
});
it("keeps unknown and rejected review submissions external instead of bootstrapping managed heads", async () => {
  const mock = installDropboxMock({realContentHash: true});
  const { emptyProjectState } = await import("../src/domain/transitions");
  const { createProductionPersistence } = await import("../src/persistence/production-factory");
  const { MutationGateClassifier } = await import("../src/mutation-gate/classifier");
  const { ArtifactMutationIntentService } = await import("../src/mutation-gate/artifact-intent");
  const { MutationGateRepository } = await import("../src/mutation-gate/repository");
  const { parseArtifactWriteRequest } = await import("../src/domain/artifact-write");
  const { candidate } = await import("./helpers/review-candidate");
  const state = { ...emptyProjectState("PRJ-0002", "Review", "review", "Test"), revision: 149 };
  const runtime = createProductionPersistence(testEnv);
  const path = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/REVIEW/CANDIDATES/${candidate.request_id}/example.pdf`;
  const metadata = (await mock.writeExternal(path, "%PDF-1.7\nexample\n%%EOF"))!;
  const observation = (await runtime.objects.getMetadata(path))!;
  const classifier = new MutationGateClassifier(runtime);
  expect(await classifier.classify(state, path, observation)).toMatchObject({kind: "external_candidate"});
  const { ProjectRepository } = await import("../src/persistence/repository");
  await expect(new ProjectRepository(runtime, "v2", "observe").writeArtifact(state, parseArtifactWriteRequest({...candidate, source: {...candidate.source, size: metadata.size, integrity: {algorithm:"dropbox-content-hash",value: metadata.content_hash}}}))).rejects.toThrow(/external.*candidate|ungoverned/i);
  const request = parseArtifactWriteRequest({...candidate, source: {...candidate.source, size: metadata.size, integrity: {algorithm:"dropbox-content-hash",value: metadata.content_hash}}});
  await new ArtifactMutationIntentService(new MutationGateRepository(runtime), runtime).prepare(state, request);
  await runtime.objects.createText(`/PROJECT_OS/.project-os/artifacts/receipts/${request.request_id}.json`, JSON.stringify({...request, status:"rejected"}));
  expect(await classifier.classify(state, path, observation)).toMatchObject({kind: "external_candidate"});
});
