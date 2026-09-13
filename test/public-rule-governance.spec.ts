import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { globalGovernancePath } from "../src/persistence/rule-governance-repository";

afterEach(() => vi.restoreAllMocks());
const authority = "public-global-governance-test-authority";
const ordinaryBindings = ["INGRESS_TOKEN", "CONTROL_TOWER_OPERATOR_TOKEN", "INPUT_RECOVERY_OPERATOR_TOKEN", "MUTATION_GATE_OPERATOR_TOKEN", "MUTATION_CONTEXT_SIGNING_KEY", "RULE_ADMISSION_SIGNING_KEY"] as const;
const baseline = { ...env } as Env;
async function fixture(overrides: Partial<Env> = {}) {
  const mock = installDropboxMock();
  const environment = { ...baseline, ...Object.fromEntries(ordinaryBindings.map(binding => [binding, baseline[binding]])), RULE_GOVERNANCE_TOKEN: authority, PROJECT_OS_LAYOUT_MODE: "v2", ...overrides } as Env;
  const registry = environment.REGISTRY_GUARD.getByName("global");
  await runInDurableObject(registry, (instance, state) => {
    Object.assign((instance as any).env, environment);
    state.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'; DELETE FROM governance_events; DELETE FROM meta WHERE key = 'rule_governance'");
  });
  const call = (method: string, body?: unknown, token: string | null = authority, path = "/v1/rule-governance") => worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: token === null ? {} : { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  }), environment, createExecutionContext());
  const tx = governanceTx("rule.propose", { rule: ruleFixture("GLOBAL") }, 0, "GLOBAL");
  const post = (body: unknown = tx, token: string | null = authority) => call("POST", body, token, "/v1/rule-governance/transactions");
  return { mock, environment, registry, call, tx, post };
}

it("public governance forwards typed global transactions and exposes fresh canonical revision without caching", async () => {
  const f = await fixture();
  const absent = await f.call("GET");
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({ error: "governance_not_initialized" });
  const committed = await f.post();
  expect(committed.status).toBe(200);
  const receipt = await committed.json();
  expect(receipt).toMatchObject({ status: "committed", project_id: "GLOBAL", new_revision: 1, transaction_id: f.tx.transaction_id });
  expect(JSON.parse(f.mock.files.get(globalGovernancePath)!).journal[f.tx.transaction_id].transaction).toEqual(f.tx);
  expect(await (await f.post()).json()).toEqual(receipt);
  const fresh = await f.call("GET");
  expect(fresh.headers.get("cache-control")).toBe("no-store");
  expect(await fresh.json()).toMatchObject({ revision: 1, rules: { "RULE-7101@1": { status: "draft" } } });
  const accepted = await f.post(governanceTx("rule.accept", { rule_id: "RULE-7101", version: 1 }, 1, "GLOBAL"));
  expect(await accepted.json()).toMatchObject({ status: "committed", new_revision: 2 });
  expect(await (await f.call("GET")).json()).toMatchObject({ revision: 2 });
  expect(await (await f.post(governanceTx("rule.accept", { rule_id: "RULE-7101", version: 1 }, 1, "GLOBAL"))).json()).toMatchObject({ status: "conflict", code: "STALE_REVISION" });
});

it("authenticates before parsing and refuses absent, wrong, or ordinary ingress authority on reads and writes", async () => {
  const f = await fixture(Object.fromEntries(ordinaryBindings.map(binding => [binding, `${Date.now()}.ordinary-${binding}`])));
  for (const token of [null, "incorrect-authority", ...ordinaryBindings.map(binding => f.environment[binding]!)]) {
    for (const response of [await f.post("not-json", token), await f.call("GET", undefined, token)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "governance_authority_required" });
    }
  }
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});

it("preserves canonical unavailability instead of inventing a fresh revision or reinitializing through public ingress", async () => {
  const f = await fixture();
  expect(await (await f.post()).json()).toMatchObject({ status: "committed" });
  f.mock.files.delete(globalGovernancePath);
  const read = await f.call("GET");
  expect(read.status).toBe(503);
  expect(await read.json()).toMatchObject({ error: "governance_unavailable" });
  expect((await f.post(governanceTx("rule.propose", { rule: ruleFixture("GLOBAL", { rule_id: "RULE-OTHER" }) }, 0, "GLOBAL"))).status).toBe(503);
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});

it.each([undefined, "", "   "])("fails closed when governance authority is unconfigured: %j", async token => {
  const f = await fixture({ RULE_GOVERNANCE_TOKEN: token });
  expect((await f.post()).status).toBe(403);
  expect((await f.call("GET")).status).toBe(403);
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});

it.each(ordinaryBindings)("rejects a governance secret shared with ordinary authority %s", async binding => {
  const f = await fixture({ [binding]: authority });
  expect((await f.post()).status).toBe(403);
  expect((await f.call("GET")).status).toBe(403);
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});

it("rejects non-global, non-governance and extended payloads before durable forwarding", async () => {
  const f = await fixture();
  for (const body of ["not-json", { ...f.tx, project_id: "PRJ-7101" }, { ...f.tx, operation: "project.create" }, { ...f.tx, qualification: { verified: true } }, { request: f.tx, mutation_context: {} }]) {
    const response = await f.post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_governance_transaction" });
  }
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});

it("does not turn the dedicated token or ordinary project route into a global mutation bypass", async () => {
  const f = await fixture();
  expect((await f.call("POST", f.tx, authority, "/v1/transactions")).status).toBe(401);
  expect((await f.call("POST", f.tx, f.environment.INGRESS_TOKEN, "/v1/transactions")).status).toBe(400);
  expect(f.mock.files.has(globalGovernancePath)).toBe(false);
});
