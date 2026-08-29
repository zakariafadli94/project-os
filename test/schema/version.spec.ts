import { describe, expect, it } from "vitest";
import {
  assertDurableSchemaVersion,
  unsupportedSchemaVersion
} from "../../src/schema/version";

describe("schema version primitives", () => {
  it("accepts only explicitly supported durable schema generations", () => {
    expect(assertDurableSchemaVersion("1.0", "ProjectState")).toBe("1.0");
    expect(assertDurableSchemaVersion("2.0", "ProjectState")).toBe("2.0");
  });

  it("fails closed on unknown future versions", () => {
    expect(() => unsupportedSchemaVersion("ProjectState", "3.0")).toThrow(
      /ProjectState.*3\.0/
    );
    expect(() => assertDurableSchemaVersion("3.0", "ProjectState")).toThrow(
      /ProjectState.*3\.0/
    );
  });

  it("fails closed when a durable version is missing or malformed", () => {
    expect(() => assertDurableSchemaVersion(undefined, "Receipt")).toThrow(
      /Receipt.*missing/
    );
    expect(() => assertDurableSchemaVersion(2, "Receipt")).toThrow(
      /Receipt.*2/
    );
  });
});
