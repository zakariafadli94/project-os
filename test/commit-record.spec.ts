import { describe, expect, it } from "vitest";
import { parseCanonicalCommitRecord } from "../src/domain/commit-record";
import { machineCommitRecordPath } from "../src/dropbox/layout";

const at = "2026-08-24T00:45:00.000Z";

function validRecord() {
  const transaction = {
    schema_version: "1.0",
    transaction_id: "TXN-COMMIT-1201-TASK",
    project_id: "PRJ-1201",
    base_revision: 1,
    operation: "task.create",
    created_at: at,
    payload: { task_id: "TASK-COMMIT1201", title: "Commit exactly once" }
  };
  const event = {
    schema_version: "1.0",
    event_id: "EVT-000002",
    project_id: "PRJ-1201",
    revision: 2,
    transaction_id: transaction.transaction_id,
    type: transaction.operation,
    timestamp: at,
    payload: transaction.payload
  };
  const state = {
    schema_version: "1.0",
    project_id: "PRJ-1201",
    name: "Commit 1201",
    slug: "commit-1201",
    aliases: [],
    objective: "Prove crash-safe commits",
    status: "active",
    revision: 2,
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
    previous_revision: 1,
    new_revision: 2,
    event_id: event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: "PRJ-1201",
    previous_revision: 1,
    new_revision: 2,
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
