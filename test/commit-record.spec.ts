import { describe, expect, it } from "vitest";
import { parseCanonicalCommitRecord } from "../src/domain/commit-record";
import { machineCommitRecordPath } from "../src/persistence/layout";

const at = "2026-08-24T00:45:00.000Z";

function validRecord(options: {
  previousRevision?: number;
  baseRevision?: number;
  operation?: string;
  payload?: Record<string, unknown>;
  stateSchemaVersion?: "1.0" | "2.0";
} = {}) {
  const previousRevision = options.previousRevision ?? 1;
  const newRevision = previousRevision + 1;
  const eventId = `EVT-${newRevision.toString().padStart(6, "0")}`;
  const transaction = {
    schema_version: "1.0",
    transaction_id: "TXN-COMMIT-1201-TASK",
    project_id: "PRJ-1201",
    base_revision: options.baseRevision ?? previousRevision,
    operation: options.operation ?? "task.create",
    created_at: at,
    payload: options.payload ?? { task_id: "TASK-COMMIT1201", title: "Commit exactly once" }
  };
  const event = {
    schema_version: "1.0",
    event_id: eventId,
    project_id: "PRJ-1201",
    revision: newRevision,
    transaction_id: transaction.transaction_id,
    type: transaction.operation,
    timestamp: at,
    payload: transaction.payload
  };
  const state = {
    schema_version: options.stateSchemaVersion ?? "1.0",
    project_id: "PRJ-1201",
    name: "Commit 1201",
    slug: "commit-1201",
    aliases: [],
    objective: "Prove crash-safe commits",
    framing: {
      scope: [],
      out_of_scope: [],
      success_criteria: [],
      stakeholders: [],
      open_questions: []
    },
    discovery: {
      confirmed_findings: [],
      provisional_findings: [],
      unresolved_questions: [],
      next_exploration: []
    },
    status: "active",
    revision: newRevision,
    current_phase_id: null,
    artifact_routes: {},
    constraints: {},
    tasks: {},
    plan_phases: {},
    decisions: {},
    research: {},
    deliverables: {},
    last_event_id: event.event_id,
    created_at: at,
    updated_at: at
  };
  const receipt = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: "PRJ-1201",
    previous_revision: previousRevision,
    new_revision: newRevision,
    event_id: event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: "PRJ-1201",
    previous_revision: previousRevision,
    new_revision: newRevision,
    transaction,
    state,
    event,
    receipt
  };
}

describe("canonical commit record", () => {
  it("uses a deterministic immutable path per project revision", () => {
    expect(machineCommitRecordPath("PRJ-1201", 2)).toBe(
      "/PROJECT_OS/.project-os/projects/PRJ-1201/commits/REV-000002.json"
    );
  });

  it("accepts a self-consistent committed record", () => {
    const record = parseCanonicalCommitRecord(validRecord());
    expect(record.project_id).toBe("PRJ-1201");
    expect(record.new_revision).toBe(2);
    expect(record.receipt.status).toBe("committed");
  });

  it("keeps envelope 1.0 while accepting nested ProjectState 2.0", () => {
    const record = parseCanonicalCommitRecord(validRecord({ stateSchemaVersion: "2.0" }));
    expect(record.schema_version).toBe("1.0");
    expect(record.state.schema_version).toBe("2.0");
    expect(record.state.revision).toBe(record.new_revision);
    expect(record.state.last_event_id).toBe(record.event.event_id);
  });

  it("rejects an unsupported nested ProjectState generation", () => {
    const record = validRecord() as ReturnType<typeof validRecord> & { state: Record<string, unknown> };
    record.state.schema_version = "3.0";
    expect(() => parseCanonicalCommitRecord(record)).toThrow(/ProjectState.*3\.0/i);
  });

  it("preserves an approved stale additive base revision while recording the effective previous revision", () => {
    const record = parseCanonicalCommitRecord(validRecord({
      previousRevision: 3,
      baseRevision: 1,
      operation: "research.add",
      payload: { research_id: "RES-COMMIT1201", title: "Rebased evidence", body: "Preserve submitted provenance" }
    }));

    expect(record.transaction.base_revision).toBe(1);
    expect(record.previous_revision).toBe(3);
    expect(record.new_revision).toBe(4);
  });

  it("rejects a stale exact-current lifecycle transaction inside a committed record", () => {
    expect(() => parseCanonicalCommitRecord(validRecord({
      previousRevision: 3,
      baseRevision: 1,
      operation: "task.complete",
      payload: { task_id: "TASK-COMMIT1201" }
    }))).toThrow(/base revision/i);
  });

  it("rejects a transaction base revision ahead of the effective previous revision", () => {
    expect(() => parseCanonicalCommitRecord(validRecord({
      previousRevision: 1,
      baseRevision: 2,
      operation: "research.add",
      payload: { research_id: "RES-COMMIT1202", title: "Future evidence", body: "Invalid" }
    }))).toThrow(/ahead/i);
  });

  it("rejects a non-contiguous revision", () => {
    const record = validRecord();
    record.new_revision = 3;
    expect(() => parseCanonicalCommitRecord(record)).toThrow(/revision/i);
  });

  it("rejects a state/event revision mismatch", () => {
    const record = validRecord();
    record.event.revision = 3;
    expect(() => parseCanonicalCommitRecord(record)).toThrow(/event.*revision|revision.*event/i);
  });

  it("rejects a receipt that does not prove a committed transaction", () => {
    const record = validRecord();
    record.receipt.status = "rejected";
    expect(() => parseCanonicalCommitRecord(record)).toThrow(/committed/i);
  });

  it("rejects transaction, event, or receipt project binding drift", () => {
    const record = validRecord();
    record.event.project_id = "PRJ-9999";
    expect(() => parseCanonicalCommitRecord(record)).toThrow(/project/i);
  });
});
