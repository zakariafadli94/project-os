import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createProject(transactionId: string, name: string, slug: string): Promise<string> {
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST",
    headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T07:39:00+01:00",
      payload: { name, slug, aliases: [], objective: "Inbox isolation fixture" }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const receipt = await response.json<{ project_id: string; status: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

describe("inbox entry isolation", () => {
  let mock: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { mock = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("continues with a healthy transaction after a poison entry cleanup conflict", async () => {
    const poisonId = "TXN-AAAA-POISON-000001";
    const poisonIncoming = `/PROJECT_OS/.project-os/transactions/incoming/${poisonId}.json`;
    const poisonRejected = `/PROJECT_OS/.project-os/transactions/rejected/${poisonId}.json`;
    mock.files.set(poisonIncoming, "{not-json");
    mock.files.set(poisonRejected, "different-existing-terminal");

    const healthy = {
      schema_version: "1.0",
      transaction_id: "TXN-ZZZZ-HEALTHY-000001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T07:40:00+01:00",
      payload: {
        name: "Healthy After Poison",
        slug: "healthy-after-poison",
        aliases: [],
        objective: "Prove one poison entry cannot block later inbox work"
      }
    };
    const healthyIncoming = `/PROJECT_OS/.project-os/transactions/incoming/${healthy.transaction_id}.json`;
    const healthyCommitted = `/PROJECT_OS/.project-os/transactions/committed/${healthy.transaction_id}.json`;
    mock.files.set(healthyIncoming, JSON.stringify(healthy));

    await expect(runScheduled()).resolves.toBeUndefined();

    expect(mock.files.has(poisonIncoming)).toBe(true);
    expect(mock.files.has(healthyCommitted)).toBe(true);
    expect(mock.files.has(healthyIncoming)).toBe(false);
  });

  it("continues with a healthy artifact after a poison artifact cleanup conflict", async () => {
    const projectId = await createProject("TXN-ARTISO-PROJECT-000001", "Artifact Isolation", "artifact-isolation");
    const poisonId = "ART-AAAA-POISON-000001";
    const poisonIncoming = `/PROJECT_OS/.project-os/artifacts/incoming/${poisonId}.json`;
    const poisonRejected = `/PROJECT_OS/.project-os/artifacts/rejected/${poisonId}.json`;
    mock.files.set(poisonIncoming, "{not-json");
    mock.files.set(poisonRejected, "different-existing-terminal");

    const content = "# healthy artifact";
    const healthyId = "ART-ZZZZ-HEALTHY-000001";
    const healthy = {
      request_id: healthyId,
      project_id: projectId,
      relative_path: "ops/healthy.md",
      content,
      content_sha256: await sha256(content),
      mode: "create"
    };
    const healthyIncoming = `/PROJECT_OS/.project-os/artifacts/incoming/${healthyId}.json`;
    const healthyCommitted = `/PROJECT_OS/.project-os/artifacts/committed/${healthyId}.json`;
    mock.files.set(healthyIncoming, JSON.stringify(healthy));

    await expect(runScheduled()).resolves.toBeUndefined();

    expect(mock.files.has(poisonIncoming)).toBe(true);
    expect(mock.files.has(healthyCommitted)).toBe(true);
    expect(mock.files.has(healthyIncoming)).toBe(false);
    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-artifact-isolation/ARTIFACTS/ops/healthy.md`)).toBe(content);
  });

  it("processes same-project transactions by revision dependency instead of filename order", async () => {
    const projectId = await createProject("TXN-ORDER-PROJECT-000001", "Inbox Ordering", "inbox-ordering");
    const taskId = "TASK-ORDER0001";
    const createTask = {
      schema_version: "1.0",
      transaction_id: "TXN-ZZZZ-TASKCREATE-000001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: "2026-08-24T07:42:01+01:00",
      payload: { task_id: taskId, title: "Ordered task" }
    };
    const startTask = {
      schema_version: "1.0",
      transaction_id: "TXN-AAAA-TASKSTART-000001",
      project_id: projectId,
      base_revision: 2,
      operation: "task.start",
      created_at: "2026-08-24T07:42:02+01:00",
      payload: { task_id: taskId }
    };
    mock.files.set(`/PROJECT_OS/.project-os/transactions/incoming/${startTask.transaction_id}.json`, JSON.stringify(startTask));
    mock.files.set(`/PROJECT_OS/.project-os/transactions/incoming/${createTask.transaction_id}.json`, JSON.stringify(createTask));

    await runScheduled();

    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${createTask.transaction_id}.json`)).toBe(true);
    expect(mock.files.has(`/PROJECT_OS/.project-os/transactions/committed/${startTask.transaction_id}.json`)).toBe(true);
    expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-inbox-ordering/TASKS/${taskId}.md`)).toContain("Status: active");
  });
});
