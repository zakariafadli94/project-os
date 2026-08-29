import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createProductionPersistence } from "../../src/persistence/production-factory";
import { schemaWriterStageFor } from "../../src/schema/runtime-policy";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DROPBOX_APP_KEY: "test-app-key",
    DROPBOX_APP_SECRET: "test-app-secret",
    DROPBOX_REFRESH_TOKEN: "test-refresh-token",
    INGRESS_TOKEN: "test-ingress-token",
    PROJECT_OS_SCHEMA_WRITER_STAGE: "core_v2",
    ...overrides
  } as Env;
}

const floorEnv = {
  PROJECT_OS_SCHEMA_CANARY_PROJECT_ID: "PRJ-0006",
  PROJECT_OS_SCHEMA_CORE_V2_FLOOR_PROJECT_IDS: "PRJ-0002,PRJ-0005,PRJ-0006"
} as unknown as Partial<Env>;

describe("production schema canary", () => {
  it("keeps crossed core-v2 projects monotonic while isolating the canary", () => {
    const canaryEnv = env(floorEnv);

    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0006"))).toBe("core_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0002"))).toBe("core_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0005"))).toBe("core_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0003"))).toBe("v1_only");
  });

  it("lets only the selected canary advance to provider-v2 before broad activation", () => {
    const canaryEnv = env({
      ...floorEnv,
      PROJECT_OS_SCHEMA_WRITER_STAGE: "provider_v2"
    });

    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0006"))).toBe("provider_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0002"))).toBe("core_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0005"))).toBe("core_v2");
    expect(schemaWriterStageFor(createProductionPersistence(canaryEnv, "PRJ-0003"))).toBe("v1_only");
  });

  it("allows broad use only when the canary selector is absent", () => {
    const broadEnv = env({ PROJECT_OS_SCHEMA_WRITER_STAGE: "provider_v2" });
    expect(schemaWriterStageFor(createProductionPersistence(broadEnv, "PRJ-0003"))).toBe("provider_v2");
  });
});
