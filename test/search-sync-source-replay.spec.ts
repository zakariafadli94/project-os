import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import type { SearchSyncStatus } from "../src/search/project-sync-store";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-01T12:36:00+01:00";

async function createProject(): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch(
    "https://registry-guard.internal/create",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-SEARCH-SOURCE-REPLAY-CREATE",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: "Search source replay",
          slug: "search-source-replay",
          aliases: [],
          objective: "Prove derived search outbox replay idempotency"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("ProjectGuard search source replay", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("does not enqueue a second document generation for an exact managed-document replay", async () => {
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    // Drain the initial canonical snapshot and generation-1 document snapshot.
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const baselineResponse = await guard.fetch("https://project-guard.internal/search-sync-status");
    expect(baselineResponse.status).toBe(200);
    expect(await baselineResponse.json<SearchSyncStatus>()).toMatchObject({
      document_generation_requested: 1,
      document_generation_indexed: 1
    });

    const content = "# One durable search event";
    const request = {
      operation: "working.write",
      request_id: "DOCREQ-SEARCH-REPLAY-7132",
      project_id: created.project_id,
      logical_path: "search/replay.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(first.status).toBe(200);
    const committed = await first.json<Record<string, unknown>>();
    expect(committed).toMatchObject({ status: "committed", request_id: request.request_id });

    const replay = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(committed);

    const statusResponse = await guard.fetch("https://project-guard.internal/search-sync-status");
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json<SearchSyncStatus>()).toMatchObject({
      document_generation_requested: 2,
      document_generation_indexed: 1
    });
  });
});
