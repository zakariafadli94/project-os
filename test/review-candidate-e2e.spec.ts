import worker from "../src/index";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { sha256Text } from "../src/documents/hash";
const testEnv = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
it("commits a review attachment with explicit evidence, no managed head, and exact replay after disablement", async () => {
  const mock = installDropboxMock({realContentHash: true});
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
