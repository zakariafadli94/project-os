import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { archiveProjectRoot, machineCommitRecordPath, machineReceiptPath, workspaceProjectRoot } from "../src/dropbox/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-24T00:25:00.000Z";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

async function submitMustFail(projectId: string, transaction: unknown): Promise<void> {
  let failed = false;
  try {
    const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    });
    failed = !response.ok;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe("ProjectGuard crash-safe archive commits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replays an archive whose workspace move succeeded before the standalone receipt failed", async () => {
    const projectId = "PRJ-1901";
    const slug = "archive-commit-1901";
    const archiveTransactionId = "TXN-COMMIT-1901-ARCHIVE";
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: machineReceiptPath(archiveTransactionId),
        occurrence: 1,
        status: 400,
        error_summary: "injected/post_archive_receipt_failure"
      }]
    });

    const created = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1901-CREATE",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Archive Commit 1901",
        slug,
        aliases: [],
        objective: "Prove archive replay is idempotent"
      }
    });
    expect(created.new_revision).toBe(1);

    const archiveTransaction = {
      schema_version: "1.0",
      transaction_id: archiveTransactionId,
      project_id: projectId,
      base_revision: 1,
      operation: "project.archive",
      created_at: "2026-08-24T00:26:00.000Z",
      payload: { reason: "Archive crash test" }
    };

    await submitMustFail(projectId, archiveTransaction);

    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineReceiptPath(archiveTransactionId))).toBe(false);
    expect(mock.files.has(`${archiveProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(false);

    const replay = await submit(projectId, archiveTransaction);
    expect(replay).toMatchObject({
      status: "committed",
      previous_revision: 1,
      new_revision: 2,
      event_id: "EVT-000002"
    });
    expect(mock.files.has(machineReceiptPath(archiveTransactionId))).toBe(true);
    expect(mock.files.has(`${archiveProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(false);
  });
});
