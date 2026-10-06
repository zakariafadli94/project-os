import { afterEach, expect, it, vi } from "vitest";
import { createControlTowerServer } from "../src/control-tower/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { successfulMcpResult } from "../scripts/control-tower-qualification.mjs";

afterEach(() => vi.restoreAllMocks());
const toolName = "project_os_diagnose_admission";
function towerFixture(reply: (request: Request) => Promise<Response>, access = { read: true, mutate: true }, token: string | undefined = "operator-test") {
  const calls: Request[] = [];
  const owner = { getByName: () => ({ fetch: async (url: string, init: RequestInit) => {
    const request = new Request(url, init); calls.push(request); return reply(request);
  } }) } as unknown as DurableObjectNamespace;
  const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner, CONTROL_TOWER_OPERATOR_TOKEN: token }, access) as any;
  const call = async () => {
    expect(server._registeredTools[toolName], "standalone governed diagnostic must be callable").toBeDefined();
    return server._registeredTools[toolName].handler({ project_id: "PRJ-0003" });
  };
  return { call, calls };
}
function safeReply(request: Request) {
  const correlation = request.headers.get("x-project-os-correlation-id");
  return {
    schema_version: "1.0", project_id: "PRJ-0003", correlation_id: correlation,
    status: "ready", code: "ADMISSION_DIAGNOSTIC_READY", canonical_revision: 609,
    freshness: "verified", authority: "issued_discarded", business_mutation: false,
    runtime: { worker_version_id: "33333333-3333-4333-8333-333333333333", worker_version_tag: "git-" + "a".repeat(40), git_sha: "a".repeat(40) },
    reader: { phase: "suffix", category: "success", elapsed_ms: 8, provider_call_count: 2, role: "initiator", initiator_correlation_id: correlation },
    admission: { stage: "after_signature", category: "success", elapsed_ms: 10 }
  };
}
it("Tower performs one authenticated diagnostic GET and returns a safe correlated result without POST", async () => {
  const f = towerFixture(async request => Response.json(safeReply(request)));
  const result = await f.call();
  expect(result.isError).not.toBe(true);
  const body = JSON.parse(result.content[0].text);
  expect(body).toMatchObject({ status: "ready", canonical_revision: 609, business_mutation: false });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.method).toBe("GET");
  expect(new URL(f.calls[0]!.url).searchParams.get("diagnostic")).toBe("true");
  expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer operator-test");
  expect(body.correlation_id).toBe(f.calls[0]!.headers.get("x-project-os-correlation-id"));
  expect(JSON.stringify(result)).not.toContain("operator-test");
});
it.each([{ read: true, mutate: false }, { read: false, mutate: true }])("Tower refuses insufficient OAuth access before fetch", async access => {
  const f = towerFixture(async request => Response.json(safeReply(request)), access);
  expect((await f.call()).isError).toBe(true);
  expect(f.calls).toHaveLength(0);
});
it.each([200, 503])("Tower never forwards a legacy signed context or unsafe %s provider body", async status => {
  const f = towerFixture(async () => Response.json({ context: { token: "SECRET_SIGNED_AUTHORITY" }, private_provider_body: "PRIVATE_BODY" }, { status }));
  const result = await f.call();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/SECRET_SIGNED_AUTHORITY|PRIVATE_BODY|"context"/);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "ADMISSION_DIAGNOSTIC_TRANSPORT_UNAVAILABLE", guard_result: "unknown" });
  expect(f.calls).toHaveLength(1);
});
it("Tower rejects contradictory ready verdict rather than declaring admission available", async () => {
  const f = towerFixture(async request => Response.json({ ...safeReply(request), authority: "not_issued" }));
  const result = await f.call();
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).guard_result).toBe("unknown");
});

