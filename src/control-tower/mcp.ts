import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { artifactWriteRequestSchema } from "../domain/artifact-write";
import { managedDocumentRequestSchema } from "../domain/managed-document-request";
import { AUTO_PROJECT_ID, transactionSchema } from "../domain/transaction";

const CONTEXT_TASK_PAGE_SIZE = 50;
const CONTEXT_TEXT_PAGE_SIZE = 4_096;
const CONTEXT_ACTION_PAGE_SIZE = 10;
const CONTEXT_FIELD_LIMIT = 256;

export function createControlTowerServer(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string }) {
  const server = new McpServer({ name: "project-os-control-tower", version: "1.0.0" });
  const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4}$/);
  server.registerTool("project_os_get_context", { description: "Read canonical Project OS context", inputSchema: { project_id: projectIdSchema, cursor: z.string().optional() } }, async ({ project_id, cursor }) => {
    return readGuard(env.PROJECT_GUARD, project_id, "/mutation-context", (response, body) => {
      if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
      const bounded = boundedContext(body as { context: unknown; canonical_state?: Record<string, unknown> }, project_id, cursor);
      if (bounded.error) return { isError: true, content: [{ type: "text", text: JSON.stringify(bounded.error) }] };
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", project_id, ...bounded.value }) }] };
    });
  });
  const requestStatus = async ({ project_id, request_id, kind }: { project_id: string; request_id: string; kind: "transaction" | "document" | "artifact" }) => {
    return readGuard(env.PROJECT_GUARD, project_id, `/request-status?request_id=${encodeURIComponent(request_id)}&kind=${kind}`, (response, body) => ({
      ...(!response.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(body) }]
    }));
  };
  const receipt = async ({ project_id, request_id, kind }: { project_id: string; request_id: string; kind: "transaction" | "document" | "artifact" }) => {
    return readGuard(env.PROJECT_GUARD, project_id, `/receipt?request_id=${encodeURIComponent(request_id)}&kind=${kind}`, (response, body) => ({
      ...(!response.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(body) }]
    }));
  };
  const requestStatusSchema = { project_id: projectIdSchema, request_id: z.string().min(1), kind: z.enum(["transaction", "document", "artifact"]) };
  server.registerTool("project_os_get_receipt", { description: "Read a receipt without triggering recovery", inputSchema: requestStatusSchema }, receipt);
  server.registerTool("project_os_get_request_status", { description: "Read Project OS request recovery status without triggering recovery", inputSchema: requestStatusSchema }, requestStatus);
  server.registerTool("project_os_submit_transaction", { description: "Submit one strict typed Project OS transaction after the server obtains fresh admission context", inputSchema: { project_id: z.union([projectIdSchema, z.literal(AUTO_PROJECT_ID)]), request: transactionSchema } }, async ({ project_id, request }) => submitGuarded(env, project_id, "transaction", request));
  server.registerTool("project_os_write_working_document", { description: "Submit one strict governed document request after the server obtains fresh admission context", inputSchema: { project_id: projectIdSchema, request: managedDocumentRequestSchema } }, async ({ project_id, request }) => submitGuarded(env, project_id, "document", request));
  server.registerTool("project_os_submit_artifact", { description: "Submit one strict governed artifact manifest after the server obtains fresh admission context", inputSchema: { project_id: projectIdSchema, request: artifactWriteRequestSchema } }, async ({ project_id, request }) => submitGuarded(env, project_id, "artifact", request));
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
  const isProjectCreate = kind === "transaction" && request.operation === "project.create";
  let mutationContext: unknown = null;
  if (!isProjectCreate) {
    const contextResponse = await env.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/mutation-context?include_state=false", { headers: env.CONTROL_TOWER_OPERATOR_TOKEN ? { authorization: `Bearer ${env.CONTROL_TOWER_OPERATOR_TOKEN}` } : {} });
    if (!contextResponse.ok) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
    mutationContext = (await contextResponse.json<{ context?: unknown }>()).context;
  }
  const owner = isProjectCreate ? env.REGISTRY_GUARD.getByName("global") : env.PROJECT_GUARD.getByName(projectId);
  const path = kind === "transaction" ? (isProjectCreate ? "/create" : "/transaction") : kind === "document" ? "/document" : "/artifact";
  const response = await owner.fetch(`https://project-guard.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admission_version: "1.0", request, mutation_context: mutationContext }) });
  const payload = { content: [{ type: "text" as const, text: JSON.stringify(await response.json()) }] };
  return response.ok ? payload : { ...payload, isError: true as const };
}

interface ContextCursor {
  project_id: string;
  revision: number;
  phase_id: string | null;
  task_offset: number;
  objective_offset: number;
  action_offset: number;
}

function boundedContext(body: { context: unknown; canonical_state?: Record<string, unknown> }, projectId: string, cursorToken?: string): {
  value?: Record<string, unknown>;
  error?: Record<string, unknown>;
} {
  const state = body.canonical_state ?? {};
  const phases = recordValues(state.plan_phases);
  const tasks = recordValues(state.tasks)
    .filter((task) => task.status !== "completed" && task.status !== "cancelled")
    .sort((left, right) => String(left.task_id ?? "").localeCompare(String(right.task_id ?? "")));
  const currentPhaseId = typeof state.current_phase_id === "string" ? state.current_phase_id : null;
  const currentPhase = phases.find((phase) => phase.phase_id === currentPhaseId) ?? null;
  const revision = typeof state.revision === "number" ? state.revision : -1;
  const cursor = cursorToken ? decodeContextCursor(cursorToken) : {
    project_id: projectId,
    revision,
    phase_id: currentPhaseId,
    task_offset: 0,
    objective_offset: 0,
    action_offset: 0
  };
  if (!cursor || cursor.project_id !== projectId) return { error: { status: "invalid_cursor", code: "CONTEXT_CURSOR_INVALID" } };
  if (cursor.revision !== revision || cursor.phase_id !== currentPhaseId) {
    return { error: { status: "stale_cursor", code: "CONTEXT_CURSOR_STALE", current_revision: revision } };
  }
  if (cursor.task_offset > tasks.length || (currentPhase === null && (cursor.objective_offset !== 0 || cursor.action_offset !== 0))) {
    return { error: { status: "invalid_cursor", code: "CONTEXT_CURSOR_INVALID" } };
  }

  const taskPage = tasks.slice(cursor.task_offset, cursor.task_offset + CONTEXT_TASK_PAGE_SIZE).map((task) => boundedRecord(task, ["task_id", "title", "status", "phase_id", "blocked_reason", "updated_at"]));
  const objective = typeof currentPhase?.objective === "string" ? currentPhase.objective : "";
  const objectiveChunk = objective.slice(cursor.objective_offset, cursor.objective_offset + CONTEXT_TEXT_PAGE_SIZE);
  const actions = Array.isArray(currentPhase?.next_actions) ? currentPhase.next_actions.filter((action): action is string => typeof action === "string") : [];
  if (cursor.objective_offset > objective.length || cursor.action_offset > actions.length) {
    return { error: { status: "invalid_cursor", code: "CONTEXT_CURSOR_INVALID" } };
  }
  const actionChunk = actions.slice(cursor.action_offset, cursor.action_offset + CONTEXT_ACTION_PAGE_SIZE).map((action) => boundedString(action, CONTEXT_FIELD_LIMIT));
  const nextCursor = cursor.task_offset + taskPage.length < tasks.length
    || cursor.objective_offset + objectiveChunk.length < objective.length
    || cursor.action_offset + actionChunk.length < actions.length
    ? encodeContextCursor({
      ...cursor,
      task_offset: cursor.task_offset + taskPage.length,
      objective_offset: cursor.objective_offset + objectiveChunk.length,
      action_offset: cursor.action_offset + actionChunk.length
    })
    : null;
  return { value: {
    context: body.context,
    project: boundedRecord(state, ["project_id", "name", "slug", "status", "revision", "current_phase_id"]),
    current_phase: currentPhase ? {
      ...boundedRecord(currentPhase, ["phase_id", "title", "status", "created_at", "updated_at"]),
      objective: objectiveChunk,
      objective_offset: cursor.objective_offset,
      objective_total_chars: objective.length,
      objective_truncated: cursor.objective_offset + objectiveChunk.length < objective.length,
      next_actions: actionChunk,
      next_actions_offset: cursor.action_offset,
      next_actions_total: actions.length,
      next_actions_truncated: cursor.action_offset + actionChunk.length < actions.length
    } : null,
    active_tasks: taskPage,
    active_tasks_total: tasks.length,
    active_tasks_offset: cursor.task_offset,
    active_tasks_truncated: cursor.task_offset + taskPage.length < tasks.length,
    next_cursor: nextCursor
  } };
}

function recordValues(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

function boundedRecord(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [
    key,
    typeof value[key] === "string" ? boundedString(value[key] as string, CONTEXT_FIELD_LIMIT) : value[key]
  ]));
}

function boundedString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function encodeContextCursor(cursor: ContextCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeContextCursor(value: string): ContextCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ContextCursor>;
    return typeof parsed.project_id === "string"
      && typeof parsed.revision === "number" && Number.isInteger(parsed.revision)
      && (typeof parsed.phase_id === "string" || parsed.phase_id === null)
      && typeof parsed.task_offset === "number" && Number.isInteger(parsed.task_offset) && parsed.task_offset >= 0
      && typeof parsed.objective_offset === "number" && Number.isInteger(parsed.objective_offset) && parsed.objective_offset >= 0
      && typeof parsed.action_offset === "number" && Number.isInteger(parsed.action_offset) && parsed.action_offset >= 0
      ? parsed as ContextCursor
      : null;
  } catch {
    return null;
  }
}
