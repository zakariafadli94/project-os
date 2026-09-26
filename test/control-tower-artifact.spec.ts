import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlTowerServer as createScopedControlTowerServer } from "../src/control-tower/mcp";
import { summarizeCanonicalContext } from "../src/control-tower/context";
const createControlTowerServer = (env: Parameters<typeof createScopedControlTowerServer>[0]) =>
  createScopedControlTowerServer(env, { read: true, mutate: true });

const artifact = {
  request_id: "ART-CONTROL-TOWER-0001",
  project_id: "PRJ-0007",
  relative_path: "DELIVERABLES/AMM-PROGRAMME-1/C2/canary.xlsx",
  content_sha256: "a".repeat(64),
  mode: "create" as const,
  source: {
    kind: "staged_provider_object" as const,
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-CONTROL-TOWER-0001/canary.xlsx",
    object_id: "id:canary",
    revision_token: "rev-canary",
    size: 123,
    integrity: { algorithm: "dropbox-content-hash", value: "provider-hash" }
  }
};

const validMutationContext = (projectId = "PRJ-0007") => ({
  actor: { actor_id: "actor-test", authority: "operator" }, project_id: projectId, canonical_revision: 1,
  state_hash: "a".repeat(64), observed_at: "2026-09-24T10:00:00.000Z", expiry: "2026-09-24T10:05:00.000Z", token: "a.b"
});

