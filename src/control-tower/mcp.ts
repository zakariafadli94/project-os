import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { artifactWriteRequestSchema } from "../domain/artifact-write";
import { managedDocumentRequestSchema } from "../domain/managed-document-request";
import { AUTO_PROJECT_ID, transactionSchema } from "../domain/transaction";
import { parseMutationContextOrNull } from "../admission/mutation-context";
import { DETAIL_FIELDS } from "./context";
import type { ControlTowerAccess } from "./auth";
import { persistenceCapabilities } from "../persistence/capabilities";
import type { VersionMetadataLike } from "../deployment/identity";
import { checkCatalogue } from "../rules/check-catalogue";
import { persistenceObservation, type RequestKind } from "../persistence/observation";

export function createControlTowerServer(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string; CF_VERSION_METADATA?: VersionMetadataLike }, access: ControlTowerAccess = { read: false, mutate: false }) {
  const server = new McpServer({ name: "project-os-control-tower", version: "1.0.0" });
  const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4}$/);
  server.registerTool("project_os_get_capabilities", {
    description: "Read deployed persistence capabilities and token permissions; client tool availability is unknown to the server",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(persistenceCapabilities(env, access)) }] }));
  server.registerTool("project_os_get_context", { description: "Read canonical Project OS context", inputSchema: { project_id: projectIdSchema, cursor: z.string().max(1_024).optional() } }, async ({ project_id, cursor }) => {
    if (!access.read) return scopeDenied("project.read");
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return readGuard(env.PROJECT_GUARD, project_id, `/context${query.size ? `?${query}` : ""}`, (response, body) => {
      if (!response.ok) return contextReadError(response, body);
      if (!isContextReadPage(body, project_id)) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "CONTEXT_RESPONSE_INVALID" }) }] };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
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
    if (!access.read) return scopeDenied("project.read");
    const query = new URLSearchParams({ revision: String(revision), entity_type, entity_id, field });
    if (cursor) query.set("cursor", cursor);
    return readGuard(env.PROJECT_GUARD, project_id, `/context?${query}`, (response, body) => {
      if (!response.ok) return contextReadError(response, body);
      if (!isContextReadPage(body, project_id) || body.revision !== revision || body.entity_type !== entity_type
        || body.entity_id !== entity_id || body.field !== field) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "CONTEXT_RESPONSE_INVALID" }) }] };
      }
      const text = JSON.stringify(body);
      return new TextEncoder().encode(text).byteLength <= 16 * 1024
        ? { content: [{ type: "text", text }] }
        : { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "CONTEXT_DETAIL_PAGE_TOO_LARGE" }) }] };
    });
  });
  const requestStatus = async ({ project_id, request_id, kind }: { project_id: string; request_id: string; kind: "transaction" | "document" | "artifact" }) => {
    if (!access.read) return scopeDenied("project.read");
    if (project_id === AUTO_PROJECT_ID) {
      if (kind !== "transaction") return invalidAutoKind();
      return readCreateStatus(env.REGISTRY_GUARD, request_id);
    }
    return readGuard(env.PROJECT_GUARD, project_id, `/request-status?request_id=${encodeURIComponent(request_id)}&kind=${kind}`, (response, body) => ({
      ...(!response.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(body) }]
    }));
  };
  const receipt = async ({ project_id, request_id, kind }: { project_id: string; request_id: string; kind: "transaction" | "document" | "artifact" }) => {
    if (!access.read) return scopeDenied("project.read");
    if (project_id === AUTO_PROJECT_ID) {
      if (kind !== "transaction") return invalidAutoKind();
      return readCreateStatus(env.REGISTRY_GUARD, request_id);
    }
    return readGuard(env.PROJECT_GUARD, project_id, `/receipt?request_id=${encodeURIComponent(request_id)}&kind=${kind}`, (response, body) => ({
      ...(!response.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(body) }]
    }));
  };
  const requestStatusSchema = { project_id: z.union([projectIdSchema, z.literal(AUTO_PROJECT_ID)]), request_id: z.string().min(1), kind: z.enum(["transaction", "document", "artifact"]) };
  const submit = (projectId: string, kind: "transaction" | "document" | "artifact", request: Record<string, unknown>) =>
    access.read && access.mutate ? submitGuarded(env, projectId, kind, request) : Promise.resolve(scopeDenied("project.mutate"));
  server.registerTool("project_os_get_receipt", { description: "Read a receipt without triggering recovery", inputSchema: requestStatusSchema }, receipt);
  server.registerTool("project_os_get_request_status", { description: "Read Project OS request recovery status without triggering recovery", inputSchema: requestStatusSchema }, requestStatus);
  server.registerTool("project_os_submit_transaction", { description: "Submit one strict typed Project OS transaction after the server obtains fresh admission context", inputSchema: { project_id: z.union([projectIdSchema, z.literal(AUTO_PROJECT_ID)]), request: transactionSchema } }, async ({ project_id, request }) => submit(project_id, "transaction", request));
  server.registerTool("project_os_write_working_document", { description: "Submit one strict governed document request after the server obtains fresh admission context", inputSchema: { project_id: projectIdSchema, request: managedDocumentRequestSchema } }, async ({ project_id, request }) => submit(project_id, "document", request));
  server.registerTool("project_os_submit_artifact", { description: "Submit one strict governed artifact manifest after the server obtains fresh admission context", inputSchema: { project_id: projectIdSchema, request: artifactWriteRequestSchema } }, async ({ project_id, request }) => submit(project_id, "artifact", request));
  return server;
}

