import type { Env } from "../env";
import { resolveSchemaWriterStageForProject } from "../schema/writer-stage";
import { ProjectGuard as NeutralProjectGuard } from "./project-guard-neutral";

export * from "./project-guard-neutral";

export class ProjectGuard extends NeutralProjectGuard {
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
  }
}
