import type { Env } from "../env";
import { parseReferralWriteRequest } from "../domain/referral-write";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import { InputRecoveryService } from "../documents/input-recovery";
import { ReferralProvenanceRepository } from "../documents/referral-provenance";
import { machineStatePath } from "../persistence/layout";
import { resolveSchemaWriterStageForProject } from "../schema/writer-stage";
import { ProjectGuard as NeutralProjectGuard } from "./project-guard-neutral";

export * from "./project-guard-neutral";

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

export class ProjectGuard extends NeutralProjectGuard {
  private readonly referralProvenance: ReferralProvenanceRepository;
  private readonly inputRecovery: InputRecoveryService;

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
    this.referralProvenance = new ReferralProvenanceRepository(this.persistence.objects);
    this.inputRecovery = new InputRecoveryService(this.persistence);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/referral") {
      return this.handleReferral(request);
    }
    if (request.method === "POST" && url.pathname === "/recover-inputs") {
      return this.handleInputRecovery();
    }
    if (request.method === "GET" && url.pathname === "/input-recovery-status") {
      return this.handleInputRecoveryStatus();
    }
    return super.fetch(request);
  }

  private async handleReferral(request: Request): Promise<Response> {
    let referral;
    try {
      referral = parseReferralWriteRequest(await request.json());
    } catch (error) {
      return Response.json({
        error: "invalid_referral_request",
        message: error instanceof Error ? error.message : "Invalid referral request"
      }, { status: 400 });
    }

    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId || boundProjectId !== referral.target_project_id) {
      return Response.json({
        request_id: referral.request_id,
        source_project_id: referral.source_project_id,
        target_project_id: referral.target_project_id,
        relative_path: referral.relative_path,
        content_sha256: referral.content_sha256,
        status: "rejected",
        code: "PROJECT_BINDING_MISMATCH",
        message: "Durable Object binding does not match referral target_project_id"
      });
    }

    const state = await this.loadBoundState(boundProjectId);
    if (!state) {
      return Response.json({
        request_id: referral.request_id,
        source_project_id: referral.source_project_id,
        target_project_id: referral.target_project_id,
        relative_path: referral.relative_path,
        content_sha256: referral.content_sha256,
        status: "rejected",
        code: "PROJECT_NOT_INITIALIZED",
        message: "Target project state is not initialized"
      });
    }

    return Response.json(await this.referralProvenance.deliver(state, referral));
  }

  private async handleInputRecovery(): Promise<Response> {
    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const state = await this.loadBoundState(boundProjectId);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    return Response.json({
      project_id: boundProjectId,
      ...await this.inputRecovery.recover(state)
    });
  }

  private async handleInputRecoveryStatus(): Promise<Response> {
    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const state = await this.loadBoundState(boundProjectId);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    return Response.json({
      project_id: boundProjectId,
      ...await this.inputRecovery.status(state)
    });
  }

  private async loadBoundState(projectId: string) {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    const rawState = row?.state_json ?? await this.persistence.objects.readText(machineStatePath(projectId));
    if (rawState === null) return null;
    const state = normalizeProjectState(JSON.parse(rawState));
    if (state.project_id !== projectId) {
      throw new Error(`ProjectGuard state binding mismatch: expected ${projectId}, got ${state.project_id}`);
    }
    return state;
  }
}