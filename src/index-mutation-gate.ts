import { deploymentIdentity } from "./deployment/identity";
import { AdmissionError } from "./admission/mutation-context";
import { decodeAdmission } from "./admission/transport";
import { parseMutationCandidateResolutionRequest } from "./domain/mutation-candidate-resolution";
import type { ProjectState } from "./domain/project-state";
import type { Env } from "./env";
import {
  MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES,
  parseFallbackDecryptedRequest
} from "./fallback/contract";
import baseWorker from "./index";
import { searchReadDisabledResponse, searchReadEnabled } from "./search/read-mode";

export { DropboxChangeGuard } from "./durable/dropbox-change-guard";
export { MaterializationGuard } from "./durable/materialization-guard";
export { DiagnosticProjectGuard as ProjectGuard } from "./durable/project-guard-diagnostics";
export { RegistryGuard } from "./durable/registry-guard";
export { SearchSyncGuard } from "./durable/search-sync-guard";
export { SearchIndexGuard } from "./search/search-index-guard";

const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
const OPERATOR_TOKEN_FUTURE_SKEW_MS = 60_000;
const EXACT_PROJECT_ID = /^PRJ-[0-9]{4}$/;

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
      const registry = env.REGISTRY_GUARD.getByName("global");
      const response = await registry.fetch("https://registry-guard.internal/fallback/key", { method: "GET" });
      if (!response.ok) return fallbackIngressError(503);
      return fallbackIngressResponse(await response.text(), response.status);
    }

    if (request.method === "POST" && url.pathname === "/v1/fallback-ingress") {
      if (!authorizedIngress(request, env)) return fallbackIngressError(401);
      const declaredLength = request.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES)) {
        return fallbackIngressError(400);
      }
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_FALLBACK_ENCRYPTED_REQUEST_BYTES) return fallbackIngressError(400);

      const registry = env.REGISTRY_GUARD.getByName("global");
      const decrypted = await registry.fetch("https://registry-guard.internal/fallback/decrypt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw
      });
      if (!decrypted.ok) return fallbackIngressError(400);

      let exchange: FallbackDecryptExchange;
      let fallbackRequest;
      try {
        exchange = parseFallbackDecryptExchange(await decrypted.json());
        fallbackRequest = parseFallbackDecryptedRequest(exchange.plaintext);
        if (fallbackRequest.request_id !== exchange.request_id || fallbackRequest.operation !== exchange.operation) {
          return fallbackIngressError(400);
        }
      } catch {
        return fallbackIngressError(400);
      }

      if (fallbackRequest.operation === "transaction") {
        const transactionResponse = await baseWorker.fetch(new Request("https://fallback-ingress.internal/v1/transactions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.INGRESS_TOKEN}`,
            "content-type": "application/json"
          },
          body: fallbackRequest.admission_json
        }), env, ctx);
        let receipt: unknown;
        try {
          receipt = JSON.parse(await transactionResponse.text());
        } catch {
          return encryptFallbackResult(registry, exchange, {
            status: "unavailable",
            operation: "transaction",
            request_id: fallbackRequest.request_id,
            code: "transaction_response_unavailable"
          });
        }
        return encryptFallbackResult(registry, exchange, {
          status: "ok",
          operation: "transaction",
          request_id: fallbackRequest.request_id,
          response_status: transactionResponse.status,
          receipt
        });
      }

      const canonicalResponse = await env.PROJECT_GUARD.getByName(fallbackRequest.project_id).fetch(
        "https://project-guard.internal/mutation-context",
        { headers: { authorization: `Bearer ${env.INGRESS_TOKEN}` } }
      );
      if (!canonicalResponse.ok) {
        return encryptFallbackResult(registry, exchange, {
          status: "unavailable",
          operation: "project_context",
          request_id: fallbackRequest.request_id,
          code: "canonical_unavailable"
        });
      }
      try {
        const canonical = await canonicalResponse.json<CanonicalMutationContext>();
        if (!canonical.context || !canonical.canonical_state) {
          return encryptFallbackResult(registry, exchange, {
            status: "unavailable",
            operation: "project_context",
            request_id: fallbackRequest.request_id,
            code: "canonical_unavailable"
          });
        }
        return encryptFallbackResult(registry, exchange, {
          status: "ok",
          operation: "project_context",
          request_id: fallbackRequest.request_id,
          project: compactCanonicalState(canonical.canonical_state),
          mutation_context: canonical.context
        });
      } catch {
        return encryptFallbackResult(registry, exchange, {
          status: "unavailable",
          operation: "project_context",
          request_id: fallbackRequest.request_id,
          code: "canonical_unavailable"
        });
      }
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

      let admission;
      try {
        admission = decodeAdmission(await request.json(), parseMutationCandidateResolutionRequest);
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        return Response.json({
          error: "invalid_mutation_candidate_resolution",
          message: error instanceof Error ? error.message : "Invalid mutation candidate resolution request"
        }, { status: 400 });
      }

      const stub = env.PROJECT_GUARD.getByName(admission.request.project_id);
      return stub.fetch("https://project-guard.internal/mutation-candidate-resolution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(admission)
      });
    }

    return baseWorker.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;

