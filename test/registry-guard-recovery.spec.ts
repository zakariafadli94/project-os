import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-23T22:00:00.000Z";

async function createProject(transactionId: string, name: string, slug: string): Promise<Receipt> {
  const stub = testEnv.REGISTRY_GUARD.getByName("global");
  const response = await stub.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name, slug, aliases: [], objective: `Objective for ${name}` }
    })
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("RegistryGuard canonical recovery", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("reconstructs the project registry from canonical Dropbox after local SQLite loss", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1300' WHERE key = 'next_project_number'");
    });

    const first = await createProject("TXN-REGREC-1300-A", "Registry Recovery A", "registry-recovery-a");
    const second = await createProject("TXN-REGREC-1300-B", "Registry Recovery B", "registry-recovery-b");
    expect(first.status).toBe("committed");
    expect(second.status).toBe("committed");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'next_project_number'");
    });

    const response = await stub.fetch("https://registry-guard.internal/registry");
    expect(response.status).toBe(200);
    const registry = await response.json<{ projects: Array<{ project_id: string }> }>();
    expect(registry.projects.map((project) => project.project_id)).toEqual([
      first.project_id,
      second.project_id
    ]);
  });
});
