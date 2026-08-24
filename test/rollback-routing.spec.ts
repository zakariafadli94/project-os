import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Transaction } from "../src/domain/transaction";
import { executeTransactionWithContinuity } from "../src/index";
import { installDropboxMock } from "./helpers/mock-dropbox";

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
});