describe("Control Tower governed artifact submission", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["context", "submission"])("reports recoverable transport failure at %s without resubmitting", async (boundary) => {
    const calls: string[] = [];
    const stub = { fetch: async (input: string) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === "/mutation-context" && boundary === "submission") return Response.json({ context: validMutationContext() });
      throw new Error("provider private diagnostic");
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: boundary === "context" ? "not_submitted" : "unknown",
      code: "PROJECT_OS_SUBMISSION_UNAVAILABLE",
      request_id: artifact.request_id,
      failed_boundary: boundary,
      recovery: { preserve_request_id: true, check_status_before_retry: boundary === "submission" }
    });
    expect(result.content[0]!.text).not.toContain("provider private diagnostic");
    expect(calls).toEqual(boundary === "context" ? ["/mutation-context"] : ["/mutation-context", "/artifact"]);
  });
  it("reads the receipt endpoint without triggering request recovery", async () => {
    const calls: string[] = [];
    const stub = {
      fetch: async (input: string) => {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/receipt") return Response.json({ status: "committed", request_id: artifact.request_id });
        return Response.json({ error: "unexpected_route" }, { status: 500 });
      }
    };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> };

    const result = await server._registeredTools.project_os_get_receipt.handler({ project_id: "PRJ-0007", request_id: artifact.request_id, kind: "artifact" });
    expect(calls).toEqual([`/receipt?request_id=${artifact.request_id}&kind=artifact`]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ status: "committed", request_id: artifact.request_id });
  });

  it("keeps request status separate and preserves non-2xx receipt responses as tool errors", async () => {
    const calls: string[] = [];
    const stub = {
      fetch: async (input: string) => {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/receipt") return Response.json({ error: "receipt_not_found" }, { status: 404 });
        if (url.pathname === "/request-status") return Response.json({
          status: "committed",
          receipt: { status: "committed", request_id: artifact.request_id },
          execution: { status: "finalizing", terminal: false }
        });
        return Response.json({ error: "unexpected_route" }, { status: 500 });
      }
    };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };

    const missingReceipt = await server._registeredTools.project_os_get_receipt.handler({ project_id: "PRJ-0007", request_id: artifact.request_id, kind: "artifact" });
    const requestStatus = await server._registeredTools.project_os_get_request_status.handler({ project_id: "PRJ-0007", request_id: artifact.request_id, kind: "artifact" });

    expect(missingReceipt.isError).toBe(true);
    expect(JSON.parse(missingReceipt.content[0]!.text)).toMatchObject({ error: "receipt_not_found",
      request_id: artifact.request_id, recovery: { action: "check_status", requires_new_approval: false } });
    expect(calls).toEqual([
      `/receipt?request_id=${artifact.request_id}&kind=artifact`,
      `/request-status?request_id=${artifact.request_id}&kind=artifact`
    ]);
    expect(JSON.parse(requestStatus.content[0]!.text)).toMatchObject({ status: "committed", execution: { status: "finalizing", terminal: false } });
  });

  it("sends a staged artifact with fresh signed admission to ProjectGuard", async () => {
    const calls: Array<{ path: string; body?: unknown; correlation?: string | null; signal?: AbortSignal | null }> = [];
    const stub = {
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        calls.push({ path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined,
          correlation: new Headers(init?.headers).get("x-project-os-correlation-id"), signal: init?.signal });
        if (url.pathname === "/mutation-context") {
          return Response.json({ context: validMutationContext() });
        }
        return Response.json({ status: "committed", request_id: artifact.request_id, project_id: artifact.project_id });
      }
    };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> };

    const result = await server._registeredTools.project_os_submit_artifact.handler({
      project_id: "PRJ-0007",
      request: artifact
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(calls).toEqual([
      expect.objectContaining({ path: "/mutation-context?include_state=false", correlation: expect.any(String), signal: expect.any(AbortSignal) }),
      {
        path: "/artifact",
        correlation: calls[0]!.correlation,
        signal: calls[0]!.signal,
        body: {
          admission_version: "1.0",
          request: artifact,
          mutation_context: validMutationContext()
        }
      }
    ]);
  });

  it("bounds context fetch by its 10-second deadline and never submits without context", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    let releaseContext!: (response: Response) => void;
    const calls: string[] = [];
    const stub = { fetch: async (input: string, init?: RequestInit) => {
      calls.push(new URL(input).pathname);
      receivedSignal = init?.signal;
      return await new Promise<Response>((resolve) => { releaseContext = resolve; });
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const pending = server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    await vi.advanceTimersByTimeAsync(10_001);
    await Promise.resolve();
    const result = await pending;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "not_submitted", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: artifact.request_id,
      failed_boundary: "context", recovery: { preserve_request_id: true, check_status_before_retry: false }
    });
    releaseContext(Response.json({ context: validMutationContext() }));
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(calls).toEqual(["/mutation-context"]);
  }, 2000);

  it("keeps one ordinary submission alive for 30 seconds and returns committed without aborting", async () => {
    vi.useFakeTimers();
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-CONTROL-TOWER-30000", project_id: "PRJ-0007", operation: "decision.accept",
      base_revision: 1, created_at: "2026-09-24T10:00:00.000Z", payload: {}
    };
    let submissionSignal: AbortSignal | null | undefined;
    const stub = { fetch: async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === "/mutation-context") return Response.json({ context: validMutationContext() });
      submissionSignal = init?.signal;
      return await new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({
        status: "committed", transaction_id: transaction.transaction_id, project_id: transaction.project_id
      })), 30_000));
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const pending = server._registeredTools.project_os_submit_transaction.handler({ project_id: transaction.project_id, request: transaction });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "committed", transaction_id: transaction.transaction_id });
    expect(submissionSignal?.aborted).toBe(false);
  }, 2000);

  it("bounds response JSON parsing at 40 seconds after the one POST and returns unknown without retry", async () => {
    vi.useFakeTimers();
    const calls: Array<{ path: string; correlation: string | null; signal: AbortSignal | null }> = [];
    const blockedJson = { ok: true, json: () => new Promise<unknown>(() => {}) } as unknown as Response;
    const stub = { fetch: async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push({ path, correlation: new Headers(init?.headers).get("x-project-os-correlation-id"), signal: init?.signal ?? null });
      return path === "/mutation-context" ? Response.json({ context: validMutationContext() }) : blockedJson;
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const pending = server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    await vi.advanceTimersByTimeAsync(10_001);
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls[1]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    await Promise.resolve();
    const result = await pending;
    expect(calls.map((call) => call.path)).toEqual(["/mutation-context", "/artifact"]);
    expect(calls[1]!.correlation).toBeTruthy();
    expect(calls[1]!.correlation).toBe(calls[0]!.correlation);
    expect(calls[1]!.signal).toBe(calls[0]!.signal);
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "unknown", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: artifact.request_id,
      failed_boundary: "submission", recovery: { preserve_request_id: true, check_status_before_retry: true }
    });
  }, 2000);

  it.each([
    ["missing", {}], ["null", { context: null }], ["malformed", { context: { token: "not-a-context" } }],
    ["wrong project", { context: validMutationContext("PRJ-0008") }]
  ])("does not submit when mutation context is %s", async (_label, body) => {
    const calls: string[] = [];
    const stub = { fetch: async (input: string) => {
      const path = new URL(input).pathname; calls.push(path);
      return Response.json(body);
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "not_submitted", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: artifact.request_id,
      failed_boundary: "context", recovery: { preserve_request_id: true, check_status_before_retry: false }
    });
    expect(result.content[0]!.text).not.toContain("not-a-context");
    expect(calls).toEqual(["/mutation-context"]);
  });

  it("returns unknown for HTTP 5xx after POST without exposing the response body", async () => {
    const calls: string[] = [];
    const stub = { fetch: async (input: string) => {
      const path = new URL(input).pathname; calls.push(path);
      if (path === "/mutation-context") return Response.json({ context: validMutationContext() });
      return Response.json({ error: "provider secret diagnostic" }, { status: 502 });
    } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "unknown", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: artifact.request_id,
      failed_boundary: "submission", recovery: { preserve_request_id: true, check_status_before_retry: true }
    });
    expect(result.content[0]!.text).not.toContain("provider secret diagnostic");
    expect(calls).toEqual(["/mutation-context", "/artifact"]);
  });

  it.each([null, {}, { status: "committed", request_id: "ART-OTHER-0001", project_id: "PRJ-0007" }])(
    "returns unknown for an invalid or mismatched successful POST response (%#)", async (payload) => {
      const stub = { fetch: async (input: string) => new URL(input).pathname === "/mutation-context"
        ? Response.json({ context: validMutationContext() })
        : Response.json(payload) };
      const server = createControlTowerServer({
        PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
        REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
      }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
      const result = await server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        status: "unknown", code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: artifact.request_id,
        failed_boundary: "submission", recovery: { preserve_request_id: true, check_status_before_retry: true }
      });
    }
  );

  it("preserves only allowlisted capacity refusal diagnostics from ProjectGuard", async () => {
    const stub = { fetch: async (input: string) => new URL(input).pathname === "/mutation-context"
      ? Response.json({ context: validMutationContext() })
      : Response.json({ error: "convergence_capacity_exceeded", detail: {
        reason: "queued_outputs_exceeded", canonical_revision: 17, materialized_revision: 12,
        queued_outputs: 205, oldest_pending_seconds: 680, blocking_obligation: { layer: "state", target_revision: 17, code: "pending" },
        retry_after_seconds: 90, provider_secret: "do-not-copy"
      } }, { status: 503 }) };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_submit_artifact.handler({ project_id: artifact.project_id, request: artifact });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "rejected", code: "convergence_capacity_exceeded", request_id: artifact.request_id,
      reason: "queued_outputs_exceeded", canonical_revision: 17, materialized_revision: 12,
      queued_outputs: 205, oldest_pending_seconds: 680,
      blocking_obligation: { layer: "state", target_revision: 17, code: "pending" }, retry_after_seconds: 90
    });
    expect(result.content[0]!.text).not.toContain("provider_secret");
  });

  it("routes PRJ-AUTO receipt lookup to Registry create-status using the original transaction id", async () => {
    const calls: string[] = [];
    const registry = { fetch: async (input: string) => {
      const url = new URL(input); calls.push(`${url.pathname}${url.search}`);
      return Response.json({ transaction_id: "TXN-CREATE-000001", status: "committed", project_id: "PRJ-0008" });
    } };
    const projectGuard = { fetch: async () => { throw new Error("must not query ProjectGuard for PRJ-AUTO"); } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => projectGuard } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => registry } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_get_receipt.handler({ project_id: "PRJ-AUTO", request_id: "TXN-CREATE-000001", kind: "transaction" });
    const invalidKind = await server._registeredTools.project_os_get_receipt.handler({ project_id: "PRJ-AUTO", request_id: "ART-CONTROL-TOWER-0001", kind: "artifact" });
    expect(calls).toEqual(["/create-status?transaction_id=TXN-CREATE-000001"]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ transaction_id: "TXN-CREATE-000001", status: "committed", project_id: "PRJ-0008" });
    expect(invalidKind.isError).toBe(true);
    expect(JSON.parse(invalidKind.content[0]!.text)).toMatchObject({ status: "rejected", code: "invalid_auto_project_status_kind" });
  });

  it("fails closed when Registry create-status returns a different transaction id", async () => {
    const registry = { fetch: async () => Response.json({ transaction_id: "TXN-CREATE-OTHER", status: "committed", project_id: "PRJ-0008" }) };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => ({ fetch: async () => { throw new Error("unexpected ProjectGuard route"); } }) } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => registry } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const result = await server._registeredTools.project_os_get_receipt.handler({ project_id: "PRJ-AUTO", request_id: "TXN-CREATE-000001", kind: "transaction" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "unknown", code: "PROJECT_OS_CREATE_STATUS_IDENTITY_MISMATCH" });
    expect(result.content[0]!.text).not.toContain("TXN-CREATE-OTHER");
  });

  it("keeps a timed-out create to one Registry POST and recovers the same transaction id through read-only status", async () => {
    vi.useFakeTimers();
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-CREATE-000002", project_id: "PRJ-AUTO", operation: "project.create",
      base_revision: 0, created_at: "2026-09-24T10:00:00.000Z",
      payload: { name: "New Project", slug: "new-project", aliases: [], objective: "Test create status recovery" }
    };
    const calls: Array<{ path: string; method: string; transactionId?: string }> = [];
    const registry = { fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ path: url.pathname, method: init?.method ?? "GET", transactionId: url.searchParams.get("transaction_id") ?? undefined });
      if (url.pathname === "/create") return await new Promise<Response>(() => {});
      return Response.json({ transaction_id: transaction.transaction_id, status: "committed", project_id: "PRJ-0008" });
    } };
    const projectGuard = { fetch: async () => { throw new Error("create must not read ProjectGuard context"); } };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => projectGuard } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => registry } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> };
    const submission = server._registeredTools.project_os_submit_transaction.handler({ project_id: "PRJ-AUTO", request: transaction });
    let settled = false;
    void submission.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_001);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    const submissionResult = await submission;
    expect(JSON.parse(submissionResult.content[0]!.text)).toMatchObject({
      status: "unknown", request_id: transaction.transaction_id,
      recovery: { preserve_request_id: true, check_status_before_retry: true }
    });
    const lookup = await server._registeredTools.project_os_get_request_status.handler({ project_id: "PRJ-AUTO", request_id: transaction.transaction_id, kind: "transaction" });
    expect(JSON.parse(lookup.content[0]!.text)).toMatchObject({ transaction_id: transaction.transaction_id, status: "committed", project_id: "PRJ-0008" });
    expect(calls).toEqual([
      { path: "/create", method: "POST" },
      { path: "/create-status", method: "GET", transactionId: transaction.transaction_id }
    ]);
  }, 2000);

  it("returns the current phase and paginates bounded context details with a stable cursor", async () => {
    const canonicalState = {
      project_id: "PRJ-0007",
      name: "Atlantic Machinery",
      slug: "atlantic-machinery",
      status: "active",
      revision: 76,
      current_phase_id: "PHASE-CURRENT",
      plan_phases: {
        "PHASE-CURRENT": { phase_id: "PHASE-CURRENT", title: "Current", status: "active", objective: "x".repeat(200_000), next_actions: [], created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
        "PHASE-HISTORY": { phase_id: "PHASE-HISTORY", title: "History", status: "completed", objective: "y".repeat(200_000), next_actions: [], created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }
      },
      tasks: Object.fromEntries(Array.from({ length: 55 }, (_, index) => {
        const taskId = `TASK-${String(index + 1).padStart(3, "0")}`;
        return [taskId, { task_id: taskId, title: `Continue ${index + 1}`, status: "in_progress" }];
      }))
    };
    const paths: string[] = [];
    const canonical = {
      context: { project_id: "PRJ-0007", canonical_revision: 76 },
      canonical_state: canonicalState
    };
    const stub = {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        paths.push(url.pathname + url.search);
        const page = summarizeCanonicalContext(canonical, "PRJ-0007", url.searchParams.get("cursor") ?? undefined);
        return Response.json(page.error ?? { ...page.value, freshness: "verified", observed_at: "2026-09-26T10:00:00.000Z" },
          { status: page.error ? 400 : 200 });
      }
    };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> };

    const result = await server._registeredTools.project_os_get_context.handler({ project_id: "PRJ-0007" });
    const body = JSON.parse(result.content[0]!.text);

    expect(body).toMatchObject({
      status: "ok",
      project_id: "PRJ-0007",
      context: { project_id: "PRJ-0007", canonical_revision: 76 },
      project: { name: "Atlantic Machinery", revision: 76, current_phase_id: "PHASE-CURRENT" },
      current_phase: { phase_id: "PHASE-CURRENT", status: "active", objective_offset: 0, objective_total_chars: 200_000, objective_truncated: true },
      active_tasks_total: 55,
      active_tasks_truncated: true
    });
    expect(paths[0]).toBe("/context");
    expect(body.context).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("canonical_state");
    expect(body.active_tasks).toHaveLength(50);
    expect(body.active_tasks[0]).toMatchObject({ task_id: "TASK-001", status: "in_progress" });
    expect(body.current_phase.objective).toHaveLength(4096);
    expect(body.next_cursor).toEqual(expect.any(String));
    expect(result.content[0]!.text.length).toBeLessThan(20_000);

    const repeated = await server._registeredTools.project_os_get_context.handler({ project_id: "PRJ-0007" });
    expect(JSON.parse(repeated.content[0]!.text).next_cursor).toBe(body.next_cursor);

    const next = await server._registeredTools.project_os_get_context.handler({ project_id: "PRJ-0007", cursor: body.next_cursor });
    const nextBody = JSON.parse(next.content[0]!.text);
    expect(nextBody.active_tasks).toHaveLength(5);
    expect(nextBody.active_tasks[0].task_id).toBe("TASK-051");
    expect(nextBody.current_phase.objective_offset).toBe(4096);
    expect(nextBody.current_phase.objective).toBe("x".repeat(4096));
    expect(nextBody.next_cursor).toEqual(expect.any(String));
  });
});
