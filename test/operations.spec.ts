import { describe, expect, it } from "vitest";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { parseTransaction, type Transaction } from "../src/domain/transaction";

const at = "2026-08-20T18:00:00.000Z";
let serial = 0;

function tx<T extends Transaction["operation"]>(projectId: string, baseRevision: number, operation: T, payload: Extract<Transaction, { operation: T }>["payload"]): Transaction {
  serial += 1;
  return {
    schema_version: "1.0",
    transaction_id: `TXN-OPERATIONS-${serial.toString().padStart(8, "0")}`,
    project_id: projectId,
    base_revision: baseRevision,
    operation,
    created_at: at,
    payload
  } as Transaction;
}

function commit(state: ReturnType<typeof emptyProjectState>, transaction: Transaction) {
  const result = applyTransaction(state, transaction);
  expect(result.kind).toBe("commit");
  if (result.kind !== "commit") throw new Error(`Expected commit, got ${result.kind}`);
  return result.state;
}

describe("complete V1 operation surface", () => {
  it("enforces project lifecycle transitions", () => {
    let state = emptyProjectState("PRJ-2001", "Lifecycle", "lifecycle");
    state = commit(state, tx(state.project_id, 0, "project.pause", { reason: "wait" }));
    expect(state.status).toBe("paused");
    state = commit(state, tx(state.project_id, 1, "project.resume", {}));
    expect(state.status).toBe("active");
    state = commit(state, tx(state.project_id, 2, "project.complete", { summary: "done" }));
    expect(state.status).toBe("completed");
    state = commit(state, tx(state.project_id, 3, "project.archive", { reason: "closed" }));
    expect(state.status).toBe("archived");
    expect(applyTransaction(state, tx(state.project_id, 4, "project.resume", {})).kind).toBe("rejected");
  });

  it("preserves superseded decisions rather than deleting history", () => {
    let state = emptyProjectState("PRJ-2002", "Decisions", "decisions");
    state = commit(state, tx(state.project_id, 0, "decision.accept", {
      decision_id: "DEC-2001", title: "Pricing", decision: "5000", reason: "Initial", impacts: []
    }));
    state = commit(state, tx(state.project_id, 1, "decision.accept", {
      decision_id: "DEC-2002", title: "Pricing v2", decision: "7500", reason: "Validated", impacts: []
    }));
    state = commit(state, tx(state.project_id, 2, "decision.supersede", {
      decision_id: "DEC-2001", replacement_decision_id: "DEC-2002", reason: "Replaced"
    }));
    expect(state.decisions["DEC-2001"].status).toBe("superseded");
    expect(state.decisions["DEC-2001"].superseded_by).toBe("DEC-2002");
    expect(state.decisions["DEC-2002"].status).toBe("accepted");
  });

  it("creates, updates and completes plan phases deterministically", () => {
    let state = emptyProjectState("PRJ-2003", "Plan", "plan");
    state = commit(state, tx(state.project_id, 0, "plan.phase.create", { phase_id: "PHASE-2001", title: "Research" }));
    state = commit(state, tx(state.project_id, 1, "plan.phase.create", { phase_id: "PHASE-2002", title: "Launch" }));
    state = commit(state, tx(state.project_id, 2, "plan.phase.update", { phase_id: "PHASE-2001", next_actions: ["Interview users"] }));
    state = commit(state, tx(state.project_id, 3, "plan.phase.complete", { phase_id: "PHASE-2001" }));
    expect(state.plan_phases["PHASE-2001"].status).toBe("completed");
    expect(state.plan_phases["PHASE-2002"].status).toBe("active");
    expect(state.current_phase_id).toBe("PHASE-2002");
    expect(applyTransaction(state, tx(state.project_id, 4, "plan.phase.update", { phase_id: "PHASE-2001", title: "Changed" })).kind).toBe("rejected");
  });

  it("keeps deprecated deliverable operations compatible without inferring acceptance", () => {
    let state = emptyProjectState("PRJ-2004", "Outputs", "outputs");
    state = commit(state, tx(state.project_id, 0, "constraint.add", { constraint_id: "CON-2001", title: "Budget", description: "Low" }));
    expect(applyTransaction(state, tx(state.project_id, 1, "constraint.add", { constraint_id: "CON-2001", title: "Budget", description: "Again" })).kind).toBe("rejected");
    state = commit(state, tx(state.project_id, 1, "deliverable.add", { deliverable_id: "DEL-2001", title: "Report" }));
    expect(state.deliverables["DEL-2001"].status).toBe("planned");
    state = commit(state, tx(state.project_id, 2, "deliverable.complete", { deliverable_id: "DEL-2001", outcome: "Delivered" }));
    expect(state.deliverables["DEL-2001"].status).toBe("legacy_completed");
    expect(state.deliverables["DEL-2001"].acceptance_note).toBeUndefined();
    expect(applyTransaction(state, tx(state.project_id, 3, "deliverable.complete", { deliverable_id: "DEL-2001" })).kind).toBe("rejected");
  });
});

