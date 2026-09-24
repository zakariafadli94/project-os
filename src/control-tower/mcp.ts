import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { artifactWriteRequestSchema } from "../domain/artifact-write";
import { managedDocumentRequestSchema } from "../domain/managed-document-request";
import { AUTO_PROJECT_ID, transactionSchema } from "../domain/transaction";
import { DETAIL_FIELDS, retrieveContextDetail, summarizeCanonicalContext } from "./context";

export function createControlTowerServer(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string }) {
  const server = new McpServer({ name: "project-os-control-tower", version: "1.0.0" });
  const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4}$/);
  server.registerTool("project_os_get_context", { description: "Read canonical Project OS context", inputSchema: { project_id: projectIdSchema, cursor: z.string().max(1_024).optional() } }, async ({ project_id, cursor }) => {
    return readGuard(env.PROJECT_GUARD, project_id, "/mutation-context", (response, body) => {
      if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
      const bounded = summarizeCanonicalContext(body as { context: unknown; canonical_state?: Record<string, unknown> }, project_id, cursor);
      if (bounded.error) return { isError: true, content: [{ type: "text", text: JSON.stringify(bounded.error) }] };
      return { content: [{ type: "text", text: JSON.stringify(bounded.value) }] };
    });
  });
  const detailFieldSchema = z.enum([...DETAIL_FIELDS.project, ...DETAIL_FIELDS.phase, ...DETAIL_FIELDS.task]);
  server.registerTool("project_os_get_context_detail", {
    description: "Retrieve a whitelisted canonical context field in bounded pages",
    inputSchema: {
      project_id: projectIdSchema,
      revision: z.number().int().nonnegative(),
      entity_type: z.enum(["project", "phase", "task"]),
      entity_id: z.string().min(1),
      field: detailFieldSchema,
      cursor: z.string().max(1_024).optional()
    }
  }, async ({ project_id, revision, entity_type, entity_id, field, cursor }) => {
    return readGuard(env.PROJECT_GUARD, project_id, "/mutation-context", (response, body) => {
      if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
      const detail = retrieveContextDetail(body as { context: unknown; canonical_state?: Record<string, unknown> }, project_id,
        { revision, entity_type, entity_id, field, cursor });
      if (detail.error) return { isError: true, content: [{ type: "text", text: JSON.stringify(detail.error) }] };
      const text = JSON.stringify(detail.value);
      return new TextEncoder().encode(text).byteLength <= 16 * 1024
        ? { content: [{ type: "text", text }] }
        : { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "CONTEXT_DETAIL_PAGE_TOO_LARGE" }) }] };
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
