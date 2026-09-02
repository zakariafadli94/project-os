import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receipt } from "../src/domain/receipt";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const projectId = "PRJ-1012";
const at = "2026-09-02T14:45:00+01:00";

async function submit(transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    }
  );
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard direct transaction concurrency", () => {
  beforeEach(() => { installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("turns concurrent duplicate direct transactions into one business effect", async () => {
    const created = await submit({
      schema_version: "1.0",
      transaction_id: "TXN-DIRECT-CONCURRENCY-PROJECT-0001",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Direct Concurrency",
        slug: "direct-concurrency",
        aliases: [],
        objective: "Prove direct transaction idempotency under concurrency"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });

    const duplicate = {
      schema_version: "1.0",
      transaction_id: "TXN-DIRECT-CONCURRENCY-TASK-0001",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-DIRECT001", title: "Exactly once" }
    };

    const [first, second] = await Promise.all([
      submit(duplicate),
      submit(duplicate)
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "committed",
      previous_revision: 1,
      new_revision: 2
    });

    const followUp = await submit({
      schema_version: "1.0",
      transaction_id: "TXN-DIRECT-CONCURRENCY-RESEARCH-0001",
      project_id: projectId,
      base_revision: 2,
      operation: "research.add",
      created_at: at,
      payload: {
        research_id: "RES-DIRECT001",
        title: "Follow-up",
        body: "A current-revision mutation still commits after the concurrent duplicate pair."
      }
    });

    expect(followUp).toMatchObject({
      status: "committed",
      previous_revision: 2,
      new_revision: 3
    });
  });
});