it.each(["project", "correlation", "phase", "count", "extra", "runtime", "reader", "http"])("Tower rejects invalid %s diagnostic without exposing unsafe content", async field => {
  const f = towerFixture(async request => {
    const body: any = safeReply(request);
    if (field === "project") body.project_id = "PRJ-0007";
    if (field === "correlation") body.correlation_id = "44444444-4444-4444-8444-444444444444";
    if (field === "phase") body.reader.phase = "PRIVATE_PROVIDER_BODY";
    if (field === "count") body.reader.provider_call_count = -1;
    if (field === "extra") body.context = { token: "PRIVATE_PROVIDER_BODY" };
    if (field === "runtime") body.runtime.git_sha = "b".repeat(40);
    if (field === "reader") body.reader = null;
    return Response.json(body, { status: field === "http" ? 503 : 200 });
  });
  const result = await f.call();
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).guard_result).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_BODY");
  expect(f.calls).toHaveLength(1);
});

it("Tower forwards safe refusal evidence instead of collapsing an allowlisted 503", async () => {
  const f = towerFixture(async request => Response.json({ ...safeReply(request), status: "unavailable", code: "ADMISSION_DIAGNOSTIC_UNAVAILABLE",
    freshness: "unknown", authority: "not_issued", canonical_revision: null,
    reader: { ...safeReply(request).reader, category: "deadline", phase: "snapshot", provider_call_count: 1 },
    admission: { stage: "canonical_read", category: "unavailable", elapsed_ms: 5000 } }, { status: 503 }));
  const result = await f.call();
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "ADMISSION_DIAGNOSTIC_UNAVAILABLE", reader: { category: "deadline", provider_call_count: 1 } });
});

it("Tower missing operator configuration does not fetch", async () => {
  const f = towerFixture(async request => Response.json(safeReply(request)), undefined, "");
  expect((await f.call()).isError).toBe(true);
  expect(f.calls).toHaveLength(0);
});

it("Tower deadline aborts its sole fetch and returns unknown without retry", async () => {
  vi.useFakeTimers();
  try {
    const f = towerFixture(async () => new Promise(() => undefined));
    const result = f.call();
    await vi.advanceTimersByTimeAsync(10_000);
    const body = JSON.parse((await result).content[0].text);
    expect(body).toMatchObject({ code: "ADMISSION_DIAGNOSTIC_TRANSPORT_UNAVAILABLE", guard_result: "unknown" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.signal.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("three independent local MCP sessions discover the same strict diagnostic contract", async () => {
  const owner = { getByName: () => ({ fetch: async () => Response.json({}) }) } as unknown as DurableObjectNamespace;
  for (let i = 0; i < 3; i++) {
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }));
    const response = await handler.fetch(new Request("https://tower.example/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    }));
    const wire = await response.text();
    const body = successfulMcpResult(wire, 1) as { tools: any[] };
    const tool = body.tools.find((entry: any) => entry.name === toolName);
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["project_id"], additionalProperties: false });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["project_id"]);
  }
});

it.each(["after_signature_not_issued", "verified_refusal", "signature_error_before_signature", "stale_canonical_read", "unavailable_signature", "oversized"])(
  "Tower rejects contradictory refusal %s rather than reporting unsafe evidence", async contradiction => {
    const f = towerFixture(async request => {
      const body: any = { ...safeReply(request), status: "unavailable", code: "ADMISSION_DIAGNOSTIC_UNAVAILABLE", freshness: "unknown",
        admission: { stage: "after_signature", category: "stale_state", elapsed_ms: 10 } };
      if (contradiction === "after_signature_not_issued") body.authority = "not_issued";
      if (contradiction === "verified_refusal") body.freshness = "verified";
      if (contradiction === "signature_error_before_signature") {
        body.authority = "not_issued"; body.admission = { stage: "before_signature", category: "signature_error", elapsed_ms: 10 };
      }
      if (contradiction === "stale_canonical_read") {
        body.authority = "not_issued"; body.admission = { stage: "canonical_read", category: "stale_state", elapsed_ms: 10 };
      }
      if (contradiction === "unavailable_signature") {
        body.authority = "not_issued"; body.admission = { stage: "signature", category: "unavailable", elapsed_ms: 10 };
      }
      if (contradiction === "oversized") body.reader.phase = "PRIVATE_OVERSIZED".repeat(10_000);
      return Response.json(body, { status: 503 });
    });
    const result = await f.call();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "ADMISSION_DIAGNOSTIC_TRANSPORT_UNAVAILABLE", guard_result: "unknown" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OVERSIZED|"authority"|"reader"|"token"/);
    expect(f.calls).toHaveLength(1);
  }
);
