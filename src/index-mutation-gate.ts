import { deploymentIdentity } from "./deployment/identity";
import { parseMutationCandidateResolutionRequest } from "./domain/mutation-candidate-resolution";
import type { ProjectState } from "./domain/project-state";
import type { Env } from "./env";
import baseWorker from "./index";
import { parseLayoutMode } from "./persistence/layout";
import { createProductionPersistence } from "./persistence/production-factory";
import { ProjectRepository } from "./persistence/repository";
import { searchReadDisabledResponse, searchReadEnabled } from "./search/read-mode";

export { DropboxChangeGuard } from "./durable/dropbox-change-guard";
export { FallbackIngressGuard } from "./durable/fallback-ingress-guard";
export { MaterializationGuard } from "./durable/materialization-guard";
export { DiagnosticProjectGuard as ProjectGuard } from "./durable/project-guard-diagnostics";
export { RegistryGuard } from "./durable/registry-guard";
export { SearchSyncGuard } from "./durable/search-sync-guard";
export { SearchIndexGuard } from "./search/search-index-guard";

const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
const OPERATOR_TOKEN_FUTURE_SKEW_MS = 60_000;
const EXACT_PROJECT_ID = /^PRJ-[0-9]{4}$/;
const FALLBACK_MAX_ENVELOPE_BYTES = 128 * 1024;
const encoder = new TextEncoder();

interface DecryptedFallbackEnvelope {
  key_id: string;
  client_public_key: JsonWebKey;
  plaintext: string;
}

