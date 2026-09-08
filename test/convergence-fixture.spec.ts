import { describe, expect, it } from "vitest";
import { commitFixture } from "./helpers/convergence-fixture";

describe("convergence commit fixture", () => {
  it("builds a contiguous canonical history without relying on a real project", () => {
    const records = commitFixture("PRJ-9258", 3);

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.new_revision)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.event.event_id)).toEqual([
      "EVT-000001",
      "EVT-000002",
      "EVT-000003"
    ]);
    expect(records.every((record) => record.project_id === "PRJ-9258")).toBe(true);
  });
});