function scopeDenied(scope: string): ReadToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({
    status: "not_submitted", code: "insufficient_scope", required_scope: scope,
    recovery: { owner: "client_authorization", action: "authorize_required_scope", requires_new_approval: false }
  }) }] };
}

function readCreateStatus(namespace: DurableObjectNamespace, transactionId: string): Promise<ReadToolResult> {
  return readGuard(namespace, "global", `/create-status?transaction_id=${encodeURIComponent(transactionId)}`, (response, body) => {
    if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unknown", code: "PROJECT_OS_CREATE_STATUS_UNAVAILABLE", transaction_id: transactionId }) }] };
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).transaction_id !== transactionId) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unknown", code: "PROJECT_OS_CREATE_STATUS_IDENTITY_MISMATCH", transaction_id: transactionId }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  });
}

type ReadToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

function isContextReadPage(value: unknown, projectId: string): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, any>;
  const context = body.context;
  return body.status === "ok" && body.project_id === projectId
    && typeof body.revision === "number" && Number.isSafeInteger(body.revision)
    && context && typeof context === "object" && context.project_id === projectId
    && context.canonical_revision === body.revision && !("token" in context)
    && ["verified", "stale", "unknown"].includes(body.freshness)
    && typeof body.observed_at === "string" && Number.isFinite(Date.parse(body.observed_at))
    && !(body.context && typeof body.context === "object" && "token" in body.context);
}

