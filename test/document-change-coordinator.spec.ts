import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { documentIdFor } from "../src/domain/managed-document";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T23:00:00+01:00";

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
      payload: { name: `Managed ${slug}`, slug, aliases: [], objective: "Managed document change cursor" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function createWorking(projectId: string) {
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  const content = "# Strategy\n\nInitial";
  const response = await guard.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "working.write",
      request_id: `DOCREQ-WORK-${projectId.replace(/\D/g, "").padStart(8, "0")}`,
      project_id: projectId,
      logical_path: "strategy/commercial.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    })
  });
  expect(response.status).toBe(200);
  return response.json<{ document_id: string; version_id: string }>();
}

describe("ProjectGuard managed document change reconciliation", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("lazily adopts a pre-ledger WORKING file on the first recursive baseline without rewriting it", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0000", "doc-change-zero");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const logicalPath = "strategy/legacy.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-zero/WORKING/${logicalPath}`;
    const content = "# Legacy strategy\n\nHuman bytes before managed-document rollout";
    await mock.writeExternal(visiblePath, content);

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);
    expect(await baseline.json()).toMatchObject({ baseline: true, bootstrapped: 1, captured: 0, conflicts: 0 });
    expect(mock.files.get(visiblePath)).toBe(content);
    expect(mock.uploadCalls.filter((path) => path === visiblePath)).toHaveLength(0);

    const documentId = await documentIdFor(created.project_id, logicalPath);
    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      document_id: documentId,
      logical_path: logicalPath,
      reconciliation_status: "clean"
    });
  });

  it("does not bootstrap an unknown DELIVERABLE as published on the first baseline", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0004", "doc-change-four");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const logicalPath = "strategy/direct.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-four/DELIVERABLES/${logicalPath}`;
    await mock.writeExternal(visiblePath, "# ungoverned deliverable");

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await baseline.json()).toMatchObject({ baseline: true, bootstrapped: 0, conflicts: 0 });

    const documentId = await documentIdFor(created.project_id, logicalPath);
    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(404);
    expect(mock.files.get(visiblePath)).toBe("# ungoverned deliverable");
  });

  it("captures only a new WORKING provider revision after the durable baseline cursor", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0001", "doc-change-one");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const document = await createWorking(created.project_id);

    const baselineResponse = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baselineResponse.status).toBe(200);
    expect(await baselineResponse.json()).toMatchObject({ baseline: true, captured: 0, conflicts: 0 });

    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-one/WORKING/strategy/commercial.md`;
    await mock.writeExternal(visiblePath, "# Strategy\n\nHuman edit from Obsidian");

    const incremental = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await incremental.json()).toMatchObject({ baseline: false, captured: 1, conflicts: 0 });

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(document.document_id)}`,
      { method: "GET" }
    );
    const head = await status.json<{ working_version_id: string }>();
    expect(head.working_version_id).not.toBe(document.version_id);

    const replay = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await replay.json()).toMatchObject({ captured: 0, ingested: 0, conflicts: 0 });
  });

  it("ingests a new INPUT into REFERENCES/UNCLASSIFIED and advances the cursor only after success", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0002", "doc-change-two");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const input = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-two/INPUTS/market-report.pdf`;
    await mock.writeExternal(input, "%PDF managed test payload");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await response.json()).toMatchObject({ baseline: false, ingested: 1, duplicates: 0, conflicts: 0 });
    expect(mock.files.has(input)).toBe(false);
    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-two/REFERENCES/UNCLASSIFIED/market-report.pdf`))
      .toBe("%PDF managed test payload");
  });

  it("rebuilds from a recursive baseline when Dropbox invalidates the stored cursor", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      }]
    });
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0003", "doc-change-three");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const document = await createWorking(created.project_id);

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-three/WORKING/strategy/commercial.md`;
    await mock.writeExternal(visiblePath, "# Strategy\n\nEdit surviving cursor reset");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await response.json()).toMatchObject({ cursor_reset: true, baseline: true, captured: 1, conflicts: 0 });

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(document.document_id)}`,
      { method: "GET" }
    );
    const head = await status.json<{ working_version_id: string }>();
    expect(head.working_version_id).not.toBe(document.version_id);
  });

  it("does not bootstrap an unknown DELIVERABLE as published after cursor reset", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      }]
    });
    const created = await createProject("TXN-DOCCHANGE-PROJECT-0005", "doc-change-five");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const logicalPath = "strategy/reset-direct.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-doc-change-five/DELIVERABLES/${logicalPath}`;
    await mock.writeExternal(visiblePath, "# reset bypass");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await response.json()).toMatchObject({ cursor_reset: true, baseline: true, bootstrapped: 0, conflicts: 0 });

    const documentId = await documentIdFor(created.project_id, logicalPath);
    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(404);
    expect(mock.files.get(visiblePath)).toBe("# reset bypass");
  });
});