import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { machineDocumentProviderPayloadPath, machineDocumentVersionPath } from "../src/persistence/layout";
import { documentIdFor } from "../src/domain/managed-document";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-07T20:10:00Z";

async function createProject(transactionId: string) {
  const suffix = transactionId.slice(-4).toLowerCase();
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry.internal/create", {
    method: "POST",
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Promotion ${suffix}`, slug: `promotion-${suffix}`, aliases: [], objective: "Review candidate promotion" }
    })
  });
  return { ...(await response.json<{ project_id: string; new_revision: number }>()), slug: `promotion-${suffix}` };
}

async function committedCandidate(project: { project_id: string; new_revision: number; slug: string }, candidateId: string, mock: ReturnType<typeof installDropboxMock>) {
  const body = "%PDF-1.7\nvalidated candidate\n%%EOF";
  const sourcePath = `/PROJECT_OS/.project-os/artifacts/staging/${candidateId}/fiche.pdf`;
  const source = (await mock.writeExternal(sourcePath, body))!;
  const request = {
    operation: "REVIEW_CANDIDATE" as const,
    request_id: candidateId,
    project_id: project.project_id,
    base_revision: project.new_revision,
    relative_path: "fiche.pdf",
    media_type: "application/pdf" as const,
    content_sha256: await sha256Text(body),
    mode: "create" as const,
    source: {
      kind: "staged_provider_object" as const,
      provider_id: "dropbox",
      path: sourcePath,
      object_id: source.id,
      revision_token: source.rev,
      size: source.size,
      integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
    }
  };
  const guard = testEnv.PROJECT_GUARD.getByName(project.project_id);
  await runInDurableObject(guard, instance => {
    Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE: "scoped",
      PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY: JSON.stringify({
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        requests: [request]
      })
    });
  });
  const response = await guard.fetch("https://project-guard.internal/artifact", { method: "POST", body: JSON.stringify(request) });
  expect(await response.json()).toMatchObject({ status: "committed", accepted: false, published: false });
  return { guard, mock, request, body };
}

describe("governed binary review candidate promotion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes an explicitly accepted candidate as one managed DELIVERABLE and replays from the durable receipt", async () => {
    const mock = installDropboxMock({ realContentHash: true });
    const project = await createProject("TXN-CANDIDATE-PROMOTION-0001");
    const { guard, request, body } = await committedCandidate(project, "ART-REVIEW-PROMOTION-0001", mock);
    const promotion = {
      operation: "review_candidate.promote" as const,
      request_id: "DOCREQ-CANDIDATE-PROMOTE-0001",
      project_id: project.project_id,
      candidate_request_id: request.request_id,
      logical_path: "dg-v2.0/fiche.pdf",
      expected_project_revision: project.new_revision,
      accepted: true as const,
      created_at: at
    };

    const first = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(promotion) });
    const receipt = await first.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      status: "committed",
      stage: "published",
      accepted: true,
      published: true,
      candidate_request_id: request.request_id
    });
    const destination = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/DELIVERABLES/dg-v2.0/fiche.pdf`;
    expect(mock.files.get(destination)).toBe(body);
    expect(mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/REVIEW/CANDIDATES/${request.request_id}/fiche.pdf`)).toBe(true);
    expect(mock.files.has(machineDocumentProviderPayloadPath(project.project_id, receipt.document_id as string, receipt.version_id as string))).toBe(true);

    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests");
    });
    const replay = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(promotion) });
    expect(await replay.json()).toEqual(receipt);
    expect([...mock.files.keys()].filter(path => path === destination)).toHaveLength(1);
  });

  it("rejects a candidate whose frozen provider revision changed before acceptance", async () => {
    const mock = installDropboxMock({ realContentHash: true });
    const project = await createProject("TXN-CANDIDATE-PROMOTION-0002");
    const { guard, request } = await committedCandidate(project, "ART-REVIEW-PROMOTION-0002", mock);
    const candidatePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/REVIEW/CANDIDATES/${request.request_id}/fiche.pdf`;
    await mock.writeExternal(candidatePath, "%PDF-1.7\nchanged\n%%EOF");
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      body: JSON.stringify({
        operation: "review_candidate.promote",
        request_id: "DOCREQ-CANDIDATE-PROMOTE-0002",
        project_id: project.project_id,
        candidate_request_id: request.request_id,
        logical_path: "dg-v2.0/changed.pdf",
        expected_project_revision: project.new_revision,
        accepted: true,
        created_at: at
      })
    });
    expect(await response.json()).toMatchObject({ status: "conflict", code: "CANDIDATE_EVIDENCE_CHANGED" });
  });

  it("rejects a stale project revision and a pre-existing deliverable collision", async () => {
    const mock = installDropboxMock({ realContentHash: true });
    const project = await createProject("TXN-CANDIDATE-PROMOTION-0003");
    const { guard, request, body } = await committedCandidate(project, "ART-REVIEW-PROMOTION-0003", mock);
    const target = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/DELIVERABLES/dg-v2.0/collision.pdf`;
    await mock.writeExternal(target, "%PDF-1.7\npre-existing\n%%EOF");
    const stale = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify({
      operation: "review_candidate.promote", request_id: "DOCREQ-CANDIDATE-PROMOTE-0003A", project_id: project.project_id,
      candidate_request_id: request.request_id, logical_path: "dg-v2.0/stale.pdf", expected_project_revision: project.new_revision + 1, accepted: true, created_at: at
    }) });
    expect(await stale.json()).toMatchObject({ status: "conflict", code: "PROJECT_REVISION_CONFLICT" });
    const collision = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify({
      operation: "review_candidate.promote", request_id: "DOCREQ-CANDIDATE-PROMOTE-0003B", project_id: project.project_id,
      candidate_request_id: request.request_id, logical_path: "dg-v2.0/collision.pdf", expected_project_revision: project.new_revision, accepted: true, created_at: at
    }) });
    expect(await collision.json()).toMatchObject({ status: "conflict", code: "DELIVERABLE_PATH_COLLISION" });
  });

  it("replays after the visible copy succeeds but the version response is lost", async () => {
    const faults: Array<{
      endpoint: string;
      occurrence: number;
      status: number;
      error_summary: string;
      path?: string;
    }> = [];
    const mock = installDropboxMock({ realContentHash: true, faults });
    const project = await createProject("TXN-CANDIDATE-PROMOTION-0004");
    const { guard, request, body } = await committedCandidate(project, "ART-REVIEW-PROMOTION-0004", mock);
    const logicalPath = "dg-v2.0/recovery.pdf";
    const documentId = await documentIdFor(project.project_id, logicalPath);
    const promotionRequestId = "DOCREQ-CANDIDATE-PROMOTE-0004";
    const versionId = `VER-REQ-${(await sha256Text(`${promotionRequestId}\npublished`)).slice(0, 24).toUpperCase()}`;
    faults.push({
      endpoint: "/2/files/upload",
      occurrence: 1,
      status: 409,
      error_summary: "path/conflict/file/injected_version_write",
      path: machineDocumentVersionPath(project.project_id, documentId, versionId)
    });
    const promotion = {
      operation: "review_candidate.promote" as const,
      request_id: promotionRequestId,
      project_id: project.project_id,
      candidate_request_id: request.request_id,
      logical_path: logicalPath,
      expected_project_revision: project.new_revision,
      accepted: true as const,
      created_at: at
    };

    await expect(guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(promotion) }))
      .rejects.toThrow();
    const destination = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/DELIVERABLES/${logicalPath}`;
    expect(mock.files.get(destination)).toBe(body);

    const replay = await guard.fetch("https://project-guard.internal/document", { method: "POST", body: JSON.stringify(promotion) });
    expect(await replay.json()).toMatchObject({ status: "committed", published: true, candidate_request_id: request.request_id });
    expect(mock.files.get(destination)).toBe(body);
  });
});
