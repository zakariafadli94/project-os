import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { installDropboxMock } from "./helpers/mock-dropbox";
const testEnv = env as unknown as Env;
const authority = "synthetic-rule-governance-authority";
let registryName: string;
const stub = () => testEnv.REGISTRY_GUARD.getByName(registryName);
async function configure(token: string | undefined) {
  await runInDurableObject(stub(), instance => { (instance as unknown as { env: Env }).env.RULE_GOVERNANCE_TOKEN = token; });
}
async function submit(tx: unknown, token: string = authority) {
  return stub().fetch("https://registry-guard.internal/governance/transaction", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(tx)
  });
}
describe("RegistryGuard global governance", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;
  const canonicalPath = "/PROJECT_OS/.project-os/registry/RULE_GOVERNANCE.json";
  beforeEach(() => { dropbox = installDropboxMock(); registryName = `governance-${crypto.randomUUID()}`; });
  afterEach(() => vi.restoreAllMocks());
  it("fails closed without dedicated authority and refuses ordinary ingress authority", async () => {
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    await configure(undefined);
    expect((await submit(tx)).status).toBe(403);
    await configure(authority);
    expect((await submit(tx, testEnv.INGRESS_TOKEN)).status).toBe(403);
    const response = await stub().fetch("https://registry-guard.internal/governance");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "governance_not_initialized" });
  });

  it("does not report never initialized when only governance event/request cache survives", async () => {
    await configure(authority);
    expect(await (await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
    dropbox.files.delete(canonicalPath);
    dropbox.files.delete("/PROJECT_OS/.project-os/registry/RULE_GOVERNANCE_BOOTSTRAP.json");
    await runInDurableObject(stub(), (_instance, state) => { state.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'"); });
    const response = await stub().fetch("https://registry-guard.internal/governance");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "governance_unavailable" });
    expect((await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL", { rule_id: "RULE-NOT-NEW" }) }, 0, "GLOBAL"))).status).toBe(503);
  });
  it.each(["CONTROL_TOWER_OPERATOR_TOKEN", "INPUT_RECOVERY_OPERATOR_TOKEN", "MUTATION_GATE_OPERATOR_TOKEN", "MUTATION_CONTEXT_SIGNING_KEY"] as const)("refuses shared authority with %s", async (binding) => {
    await configure(authority);
    const previous = await runInDurableObject(stub(), instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      const old = bindings[binding]; bindings[binding] = authority; return old;
    });
    try {
      const response = await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL"));
      expect(response.status).toBe(403);
      expect(dropbox.files.has(canonicalPath)).toBe(false);
    } finally {
      await runInDurableObject(stub(), instance => { (instance as unknown as { env: Env }).env[binding] = previous; });
    }
  });
  it("refuses an absent canonical ruleset after complete SQL loss", async () => {
    await configure(authority);
    expect(await (await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
    dropbox.files.delete(canonicalPath);
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'");
      ctx.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'");
      ctx.storage.sql.exec("DELETE FROM governance_events");
    });
    expect((await stub().fetch("https://registry-guard.internal/governance")).status).toBe(503);
    expect((await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL", { rule_id: "RULE-NEW1" }) }, 0, "GLOBAL"))).status).toBe(503);
    expect(dropbox.files.has(canonicalPath)).toBe(false);
  });
  it("persists rule, event and receipt atomically; replays after eviction and rejects ID reuse", async () => {
    await configure(authority);
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    const response = await submit(tx);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ status: "committed", previous_revision: 0, new_revision: 1, project_id: "GLOBAL" });
    await evictDurableObject(stub());
    await configure(authority);
    expect(await (await submit(tx)).json()).toEqual(receipt);
    expect(await (await submit({ ...tx, payload: { rule: ruleFixture("GLOBAL", { title: "Altered" }) } })).json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    const state = await (await stub().fetch("https://registry-guard.internal/governance")).json();
    expect(state).toMatchObject({ revision: 1, rules: { "RULE-7101@1": { title: "Verify destination" } } });
    await runInDurableObject(stub(), (_instance, ctx) => {
      const rows = ctx.storage.sql.exec("SELECT event_json FROM governance_events").toArray();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0].event_json))).toMatchObject({ transaction_id: tx.transaction_id, revision: 1, type: "rule.propose" });
    });
  });
  it("serializes competing changes at an exact global revision", async () => {
    await configure(authority);
    const results = await Promise.all([1, 2].map(i => submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL", { rule_id: `RULE-710${i}` }) }, 0, "GLOBAL")).then(r => r.json<{ status: string }>() )));
    expect(results.map(r => r.status).sort()).toEqual(["committed", "conflict"]);
  });
  it("recovers global state, history and idempotent receipts from canonical storage after SQL loss", async () => {
    await configure(authority);
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    const receipt = await (await submit(tx)).json();
    expect(dropbox.files.has(canonicalPath)).toBe(true);
    const canonical = JSON.parse(dropbox.files.get(canonicalPath)!);
    expect(canonical).toMatchObject({ revision: 1, journal: { [tx.transaction_id]: { receipt, transaction: tx } } });
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'rule_governance'");
      ctx.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'");
      ctx.storage.sql.exec("DELETE FROM governance_events");
    });
    expect(await (await submit(tx)).json()).toEqual(receipt);
    expect(await (await stub().fetch("https://registry-guard.internal/governance")).json()).toMatchObject({ revision: 1 });
  });
  it("never claims committed when canonical publication fails", async () => {
    dropbox = installDropboxMock({ faults: [{ endpoint: "/2/files/upload", path: canonicalPath, occurrence: 1, status: 403, error_summary: "permission_denied/" }] });
    await configure(authority);
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    const response = await submit(tx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "governance_unavailable" });
    expect(dropbox.files.has(canonicalPath)).toBe(false);
    expect(JSON.parse(dropbox.files.get("/PROJECT_OS/.project-os/registry/RULE_GOVERNANCE_BOOTSTRAP.json")!)).toMatchObject({ status: "pending", transaction: tx });
    expect((await submit(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL", { title: "Changed intent" }) }, 0, "GLOBAL"))).status).toBe(503);
    expect(await (await submit(tx)).json()).toMatchObject({ status: "committed", new_revision: 1 });
    expect(JSON.parse(dropbox.files.get("/PROJECT_OS/.project-os/registry/RULE_GOVERNANCE_BOOTSTRAP.json")!)).toMatchObject({ status: "initialized", transaction: tx });
  });
  it("uses canonical receipts when the local cache contains a contradictory receipt", async () => {
    await configure(authority);
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    const receipt = await (await submit(tx)).json();
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE requests SET receipt_json = ? WHERE transaction_id = ?", JSON.stringify({ status: "rejected", code: "STALE_CACHE" }), tx.transaction_id);
    });
    expect(await (await submit(tx)).json()).toEqual(receipt);
  });
  it("confirms an ambiguous successful canonical write and refuses a missing canonical state", async () => {
    dropbox = installDropboxMock({ faults: [{ endpoint: "/2/files/upload", path: canonicalPath, occurrence: 1, phase: "after", status: 403, error_summary: "permission_denied/" }] });
    await configure(authority);
    const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
    expect(await (await submit(tx)).json()).toMatchObject({ status: "committed", new_revision: 1 });
    expect(dropbox.files.has(canonicalPath)).toBe(true);
    dropbox.files.delete(canonicalPath);
    expect((await stub().fetch("https://registry-guard.internal/governance")).status).toBe(503);
  });
});
