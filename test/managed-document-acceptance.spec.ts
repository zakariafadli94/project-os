import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentVersionPath } from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-25T00:55:00+01:00";

async function createProject(): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-MANAGED-ACCEPTANCE-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Managed acceptance",
        slug: "managed-acceptance",
        aliases: [],
        objective: "Prove managed document governance end to end"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function postDocument<T extends Record<string, unknown>>(guard: DurableObjectStub, body: T) {
  const response = await guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json<any>();
}

async function workingWrite(
  guard: DurableObjectStub,
  projectId: string,
  requestId: string,
  content: string,
  expectedVersionId?: string
) {
  return postDocument(guard, {
    operation: "working.write",
    request_id: requestId,
    project_id: projectId,
    logical_path: "strategy/commercial.md",
    content,
    content_sha256: await sha256Text(content),
    ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
    created_at: at
  });
}

describe("managed document governance acceptance", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("supports section-by-section work, human edits, stale conflict, review, publish, reopen and second publish", async () => {
    const mock = installDropboxMock();
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const v1Content = "# Commercial strategy\n\n## ICP\nMid-market";
    const v1 = await workingWrite(guard, created.project_id, "DOCREQ-ACCEPT-WORK-0001", v1Content);
    expect(v1).toMatchObject({ status: "committed", stage: "working" });

    const v2Content = `${v1Content}\n\n## Positioning\nOperational leverage`;
    const v2 = await workingWrite(guard, created.project_id, "DOCREQ-ACCEPT-WORK-0002", v2Content, v1.version_id);
    expect(v2).toMatchObject({ status: "committed", stage: "working", document_id: v1.document_id });

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await baseline.json()).toMatchObject({ baseline: true, conflicts: 0 });

    const workingPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-managed-acceptance/WORKING/strategy/commercial.md`;
    const humanContent = `${v2Content}\n\n## Human note\nKeep enterprise optional`;
    await mock.writeExternal(workingPath, humanContent);

    const capture = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await capture.json()).toMatchObject({ baseline: false, captured: 1, conflicts: 0 });

    const statusAfterHuman = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(v1.document_id)}`,
      { method: "GET" }
    );
    const humanHead = await statusAfterHuman.json<any>();
    expect(humanHead.working_version_id).not.toBe(v2.version_id);

    const stale = await workingWrite(
      guard,
      created.project_id,
      "DOCREQ-ACCEPT-WORK-0003",
      `${v2Content}\n\n## Channels\nOutbound`,
      v2.version_id
    );
    expect(stale).toMatchObject({ status: "conflict", document_id: v1.document_id });
    expect(mock.files.get(workingPath)).toBe(humanContent);

    const aiContent = `${humanContent}\n\n## Channels\nFounder-led outbound`;
    const v4 = await workingWrite(
      guard,
      created.project_id,
      "DOCREQ-ACCEPT-WORK-0004",
      aiContent,
      humanHead.working_version_id
    );
    expect(v4).toMatchObject({ status: "committed", stage: "working" });

    const review = await postDocument(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-ACCEPT-REVIEW-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: v4.version_id,
      created_at: at
    });
    expect(review).toMatchObject({ status: "committed", stage: "review" });

    const candidateContent = `${aiContent}\n\n## Final QA\nApproved structure`;
    const reviewEdit = await postDocument(guard, {
      operation: "review.write",
      request_id: "DOCREQ-ACCEPT-REVIEW-0002",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review.version_id,
      content: candidateContent,
      content_sha256: await sha256Text(candidateContent),
      created_at: at
    });
    expect(reviewEdit).toMatchObject({ status: "committed", stage: "review" });

    const published1 = await postDocument(guard, {
      operation: "publish",
      request_id: "DOCREQ-ACCEPT-PUBLISH-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: reviewEdit.version_id,
      created_at: at
    });
    expect(published1).toMatchObject({ status: "committed", stage: "published" });

    const publishedPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-managed-acceptance/DELIVERABLES/strategy/commercial.md`;
    expect(mock.files.get(publishedPath)).toBe(candidateContent);
    expect(mock.files.has(machineDocumentVersionPath(created.project_id, v1.document_id, published1.version_id))).toBe(true);

    const reopened = await postDocument(guard, {
      operation: "reopen",
      request_id: "DOCREQ-ACCEPT-REOPEN-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: published1.version_id,
      created_at: at
    });
    expect(reopened).toMatchObject({ status: "committed", stage: "working" });
    expect(mock.files.get(publishedPath)).toBe(candidateContent);
    expect(mock.files.get(workingPath)).toBe(candidateContent);

    const iteration2 = `${candidateContent}\n\n## Iteration 2\nPartner channel added`;
    const vNext = await workingWrite(
      guard,
      created.project_id,
      "DOCREQ-ACCEPT-WORK-0005",
      iteration2,
      reopened.version_id
    );
    const review2 = await postDocument(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-ACCEPT-REVIEW-0003",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: vNext.version_id,
      created_at: at
    });
    const published2 = await postDocument(guard, {
      operation: "publish",
      request_id: "DOCREQ-ACCEPT-PUBLISH-0002",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review2.version_id,
      created_at: at
    });

    expect(published2.version_id).not.toBe(published1.version_id);
    expect(mock.files.get(publishedPath)).toBe(iteration2);
    expect(mock.files.has(machineDocumentVersionPath(created.project_id, v1.document_id, published1.version_id))).toBe(true);
    expect(mock.files.has(machineDocumentVersionPath(created.project_id, v1.document_id, published2.version_id))).toBe(true);

    const finalStatus = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(v1.document_id)}`,
      { method: "GET" }
    );
    expect(await finalStatus.json()).toMatchObject({
      document_id: v1.document_id,
      published_version_id: published2.version_id,
      reconciliation_status: "clean"
    });
  });
});