function contextReadError(response: Response, value: unknown): ReadToolResult {
  if (response.status < 500 && value && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    if (typeof body.status === "string" && typeof body.code === "string") {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
    }
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "canonical_unavailable" }) }] };
}

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
  const query = new URL(path, "https://project-guard.internal").searchParams;
  const requestId = query.get("request_id") ?? query.get("transaction_id");
  const diagnostic = { correlation_id: correlationId, project_id: projectId, ...(requestId ? { request_id: requestId } : {}), route: path.split("?")[0],
    failed_boundary: projectId === "global" ? "control_tower_to_registry_guard" : "control_tower_to_project_guard" };
  const recovery = { owner: "system", action: requestId ? "check_status" : "retry_context_read", preserve_request_id: true,
    requires_new_approval: false, next_attempt_at: null, dependency: diagnostic.failed_boundary };
  console.log("project_os_read_started", diagnostic);
  try {
    const result = await Promise.race([
      (async () => {
        const response = await namespace.getByName(projectId).fetch(`https://project-guard.internal${path}`, {
          signal: controller.signal, headers: { "x-project-os-correlation-id": correlationId }
        });
        if (response.status >= 500) {
          // Only known, non-sensitive observation verdicts may cross this boundary.
          // Do not echo arbitrary 5xx payloads from a dependency to a client.
          if (diagnostic.route === "/request-status" && response.status === 503) {
            const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
            if (body && (body.code === "PROJECT_OS_READ_BUSY" || body.code === "request_status_unavailable")) {
              const retryAfter = Number(response.headers.get("Retry-After"));
              const retryAfterSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60
                ? retryAfter : 1;
              const unavailableObservation = body.code === "request_status_unavailable" && requestId
                && ["transaction", "document", "artifact"].includes(query.get("kind") ?? "")
                ? persistenceObservation({ project_id: projectId, kind: query.get("kind") as RequestKind,
                    request_id: requestId, observed_at: new Date().toISOString(), correlation_id: correlationId,
                    code: "request_status_unavailable" })
                : null;
              return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
                status: unavailableObservation ? "unknown" : "unavailable", code: body.code, ...diagnostic,
                ...(unavailableObservation ? { observation: unavailableObservation } : {}),
                retry_after_seconds: retryAfterSeconds, recovery
              }) }] };
            }
          }
          throw new Error("dependency_http_failed");
        }
        const presented = present(response, await response.json());
        if (!response.ok) {
          return { ...presented, content: presented.content.map(item => ({ ...item,
            text: JSON.stringify({ ...JSON.parse(item.text), ...diagnostic, recovery }) })) };
        }
        return presented;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read_deadline_exceeded")), 10_000); })
    ]);
    console.log("project_os_read_finished", { ...diagnostic, elapsed_ms: Date.now() - started });
    return result;
  } catch (error) {
    controller.abort();
    const reason = error instanceof Error && error.message === "read_deadline_exceeded" ? "deadline_exceeded" : "dependency_failed";
    console.warn("project_os_read_unavailable", { ...diagnostic, reason, elapsed_ms: Date.now() - started });
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", code: "PROJECT_OS_READ_UNAVAILABLE", ...diagnostic, reason,
      recovery
    }) }] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function submitGuarded(env: { PROJECT_GUARD: DurableObjectNamespace; REGISTRY_GUARD: DurableObjectNamespace; CONTROL_TOWER_OPERATOR_TOKEN?: string }, projectId: string, kind: "transaction" | "document" | "artifact", request: Record<string, unknown>) {
  const requestId = kind === "transaction" ? request?.transaction_id : request?.request_id;
  if (!request || typeof request !== "object" || request.project_id !== projectId) return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", code: "project_binding_mismatch" }) }] };
  const isProjectCreate = kind === "transaction" && request.operation === "project.create";
  if ((projectId === AUTO_PROJECT_ID && !isProjectCreate) || (isProjectCreate && projectId !== AUTO_PROJECT_ID)) {
    return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", code: "invalid_project_create_binding" }) }] };
  }
  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const started = Date.now();
  let boundary: "context" | "submission" = "context";
  let postStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diagnostic = { correlation_id: correlationId, request_id: requestId, family: kind };
  console.log("project_os_submission_started", diagnostic);
  try {
    let mutationContext: unknown = null;
    if (!isProjectCreate) {
      const contextStarted = Date.now();
      const contextDeadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SubmissionFailure("context", true)), 10_000);
      });
      try {
        const contextWork = (async () => {
          const contextHeaders = new Headers({ "x-project-os-correlation-id": correlationId });
          if (env.CONTROL_TOWER_OPERATOR_TOKEN) contextHeaders.set("authorization", `Bearer ${env.CONTROL_TOWER_OPERATOR_TOKEN}`);
          const contextResponse = await env.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/mutation-context?include_state=false", {
            headers: contextHeaders, signal: controller.signal
          });
          if (!contextResponse.ok) throw new SubmissionFailure("context");
          const contextBody = await contextResponse.json<{ context?: unknown }>();
          const context = parseMutationContextOrNull(contextBody?.context);
          if (!context || context.project_id !== projectId) throw new SubmissionFailure("context");
          return context;
        })();
        mutationContext = await Promise.race([contextWork, contextDeadline]);
        if (Date.now() - contextStarted >= 10_000) throw new SubmissionFailure("context", true);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
    }
    const owner = isProjectCreate ? env.REGISTRY_GUARD.getByName("global") : env.PROJECT_GUARD.getByName(projectId);
    const path = kind === "transaction" ? (isProjectCreate ? "/create" : "/transaction") : kind === "document" ? "/document" : "/artifact";
    const headers = new Headers({ "content-type": "application/json", "x-project-os-correlation-id": correlationId });
    const body = JSON.stringify({ admission_version: "1.0", request, mutation_context: mutationContext });
    if (controller.signal.aborted) throw new SubmissionFailure("context", true);
    boundary = "submission";
    const submissionDeadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SubmissionFailure("submission", true)), 40_000);
    });
    postStarted = true;
    const serviceHost = isProjectCreate ? "registry-guard.internal" : "project-guard.internal";
    const submissionWork = (async () => {
      const response = await owner.fetch(`https://${serviceHost}${path}`, {
        method: "POST", headers, body, signal: controller.signal
      });
      return { response, payload: await response.json() };
    })();
    let response: Response;
    let submissionPayload: unknown;
    try {
      ({ response, payload: submissionPayload } = await Promise.race([submissionWork, submissionDeadline]));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
    let submitted: { response: Response; payload: unknown; outcome: "business_refusal" | "http_rejection" | "committed" };
    if (!response.ok) {
      const refusal = knownBusinessRefusal(submissionPayload, response.status, requestId, projectId);
      if (refusal) submitted = { response, payload: refusal, outcome: "business_refusal" };
      else if (response.status >= 500) throw new SubmissionFailure("submission");
      else submitted = { response, payload: { status: "rejected", code: "PROJECT_OS_SUBMISSION_REJECTED", request_id: requestId }, outcome: "http_rejection" };
    } else {
      if (!validSubmissionResponse(submissionPayload, kind, requestId, projectId, isProjectCreate)) throw new SubmissionFailure("submission");
      if (submissionPayload.status !== "committed") submitted = { response, payload: sanitizeSubmissionReceipt(submissionPayload), outcome: "business_refusal" };
      else submitted = { response, payload: submissionPayload, outcome: "committed" };
    }
    console.log("project_os_submission_finished", { ...diagnostic, boundary: "submission", elapsed_ms: Date.now() - started, result: submitted.outcome });
    const payload = { content: [{ type: "text" as const, text: JSON.stringify(submitted.payload) }] };
    return submitted.outcome === "committed" ? payload : { ...payload, isError: true as const };
  } catch (error) {
    controller.abort();
    const failedBoundary = error instanceof SubmissionFailure ? error.boundary : boundary;
    const status = postStarted ? "unknown" : "not_submitted";
    const result = { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({
      status, code: "PROJECT_OS_SUBMISSION_UNAVAILABLE", request_id: requestId,
      failed_boundary: failedBoundary, correlation_id: correlationId,
      recovery: { owner: "system", action: postStarted ? "check_status" : "retry_context_read",
        preserve_request_id: true, check_status_before_retry: postStarted, requires_new_approval: false,
        next_attempt_at: null, dependency: isProjectCreate ? "control_tower_to_registry_guard" : "control_tower_to_project_guard" }
    }) }] };
    console.warn("project_os_submission_unavailable", { ...diagnostic, boundary: failedBoundary, elapsed_ms: Date.now() - started, result: status });
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class SubmissionFailure extends Error {
  constructor(readonly boundary: "context" | "submission", readonly deadline = false) { super("submission_unavailable"); }
}

