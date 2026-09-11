import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function createControlTowerServer(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace }) {
  const server = new McpServer({ name: "project-os-control-tower", version: "1.0.0" });
  server.registerTool("project_os_get_context", { description: "Read canonical Project OS context", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/) } }, async ({ project_id }) => {
    const response = await env.PROJECT_GUARD.getByName(project_id).fetch("https://project-guard.internal/mutation-context");
    if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
    const body = await response.json();
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", project_id, context: body }) }] };
  });
  server.registerTool("project_os_get_receipt", { description: "Read a terminal receipt", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request_id: z.string().min(1), kind: z.enum(["transaction", "document", "artifact"]) } }, async ({ project_id, request_id, kind }) => {
    const response = await env.PROJECT_GUARD.getByName(project_id).fetch(`https://project-guard.internal/receipt?request_id=${encodeURIComponent(request_id)}&kind=${kind}`);
    return { isError: !response.ok, content: [{ type: "text", text: JSON.stringify(await response.json()) }] };
  });
  server.registerTool("project_os_submit_transaction", { description: "Submit one typed Project OS transaction", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "transaction", request));
  server.registerTool("project_os_write_working_document", { description: "Submit one typed working document request", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "document", request));
  server.registerTool("project_os_submit_artifact", { description: "Submit one governed Project OS artifact manifest", inputSchema: { project_id: z.string().regex(/^PRJ-[0-9]{4}$/), request: z.any() } }, async ({ project_id, request }) => submitGuarded(env, project_id, "artifact", request));
  return server;
}

async function submitGuarded(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace }, projectId: string, kind: "transaction" | "document" | "artifact", request: Record<string, unknown>) {
  if (!request || typeof request !== "object" || request.project_id !== projectId) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", code: "project_binding_mismatch" }) }] };
  const contextResponse = await env.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/mutation-context");
  if (!contextResponse.ok) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
  const canonical = await contextResponse.json<{ context?: unknown }>();
  const owner = kind === "transaction" && request.operation === "project.create" ? env.REGISTRY_GUARD.getByName("global") : env.PROJECT_GUARD.getByName(projectId);
  const path = kind === "transaction" ? (request.operation === "project.create" ? "/create" : "/transaction") : kind === "document" ? "/document" : "/artifact";
  const response = await owner.fetch(`https://project-guard.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admission_version: "1.0", request, mutation_context: request.operation === "project.create" ? null : canonical.context }) });
  const payload = { content: [{ type: "text" as const, text: JSON.stringify(await response.json()) }] };
  return response.ok ? payload : { ...payload, isError: true as const };
}
