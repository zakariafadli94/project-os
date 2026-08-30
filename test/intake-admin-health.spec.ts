import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import worker from "../src/index-mutation-gate";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-30T13:40:00.000Z";

async function createProject(): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-INTAKE-HEALTH-ADMIN-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Intake Health Admin",
        slug: "intake-health-admin",
        aliases: [],
        objective: "Prove intake health surfaces"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("intake health admin surfaces", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("exposes one project health snapshot through ProjectGuard without mutating business state", async () => {
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const response = await guard.fetch("https://project-guard.internal/intake-health", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: "1.0",
      project_id: created.project_id,
      pending_count: 0,
      stale_count: 0,
      failed_retryable_count: 0,
      failed_non_retryable_count: 0
    });
  });

  it("requires normal admin ingress authentication and aggregates registry projects", async () => {
    const created = await createProject();

    const denied = await worker.fetch(
      new Request("https://example.com/v1/admin/intake-health"),
      testEnv,
      createExecutionContext()
    );
    expect(denied.status).toBe(401);

    const allowed = await worker.fetch(
      new Request("https://example.com/v1/admin/intake-health", {
        headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
      }),
      testEnv,
      createExecutionContext()
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      projects: expect.arrayContaining([
        expect.objectContaining({
          project_id: created.project_id,
          pending_count: 0,
          stale_count: 0
        })
      ])
    });
  });
});
