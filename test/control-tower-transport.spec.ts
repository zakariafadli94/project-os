import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { createControlTowerServer as createScopedControlTowerServer } from "../src/control-tower/mcp";
const createControlTowerServer = (env: Parameters<typeof createScopedControlTowerServer>[0]) =>
  createScopedControlTowerServer(env, { read: true, mutate: true });

describe("Control Tower MCP wire transport", () => {
  afterEach(() => vi.useRealTimers());
  it("returns an actionable bounded failure when ProjectGuard never answers", async () => {
    vi.useFakeTimers();
    const owner = { getByName: () => ({ fetch: () => new Promise<Response>(() => {}) }) } as unknown as DurableObjectNamespace;
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }));
    const response = await handler.fetch(new Request("https://project-os-control-tower.example/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project_os_get_context", arguments: { project_id: "PRJ-0007" } } })
    }));
    const text = response.text();
    await vi.advanceTimersByTimeAsync(10_001);
    const wire = await text;
    expect(wire).toContain("PROJECT_OS_READ_UNAVAILABLE");
    expect(wire).toContain("control_tower_to_project_guard");
    expect(wire).toContain("correlation_id");
  }, 2000);
  it.each(["2025-03-26", "2025-06-18"])("completes a context response for protocol %s", async (version) => {
    const owner = { getByName: () => ({ fetch: async () => Response.json({
      status: "ok", project_id: "PRJ-0007", revision: 82, freshness: "verified", observed_at: "2026-09-26T10:00:00.000Z",
      context: { project_id: "PRJ-0007", canonical_revision: 82 },
      canonical_state: { project_id: "PRJ-0007", revision: 82, tasks: {}, phases: {} }
    }) }) } as unknown as DurableObjectNamespace;
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }));
    const response = await handler.fetch(new Request("https://project-os-control-tower.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_os_get_context", arguments: { project_id: "PRJ-0007" } } })
    }));
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('"id":1');
    expect(wire).toContain('\\"revision\\":82');
  }, 5000);

  it("maps the transaction response_mode envelope to Prefer without changing request bytes", async () => {
    const calls: Array<{ path: string; prefer: string | null; body?: unknown }> = [];
    const owner = { getByName: () => ({ fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, prefer: new Headers(init?.headers).get("prefer"), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/mutation-context") return Response.json({ context: {
        actor: { actor_id: "tower-test", authority: "operator" }, project_id: "PRJ-0007", canonical_revision: 1,
        state_hash: "a".repeat(64), observed_at: "2026-09-26T10:00:00.000Z", expiry: "2026-09-26T10:05:00.000Z", token: "a.b"
      } });
      return Response.json({ schema_version: "1.0", transaction_id: "TXN-TOWER-ASYNC-0001", project_id: "PRJ-0007",
        status: "committed", previous_revision: 1, new_revision: 2, event_id: "EVT-000002", committed_at: "2026-09-26T10:01:00.000Z" });
    } }) } as unknown as DurableObjectNamespace;
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }));
    const response = await handler.fetch(new Request("https://project-os-control-tower.example/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "project_os_submit_transaction", arguments: {
        project_id: "PRJ-0007", response_mode: "respond_async", request: {
          schema_version: "1.0", transaction_id: "TXN-TOWER-ASYNC-0001", project_id: "PRJ-0007", base_revision: 1,
          operation: "task.create", created_at: "2026-09-26T10:01:00.000Z",
          payload: { task_id: "TASK-TOWERASYNC1", title: "Transport preference only" }
        }
      } } })
    }));
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('\\"status\\":\\"committed\\"');
    expect(calls.map(({ path }) => path)).toEqual(["/mutation-context", "/transaction"]);
    expect(calls[0]?.prefer).toBeNull();
    expect(calls[1]).toMatchObject({ prefer: "respond-async", body: {
      admission_version: "1.0", request: { transaction_id: "TXN-TOWER-ASYNC-0001" }
    } });
    expect(calls[1]?.body).not.toHaveProperty("response_mode");
  }, 5000);
});
