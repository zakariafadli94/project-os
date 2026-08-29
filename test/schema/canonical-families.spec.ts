import { describe, expect, it } from "vitest";
import { readDomainEvent } from "../../src/schema/event";
import { readReceipt } from "../../src/schema/receipt";

const at = "2026-08-28T17:00:00.000Z";

function eventFixture() {
  return {
    schema_version: "1.0" as const,
    event_id: "EVT-000007",
    project_id: "PRJ-9003",
    revision: 7,
    transaction_id: "TXN-SCHEMA-CANON-9003",
    type: "task.create" as const,
    timestamp: at,
    payload: { task_id: "TASK-SCHEMA9003", title: "Read strictly" }
  };
}

function receiptFixture() {
  return {
    schema_version: "1.0" as const,
    transaction_id: "TXN-SCHEMA-CANON-9003",
    status: "committed" as const,
    project_id: "PRJ-9003",
    previous_revision: 6,
    new_revision: 7,
    event_id: "EVT-000007",
    committed_at: at
  };
}

describe("canonical 1.0 family readers", () => {
  it("reads the retained DomainEvent 1.0 family strictly", () => {
    expect(readDomainEvent(eventFixture())).toEqual(eventFixture());
    expect(() => readDomainEvent({ ...eventFixture(), unexpected: true })).toThrow();
    expect(() => readDomainEvent({ ...eventFixture(), type: "future.operation" })).toThrow();
    expect(() => readDomainEvent({ ...eventFixture(), schema_version: "2.0" })).toThrow(/event.*2\.0/i);
  });

  it("reads the retained Receipt 1.0 family strictly", () => {
    expect(readReceipt(receiptFixture())).toEqual(receiptFixture());
    expect(() => readReceipt({ ...receiptFixture(), unexpected: true })).toThrow();
    expect(() => readReceipt({ ...receiptFixture(), schema_version: "2.0" })).toThrow(/receipt.*2\.0/i);
  });

  it("keeps terminal receipt semantics at 1.0 without inventing commit evidence", () => {
    const terminal = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-SCHEMA-CANON-9004",
      status: "conflict" as const,
      project_id: "PRJ-9003",
      previous_revision: 7,
      new_revision: 7,
      code: "REVISION_CONFLICT",
      message: "conflict"
    };
    expect(readReceipt(terminal)).toEqual(terminal);
  });
});
