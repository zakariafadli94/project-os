import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { createControlTowerServer } from "../src/control-tower/mcp";

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
});
