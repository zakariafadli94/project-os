import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { governanceTx, ruleAt, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
const testEnv = env as unknown as Env;
beforeEach(() => { installDropboxMock(); });
afterEach(() => vi.restoreAllMocks());
it("serializes project governance through ordinary committed event/receipt persistence", async () => {
  const stub = testEnv.PROJECT_GUARD.getByName("PRJ-7101");
  async function submit(tx: unknown) {
    const response = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx)
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  await submit({ schema_version: "1.0", transaction_id: "TXN-RULE-PROJECT-CREATE", project_id: "PRJ-7101",
    base_revision: 0, created_at: ruleAt, operation: "project.create", payload: { name: "Rules", slug: "rules", objective: "Verify governance", aliases: [] } });
  const tx = governanceTx("rule.propose", { rule: ruleFixture() }, 1);
  const receipt = await submit(tx);
  expect(receipt).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
  expect(await submit(tx)).toEqual(receipt);
  const stale = governanceTx("rule.accept", { rule_id: "RULE-7101", version: 1 }, 1);
  expect(await submit(stale)).toMatchObject({ status: "conflict", code: "STALE_REVISION", new_revision: 2 });
});