function invalidAutoKind() {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", code: "invalid_auto_project_status_kind" }) }] };
}

function validSubmissionResponse(payload: unknown, kind: "transaction" | "document" | "artifact", requestId: unknown, projectId: string, isProjectCreate: boolean): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const result = payload as Record<string, unknown>;
  const identityField = kind === "transaction" ? "transaction_id" : "request_id";
  if (result[identityField] !== requestId || !["committed", "rejected", "conflict"].includes(String(result.status))) return false;
  if (isProjectCreate) {
    if (result.status === "committed") return typeof result.project_id === "string" && /^PRJ-[0-9]{4,}$/.test(result.project_id);
    return result.project_id === AUTO_PROJECT_ID || typeof result.project_id === "string" && /^PRJ-[0-9]{4,}$/.test(result.project_id);
  }
  return result.project_id === projectId;
}

const safeAdmissionRefusals = new Set([
  ...Object.values(checkCatalogue).flatMap(check => [...check.result_codes]),
  "RULESET_CONFLICT", "UNKNOWN_ACTIVE_CHECK", "INVALID_CHECK_PARAMETERS", "UNSUPPORTED_CHECK_OPERATION", "UNSUPPORTED_CHECK_STAGE",
  "mutation_context_missing", "mutation_context_expired", "mutation_context_invalid", "mutation_context_stale",
  "canonical_unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", "RULE_ADMISSION_STALE",
  "ARTIFACT_DESTINATION_FORBIDDEN", "idempotency_payload_mismatch", "convergence_capacity_exceeded"
]);

