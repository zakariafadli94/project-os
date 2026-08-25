import type { Env } from "../env";
import { DropboxClient } from "../dropbox/client";
import { MutationGateService, parseMutationGateMode } from "../mutation-gate/service";
import { ProjectGuard as BaseProjectGuard } from "./project-guard";

export class MutationGateProjectGuard extends BaseProjectGuard {
  private readonly gate: MutationGateService;
  private readonly gateMode: "observe" | "enforce";
  private readonly boundProjectId: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.boundProjectId = this.ctx.id.name ?? "";
    this.gateMode = parseMutationGateMode(env.PROJECT_OS_MUTATION_GATE_MODE);
    const dropbox = new DropboxClient({
      appKey: env.DROPBOX_APP_KEY,
      appSecret: env.DROPBOX_APP_SECRET,
      refreshToken: env.DROPBOX_REFRESH_TOKEN
    });
    this.gate = new MutationGateService(dropbox, this.gateMode);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/mutation-candidates") {
      if (!this.boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      return Response.json({
        project_id: this.boundProjectId,
        gate_mode: this.gateMode,
        candidates: await this.gate.list(this.boundProjectId)
      });
    }

    if (request.method === "GET" && url.pathname === "/mutation-candidate-status") {
      const candidateId = url.searchParams.get("candidate_id");
      if (!candidateId || !/^MUTCAND-[A-F0-9]{24}$/.test(candidateId)) {
        return Response.json({ error: "invalid_candidate_id" }, { status: 400 });
      }
      if (!this.boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      const status = await this.gate.status(this.boundProjectId, candidateId);
      if (!status) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      return Response.json(status);
    }

    const response = await super.fetch(request);

    if (request.method === "POST" && url.pathname === "/reconcile-documents" && response.ok) {
      const body = await response.json<Record<string, unknown>>();
      const candidates = typeof body.candidates === "number" ? body.candidates : 0;
      return Response.json({
        ...body,
        mutation_gate_mode: this.gateMode,
        policy_violations: this.gateMode === "enforce" ? candidates : 0
      });
    }

    if (request.method === "POST" && url.pathname === "/artifact" && response.ok) {
      const body = await response.json<Record<string, unknown>>();
      if (
        body.status === "conflict"
        && body.code === "ARTIFACT_CONTENT_CONFLICT"
        && typeof body.message === "string"
        && body.message.startsWith("Unresolved external mutation candidate")
      ) {
        return Response.json({ ...body, code: "UNRESOLVED_EXTERNAL_CANDIDATE" });
      }
      return Response.json(body);
    }

    return response;
  }
}