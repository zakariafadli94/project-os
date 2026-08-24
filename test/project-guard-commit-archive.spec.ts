import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
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

async function createRegisteredProject(slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-COMMIT-1901-CREATE",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Archive Commit 1901",
        slug,
        aliases: [],
        objective: "Prove archive commit remains replay-safe before projection"
      }
    })
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard crash-safe archive commits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("commits archive exactly once while deferring the physical workspace move to projection", async () => {
    const slug = "archive-commit-1901";
    const archiveTransactionId = "TXN-COMMIT-1901-ARCHIVE";
    const mock = installDropboxMock();

    const created = await createRegisteredProject(slug);
    expect(created.status).toBe("committed");
    expect(created.new_revision).toBe(1);
    const projectId = created.project_id;
    const projectStub = testEnv.PROJECT_GUARD.getByName(projectId);

    expect(await runDurableObjectAlarm(projectStub)).toBe(true);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${archiveProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(false);

    const archiveTransaction = {
      schema_version: "1.0",
      transaction_id: archiveTransactionId,
      project_id: projectId,
      base_revision: 1,
      operation: "project.archive",
      created_at: "2026-08-24T00:26:00.000Z",
      payload: { reason: "Archive crash test" }
    };

    const committed = await submit(projectId, archiveTransaction);
    expect(committed).toMatchObject({
      status: "committed",
      previous_revision: 1,
      new_revision: 2,
      event_id: "EVT-000002"
    });

    expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(true);
    expect(mock.files.has(machineReceiptPath(archiveTransactionId))).toBe(false);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${archiveProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(false);

    const replay = await submit(projectId, archiveTransaction);
    expect(replay).toEqual(committed);
    expect(mock.files.has(machineCommitRecordPath(projectId, 3))).toBe(false);
    expect(mock.files.has(`${workspaceProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${archiveProjectRoot(projectId, slug)}/PROJECT.md`)).toBe(false);
  });
});