describe("SOP V2 framing and discovery operations", () => {
  it("updates project framing with replacement semantics and exact revision safety", () => {
    let state = emptyProjectState("PRJ-2101", "Framing", "framing", "Initial objective");
    state = commit(state, tx(state.project_id, state.revision, "project.framing.update", {
      objective: "Validated objective",
      scope: ["Agency offer design"],
      success_criteria: ["Offer explicitly validated"],
      stakeholders: ["Owner"]
    }));

    expect(state.objective).toBe("Validated objective");
    expect(state.framing.scope).toEqual(["Agency offer design"]);
    expect(state.framing.success_criteria).toEqual(["Offer explicitly validated"]);
    expect(state.framing.stakeholders).toEqual(["Owner"]);

    const stale = applyTransaction(state, tx(state.project_id, 0, "project.framing.update", { scope: ["Stale"] }));
    expect(stale.kind).toBe("conflict");

    state = commit(state, tx(state.project_id, state.revision, "project.framing.update", { scope: [] }));
    expect(state.framing.scope).toEqual([]);
  });

  it("stores discovery synthesis only when referenced research exists", () => {
    let state = emptyProjectState("PRJ-2102", "Discovery", "discovery");
    state.research["RES-2101"] = {
      research_id: "RES-2101",
      title: "Interviews",
      body: "Evidence",
      created_at: at
    };

    state = commit(state, tx(state.project_id, state.revision, "discovery.synthesis.update", {
      confirmed_findings: [{ summary: "SMBs value speed", research_ids: ["RES-2101"] }],
      provisional_findings: [{ summary: "A niche offer may convert better", research_ids: [] }],
      unresolved_questions: ["Preferred pricing model?"],
      next_exploration: ["Test pricing interviews"]
    }));

    expect(state.discovery.confirmed_findings).toEqual([
      { summary: "SMBs value speed", research_ids: ["RES-2101"] }
    ]);
    expect(state.discovery.unresolved_questions).toEqual(["Preferred pricing model?"]);

    const missing = applyTransaction(state, tx(state.project_id, state.revision, "discovery.synthesis.update", {
      confirmed_findings: [{ summary: "Unsupported finding", research_ids: ["RES-9999"] }]
    }));
    expect(missing.kind).toBe("rejected");

    const stale = applyTransaction(state, tx(state.project_id, 0, "discovery.synthesis.update", {
      unresolved_questions: []
    }));
    expect(stale.kind).toBe("conflict");
  });

  it("rejects empty framing and discovery update payloads", () => {
    const base = {
      schema_version: "1.0" as const,
      project_id: "PRJ-2103",
      base_revision: 0,
      created_at: at
    };

    expect(() => parseTransaction({
      ...base,
      transaction_id: "TXN-EMPTY-FRAMING-0001",
      operation: "project.framing.update",
      payload: {}
    })).toThrow();

    expect(() => parseTransaction({
      ...base,
      transaction_id: "TXN-EMPTY-DISCOVERY-001",
      operation: "discovery.synthesis.update",
      payload: {}
    })).toThrow();
  });
});

