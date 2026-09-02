import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env & {
  DROPBOX_CHANGE_GUARD: DurableObjectNamespace;
};

async function createProject(transactionId: string, slug: string): Promise<string> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-02T13:20:00+01:00",
      payload: {
        name: `Inbox single flight ${slug}`,
        slug,
        aliases: [],
        objective: "Prove inbox execution is owned by one durable boundary"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

describe("DropboxChangeGuard inbox ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("processes transaction inbox work through the durable guard boundary", async () => {
    const mock = installDropboxMock();
    const projectId = await createProject("TXN-INBOX-GUARD-PROJECT-0001", "inbox-guard-owner");
    const transactionId = "TXN-INBOX-GUARD-TASK-000001";
    mock.files.set(`/PROJECT_OS/.project-os/transactions/incoming/${transactionId}.json`, JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: "2026-09-02T13:20:01+01:00",
      payload: {
        task_id: "TASK-INBOXGUARD001",
        title: "Durably single-flight inbox work"
      }
    }));

    const response = await testEnv.DROPBOX_CHANGE_GUARD.getByName("global").fetch(
      "https://dropbox-change-guard.internal/process-inbox",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanned: 1, processed: 1, failed: 0 });
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/incoming/${transactionId}.json`)).toBe(false);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${transactionId}.json`)).toBe(true);
  });
});
