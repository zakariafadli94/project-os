import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-21T20:00:00.000Z";

async function createProject(): Promise<Receipt> {
  const stub = testEnv.REGISTRY_GUARD.getByName("global");
  const response = await stub.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-REGISTRY-LIFECYCLE-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: "Lifecycle Sync", slug: "lifecycle-sync", aliases: [], objective: "Test registry lifecycle sync" }
    })
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("registry lifecycle synchronization", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("updates registry/archive dashboard immediately while workspace movement remains projection work", async () => {
    const created = await createProject();
    expect(created.status).toBe("committed");

    const projectStub = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const archivedResponse = await projectStub.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-REGISTRY-LIFECYCLE-0002",
        project_id: created.project_id,
        base_revision: 1,
        operation: "project.archive",
        created_at: at,
        payload: { reason: "Test complete" }
      })
    });
    expect(archivedResponse.status).toBe(200);
    const archived = await archivedResponse.json<Receipt>();
    expect(archived.status).toBe("committed");
    expect(archived.new_revision).toBe(2);

    const registryStub = testEnv.REGISTRY_GUARD.getByName("global");
    const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry");
    const registry = await registryResponse.json<{ projects: Array<{ project_id: string; status: string }> }>();
    expect(registry.projects.find((project) => project.project_id === created.project_id)?.status).toBe("archived");

    const dashboard = dropbox.files.get("/PROJECT_OS/WORKSPACE/PORTFOLIO/DASHBOARD.md");
    expect(dashboard).toContain("## Archived");
    expect(dashboard).toContain(`**${created.project_id}**`);
  });
});
