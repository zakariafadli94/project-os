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

  it("recovers the allocator above the highest canonical project ID", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1400' WHERE key = 'next_project_number'");
    });

    await createProject("TXN-REGREC-1400-A", "Registry Allocator A", "registry-allocator-a");
    await createProject("TXN-REGREC-1400-B", "Registry Allocator B", "registry-allocator-b");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1399' WHERE key = 'next_project_number'");
    });

    const recoveredRegistry = await stub.fetch("https://registry-guard.internal/registry");
    expect(recoveredRegistry.status).toBe(200);

    const third = await createProject("TXN-REGREC-1400-C", "Registry Allocator C", "registry-allocator-c");
    expect(third.status).toBe("committed");
    expect(third.project_id).toBe("PRJ-1402");
  });

  it("recovers automatically before allocating a new project after local loss", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1500' WHERE key = 'next_project_number'");
    });

    await createProject("TXN-REGREC-1500-A", "Registry Automatic A", "registry-automatic-a");
    await createProject("TXN-REGREC-1500-B", "Registry Automatic B", "registry-automatic-b");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1499' WHERE key = 'next_project_number'");
    });

    const third = await createProject("TXN-REGREC-1500-C", "Registry Automatic C", "registry-automatic-c");
    expect(third.status).toBe("committed");
    expect(third.project_id).toBe("PRJ-1502");
  });

  it("recovers automatically before a project status sync after local loss", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1600' WHERE key = 'next_project_number'");
    });

    const created = await createProject("TXN-REGREC-1600-A", "Registry Status A", "registry-status-a");
    expect(created.status).toBe("committed");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM requests");
      state.storage.sql.exec("DELETE FROM projects");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'next_project_number'");
    });

    const synced = await stub.fetch("https://registry-guard.internal/sync-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: created.project_id, status: "paused", updated_at: "2026-08-23T22:05:00.000Z" })
    });
    expect(synced.status).toBe(200);

    const registryResponse = await stub.fetch("https://registry-guard.internal/registry");
    const registry = await registryResponse.json<{ projects: Array<{ project_id: string; status: string }> }>();
    expect(registry.projects).toContainEqual(expect.objectContaining({
      project_id: created.project_id,
      status: "paused"
    }));
  });

  it("rejects a stale fleet cursor write without replacing the acknowledged wake queue", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    const initialResponse = await stub.fetch("https://registry-guard.internal/convergence-fleet");
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json<{ token: string }>();

    const cursor = {
      schema_version: "1.0" as const,
      after_project_id: "PRJ-0001",
      pending_project_ids: ["PRJ-0002", "PRJ-0003"],
      turn_started_at: "2026-09-09T07:00:00.000Z",
      last_success_at: null
    };
    const accepted = await stub.fetch("https://registry-guard.internal/convergence-fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_token: initial.token, cursor })
    });
    expect(accepted.status).toBe(200);

    const stale = await stub.fetch("https://registry-guard.internal/convergence-fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_token: initial.token, cursor: {
        ...cursor,
        pending_project_ids: []
      } })
    });
    expect(stale.status).toBe(409);

    const currentResponse = await stub.fetch("https://registry-guard.internal/convergence-fleet");
    const current = await currentResponse.json<{ cursor: typeof cursor }>();
    expect(current.cursor.pending_project_ids).toEqual(["PRJ-0002", "PRJ-0003"]);
  });

  it("recovers the fleet cursor from its Dropbox checkpoint after local loss", async () => {
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    const initial = await (await stub.fetch("https://registry-guard.internal/convergence-fleet"))
      .json<{ token: string }>();
    const cursor = {
      schema_version: "1.0" as const,
      after_project_id: "PRJ-0003",
      pending_project_ids: ["PRJ-0004"],
      turn_started_at: "2026-09-09T07:05:00.000Z",
      last_success_at: "2026-09-09T07:05:01.000Z"
    };
    const written = await stub.fetch("https://registry-guard.internal/convergence-fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_token: initial.token, cursor })
    });
    expect(written.status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key IN ('fleet_cursor', 'fleet_cursor_token')");
    });

    const recovered = await (await stub.fetch("https://registry-guard.internal/convergence-fleet"))
      .json<{ cursor: typeof cursor }>();
    expect(recovered.cursor).toEqual(cursor);
  });

  it("reports an external conditional-write race as a fleet cursor conflict", async () => {
    vi.restoreAllMocks();
    installDropboxMock({ faults: [{
      endpoint: "/2/files/upload",
      occurrence: 2,
      status: 409,
      error_summary: "path/conflict/file/",
      path: "/PROJECT_OS/.project-os/convergence/fleet.json"
    }] });
    const stub = testEnv.REGISTRY_GUARD.getByName("global");
    const initial = await (await stub.fetch("https://registry-guard.internal/convergence-fleet"))
      .json<{ token: string }>();
    const cursor = {
      schema_version: "1.0" as const,
      after_project_id: null,
      pending_project_ids: ["PRJ-0001"],
      turn_started_at: "2026-09-09T07:10:00.000Z",
      last_success_at: null
    };
    expect((await stub.fetch("https://registry-guard.internal/convergence-fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_token: initial.token, cursor })
    })).status).toBe(200);

    const current = await (await stub.fetch("https://registry-guard.internal/convergence-fleet"))
      .json<{ token: string }>();
    const raced = await stub.fetch("https://registry-guard.internal/convergence-fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_token: current.token, cursor: {
        ...cursor,
        pending_project_ids: []
      } })
    });
    expect(raced.status).toBe(409);
  });
});
