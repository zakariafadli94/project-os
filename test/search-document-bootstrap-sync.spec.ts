import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { documentIdFor } from "../src/domain/managed-document";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T11:20:00+01:00";

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
        name: `Search bootstrap ${slug}`,
        slug,
        aliases: [],
        objective: "Search bootstrap changed document ID proof"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("managed document bootstrap search synchronization", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("reports the adopted document id on the first recursive baseline", async () => {
    const mock = installDropboxMock();
    const created = await createProject("TXN-SEARCH-BOOTSTRAP-0001", "search-bootstrap-one");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const logicalPath = "strategy/legacy.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-search-bootstrap-one/WORKING/${logicalPath}`;
    const documentId = await documentIdFor(created.project_id, logicalPath);
    await mock.writeExternal(visiblePath, "# Legacy\n\nAdopt me");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      baseline: true,
      bootstrapped: 1,
      captured: 0,
      changed_document_ids: [documentId]
    });
  });

  it("reports a newly adopted document id when cursor reset falls back to a recursive baseline", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      }]
    });
    const created = await createProject("TXN-SEARCH-BOOTSTRAP-0002", "search-bootstrap-two");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const initial = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(initial.status).toBe(200);

    const logicalPath = "strategy/reset-legacy.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-search-bootstrap-two/WORKING/${logicalPath}`;
    const documentId = await documentIdFor(created.project_id, logicalPath);
    await mock.writeExternal(visiblePath, "# Reset legacy\n\nAdopt after reset");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cursor_reset: true,
      baseline: true,
      bootstrapped: 1,
      captured: 0,
      changed_document_ids: [documentId]
    });
  });
});
