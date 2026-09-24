import { describe, expect, it } from "vitest";
import { createControlTowerServer } from "../src/control-tower/mcp";

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

describe("Control Tower governed artifact submission", () => {
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
    expect(JSON.parse(missingReceipt.content[0]!.text)).toEqual({ error: "receipt_not_found" });
    expect(calls).toEqual([
      `/receipt?request_id=${artifact.request_id}&kind=artifact`,
      `/request-status?request_id=${artifact.request_id}&kind=artifact`
    ]);
    expect(JSON.parse(requestStatus.content[0]!.text)).toMatchObject({ status: "committed", execution: { status: "finalizing", terminal: false } });
  });

  it("sends a staged artifact with fresh signed admission to ProjectGuard", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const stub = {
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        calls.push({ path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.pathname === "/mutation-context") {
          return Response.json({ context: { project_id: "PRJ-0007", token: "signed" } });
        }
        return Response.json({ status: "committed", request_id: artifact.request_id });
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
      { path: "/mutation-context?include_state=false" },
      {
        path: "/artifact",
        body: {
          admission_version: "1.0",
          request: artifact,
          mutation_context: { project_id: "PRJ-0007", token: "signed" }
        }
      }
    ]);
  });

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
    const stub = {
      fetch: async () => Response.json({
        context: { project_id: "PRJ-0007", canonical_revision: 76, token: "signed" },
        canonical_state: canonicalState
      })
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
      context: { project_id: "PRJ-0007", canonical_revision: 76, token: "signed" },
      project: { name: "Atlantic Machinery", revision: 76, current_phase_id: "PHASE-CURRENT" },
      current_phase: { phase_id: "PHASE-CURRENT", status: "active", objective_offset: 0, objective_total_chars: 200_000, objective_truncated: true },
      active_tasks_total: 55,
      active_tasks_truncated: true
    });
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
