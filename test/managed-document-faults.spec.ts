import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { machineDocumentVersionPath } from "../src/persistence/layout";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-25T01:05:00+01:00";

async function createProject(): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-MANAGED-FAULT-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Managed fault",
        slug: "managed-fault",
        aliases: [],
        objective: "Prove recovery after provider CAS"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function documentCall(guard: DurableObjectStub, body: Record<string, unknown>) {
  return guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function jsonCall(guard: DurableObjectStub, body: Record<string, unknown>) {
  const response = await documentCall(guard, body);
  return response.json<any>();
}

async function workingWrite(
  guard: DurableObjectStub,
  projectId: string,
  requestId: string,
  content: string,
  expectedVersionId?: string
) {
  return jsonCall(guard, {
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

async function publishVersionId(requestId: string): Promise<string> {
  const digest = await sha256Text(`${requestId}\npublished`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

describe("managed document crash recovery", () => {
  let faults: DropboxMockFault[];

  beforeEach(() => { faults = []; });
  afterEach(() => vi.restoreAllMocks());

  it("replays the same publish after Dropbox CAS succeeded but immutable version persistence failed", async () => {
    const mock = installDropboxMock({ faults });
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const v1 = await workingWrite(guard, created.project_id, "DOCREQ-FAULT-WORK-0001", "published v1");
    const review1 = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-FAULT-REVIEW-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: v1.version_id,
      created_at: at
    });
    const published1 = await jsonCall(guard, {
      operation: "publish",
      request_id: "DOCREQ-FAULT-PUBLISH-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review1.version_id,
      created_at: at
    });
    expect(published1.status).toBe("committed");

    const reopened = await jsonCall(guard, {
      operation: "reopen",
      request_id: "DOCREQ-FAULT-REOPEN-0001",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: published1.version_id,
      created_at: at
    });
    const v2 = await workingWrite(
      guard,
      created.project_id,
      "DOCREQ-FAULT-WORK-0002",
      "published v2 after crash",
      reopened.version_id
    );
    const review2 = await jsonCall(guard, {
      operation: "review.promote",
      request_id: "DOCREQ-FAULT-REVIEW-0002",
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: v2.version_id,
      created_at: at
    });

    const publishRequestId = "DOCREQ-FAULT-PUBLISH-0002";
    const expectedPublishedVersionId = await publishVersionId(publishRequestId);
    const versionPath = machineDocumentVersionPath(created.project_id, v1.document_id, expectedPublishedVersionId);
    faults.push({
      endpoint: "/2/files/upload",
      path: versionPath,
      occurrence: 1,
      status: 409,
      error_summary: "path/conflict/file/injected_version_write_after_provider_cas"
    });

    const publishBody = {
      operation: "publish",
      request_id: publishRequestId,
      project_id: created.project_id,
      document_id: v1.document_id,
      expected_version_id: review2.version_id,
      created_at: at
    };

    try {
      await documentCall(guard, publishBody);
    } catch {
      // The injected non-retryable ledger failure is expected to escape the first attempt.
    }

    const publishedPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-managed-fault/DELIVERABLES/strategy/commercial.md`;
    expect(mock.files.get(publishedPath)).toContain("published v2 after crash");
    expect(mock.files.has(versionPath)).toBe(false);

    const replayResponse = await documentCall(guard, publishBody);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      status: "committed",
      document_id: v1.document_id,
      version_id: expectedPublishedVersionId,
      stage: "published"
    });
    expect(mock.files.has(versionPath)).toBe(true);
  });
});
