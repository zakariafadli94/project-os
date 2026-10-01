import { describe, expect, it } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { requireGovernedNavigationTool, successfulMcpResult } from "../scripts/control-tower-qualification.mjs";
import { createControlTowerServer as createScopedControlTowerServer } from "../src/control-tower/mcp";
const createControlTowerServer = (env: Parameters<typeof createScopedControlTowerServer>[0]) =>
  createScopedControlTowerServer(env, { read: true, mutate: true });

describe("Control Tower typed tool contracts", () => {
  it("preserves validated admission gaps on a sanitized business refusal without leaking other fields", async () => {
    const admissionGap = {
      rule: { rule_id: "RULE-GAP-RECEIPT-0001", version: 1, scope: { kind: "global" } },
      code: "ACCEPTED_UNENFORCED",
      check_id: "expected_version"
    };
    const owner = { getByName: () => ({ fetch: async (url: string) => {
      if (new URL(url).pathname === "/mutation-context") return Response.json({ context: {
        actor: { actor_id: "control_tower", authority: "control_tower_operator" },
        project_id: "PRJ-0007", canonical_revision: 1, state_hash: "a".repeat(64),
        observed_at: "2026-09-29T10:00:00.000Z", expiry: "2026-09-29T10:05:00.000Z", token: "synthetic.test"
      } });
      return Response.json({
        schema_version: "1.0", transaction_id: "TXN-GAP-REFUSAL-0001", project_id: "PRJ-0007",
        status: "conflict", previous_revision: 1, new_revision: 1, code: "TASK_EXISTS",
        gaps: [admissionGap], private_provider_body: "must-not-escape"
      });
    } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }) as any;

    const result = await server._registeredTools.project_os_submit_transaction.handler({
      project_id: "PRJ-0007", request: {
        schema_version: "1.0", transaction_id: "TXN-GAP-REFUSAL-0001", project_id: "PRJ-0007",
        base_revision: 1, operation: "task.create", created_at: "2026-09-29T10:01:00.000Z",
        payload: { task_id: "TASK-GAPREFUSAL1", title: "Expose immutable admission gap" }
      }
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ status: "conflict", code: "TASK_EXISTS", gaps: [admissionGap] });
    expect(JSON.stringify(body)).not.toContain("must-not-escape");
  });

  it("reports an unavailable rule adapter as a precise refusal, not an ambiguous submission", async () => {
    const owner = { getByName: () => ({ fetch: async (url: string) => {
      if (new URL(url).pathname === "/mutation-context") return Response.json({ context: {
        actor: { actor_id: "control_tower", authority: "control_tower_operator" },
        project_id: "PRJ-0007", canonical_revision: 1, state_hash: "a".repeat(64),
        observed_at: "2026-09-29T10:00:00.000Z", expiry: "2026-09-29T10:05:00.000Z", token: "synthetic.test"
      } });
      return Response.json({
        error: "RULE_POSTCHECK_ADAPTER_UNAVAILABLE",
        rule: { rule_id: "RULE-PRESENCE-0001", version: 2, scope: { kind: "global" } },
        expected: "Implemented finalization adapter", observed: "No adapter for this operation",
        required_action: "Equip and qualify the adapter before activating this rule",
        private_provider_body: "must-not-escape"
      }, { status: 503 });
    } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }) as any;
    const result = await server._registeredTools.project_os_submit_transaction.handler({
      project_id: "PRJ-0007", request: {
        schema_version: "1.0", transaction_id: "TXN-ADAPTER-REFUSAL-0001", project_id: "PRJ-0007",
        base_revision: 1, operation: "task.create", created_at: "2026-09-29T10:01:00.000Z",
        payload: { task_id: "TASK-ADAPTERREFUSAL1", title: "Keep rejected admission uncommitted" }
      }
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ status: "rejected", code: "RULE_POSTCHECK_ADAPTER_UNAVAILABLE",
      rule: { rule_id: "RULE-PRESENCE-0001", version: 2 },
      expected: "Implemented finalization adapter", observed: "No adapter for this operation",
      required_action: "Equip and qualify the adapter before activating this rule",
      recovery: { preserve_request_id: true, check_status_before_retry: false }
    });
    expect(body).not.toHaveProperty("new_revision");
    expect(JSON.stringify(body)).not.toContain("must-not-escape");
  });

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
    const discovery = successfulMcpResult(wire, 1) as { tools: Array<{ name: string; inputSchema: unknown }> };
    const documentSchema = JSON.stringify(discovery.tools.find(tool => tool.name === "project_os_write_working_document")?.inputSchema);
    expect(documentSchema).toContain("navigation.reconcile");
    expect(documentSchema).toContain("expected_generation");
    expect(documentSchema).toContain("expected_index");
    expect(() => requireGovernedNavigationTool(discovery.tools)).not.toThrow();
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
          return Response.json({ status: "committed", project_id: "PRJ-0009", transaction_id: "TXN-PROJECT-CREATE-0001" });
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
    expect(registryRequests).toEqual(["https://registry-guard.internal/create"]);
    const result = successfulMcpResult(await response.text(), 2) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "committed", transaction_id: "TXN-PROJECT-CREATE-0001" });
  });
});