const worker = {
  ...baseWorker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/v1/search" && !searchReadEnabled(env)) {
      return searchReadDisabledResponse();
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", ...deploymentIdentity(env) });
    }

    if (request.method === "GET" && url.pathname === "/v1/fallback-ingress/key") {
      return env.FALLBACK_INGRESS_GUARD.getByName("global").fetch(
        "https://fallback-ingress.internal/key",
        { method: "GET" }
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/fallback-ingress") {
      if (!authorizedIngress(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return handleFallbackIngress(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/schema-status") {
      if (!authorizedIngress(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const projectId = url.searchParams.get("project_id");
      if (!projectId || !EXACT_PROJECT_ID.test(projectId)) {
        return Response.json({ error: "invalid_project_id" }, { status: 400 });
      }
      const stub = env.PROJECT_GUARD.getByName(projectId);
      return stub.fetch("https://project-guard.internal/schema-status", { method: "GET" });
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/input-recovery-status") {
      if (!authorizedRecovery(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const projectId = url.searchParams.get("project_id");
      if (!projectId || !EXACT_PROJECT_ID.test(projectId)) {
        return Response.json({ error: "invalid_project_id" }, { status: 400 });
      }
      const stub = env.PROJECT_GUARD.getByName(projectId);
      return stub.fetch("https://project-guard.internal/input-recovery-status", { method: "GET" });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/recover-inputs") {
      if (!authorizedRecovery(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${env.INGRESS_TOKEN}`);
      return baseWorker.fetch(new Request(request, { headers }), env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/v1/mutation-candidates/resolve") {
      if (!authorizedResolution(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let resolution;
      try {
        resolution = parseMutationCandidateResolutionRequest(await request.json());
      } catch (error) {
        return Response.json({
          error: "invalid_mutation_candidate_resolution",
          message: error instanceof Error ? error.message : "Invalid mutation candidate resolution request"
        }, { status: 400 });
      }

      const stub = env.PROJECT_GUARD.getByName(resolution.project_id);
      return stub.fetch("https://project-guard.internal/mutation-candidate-resolution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resolution)
      });
    }

    return baseWorker.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;

export default worker;

async function handleFallbackIngress(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > FALLBACK_MAX_ENVELOPE_BYTES) {
    return Response.json({ error: "fallback_envelope_too_large" }, { status: 413 });
  }

  let rawEnvelope: string;
  try {
    rawEnvelope = await request.text();
  } catch {
    return Response.json({ error: "invalid_fallback_envelope" }, { status: 400 });
  }
  if (encoder.encode(rawEnvelope).byteLength > FALLBACK_MAX_ENVELOPE_BYTES) {
    return Response.json({ error: "fallback_envelope_too_large" }, { status: 413 });
  }

  const fallbackGuard = env.FALLBACK_INGRESS_GUARD.getByName("global");
  const decryptedResponse = await fallbackGuard.fetch("https://fallback-ingress.internal/decrypt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawEnvelope
  });
  if (!decryptedResponse.ok) {
    await decryptedResponse.text();
    return Response.json({ error: "invalid_fallback_envelope" }, { status: 400 });
  }

  const decrypted = await decryptedResponse.json<DecryptedFallbackEnvelope>();
  let inner: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decrypted.plaintext) as unknown;
    if (!isRecord(parsed) || parsed.schema_version !== "1.0") throw new Error("invalid request");
    if (typeof parsed.request_id !== "string" || parsed.request_id.length === 0 || parsed.request_id.length > 128) {
      throw new Error("invalid request id");
    }
    inner = parsed;
  } catch {
    return Response.json({ error: "invalid_fallback_request" }, { status: 400 });
  }

  const requestId = inner.request_id as string;
  let plaintextResponse: Record<string, unknown>;

  if (inner.operation === "project_context") {
    const projectId = inner.project_id;
    if (typeof projectId !== "string" || !EXACT_PROJECT_ID.test(projectId)) {
      return Response.json({ error: "invalid_fallback_request" }, { status: 400 });
    }

    const statusResponse = await env.PROJECT_GUARD.getByName(projectId).fetch(
      "https://project-guard.internal/search-sync-status",
      { method: "GET" }
    );
    if (!statusResponse.ok) {
      await statusResponse.text();
      return encryptFallbackResponse(fallbackGuard, decrypted, fallbackContextUnavailable(
        requestId,
        projectId,
        "canonical_revision_unavailable",
        statusResponse.status
      ));
    }

    const status = await statusResponse.json<Record<string, unknown>>();
    if (status.project_id !== projectId || !Number.isSafeInteger(status.canonical_revision)) {
      return Response.json({ error: "fallback_context_invalid" }, { status: 502 });
    }
    const canonicalRevision = status.canonical_revision as number;

    let state: ProjectState | null = null;
    try {
      const repository = new ProjectRepository(
        createProductionPersistence(env, projectId),
        parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE)
      );
      const record = await repository.readCommitRecord(projectId, canonicalRevision);
      state = record?.state ?? null;
    } catch {
      return encryptFallbackResponse(fallbackGuard, decrypted, fallbackContextUnavailable(
        requestId,
        projectId,
        "canonical_commit_unavailable",
        503,
        canonicalRevision
      ));
    }

    if (!state) {
      return encryptFallbackResponse(fallbackGuard, decrypted, fallbackContextUnavailable(
        requestId,
        projectId,
        "canonical_commit_missing",
        404,
        canonicalRevision
      ));
    }
    if (state.project_id !== projectId || state.revision !== canonicalRevision) {
      return Response.json({ error: "fallback_context_invalid" }, { status: 502 });
    }

    plaintextResponse = {
      schema_version: "1.0",
      request_id: requestId,
      operation: "project_context",
      result: buildFallbackProjectContext(state)
    };
  } else if (inner.operation === "transaction") {
    if (!isRecord(inner.transaction)) {
      return Response.json({ error: "invalid_fallback_request" }, { status: 400 });
    }
    const authorization = request.headers.get("authorization");
    if (!authorization) return Response.json({ error: "unauthorized" }, { status: 401 });
    const transactionResponse = await baseWorker.fetch(
      new Request("https://project-os.internal/v1/transactions", {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify(inner.transaction)
      }),
      env,
      ctx
    );
    let result: unknown;
    try {
      result = await transactionResponse.json<unknown>();
    } catch {
      return Response.json({ error: "fallback_transaction_invalid_response" }, { status: 502 });
    }
    plaintextResponse = {
      schema_version: "1.0",
      request_id: requestId,
      operation: "transaction",
      http_status: transactionResponse.status,
      result
    };
  } else {
    return Response.json({ error: "invalid_fallback_request" }, { status: 400 });
  }

  return encryptFallbackResponse(fallbackGuard, decrypted, plaintextResponse);
}

function fallbackContextUnavailable(
  requestId: string,
  projectId: string,
  code: string,
  httpStatus: number,
  revision?: number
): Record<string, unknown> {
  return {
    schema_version: "1.0",
    request_id: requestId,
    operation: "project_context",
    result: {
      project_id: projectId,
      status: "unavailable",
      code,
      http_status: httpStatus,
      ...(revision !== undefined ? { revision } : {})
    }
  };
}

function buildFallbackProjectContext(state: ProjectState): Record<string, unknown> {
  const currentPhase = state.current_phase_id ? state.plan_phases[state.current_phase_id] ?? null : null;
  const activeTasks = Object.values(state.tasks)
    .filter((task) => task.status === "active" || task.status === "blocked")
    .sort((left, right) => left.task_id.localeCompare(right.task_id))
    .map((task) => ({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      ...(task.description ? { description: task.description } : {}),
      ...(task.phase_id ? { phase_id: task.phase_id } : {}),
      ...(task.blocked_reason ? { blocked_reason: task.blocked_reason } : {}),
      ...(task.result ? { result: task.result } : {}),
      updated_at: task.updated_at
    }));
  const blockers = Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((left, right) => left.task_id.localeCompare(right.task_id))
    .map((task) => ({
      task_id: task.task_id,
      title: task.title,
      blocked_reason: task.blocked_reason ?? "blocked"
    }));
  const constraints = Object.values(state.constraints)
    .sort((left, right) => left.constraint_id.localeCompare(right.constraint_id));
  const acceptedDecisions = Object.values(state.decisions)
    .filter((decision) => decision.status === "accepted")
    .sort((left, right) => left.decision_id.localeCompare(right.decision_id))
    .map((decision) => ({
      decision_id: decision.decision_id,
      title: decision.title,
      status: decision.status,
      impacts: decision.impacts,
      updated_at: decision.updated_at
    }));
  const researchIndex = Object.values(state.research)
    .sort((left, right) => left.research_id.localeCompare(right.research_id))
    .map((research) => ({
      research_id: research.research_id,
      title: research.title,
      ...(research.source ? { source: research.source } : {}),
      created_at: research.created_at
    }));
  const deliverablesIndex = Object.values(state.deliverables)
    .sort((left, right) => left.deliverable_id.localeCompare(right.deliverable_id))
    .map((deliverable) => ({
      deliverable_id: deliverable.deliverable_id,
      title: deliverable.title,
      status: deliverable.status,
      ...(deliverable.reference ? { reference: deliverable.reference } : {}),
      updated_at: deliverable.updated_at
    }));

  return {
    project_id: state.project_id,
    revision: state.revision,
    name: state.name,
    slug: state.slug,
    aliases: state.aliases,
    objective: state.objective,
    framing: state.framing,
    discovery: state.discovery,
    status: state.status,
    current_phase_id: state.current_phase_id,
    current_phase: currentPhase,
    active_tasks: activeTasks,
    blockers,
    constraints,
    accepted_decisions: acceptedDecisions,
    research_index: researchIndex,
    deliverables_index: deliverablesIndex,
    updated_at: state.updated_at
  };
}

async function encryptFallbackResponse(
  guard: DurableObjectStub,
  decrypted: DecryptedFallbackEnvelope,
  plaintext: Record<string, unknown>
): Promise<Response> {
  const encrypted = await guard.fetch("https://fallback-ingress.internal/encrypt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key_id: decrypted.key_id,
      client_public_key: decrypted.client_public_key,
      plaintext: JSON.stringify(plaintext)
    })
  });
  if (!encrypted.ok) {
    await encrypted.text();
    return Response.json({ error: "fallback_response_encryption_failed" }, { status: 502 });
  }
  return new Response(encrypted.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorizedIngress(request: Request, env: Env): boolean {
  if (typeof env.INGRESS_TOKEN !== "string" || env.INGRESS_TOKEN.length === 0) return false;
  const authorization = request.headers.get("authorization");
  return !!authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`);
}

function authorizedRecovery(request: Request, env: Env, now = Date.now()): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  if (typeof env.INGRESS_TOKEN === "string" && env.INGRESS_TOKEN.length > 0
      && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;

  const operatorToken = env.INPUT_RECOVERY_OPERATOR_TOKEN;
  return Boolean(operatorToken && validOperatorToken(operatorToken, now)
    && secureStringEqual(authorization, `Bearer ${operatorToken}`));
}

function authorizedResolution(request: Request, env: Env, now = Date.now()): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  if (
    typeof env.INGRESS_TOKEN === "string" &&
    env.INGRESS_TOKEN.length > 0 &&
    secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)
  ) return true;

  const operatorToken = env.MUTATION_GATE_OPERATOR_TOKEN;
  if (!operatorToken || !validOperatorToken(operatorToken, now)) return false;

  return secureStringEqual(authorization, `Bearer ${operatorToken}`);
}

function validOperatorToken(token: string, now: number): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;

  const issuedAt = Number(token.slice(0, separator));
  if (!Number.isSafeInteger(issuedAt)) return false;
  if (issuedAt > now + OPERATOR_TOKEN_FUTURE_SKEW_MS) return false;
  if (now - issuedAt > OPERATOR_TOKEN_TTL_MS) return false;

  return true;
}

function secureStringEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
