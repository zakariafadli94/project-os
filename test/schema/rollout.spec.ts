import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  initializeSchemaRolloutStorage,
  SchemaRolloutState,
  schemaDiagnostic
} from "../../src/schema/rollout";

async function withRollout<T>(projectId: string, fn: (rollout: SchemaRolloutState, storage: DurableObjectStorage) => T | Promise<T>): Promise<T> {
  const stub = env.PROJECT_GUARD.getByName(projectId);
  return runInDurableObject(stub, async (_instance, state) => {
    initializeSchemaRolloutStorage(state.storage);
    return fn(new SchemaRolloutState(state.storage), state.storage);
  });
}

describe("schema rollout frontier", () => {
  it("starts at the V1-only pre-frontier and permits V1-only operation", async () => {
    await withRollout("PRJ-9101", (rollout) => {
      expect(rollout.status()).toEqual({ storage_version: 1, frontier: "v1_only" });
      expect(() => rollout.assertConfiguredStage("v1_only")).not.toThrow();
    });
  });

  it("advances monotonically from core V2 to provider V2 only after explicit durable-write evidence", async () => {
    await withRollout("PRJ-9102", (rollout) => {
      rollout.noteDurableWrite("core_v2");
      expect(rollout.status().frontier).toBe("core_v2");
      rollout.noteDurableWrite("v1_only");
      expect(rollout.status().frontier).toBe("core_v2");
      rollout.noteDurableWrite("provider_v2");
      expect(rollout.status().frontier).toBe("provider_v2");
      rollout.noteDurableWrite("core_v2");
      expect(rollout.status().frontier).toBe("provider_v2");
    });
  });

  it("forbids writer regression after each durable frontier", async () => {
    await withRollout("PRJ-9103", (rollout) => {
      rollout.noteDurableWrite("core_v2");
      expect(() => rollout.assertConfiguredStage("v1_only")).toThrow(/regression|frontier/i);
      expect(() => rollout.assertConfiguredStage("core_v2")).not.toThrow();

      rollout.noteDurableWrite("provider_v2");
      expect(() => rollout.assertConfiguredStage("core_v2")).toThrow(/regression|frontier/i);
      expect(() => rollout.assertConfiguredStage("provider_v2")).not.toThrow();
    });
  });

  it("persists the frontier across new ledger instances without creating business state", async () => {
    const projectId = "PRJ-9104";
    const stub = env.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      initializeSchemaRolloutStorage(state.storage);
      new SchemaRolloutState(state.storage).noteDurableWrite("core_v2");
      const second = new SchemaRolloutState(state.storage);
      expect(second.status()).toEqual({ storage_version: 1, frontier: "core_v2" });
      const businessTables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_state'"
      ).toArray();
      expect(businessTables).toEqual([]);
    });
  });

  it("fails closed on an unknown newer local rollout-storage version", async () => {
    await withRollout("PRJ-9105", (_rollout, storage) => {
      storage.sql.exec("UPDATE schema_rollout_control SET storage_version = 99 WHERE singleton = 1");
      expect(() => new SchemaRolloutState(storage).status()).toThrow(/storage version/i);
    });
  });

  it("emits safe structured diagnostics without raw provider payloads", () => {
    expect(schemaDiagnostic({
      projectId: "PRJ-9106",
      family: "ProjectState",
      encounteredVersion: "2.0",
      semanticVersion: "2.0",
      canonicalRevision: 12,
      deploymentIdentity: "git:abc123",
      failureClass: "writer_stage_regression",
      writerStage: "v1_only",
      frontier: "core_v2"
    })).toEqual({
      project_id: "PRJ-9106",
      family: "ProjectState",
      encountered_version: "2.0",
      semantic_version: "2.0",
      canonical_revision: 12,
      deployment_identity: "git:abc123",
      failure_class: "writer_stage_regression",
      active_writer_stage: "v1_only",
      frontier: "core_v2"
    });
  });
});
