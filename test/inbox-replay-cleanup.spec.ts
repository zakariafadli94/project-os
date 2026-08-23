import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

describe("exact inbox replay cleanup", () => {
  let mock: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { mock = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("removes an exact transaction replay from incoming when committed terminal content already matches", async () => {
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-REPLAY-CLEANUP-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-23T00:50:00.000Z",
      payload: { name: "Replay Cleanup Tx", slug: "replay-cleanup-tx", aliases: [], objective: "Verify transaction replay cleanup" }
    };
    const raw = JSON.stringify(transaction);
    const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
    const committed = `/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`;

    mock.files.set(incoming, raw);
    await runScheduled();
    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);

    mock.files.set(incoming, raw);
    await runScheduled();

    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);
  });

  it("removes an exact artifact replay from incoming when committed terminal content already matches", async () => {
    const create = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-REPLAY-CLEANUP-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-08-23T00:50:00.000Z",
        payload: { name: "Replay Cleanup Artifact", slug: "replay-cleanup-artifact", aliases: [], objective: "Verify artifact replay cleanup" }
      })
    }), testEnv, createExecutionContext());
    const project = await create.json<{ project_id: string }>();
    const content = "# replay cleanup";
    const requestId = "ART-REPLAY-CLEANUP-0001";
    const artifact = {
      request_id: requestId,
      project_id: project.project_id,
      relative_path: "ops/replay-cleanup.md",
      content,
      content_sha256: await sha256(content),
      mode: "create"
    };
    const raw = JSON.stringify(artifact);
    const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`;
    const committed = `/PROJECT_OS/.project-os/artifacts/committed/${requestId}.json`;

    mock.files.set(incoming, raw);
    await runScheduled();
    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);

    mock.files.set(incoming, raw);
    await runScheduled();

    expect(mock.files.has(committed)).toBe(true);
    expect(mock.files.has(incoming)).toBe(false);
  });
});
