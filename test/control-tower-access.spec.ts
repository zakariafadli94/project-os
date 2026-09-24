import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_EMAIL, resolveTokenAccess } from "../src/control-tower/auth";
import { createControlTowerServer } from "../src/control-tower/mcp";
import { controlTowerApiHandler } from "../src/control-tower/index";
import { createExecutionContext } from "cloudflare:test";

describe("effective Control Tower token permissions", () => {
  afterEach(() => vi.useRealTimers());

  it("wires effective OAuth scopes into the actual MCP handler", async () => {
    const getByName = vi.fn();
    const environment = {
      OAUTH_KV: {} as KVNamespace, GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: "unused-test-secret",
      CONTROL_TOWER_PUBLIC_URL: "https://tower",
      PROJECT_GUARD: { getByName } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName } as unknown as DurableObjectNamespace,
      OAUTH_PROVIDER: { unwrapToken: async () => ({ scope: ["project.read"], grant: { props: { email: ALLOWED_EMAIL } } }) }
    };
    const response = await controlTowerApiHandler.fetch(new Request("https://tower/mcp", {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "project_os_submit_transaction", arguments: { project_id: "PRJ-AUTO", request: {
          schema_version: "1.0", transaction_id: "TXN-AUTH-CREATE-0001", project_id: "PRJ-AUTO", base_revision: 0,
          operation: "project.create", created_at: "2026-09-24T11:00:00Z",
          payload: { name: "Fixture", slug: "fixture", aliases: [], objective: "Local qualification" }
        } }
      } })
    }), environment, createExecutionContext());
    expect(await response.text()).toContain("insufficient_scope");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("never calls a mutation owner for read-only or missing access", async () => {
    const getByName = vi.fn();
    const bindings = { PROJECT_GUARD: { getByName } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName } as unknown as DurableObjectNamespace };
    for (const access of [undefined, { read: true, mutate: false }]) {
      const server = createControlTowerServer(bindings, access) as unknown as {
        _registeredTools: Record<string, { handler(input: unknown): Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>
      };
      for (const tool of ["project_os_submit_transaction", "project_os_write_working_document", "project_os_submit_artifact"]) {
        const result = await server._registeredTools[tool]!.handler({ project_id: "PRJ-0003", request: { transaction_id: "TXN-ACCESS", request_id: "REQ-ACCESS" } });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "not_submitted", code: "insufficient_scope" });
      }
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("uses downscoped token permissions, never the broader grant", async () => {
    const unwrapToken = vi.fn(async () => ({
      scope: ["project.read"],
      grant: { scope: ["project.read", "project.mutate"], props: { email: ALLOWED_EMAIL } }
    }));
    const result = await resolveTokenAccess(new Request("https://tower/mcp", {
      headers: { authorization: "Bearer private-token" }
    }), { unwrapToken });
    expect(result).toEqual({ read: true, mutate: false });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it.each([null, { scope: ["project.read"], grant: { props: { email: "other@example.com" } } },
    { scope: ["project.mutate"], grant: { props: { email: ALLOWED_EMAIL } } }])(
    "fails closed on missing identity or insufficient read scope", async (token) => {
      expect(await resolveTokenAccess(new Request("https://tower/mcp", {
        headers: { authorization: "Bearer private-token" }
      }), { unwrapToken: async () => token })).toBeNull();
    }
  );

  it("bounds token lookup without leaking provider exceptions", async () => {
    vi.useFakeTimers();
    const result = resolveTokenAccess(new Request("https://tower/mcp", {
      headers: { authorization: "Bearer private-token" }
    }), { unwrapToken: () => new Promise(() => {}) });
    const observed = result.catch(error => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await observed).toMatchObject({ message: "control_tower_authority_unavailable" });
  });

  it("keeps the exact request identity and recovery action on a status read outage", async () => {
    const owner = { getByName: () => ({ fetch: async () => { throw new Error("private-provider-detail"); } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
    };
    const result = await server._registeredTools.project_os_get_request_status!.handler({ project_id: "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ request_id: "TXN-ORIGINAL",
      recovery: { action: "check_status", preserve_request_id: true, requires_new_approval: false } });
    expect(result.content[0]!.text).not.toContain("private-provider-detail");
  });

  it("preserves a known busy status and retry delay without exposing Guard details", async () => {
    const owner = { getByName: () => ({ fetch: async () => Response.json({
      status: "unknown", code: "PROJECT_OS_READ_BUSY", private_detail: "provider-secret"
    }, { status: 503, headers: { "Retry-After": "1" } }) }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
    };
    const result = await server._registeredTools.project_os_get_request_status!.handler({
      project_id: "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction"
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ status: "unavailable", code: "PROJECT_OS_READ_BUSY", retry_after_seconds: 1,
      request_id: "TXN-ORIGINAL", recovery: { action: "check_status", preserve_request_id: true } });
    expect(result.content[0]!.text).not.toContain("provider-secret");
  });

  it("distinguishes an exhausted status observation from a busy Guard", async () => {
    const owner = { getByName: () => ({ fetch: async () => Response.json({
      status: "unknown", code: "request_status_unavailable", private_detail: "provider-secret"
    }, { status: 503, headers: { "Retry-After": "1" } }) }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
    };
    const result = await server._registeredTools.project_os_get_request_status!.handler({
      project_id: "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction"
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ status: "unknown", code: "request_status_unavailable",
      request_id: "TXN-ORIGINAL", recovery: { action: "check_status", preserve_request_id: true },
      observation: { status: "unknown", terminal: false, project_id: "PRJ-0003",
        kind: "transaction", request_id: "TXN-ORIGINAL", code: "request_status_unavailable" } });
    expect(result.content[0]!.text).not.toContain("provider-secret");
  });

  it.each(["project_os_get_context", "project_os_get_context_detail", "project_os_get_request_status", "project_os_get_receipt"])(
    "provides recovery instructions for HTTP dependency failures in %s", async (tool) => {
      const owner = { getByName: () => ({ fetch: async () => Response.json({ error: "private-provider-detail" }, { status: 503 }) }) } as unknown as DurableObjectNamespace;
      const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
        _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
      };
      const lookup = tool.endsWith("status") || tool.endsWith("receipt");
      const result = await server._registeredTools[tool]!.handler({
        project_id: lookup ? "PRJ-AUTO" : "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction",
        revision: 1, entity_type: "project", entity_id: "PRJ-0003", field: "objective"
      });
      const body = JSON.parse(result.content[0]!.text);
      expect(body).toMatchObject({ correlation_id: expect.any(String),
        recovery: { owner: "system", action: lookup ? "check_status" : "retry_context_read",
          next_attempt_at: null, requires_new_approval: false } });
      if (lookup) expect(body.request_id).toBe("TXN-ORIGINAL");
      expect(result.content[0]!.text).not.toContain("private-provider-detail");
    }
  );

  it("assigns a technical recovery action after an ambiguous submission", async () => {
    const owner = { getByName: () => ({ fetch: async () => { throw new Error("private-provider-detail"); } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
    };
    const result = await server._registeredTools.project_os_submit_transaction!.handler({
      project_id: "PRJ-AUTO", request: { project_id: "PRJ-AUTO", transaction_id: "TXN-ORIGINAL", operation: "project.create" }
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unknown", request_id: "TXN-ORIGINAL",
      recovery: { owner: "system", action: "check_status", dependency: "control_tower_to_registry_guard",
        requires_new_approval: false, next_attempt_at: null, check_status_before_retry: true } });
  });
});
