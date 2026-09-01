import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T15:30:00+01:00";

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Working Head Integration",
        slug,
        aliases: [],
        objective: "Prove one active working head"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function postDocument(guard: DurableObjectStub, body: Record<string, unknown>) {
  const response = await guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json<any>();
}

async function createWorking(guard: DurableObjectStub, projectId: string, logicalPath: string) {
  const content = "# Architecture V0.1\n\nInitial";
  return postDocument(guard, {
    operation: "working.write",
    request_id: `DOCREQ-WORKHEAD-BASE-${projectId.replace(/\D/g, "").padStart(8, "0")}`,
    project_id: projectId,
    logical_path: logicalPath,
    content,
    content_sha256: await sha256Text(content),
    created_at: at
  });
}

async function supersede(
  guard: DurableObjectStub,
  projectId: string,
  documentId: string,
  expectedVersionId: string,
  requestId: string,
  newLogicalPath: string,
  content = "# Architecture V0.2\n\nReplacement"
) {
  return postDocument(guard, {
    operation: "working.supersede",
    request_id: requestId,
    project_id: projectId,
    document_id: documentId,
    expected_version_id: expectedVersionId,
    new_logical_path: newLogicalPath,
    content,
    content_sha256: await sha256Text(content),
    created_at: at
  });
}

async function deleteExternal(path: string): Promise<void> {
  const response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path })
  });
  expect(response.ok).toBe(true);
}

describe("ProjectGuard one active working head", () => {
  afterEach(() => vi.restoreAllMocks());

  it("supersedes across paths, archives the old head and replays idempotently", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-WORKHEAD-PROJECT-0001", "working-head-one");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const oldLogicalPath = "a02/architecture-v0.1.md";
    const newLogicalPath = "a02/architecture-v0.2.md";
    const v1 = await createWorking(guard, created.project_id, oldLogicalPath);
    expect(v1).toMatchObject({ status: "committed", stage: "working" });

    const requestId = "DOCREQ-WORKHEAD-SUPERSEDE-E2E-0001";
    const v2 = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      requestId,
      newLogicalPath
    );
    expect(v2).toMatchObject({
      status: "committed",
      stage: "working",
      document_id: v1.document_id,
      logical_path: newLogicalPath
    });

    const oldVisible = workspaceManagedDocumentPath(created.project_id, "working-head-one", "working", oldLogicalPath);
    const newVisible = workspaceManagedDocumentPath(created.project_id, "working-head-one", "working", newLogicalPath);
    const archive = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-working-head-one/ARCHIVES/MANAGED-DOCUMENTS/${v1.document_id}/${v1.version_id}/${oldLogicalPath}`;
    expect(mock.files.has(oldVisible)).toBe(false);
    expect(mock.files.get(archive)).toContain("Architecture V0.1");
    expect(mock.files.get(newVisible)).toContain(`document_id: ${v1.document_id}`);

    const replay = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      requestId,
      newLogicalPath
    );
    expect(replay).toEqual(v2);
  });

  it("fails a stale supersede without creating a second working head", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-WORKHEAD-PROJECT-0002", "working-head-two");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const v1 = await createWorking(guard, created.project_id, "a02/architecture-v0.1.md");
    const v2 = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      "DOCREQ-WORKHEAD-SUPERSEDE-E2E-0002",
      "a02/architecture-v0.2.md"
    );
    expect(v2.status).toBe("committed");

    const stale = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      "DOCREQ-WORKHEAD-SUPERSEDE-E2E-STALE",
      "a02/architecture-v0.3.md"
    );
    expect(stale).toMatchObject({ status: "conflict", code: "STALE_DOCUMENT_VERSION" });
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "working-head-two", "working", "a02/architecture-v0.3.md"))).toBe(false);
  });

  it("captures human edits and restores deletion after a path-changing supersede", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-WORKHEAD-PROJECT-0003", "working-head-three");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const oldLogicalPath = "a02/architecture-v0.1.md";
    const newLogicalPath = "a02/architecture-v0.2.md";
    const v1 = await createWorking(guard, created.project_id, oldLogicalPath);
    const v2 = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      "DOCREQ-WORKHEAD-SUPERSEDE-E2E-0003",
      newLogicalPath
    );
    expect(v2.status).toBe("committed");

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const visible = workspaceManagedDocumentPath(created.project_id, "working-head-three", "working", newLogicalPath);
    const managed = mock.files.get(visible)!;
    await mock.writeExternal(visible, `${managed}\n\nHuman edit after supersede`);

    const capture = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(capture.status).toBe(200);
    expect(await capture.json()).toMatchObject({ captured: 1, conflicts: 0 });

    await deleteExternal(visible);
    const restore = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ restored: 1, conflicts: 0 });
    expect(mock.files.get(visible)).toContain("Human edit after supersede");
  });

  it("detects a second visible head carrying the same document identity instead of bootstrapping it", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-WORKHEAD-PROJECT-0004", "working-head-four");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const oldLogicalPath = "a02/architecture-v0.1.md";
    const newLogicalPath = "a02/architecture-v0.2.md";
    const v1 = await createWorking(guard, created.project_id, oldLogicalPath);
    const v2 = await supersede(
      guard,
      created.project_id,
      v1.document_id,
      v1.version_id,
      "DOCREQ-WORKHEAD-SUPERSEDE-E2E-0004",
      newLogicalPath
    );
    expect(v2.status).toBe("committed");

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const duplicatePath = workspaceManagedDocumentPath(created.project_id, "working-head-four", "working", oldLogicalPath);
    await mock.writeExternal(
      duplicatePath,
      `---\nproject_id: ${created.project_id}\ndocument_id: ${v1.document_id}\n---\n# Obsolete head resurrected`
    );

    const reconcile = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(reconcile.status).toBe(200);
    const summary = await reconcile.json<any>();
    expect(summary.conflicts).toBeGreaterThanOrEqual(1);
    expect(summary.candidates).toBeGreaterThanOrEqual(1);

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(v1.document_id)}`,
      { method: "GET" }
    );
    expect(await status.json()).toMatchObject({ logical_path: newLogicalPath, working_version_id: v2.version_id });
  });

  it("keeps explicit parallel forks as distinct governed documents", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-WORKHEAD-PROJECT-0005", "working-head-five");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const source = await createWorking(guard, created.project_id, "a02/architecture.md");
    const forkContent = "# Architecture Option B\n\nParallel branch";
    const fork = await postDocument(guard, {
      operation: "working.fork",
      request_id: "DOCREQ-WORKHEAD-FORK-E2E-0001",
      project_id: created.project_id,
      source_document_id: source.document_id,
      expected_version_id: source.version_id,
      new_logical_path: "a02/architecture-option-b.md",
      content: forkContent,
      content_sha256: await sha256Text(forkContent),
      created_at: at
    });

    expect(fork).toMatchObject({ status: "committed", stage: "working" });
    expect(fork.document_id).not.toBe(source.document_id);
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "working-head-five", "working", "a02/architecture.md"))).toBe(true);
    expect(mock.files.has(workspaceManagedDocumentPath(created.project_id, "working-head-five", "working", "a02/architecture-option-b.md"))).toBe(true);
  });
});