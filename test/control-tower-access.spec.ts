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
    const safeDiagnostic = {
      scope: "local_only", payload_present: true, payload_hash_valid: true,
      staged_marker_matches_payload: false, queue_present: false,
      failure_stopped: null, failure_attempts: null, failure_code: null,
      failure_next_attempt_at: null,
      failure_identity: {
        fingerprint: "b".repeat(64), classification: "internal", error_name: "Error",
        progress_sha256: "c".repeat(64), external_progress_sha256: "d".repeat(64)
      },
      alarm_readable: true, alarm_at: null,
      local_receipt_present: false, local_observation_present: null
    };
    let diagnostic: unknown = { ...safeDiagnostic, raw_payload: "nested-provider-secret",
      failure_identity: { ...safeDiagnostic.failure_identity, private_detail: "nested-provider-secret" } };
    let upstreamCode = "PROJECT_OS_READ_BUSY";
    const owner = { getByName: () => ({ fetch: async () => Response.json({
      project_id: "PRJ-0003", kind: "transaction", request_id: "TXN-ORIGINAL",
      status: "unknown", code: upstreamCode, private_detail: "provider-secret",
      local_recovery_diagnostic: diagnostic
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
    expect(body.local_recovery_diagnostic).toEqual(safeDiagnostic);
    expect(result.content[0]!.text).not.toContain("provider-secret");
    upstreamCode = "request_status_unavailable";
    diagnostic = { ...safeDiagnostic, raw_payload: "nested-provider-secret",
      failure_identity: { ...safeDiagnostic.failure_identity, private_detail: "nested-provider-secret" } };
    const unknownFallback = await server._registeredTools.project_os_get_request_status!.handler({
      project_id: "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction"
    });
    const unknownBody = JSON.parse(unknownFallback.content[0]!.text);
    expect(unknownBody).toMatchObject({ status: "unknown", code: "request_status_unavailable" });
    expect(unknownBody.local_recovery_diagnostic).toEqual(safeDiagnostic);
    expect(unknownFallback.content[0]!.text).not.toContain("provider-secret");
    diagnostic = { ...safeDiagnostic, payload_hash_valid: "invalid-provider-secret" };
    const invalid = await server._registeredTools.project_os_get_request_status!.handler({
      project_id: "PRJ-0003", request_id: "TXN-ORIGINAL", kind: "transaction"
    });
    expect(JSON.parse(invalid.content[0]!.text)).not.toHaveProperty("local_recovery_diagnostic");
    expect(invalid.content[0]!.text).not.toContain("provider-secret");
  });

  it("distinguishes an exhausted status observation from a busy Guard", async () => {
    const owner = { getByName: () => ({ fetch: async () => Response.json({
      project_id: "PRJ-0003", kind: "transaction", request_id: "TXN-ORIGINAL",
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

  it("preserves a bound document recovery acknowledgement without inventing a receipt", async () => {
    let returnedId = "DOCREQ-PENDING-ORIGINAL";
    const owner = { getByName: () => ({ fetch: async (url: string) => {
      if (new URL(url).pathname === "/mutation-context") return Response.json({ context: {
        actor: { actor_id: "tower-test", authority: "operator" }, project_id: "PRJ-0003", canonical_revision: 1,
        state_hash: "a".repeat(64), observed_at: "2026-09-26T10:00:00.000Z",
        expiry: "2026-09-26T10:05:00.000Z", token: "a.b"
      } });
      return Response.json({ project_id: "PRJ-0003", request_id: returnedId, status: "pending",
        code: "DOCUMENT_RECOVERY_SCHEDULED", private_detail: "private-provider-detail" }, { status: 503 });
    } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
    };
    const input = { project_id: "PRJ-0003", request: { project_id: "PRJ-0003",
      request_id: "DOCREQ-PENDING-ORIGINAL", operation: "working.write" } };
    const result = await server._registeredTools.project_os_write_working_document!.handler(input);
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED",
      request_id: "DOCREQ-PENDING-ORIGINAL", recovery: { owner: "system", action: "check_status",
        preserve_request_id: true, check_status_before_retry: true, requires_new_approval: false } });
    expect(body).not.toHaveProperty("receipt");
    expect(result).not.toHaveProperty("isError", true);
    expect(result.content[0]!.text).not.toContain("private-provider-detail");
    returnedId = "DOCREQ-DIFFERENT";
    const mismatched = await server._registeredTools.project_os_write_working_document!.handler(input);
    expect(JSON.parse(mismatched.content[0]!.text)).toMatchObject({ status: "unknown",
      code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: "DOCREQ-PENDING-ORIGINAL" });
  });

  it.each([
    { error: "rule_admission_invalid", safe: true },
    { error: "rule_admission_request_mismatch", safe: true },
    { error: "rule_admission_scope_mismatch", safe: true },
    { error: "rule_admission_ruleset_stale", safe: true },
    { error: "execution_identity_invalid", safe: true },
    { error: "execution_plan_invalid", safe: true },
    { error: "execution_required_postcheck_adapter_missing", safe: true },
    { error: "execution_required_postcheck_missing", safe: true },
    { error: "execution_resource_scope_unavailable", safe: true },
    { error: "execution_evidence_unavailable", safe: true },
    { error: "execution_private_provider_secret", safe: false },
    { error: "unknown_failure", safe: false },
    { error: ["rule_admission_invalid"], safe: false },
    { error: null, safe: false },
    { error: "rule_admission_invalid", http_status: 500, safe: false },
    { error: "rule_admission_invalid", array_body: true, safe: false },
    { error: "rule_admission_invalid", project_id: "PRJ-0007", safe: false },
    { error: "rule_admission_invalid", request_id: "DOCREQ-OTHER", safe: false }
  ])("keeps working-write recovery unknown while exposing only a bound safe upstream code: $error", async (fixture) => {
    const calls: string[] = [];
    const owner = { getByName: () => ({ fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/mutation-context") return Response.json({ context: {
        actor: { actor_id: "tower-test", authority: "operator" }, project_id: "PRJ-0003", canonical_revision: 1,
        state_hash: "a".repeat(64), observed_at: "2026-09-26T10:00:00.000Z",
        expiry: "2026-09-26T10:05:00.000Z", token: "a.b"
      } });
      expect(path).toBe("/document");
      expect(JSON.parse(String(init?.body))).toMatchObject({ admission_version: "1.0", request: {
        project_id: "PRJ-0003", request_id: "DOCREQ-SAFE-ORIGINAL", operation: "working.write"
      } });
      const { safe: _safe, ...response } = fixture;
      const responseBody = { ...response, private_detail: "provider-secret", token: "private-token", content: "private-document" };
      return Response.json("array_body" in fixture ? [responseBody] : responseBody,
        { status: "http_status" in fixture ? fixture.http_status : 503 });
    } }) } as unknown as DurableObjectNamespace;
    const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: true }) as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>
    };
    const result = await server._registeredTools.project_os_write_working_document!.handler({
      project_id: "PRJ-0003", request: { project_id: "PRJ-0003", request_id: "DOCREQ-SAFE-ORIGINAL", operation: "working.write" }
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ status: "unknown", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE",
      request_id: "DOCREQ-SAFE-ORIGINAL", failed_boundary: "submission", recovery: {
        owner: "system", action: "check_status", preserve_request_id: true, check_status_before_retry: true,
        requires_new_approval: false, next_attempt_at: null
      } });
    expect(result.isError).toBe(true);
    expect(body).not.toHaveProperty("receipt");
    if (fixture.safe) expect(body.upstream_error).toEqual({ code: fixture.error, http_status: 503 });
    else expect(body).not.toHaveProperty("upstream_error");
    expect(result.content[0]!.text).not.toMatch(/provider-secret|private-token|private-document|execution_private_provider_secret|unknown_failure/);
    expect(calls).toEqual(["GET /mutation-context", "POST /document"]);
  });

it.each([
    ...["rule_admission_invalid", "rule_admission_request_mismatch", "rule_admission_scope_mismatch",
      "rule_admission_ruleset_stale", "execution_identity_invalid", "execution_plan_invalid",
      "execution_required_postcheck_adapter_missing", "execution_required_postcheck_missing",
      "execution_resource_scope_unavailable", "execution_evidence_unavailable"].map(error => ({ error, safe: true })),
    { error: "rule_admission_invalid", transaction_id: "TXN-SAFE-ORIGINAL", safe: true },
    { error: "rule_admission_invalid", request_id: "TXN-SAFE-ORIGINAL", safe: true },
    { error: "rule_admission_invalid", transaction_id: "TXN-SAFE-ORIGINAL", request_id: "TXN-SAFE-ORIGINAL", project_id: "PRJ-0003", safe: true },
    { error: "rule_admission_invalid", transaction_id: "TXN-OTHER", safe: false },
    { error: "rule_admission_invalid", transaction_id: null, safe: false },
    { error: "rule_admission_invalid", transaction_id: 7, safe: false },
    { error: "rule_admission_invalid", request_id: null, safe: false },
    { error: "rule_admission_invalid", request_id: "TXN-OTHER", safe: false },
    { error: "rule_admission_invalid", transaction_id: "TXN-SAFE-ORIGINAL", request_id: "TXN-OTHER", safe: false },
    { error: "rule_admission_invalid", transaction_id: "TXN-OTHER", request_id: "TXN-SAFE-ORIGINAL", safe: false },
    { error: "rule_admission_invalid", project_id: null, safe: false },
    { error: "rule_admission_invalid", project_id: "PRJ-0007", safe: false },
    { error: ["rule_admission_invalid"], safe: false },
    { error: null, safe: false },
    { error: "provider-private-secret", safe: false },
    { error: "rule_admission_invalid", http_status: 500, safe: false },
    { error: "rule_admission_invalid", array_body: true, safe: false },
    { error: "rule_admission_invalid", context_failure: true, safe: false },
    { error: "rule_admission_invalid", family: "artifact", safe: false },
    { error: "rule_admission_invalid", family: "other_document", safe: false },
    { error: "rule_admission_invalid", family: "create", safe: false }
  ])("relays ordinary transaction safe diagnostic only with consistent optional bindings: %j", async fixture => {
    const calls: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if(path === "/mutation-context" && !("context_failure" in fixture)) return Response.json({context:{
        actor:{actor_id:"tower-test",authority:"operator"},project_id:"PRJ-0003",canonical_revision:1,
        state_hash:"a".repeat(64),observed_at:"2026-09-26T10:00:00.000Z",expiry:"2026-09-26T10:05:00.000Z",token:"a.b"
      }});
      if(init?.method === "POST" && !("family" in fixture)) expect(JSON.parse(String(init.body))).toMatchObject({
        admission_version:"1.0", mutation_context:{token:"a.b"},request:{transaction_id:"TXN-SAFE-ORIGINAL"}
      });
      const {safe:_safe,...fields}=fixture;
      return Response.json("array_body" in fixture ? [fields] : {...fields,private_detail:"provider-private-secret",token:"private-token",content:"private-document"},
        {status:"http_status" in fixture ? fixture.http_status : 503});
    };
    const owner = {getByName:()=>({fetch})} as unknown as DurableObjectNamespace;
    const server=createControlTowerServer({PROJECT_GUARD:owner,REGISTRY_GUARD:owner},{read:true,mutate:true}) as unknown as {
      _registeredTools:Record<string,{handler(input:unknown):Promise<{isError?:boolean;content:Array<{text:string}>}>}>
    };
    const family="family" in fixture ? fixture.family : "transaction";
    const project_id=family==="create" ? "PRJ-AUTO":"PRJ-0003";
    const tool=family==="artifact" ? "project_os_submit_artifact":family==="other_document" ? "project_os_write_working_document":"project_os_submit_transaction";
    const result=await server._registeredTools[tool]!.handler({project_id,request:{
      project_id,transaction_id:"TXN-SAFE-ORIGINAL",request_id:"TXN-SAFE-ORIGINAL",
      operation:family==="create"?"project.create":family==="other_document"?"review.promote":"decision.accept"
    }});
    const body=JSON.parse(result.content[0]!.text);
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({status:"context_failure" in fixture?"not_submitted":"unknown",
      code:"PROJECT_OS_SUBMISSION_UNAVAILABLE",failed_boundary:"context_failure" in fixture?"context":"submission"});
    expect(body).not.toHaveProperty("receipt");
    expect(body.correlation_id).toMatch(/^[a-f0-9-]{36}$/);
    if(fixture.safe) expect(body.upstream_error).toEqual({code:fixture.error,http_status:503});
    else expect(body).not.toHaveProperty("upstream_error");
    expect(result.content[0]!.text).not.toMatch(/provider-private-secret|private-token|private-document/);
    expect(calls).toEqual(family==="create"?["POST /create"]:"context_failure" in fixture?["GET /mutation-context"]:
      ["GET /mutation-context",family==="artifact"?"POST /artifact":family==="other_document"?"POST /document":"POST /transaction"]);
  });

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