function knownBusinessRefusal(payload: unknown, httpStatus: number, requestId: unknown, projectId: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const code = typeof body.error === "string" && safeAdmissionRefusals.has(body.error) ? body.error : null;
  if (!code || ![409, 428, 503].includes(httpStatus) || (body.project_id !== undefined && body.project_id !== projectId)) return null;
  const result: Record<string, unknown> = {
    status: "rejected", code, error: code, request_id: requestId, failed_boundary: "submission",
    recovery: { preserve_request_id: true, check_status_before_retry: false }
  };
  // These are structured rule diagnostics, not exception messages or raw
  // provider bodies. Keep the refusal actionable and bounded for old clients.
  for (const key of ["expected", "observed", "required_action"] as const) {
    if (typeof body[key] === "string" && body[key].length <= 2_048) result[key] = body[key];
  }
  if (body.rule && typeof body.rule === "object" && !Array.isArray(body.rule)) {
    const rule = body.rule as Record<string, unknown>;
    if (typeof rule.rule_id === "string" && /^RULE-[A-Za-z0-9_-]{1,120}$/.test(rule.rule_id)
      && Number.isSafeInteger(rule.version) && Number(rule.version) > 0) {
      result.rule = { rule_id: rule.rule_id, version: rule.version };
    }
  }
  if (code === "convergence_capacity_exceeded") {
    const detail = body.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail as Record<string, unknown> : {};
    const reasons = new Set(["continuation_unavailable", "queued_outputs_exceeded", "oldest_pending_exceeded", "blocked_obligation", "repair_required"]);
    if (typeof detail.reason === "string" && reasons.has(detail.reason)) result.reason = detail.reason;
    for (const key of ["canonical_revision", "materialized_revision", "queued_outputs", "oldest_pending_seconds", "retry_after_seconds"] as const) {
      const value = detail[key];
      if (value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)) result[key] = value;
    }
    const blocker = detail.blocking_obligation;
    if (blocker && typeof blocker === "object" && !Array.isArray(blocker)) {
      const value = blocker as Record<string, unknown>;
      if (typeof value.layer === "string" && value.layer.length <= 80 && Number.isSafeInteger(value.target_revision)
        && (value.code === null || typeof value.code === "string" && value.code.length <= 120)) {
        result.blocking_obligation = { layer: value.layer, target_revision: value.target_revision, code: value.code };
      }
    }
  }
  return result;
}

function sanitizeSubmissionReceipt(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["status", "code", "request_id", "transaction_id", "project_id", "relative_path", "content_sha256", "new_revision", "previous_revision", "event_id", "committed_at"] as const) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}
