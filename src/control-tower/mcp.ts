import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function createControlTowerServer(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string }) {
  const server = new McpServer({ name: "project-os-control-tower", version: "1.0.0" });
  server.registerTool("project_os_get_context", { description: "Read canonical Project OS context", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/) } }, async ({ project_id }) => {
    return readGuard(env.PROJECT_GUARD, project_id, "/mutation-context", (response, body) => {
      if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", project_id, ...boundedContext(body as { context: unknown; canonical_state?: Record<string, unknown> }) }) }] };
    });
  });
  const requestStatus = async ({ project_id, request_id, kind }: { project_id: string; request_id: string; kind: "transaction" | "document" | "artifact" }) => {
    return readGuard(env.PROJECT_GUARD, project_id, `/request-status?request_id=${encodeURIComponent(request_id)}&kind=${kind}`, (response, body) => ({
      ...(!response.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(body) }]
    }));
  };
  const requestStatusSchema = { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request_id: z.string().min(1), kind: z.enum(["transaction", "document", "artifact"]) };
  server.registerTool("project_os_get_receipt", { description: "Read receipt and finalization status without triggering recovery", inputSchema: requestStatusSchema }, requestStatus);
  server.registerTool("project_os_get_request_status", { description: "Read Project OS request recovery status without triggering recovery", inputSchema: requestStatusSchema }, requestStatus);
  server.registerTool("project_os_submit_transaction", { description: "Submit one typed Project OS transaction", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "transaction", request));
  server.registerTool("project_os_write_working_document", { description: "Submit one typed working document request", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "document", request));
  server.registerTool("project_os_submit_artifact", { description: "Submit one governed Project OS artifact manifest", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "artifact", request));
  return server;
}

type ReadToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

async function readGuard(
  namespace: DurableObjectNamespace,
  projectId: string,
  path: string,
  present: (response: Response, body: unknown) => ReadToolResult
): Promise<ReadToolResult> {
  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diagnostic = { correlation_id: correlationId, project_id: projectId, route: path.split("?")[0], failed_boundary: "control_tower_to_project_guard" };
  console.log("project_os_read_started", diagnostic);
  try {
    const result = await Promise.race([
      (async () => {
        const response = await namespace.getByName(projectId).fetch(`https://project-guard.internal${path}`, {
          signal: controller.signal, headers: { "x-project-os-correlation-id": correlationId }
        });
        return present(response, await response.json());
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read_deadline_exceeded")), 10_000); })
    ]);
    console.log("project_os_read_finished", { ...diagnostic, elapsed_ms: Date.now() - started });
    return result;
  } catch (error) {
    controller.abort();
    const reason = error instanceof Error && error.message === "read_deadline_exceeded" ? "deadline_exceeded" : "dependency_failed";
    console.warn("project_os_read_unavailable", { ...diagnostic, reason, elapsed_ms: Date.now() - started });
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "PROJECT_OS_READ_UNAVAILABLE", ...diagnostic, reason }) }] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function submitGuarded(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string }, projectId: string, kind: "transaction" | "document" | "artifact", request: Record<string, unknown>) {
  if (!request || typeof request !== "object" || request.project_id !== projectId) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", code: "project_binding_mismatch" }) }] };
  const contextResponse = await env.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/mutation-context?include_state=false", { headers: env.CONTROL_TOWER_OPERATOR_TOKEN ? { authorization: `Bearer ${env.CONTROL_TOWER_OPERATOR_TOKEN}` } : {} });
  if (!contextResponse.ok) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
  const canonical = await contextResponse.json<{ context?: unknown }>();
  const owner = kind === "transaction" && request.operation === "project.create" ? env.REGISTRY_GUARD.getByName("global") : env.PROJECT_GUARD.getByName(projectId);
  const path = kind === "transaction" ? (request.operation === "project.create" ? "/create" : "/transaction") : kind === "document" ? "/document" : "/artifact";
  const response = await owner.fetch(`https://project-guard.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admission_version: "1.0", request, mutation_context: request.operation === "project.create" ? null : canonical.context }) });
  const payload = { content: [{ type: "text" as const, text: JSON.stringify(await response.json()) }] };
  return response.ok ? payload : { ...payload, isError: true as const };
}

function boundedContext(body: { context: unknown; canonical_state?: Record<string, unknown> }) {
  const state = body.canonical_state ?? {};
  const phases = recordValues(state.phases);
  const tasks = recordValues(state.tasks);
  const currentPhaseId = typeof state.current_phase_id === "string" ? state.current_phase_id : null;
  return {
    context: body.context,
    project: pick(state, ["project_id", "name", "slug", "status", "revision", "current_phase_id"]),
    current_phase: phases.find((phase) => phase.phase_id === currentPhaseId) ?? null,
    active_tasks: tasks
      .filter((task) => task.status !== "completed" && task.status !== "cancelled")
      .slice(0, 50)
      .map((task) => pick(task, ["task_id", "title", "status", "phase_id", "blocked_reason", "updated_at"]))
  };
}

function recordValues(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
