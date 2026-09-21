import { describe, expect, it } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { createControlTowerServer } from "../src/control-tower/mcp";

describe("Control Tower typed tool contracts", () => {
  it("publishes the strict transaction contract instead of an opaque request", async () => {
    const owner = { getByName: () => ({ fetch: async () => Response.json({}) }) } as unknown as DurableObjectNamespace;
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }));

    const response = await handler.fetch(new Request("https://project-os-control-tower.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    }));

    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain("project_os_submit_transaction");
    expect(wire).toContain("transaction_id");
    expect(wire).toContain("decision.accept");
    expect(wire).toContain("project_os_write_working_document");
    expect(wire).toContain("working.write");
  });

  it("submits project.create through RegistryGuard without reading a non-existent PRJ-AUTO guard", async () => {
    const projectGuardLookups: string[] = [];
    const registryRequests: string[] = [];
    const projectGuard = {
      getByName: (name: string) => {
        projectGuardLookups.push(name);
        return { fetch: async () => Response.json({ error: "not_found" }, { status: 404 }) };
      }
    } as unknown as DurableObjectNamespace;
    const registryGuard = {
      getByName: () => ({
        fetch: async (url: string) => {
          registryRequests.push(url);
          return Response.json({ status: "committed", project_id: "PRJ-0009" });
        }
      })
    } as unknown as DurableObjectNamespace;
    const handler = createMcpHandler(() => createControlTowerServer({ PROJECT_GUARD: projectGuard, REGISTRY_GUARD: registryGuard }));

    const response = await handler.fetch(new Request("https://project-os-control-tower.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "project_os_submit_transaction",
          arguments: {
            project_id: "PRJ-AUTO",
            request: {
              schema_version: "1.0", transaction_id: "TXN-PROJECT-CREATE-0001", project_id: "PRJ-AUTO", base_revision: 0,
              operation: "project.create", created_at: "2026-09-21T12:00:00Z",
              payload: { name: "New project", slug: "new-project", aliases: [], objective: "Test governed creation" }
            }
          }
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(projectGuardLookups).toEqual([]);
    expect(registryRequests).toEqual(["https://project-guard.internal/create"]);
  });
});
