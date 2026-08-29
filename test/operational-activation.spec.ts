import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction } from "../src/domain/transitions";
import { planProjection } from "../src/materialization/planner";
import { renderHandoff } from "../src/render/handoff";
import { OPERATING_CONTRACT_VERSION, renderOperating } from "../src/render/operating";

const at = "2026-08-28T20:45:00+01:00";

function projectRecord(): CanonicalCommitRecord {
  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-ACTIVATION-PROJECT-0001",
    project_id: "PRJ-7001",
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: "Activation Fixture",
      slug: "activation-fixture",
      aliases: [],
      objective: "Prove operational activation"
    }
  });
  const result = applyTransaction(null, transaction);
  if (result.kind !== "commit") throw new Error(`fixture transition failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: "PRJ-7001",
    previous_revision: 0,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: "PRJ-7001",
    previous_revision: 0,
    new_revision: result.state.revision,
    transaction,
    state: result.state,
    event: result.event,
    receipt
  };
}

describe("Operational Activation Contract", () => {
  it("publishes versioned operating rules through HANDOFF and OPERATING", () => {
    const state = projectRecord().state;
    const operating = renderOperating(state);
    const handoff = renderHandoff(state);

    expect(OPERATING_CONTRACT_VERSION).toBe(2);
    expect(operating).toContain("note_id: OPERATING");
    expect(operating).toContain("operating_contract_version: 2");
    expect(operating).toContain("INPUTS/");
    expect(operating).toContain("REFERENCES/UNCLASSIFIED/");
    expect(operating).toContain("WORKING/");
    expect(operating).toContain("REVIEW/");
    expect(operating).toContain("DELIVERABLES/");
    expect(operating).toContain("typed");
    expect(operating).toContain("receipt");

    expect(handoff).toContain("## Operating contract");
    expect(handoff).toContain("Operating contract version: 2");
    expect(handoff).toContain("[[OPERATING|Current operating contract]]");
    expect(handoff).toContain("Sources → INPUTS/ → REFERENCES/");
    expect(handoff).toContain("Drafts → WORKING/ → REVIEW/");
    expect(handoff).toContain("Published → DELIVERABLES/");
    expect(handoff).toContain("Business facts → typed transactions");
  });

  it("uses projection version 2 and includes OPERATING.md in a full projection", async () => {
    const record = projectRecord();
    expect(CURRENT_PROJECTION_VERSION).toBe(2);

    const plan = await planProjection(record, null, CURRENT_PROJECTION_VERSION);
    const operating = plan.changed_outputs.get("global:OPERATING");
    expect(operating?.relative_path).toBe("OPERATING.md");
    expect(operating?.content).toContain("operating_contract_version: 2");
  });

  it("keeps projection v1 byte-contract behavior without OPERATING or the new HANDOFF bootstrap", async () => {
    const record = projectRecord();
    const plan = await planProjection(record, null, 1);

    expect(plan.changed_outputs.has("global:OPERATING")).toBe(false);
    expect(plan.expected_output_keys).not.toContain("global:OPERATING");
    expect(plan.changed_outputs.get("global:HANDOFF")?.content).not.toContain("## Operating contract");
    expect(plan.changed_outputs.get("global:HANDOFF")?.content).not.toContain("[[OPERATING|Current operating contract]]");
  });
});
