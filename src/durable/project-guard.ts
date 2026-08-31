import { IntakeRepository } from "../documents/intake-repository";
import { computeIntakeHealth } from "../documents/intake-health";
import type { Env } from "../env";
import { resolveSchemaWriterStageForProject } from "../schema/writer-stage";
import { ProjectGuard as NeutralProjectGuard } from "./project-guard-neutral";

export * from "./project-guard-neutral";

export class ProjectGuard extends NeutralProjectGuard {
  private readonly projectId: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    const projectId = ctx.id.name ?? null;
    const writerStage = resolveSchemaWriterStageForProject(
      env.PROJECT_OS_SCHEMA_WRITER_STAGE,
      env.PROJECT_OS_SCHEMA_CANARY_PROJECT_ID,
      projectId,
      env.PROJECT_OS_SCHEMA_CORE_V2_FLOOR_PROJECT_IDS
    );
    super(ctx, {
      ...env,
      PROJECT_OS_SCHEMA_WRITER_STAGE: writerStage,
      PROJECT_OS_SCHEMA_CANARY_PROJECT_ID: undefined,
      PROJECT_OS_SCHEMA_CORE_V2_FLOOR_PROJECT_IDS: undefined
    });
    this.projectId = projectId;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/intake-health") {
      if (!this.projectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      return Response.json(await this.intakeHealthSnapshot(this.projectId));
    }

    const response = await super.fetch(request);
    if (
      request.method !== "POST"
      || url.pathname !== "/reconcile-documents"
      || !response.ok
      || !this.projectId
    ) return response;

    const summary = await response.clone().json<Record<string, unknown>>();
    const now = new Date().toISOString();
    const repository = new IntakeRepository(this.persistence);
    const existing = await repository.readHealth(this.projectId);
    const records = await repository.list(this.projectId);
    const archived = summary.archived === true;
    const health = computeIntakeHealth(this.projectId, records, now, {
      last_reconcile_at: archived ? existing?.last_reconcile_at ?? null : now,
      last_direct_sweep_at: archived ? existing?.last_direct_sweep_at ?? null : now
    });

    if (!archived) await repository.writeHealth(health);
    console.info("Project OS intake health", {
      project_id: this.projectId,
      pending_count: health.pending_count,
      stale_count: health.stale_count,
      failed_retryable_count: health.failed_retryable_count,
      failed_non_retryable_count: health.failed_non_retryable_count
    });

    return Response.json({ ...summary, health }, { status: response.status });
  }

  private async intakeHealthSnapshot(projectId: string) {
    const repository = new IntakeRepository(this.persistence);
    const [records, existing] = await Promise.all([
      repository.list(projectId),
      repository.readHealth(projectId)
    ]);
    return computeIntakeHealth(projectId, records, new Date().toISOString(), {
      last_reconcile_at: existing?.last_reconcile_at ?? null,
      last_direct_sweep_at: existing?.last_direct_sweep_at ?? null
    });
  }
}