describe("SOP V2 deliverable lifecycle", () => {
  it("moves a versioned deliverable through planned, work, review, revision and explicit acceptance", () => {
    let state = emptyProjectState("PRJ-2201", "Deliverables", "deliverables");
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-2201", title: "Delivery"
    }));
    state = commit(state, tx(state.project_id, state.revision, "decision.accept", {
      decision_id: "DEC-2201", title: "Format", decision: "Use report", reason: "Validated", impacts: []
    }));
    state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-2201",
      title: "Strategy report",
      version: "v1",
      phase_id: "PHASE-2201",
      decision_ids: ["DEC-2201"]
    }));
    expect(state.deliverables["DEL-2201"].status).toBe("planned");
    expect(state.deliverables["DEL-2201"].version).toBe("v1");
    expect(state.deliverables["DEL-2201"].decision_ids).toEqual(["DEC-2201"]);

    state = commit(state, tx(state.project_id, state.revision, "deliverable.start", { deliverable_id: "DEL-2201" }));
    expect(state.deliverables["DEL-2201"].status).toBe("in_progress");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.submit_review", { deliverable_id: "DEL-2201" }));
    expect(state.deliverables["DEL-2201"].status).toBe("review");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.revise", {
      deliverable_id: "DEL-2201", version: "v2", description: "Revised after review"
    }));
    expect(state.deliverables["DEL-2201"].status).toBe("in_progress");
    expect(state.deliverables["DEL-2201"].version).toBe("v2");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.submit_review", { deliverable_id: "DEL-2201" }));
    state = commit(state, tx(state.project_id, state.revision, "deliverable.accept", {
      deliverable_id: "DEL-2201", acceptance_note: "Explicitly approved by user"
    }));
    expect(state.deliverables["DEL-2201"].status).toBe("accepted");
    expect(state.deliverables["DEL-2201"].acceptance_note).toBe("Explicitly approved by user");
    expect(state.deliverables["DEL-2201"].accepted_at).toBe(at);
  });

  it("rejects invalid references, stale lifecycle writes and unchanged revisions", () => {
    let state = emptyProjectState("PRJ-2202", "Validation", "validation");

    const missingPhase = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-2202", title: "Bad", version: "v1", phase_id: "PHASE-9999"
    }));
    expect(missingPhase.kind).toBe("rejected");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-2202", title: "Good", version: "v1"
    }));
    const stale = applyTransaction(state, tx(state.project_id, 0, "deliverable.start", { deliverable_id: "DEL-2202" }));
    expect(stale.kind).toBe("conflict");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.start", { deliverable_id: "DEL-2202" }));
    const sameVersion = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.revise", {
      deliverable_id: "DEL-2202", version: "v1"
    }));
    expect(sameVersion.kind).toBe("rejected");
  });

  it("preserves accepted deliverable history through explicit supersession", () => {
    let state = emptyProjectState("PRJ-2203", "Supersession", "supersession");

    for (const [id, title] of [["DEL-2203", "Report v1"], ["DEL-2204", "Report v2"]] as const) {
      state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
        deliverable_id: id, title, version: "v1"
      }));
      state = commit(state, tx(state.project_id, state.revision, "deliverable.start", { deliverable_id: id }));
      state = commit(state, tx(state.project_id, state.revision, "deliverable.submit_review", { deliverable_id: id }));
      state = commit(state, tx(state.project_id, state.revision, "deliverable.accept", {
        deliverable_id: id, acceptance_note: `Approved ${id}`
      }));
    }

    state = commit(state, tx(state.project_id, state.revision, "deliverable.supersede", {
      deliverable_id: "DEL-2203", replacement_deliverable_id: "DEL-2204", reason: "New accepted version"
    }));

    expect(state.deliverables["DEL-2203"].status).toBe("superseded");
    expect(state.deliverables["DEL-2203"].superseded_by).toBe("DEL-2204");
    expect(state.deliverables["DEL-2203"].superseded_reason).toBe("New accepted version");
    expect(state.deliverables["DEL-2204"].status).toBe("accepted");
  });

  it("abandons only non-accepted work and can explicitly accept legacy completed output", () => {
    let state = emptyProjectState("PRJ-2204", "Terminal states", "terminal-states");
    state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-2205", title: "Discarded", version: "v1"
    }));
    state = commit(state, tx(state.project_id, state.revision, "deliverable.abandon", {
      deliverable_id: "DEL-2205", reason: "No longer needed"
    }));
    expect(state.deliverables["DEL-2205"].status).toBe("abandoned");
    expect(state.deliverables["DEL-2205"].abandoned_reason).toBe("No longer needed");

    state = commit(state, tx(state.project_id, state.revision, "deliverable.add", {
      deliverable_id: "DEL-2206", title: "Legacy final"
    }));
    state = commit(state, tx(state.project_id, state.revision, "deliverable.complete", {
      deliverable_id: "DEL-2206", outcome: "Delivered before V2"
    }));
    expect(state.deliverables["DEL-2206"].status).toBe("legacy_completed");
    state = commit(state, tx(state.project_id, state.revision, "deliverable.accept", {
      deliverable_id: "DEL-2206", acceptance_note: "User explicitly accepts historical output"
    }));
    expect(state.deliverables["DEL-2206"].status).toBe("accepted");

    const acceptedAbandon = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.abandon", {
      deliverable_id: "DEL-2206", reason: "Should fail"
    }));
    expect(acceptedAbandon.kind).toBe("rejected");
  });
});
