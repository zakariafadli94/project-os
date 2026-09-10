import { describe, expect, it } from "vitest";
import { planProjection } from "../src/materialization/planner";
import { commitFixture } from "./helpers/convergence-fixture";

describe("critical human projection pair", () => {
  it("renders both critical outputs from the same canonical record", async () => {
    const record = commitFixture("PRJ-9987", 258)[257];
    const plan = await planProjection(record, null, 3);
    expect(plan.changed_outputs.get("global:STATE")?.source_revision).toBe(258);
    expect(plan.changed_outputs.get("global:HANDOFF")?.source_revision).toBe(258);
    const critical = [...plan.changed_outputs.values()].filter((output) => output.critical);
    expect(critical.map((output) => output.key).sort()).toEqual(["global:HANDOFF", "global:STATE"]);
  });
});
