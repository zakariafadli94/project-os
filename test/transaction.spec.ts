import { describe, expect, it } from "vitest";
import { parseTransaction } from "../src/domain/transaction";

describe("parseTransaction", () => {
  it("accepts a valid task.complete transaction", () => {
    const tx = parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000000",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "task.complete",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { task_id: "TASK-0001" }
    });
    expect(tx.operation).toBe("task.complete");
  });

  it("rejects arbitrary file mutation operations", () => {
    expect(() => parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000001",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "edit_file",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { path: "STATE.md", content: "bad" }
    })).toThrow();
  });

  it("rejects unknown envelope fields", () => {
    expect(() => parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000002",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "research.add",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { research_id: "RES-0001", title: "x", body: "y" },
      arbitrary_path: "../../secrets"
    })).toThrow();
  });
});
