import { parseMutationCandidateResolutionRequest } from "./domain/mutation-candidate-resolution";
import type { Env } from "./env";
import baseWorker from "./index";

export { MutationGateProjectGuard as ProjectGuard } from "./durable/project-guard-mutation-gate";
export { RegistryGuard } from "./durable/registry-guard";

const worker = {
  ...baseWorker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/mutation-candidates/resolve") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

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

function authorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return Boolean(authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`));
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
