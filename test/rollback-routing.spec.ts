import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Transaction } from "../src/domain/transaction";
import { executeTransactionWithContinuity } from "../src/index";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { executeWithRollback } from "../src/continuity/rollback";
import { issueMutationContext } from "../src/admission/mutation-context";
import { commitFixture } from "./helpers/convergence-fixture";

const testEnv = env as unknown as Env;

const createTransaction: Transaction = {
  schema_version: "1.0",
  transaction_id: "TXN-ROLLBACK-ROUTING-2010-CREATE",
  project_id: "PRJ-AUTO",
  base_revision: 0,
  operation: "project.create",
  created_at: "2026-08-24T02:10:00+01:00",
  payload: {
    name: "Rollback Routing 2010",
    slug: "rollback-routing-2010",
    aliases: [],
    objective: "Prove stable routing remains unchanged"
  }
};

describe("transaction continuity routing", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("keeps production stable mode on the stable transaction route without calling candidate", async () => {
    const candidate = vi.fn(async (_transaction: Transaction) => {
      throw new Error("candidate must not run in stable mode");
    });

    const receipt = await executeTransactionWithContinuity(testEnv, createTransaction, candidate);

    expect(receipt.status).toBe("committed");
    expect(receipt.transaction_id).toBe(createTransaction.transaction_id);
    expect(receipt.project_id).toMatch(/^PRJ-[0-9]{4,}$/);
    expect(receipt.project_id).not.toBe("PRJ-AUTO");
    expect(candidate).not.toHaveBeenCalled();
  });

  it("forwards the identical signed context to candidate and stable fallback", async () => {
    const record = commitFixture("PRJ-9985", 1)[0];
    const context = await issueMutationContext(
      record.state,
      "synthetic-context-secret-for-vitest-only",
      Date.parse("2026-09-09T10:00:00.000Z")
    );
    const candidate = vi.fn(async () => { throw new Error("candidate unavailable"); });
    const stable = vi.fn(async (transaction: Transaction) => ({
      schema_version: "1.0",
      transaction_id: transaction.transaction_id,
      project_id: transaction.project_id,
      status: "committed",
      previous_revision: 1,
      new_revision: 2,
      event_id: "EVT-000002",
      committed_at: transaction.created_at
    }));
    const transaction: Transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-ROLLBACK-CONTEXT-9985-0001",
      project_id: "PRJ-9985",
      base_revision: 1,
      operation: "task.create",
      created_at: "2026-09-09T10:00:01.000Z",
      payload: { task_id: "TASK-ROLLBACK9985A", title: "Preserve admission" }
    };

    const result = await executeWithRollback({
      selectedPath: "candidate",
      transaction,
      context,
      candidate,
      stable
    });

    expect(result.fallback_occurred).toBe(true);
    expect(candidate).toHaveBeenCalledWith(transaction, context);
    expect(stable).toHaveBeenCalledWith(transaction, context);
  });
});
