import { deploymentIdentity } from "./deployment/identity";
import { parseMutationCandidateResolutionRequest } from "./domain/mutation-candidate-resolution";
import type { Env } from "./env";
import baseWorker from "./index";

export { DropboxChangeGuard } from "./durable/dropbox-change-guard";
export { MutationGateProjectGuard as ProjectGuard } from "./durable/project-guard-mutation-gate";
export { RegistryGuard } from "./durable/registry-guard";
export { SearchIndexGuard } from "./search/search-index-guard";

const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
const OPERATOR_TOKEN_FUTURE_SKEW_MS = 60_000;

const worker = {
  ...baseWorker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", ...deploymentIdentity(env) });
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/schema-status") {
      if (!authorizedIngress(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const projectId = url.searchParams.get("project_id");
      if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
        return Response.json({ error: "invalid_project_id" }, { status: 400 });
      }
      const stub = env.PROJECT_GUARD.getByName(projectId);
      return stub.fetch("https://project-guard.internal/schema-status", { method: "GET" });
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

function authorizedIngress(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return !!authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`);
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
