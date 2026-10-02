import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlTowerServer } from "../src/control-tower/mcp";
import { exceptionFixture, ruleFixture } from "./helpers/rule-fixtures";

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
function tool(access: { read: boolean; mutate: boolean }, fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchStub = vi.fn(fetch);
  const getByName = vi.fn((name: string) => ({ fetch: fetchStub, name }));
  const server = createControlTowerServer({
    PROJECT_GUARD: { getByName: vi.fn() } as unknown as DurableObjectNamespace,
    REGISTRY_GUARD: { getByName } as unknown as DurableObjectNamespace,
    CF_VERSION_METADATA: { tag: `git-${"a".repeat(40)}` }
  }, access) as unknown as {
    _registeredTools: Record<string, { handler(input?: unknown): Promise<ToolResult> }>;
  };
  return { handler: server._registeredTools.project_os_get_rule_authority!.handler, fetchStub, getByName };
}

function activeRule(overrides: Record<string, unknown> = {}) {
  return ruleFixture("GLOBAL", { status: "active", activation_evidence: ["qualification:approved"], ...overrides });
}

describe("Control Tower global rule authority read", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the exact RegistryGuard authority route with read scope and returns only validated active references", async () => {
    const inactive = activeRule({ rule_id: "RULE-INACTIVE", status: "retired" });
    const active = activeRule({ parameters: { private: "must-not-leak" } });
    const f = tool({ read: true, mutate: false }, async (input, init) => {
      expect(String(input)).toBe("https://registry-guard.internal/governance");
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      return Response.json({ revision: 12,
        rules: { "RULE-7101@1": active, "RULE-INACTIVE@1": inactive },
        exceptions: { "EXC-7101": { ...exceptionFixture({ reason: "must-not-leak" }), status: "granted" } } });
    });

    const result = await f.handler();
    const body = JSON.parse(result.content[0]!.text);
    expect(f.getByName).toHaveBeenCalledTimes(1);
    expect(f.getByName).toHaveBeenCalledWith("global");
    expect(f.fetchStub).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ status: "verified", activation_attestation_verified: true,
      current_runtime_qualification: "not_probed", revision: 12,
      rules: [{ rule_id: "RULE-7101", version: 1, scope: { kind: "global" }, check_id: "allowed_destination" }],
      deployed_sha: "a".repeat(40) });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).not.toContain("must-not-leak");
  });

  it("denies callers without read scope without contacting RegistryGuard", async () => {
    const f = tool({ read: false, mutate: true }, async () => Response.json({ revision: 1, rules: {}, exceptions: {} }));
    const result = await f.handler();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "insufficient_scope", required_scope: "project.read" });
    expect(f.getByName).not.toHaveBeenCalled();
    expect(f.fetchStub).not.toHaveBeenCalled();
  });

  it("preserves RegistryGuard unavailability as an error and never substitutes an empty authority set", async () => {
    const f = tool({ read: true, mutate: false }, async () => Response.json({ error: "governance_unavailable", private: "secret" }, { status: 503 }));
    const result = await f.handler();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unavailable" });
    expect(JSON.parse(result.content[0]!.text)).not.toHaveProperty("rules");
    expect(result.content[0]!.text).not.toContain("secret");
  });

  it("bounds a response whose body stalls after the fetch headers arrive", async () => {
    vi.useFakeTimers();
    const f = tool({ read: true, mutate: false }, async () => new Response(new ReadableStream({
      pull: () => new Promise<void>(() => {})
    })));
    const pending = f.handler();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unavailable" });
  });

  it("rejects a governance response exceeding the byte budget", async () => {
    const oversized = new Uint8Array(256 * 1024 + 1);
    oversized.fill(32);
    const f = tool({ read: true, mutate: false }, async () => new Response(oversized));
    const result = await f.handler();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unavailable" });
    expect(JSON.parse(result.content[0]!.text)).not.toHaveProperty("current_runtime_qualification", "not_probed");
  });

  it.each([
    { revision: -1, rules: {}, exceptions: {} },
    { revision: 12, rules: { "RULE-7101@1": activeRule({ scope: { kind: "project", project_id: "PRJ-7101" } }) }, exceptions: {} },
    { revision: 12, rules: { "WRONG-KEY": activeRule() }, exceptions: {} },
    { revision: 12, rules: { "RULE-7101@1": { ...activeRule(), parameters: "not-an-object" } }, exceptions: {} },
    { revision: 12, rules: {}, exceptions: null },
    { revision: 12, rules: {}, exceptions: { PRIVATE: { reason: "secret" } } }
  ])("fails closed on malformed or misbound governance response %#", async payload => {
    const f = tool({ read: true, mutate: false }, async () => Response.json(payload));
    const result = await f.handler();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unavailable" });
    expect(JSON.parse(result.content[0]!.text)).not.toHaveProperty("activation_attestation_verified", true);
  });
});