export default worker;

function authorizedIngress(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  if (typeof env.INGRESS_TOKEN === "string" && env.INGRESS_TOKEN.length > 0
      && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;

  const operatorToken = env.CONTROL_TOWER_OPERATOR_TOKEN;
  return Boolean(operatorToken && validOperatorToken(operatorToken, Date.now())
    && secureStringEqual(authorization, `Bearer ${operatorToken}`));
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

  if (secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;

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
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

interface FallbackDecryptExchange {
  key_id: string;
  request_id: string;
  operation: "project_context" | "transaction";
  plaintext: string;
}

interface CanonicalMutationContext {
  context: Record<string, unknown>;
  canonical_state: ProjectState;
}

function parseFallbackDecryptExchange(value: unknown): FallbackDecryptExchange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fallback exchange");
  const candidate = value as Record<string, unknown>;
  const expected = ["key_id", "operation", "plaintext", "request_id"];
  const actual = Object.keys(candidate).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || typeof candidate.key_id !== "string"
    || typeof candidate.request_id !== "string"
    || typeof candidate.plaintext !== "string"
    || (candidate.operation !== "project_context" && candidate.operation !== "transaction")
  ) throw new Error("invalid fallback exchange");
  return {
    key_id: candidate.key_id,
    request_id: candidate.request_id,
    operation: candidate.operation,
    plaintext: candidate.plaintext
  };
}

async function encryptFallbackResult(registry: DurableObjectStub, exchange: FallbackDecryptExchange, result: unknown): Promise<Response> {
  const encrypted = await registry.fetch("https://registry-guard.internal/fallback/encrypt-and-rotate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key_id: exchange.key_id,
      request_id: exchange.request_id,
      operation: exchange.operation,
      plaintext: JSON.stringify(result)
    })
  });
  if (!encrypted.ok) return fallbackIngressError(503);
  return fallbackIngressResponse(await encrypted.text(), encrypted.status);
}

function compactCanonicalState(state: ProjectState) {
  const byId = <T>(records: Record<string, T>, id: (value: T) => string) => Object.values(records)
    .sort((left, right) => id(left).localeCompare(id(right)));
  const tasks = byId(state.tasks, (task) => task.task_id);
  const phases = byId(state.plan_phases, (phase) => phase.phase_id);
  const currentPhase = state.current_phase_id ? phases.find((phase) => phase.phase_id === state.current_phase_id) ?? null : null;
  return {
    identity: {
      project_id: state.project_id,
      name: state.name,
      slug: state.slug,
      aliases: [...state.aliases]
    },
    revision: state.revision,
    lifecycle: state.status,
    objective: state.objective,
    current_phase: currentPhase,
    active_tasks: tasks.filter((task) => task.status === "active"),
    blocked_tasks: tasks.filter((task) => task.status === "blocked"),
    blockers: tasks.filter((task) => task.status === "blocked").map((task) => ({
      task_id: task.task_id,
      reason: task.blocked_reason ?? null
    })),
    constraints: byId(state.constraints, (constraint) => constraint.constraint_id),
    accepted_decisions: byId(state.decisions, (decision) => decision.decision_id).filter((decision) => decision.status === "accepted"),
    research_index: byId(state.research, (research) => research.research_id).map((research) => ({
      research_id: research.research_id,
      title: research.title,
      source: research.source ?? null,
      created_at: research.created_at
    })),
    deliverable_index: byId(state.deliverables, (deliverable) => deliverable.deliverable_id).map((deliverable) => ({
      deliverable_id: deliverable.deliverable_id,
      title: deliverable.title,
      status: deliverable.status,
      version: deliverable.version ?? null,
      updated_at: deliverable.updated_at
    })),
    timestamps: { created_at: state.created_at, updated_at: state.updated_at }
  };
}

function fallbackIngressResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" }
  });
}

function fallbackIngressError(status: number): Response {
  return Response.json({ error: "fallback_ingress_unavailable" }, {
    status,
    headers: { "cache-control": "no-store" }
  });
}
