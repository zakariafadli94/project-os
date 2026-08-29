import { describe, expect, it } from "vitest";
import {
  assertNoWriterStageRegression,
  assertWriterStageAtLeast,
  parseSchemaWriterStage
} from "../../src/schema/writer-stage";

describe("schema writer stage", () => {
  it("orders writer stages monotonically", () => {
    expect(() => assertWriterStageAtLeast("v1_only", "v1_only")).not.toThrow();
    expect(() => assertWriterStageAtLeast("core_v2", "v1_only")).not.toThrow();
    expect(() => assertWriterStageAtLeast("provider_v2", "core_v2")).not.toThrow();
    expect(() => assertWriterStageAtLeast("v1_only", "core_v2")).toThrow();
    expect(() => assertWriterStageAtLeast("core_v2", "provider_v2")).toThrow();
  });

  it("forbids writer-stage regression", () => {
    expect(() => assertNoWriterStageRegression("v1_only", "core_v2")).not.toThrow();
    expect(() => assertNoWriterStageRegression("core_v2", "provider_v2")).not.toThrow();
    expect(() => assertNoWriterStageRegression("core_v2", "v1_only")).toThrow();
    expect(() => assertNoWriterStageRegression("provider_v2", "core_v2")).toThrow();
  });

  it("defaults an unset writer stage to v1_only and rejects unknown values", () => {
    expect(parseSchemaWriterStage(undefined)).toBe("v1_only");
    expect(parseSchemaWriterStage("")).toBe("v1_only");
    expect(parseSchemaWriterStage("core_v2")).toBe("core_v2");
    expect(() => parseSchemaWriterStage("future_v3")).toThrow(/future_v3/);
  });
});
