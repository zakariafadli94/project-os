import { describe, expect, it, vi } from "vitest";
import type { Receipt } from "../src/domain/receipt";
import type { Transaction } from "../src/domain/transaction";
import { executeWithRollback } from "../src/continuity/rollback";

const tx: Transaction = {
  schema_version: "1.0",
  transaction_id: "TXN-ROLLBACK-EXECUTOR-0001",
  project_id: "PRJ-2001",
  base_revision: 1,
  operation: "task.create",
  created_at: "2026-08-24T02:00:00+01:00",
  payload: { task_id: "TASK-ROLLBACK2001", title: "Rollback executor proof" }
};

function receipt(status: Receipt["status"]): Receipt {
  return {
    schema_version: "1.0",
    transaction_id: tx.transaction_id,
    project_id: tx.project_id,
    status,
    previous_revision: 1,
    new_revision: status === "committed" ? 2 : 1,
    ...(status === "committed" ? { event_id: "EVT-000002", committed_at: tx.created_at } : {})
  };
}

describe("continuity rollback executor", () => {
  it("runs stable directly when stable is selected", async () => {
    const stable = vi.fn(async () => receipt("committed"));
    const candidate = vi.fn(async () => receipt("committed"));

    const execution = await executeWithRollback({ selectedPath: "stable", transaction: tx, stable, candidate });

    expect(execution).toMatchObject({
      receipt: receipt("committed"),
      selected_path: "stable",
      final_path: "stable",
      fallback_occurred: false
    });
    expect(stable).toHaveBeenCalledTimes(1);
    expect(candidate).not.toHaveBeenCalled();
  });

  for (const status of ["committed", "rejected", "conflict"] as const) {
    it(`returns candidate ${status} business result without stable fallback`, async () => {
      const stable = vi.fn(async () => receipt("committed"));
      const candidate = vi.fn(async () => receipt(status));

      const execution = await executeWithRollback({ selectedPath: "candidate", transaction: tx, stable, candidate });

      expect(execution).toMatchObject({
        receipt: receipt(status),
        selected_path: "candidate",
        final_path: "candidate",
        fallback_occurred: false
      });
      expect(candidate).toHaveBeenCalledTimes(1);
      expect(stable).not.toHaveBeenCalled();
    });
  }

  it("falls back once to stable on candidate technical failure with the exact transaction object", async () => {
    const stable = vi.fn(async () => receipt("committed"));
    const candidate = vi.fn(async () => {
      throw new Error("candidate unavailable");
    });

    const execution = await executeWithRollback({ selectedPath: "candidate", transaction: tx, stable, candidate });

    expect(execution).toMatchObject({
      receipt: receipt("committed"),
      selected_path: "candidate",
      final_path: "stable",
      fallback_occurred: true,
      candidate_failure: "technical"
    });
    expect(candidate).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledTimes(1);
    expect(candidate.mock.calls[0]?.[0]).toBe(tx);
    expect(stable.mock.calls[0]?.[0]).toBe(tx);
  });

  it("treats a malformed candidate response as technical rollback input", async () => {
    const stable = vi.fn(async () => receipt("committed"));
    const candidate = vi.fn(async () => ({ status: "committed" }));

    const execution = await executeWithRollback({ selectedPath: "candidate", transaction: tx, stable, candidate });

    expect(execution).toMatchObject({
      final_path: "stable",
      fallback_occurred: true,
      candidate_failure: "malformed_result"
    });
    expect(stable).toHaveBeenCalledTimes(1);
  });

  it("surfaces stable technical failure and never recurses through candidate", async () => {
    const stable = vi.fn(async () => {
      throw new Error("stable transport failure");
    });
    const candidate = vi.fn(async () => receipt("committed"));

    await expect(executeWithRollback({ selectedPath: "stable", transaction: tx, stable, candidate }))
      .rejects.toThrow("stable transport failure");
    expect(stable).toHaveBeenCalledTimes(1);
    expect(candidate).not.toHaveBeenCalled();
  });
});
