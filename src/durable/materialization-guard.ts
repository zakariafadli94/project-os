import { DurableObject } from "cloudflare:workers";
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import type { ProjectState } from "../domain/project-state";
import type { Env } from "../env";
import { MaterializationCoordinator } from "../materialization/coordinator";
import { initializeMaterializationSchema, MaterializationLedger } from "../materialization/ledger";
import {
  MaterializationOutputConflictError,
  parseProjectionConcurrency,
  WorkspaceProjectionWriter
} from "../materialization/writer";
import { parseLayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProjectRepository } from "../persistence/repository";

const MATERIALIZATION_ALARM_DELAY_MS = 1_000;
const MATERIALIZATION_DEFER_DELAY_MS = 300_000;

export interface MaterializationTargetRequestBody {
  project_id: string;
  revision: number;
  projection_version: number;
}

export class MaterializationGuard extends DurableObject<Env> {
  private readonly projectId: string;
  private readonly persistence: ProjectOsPersistenceRuntime;
  private readonly repository: ProjectRepository;
  private readonly ledger: MaterializationLedger;
  private readonly coordinator: MaterializationCoordinator;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const projectId = ctx.id.name;
    if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
      throw new Error("MaterializationGuard requires a named PRJ-xxxx Durable Object instance");
    }
    this.projectId = projectId;
    initializeMaterializationSchema(ctx.storage);
    this.persistence = createProductionPersistence(env);
    this.repository = new ProjectRepository(this.persistence, parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
    this.ledger = new MaterializationLedger(ctx.storage);
    this.coordinator = new MaterializationCoordinator({
      projectId,
      repository: this.repository,
      ledger: this.ledger,
      writer: new WorkspaceProjectionWriter(
        this.persistence.objects,
        parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY)
      ),
      projectionVersion: CURRENT_PROJECTION_VERSION
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/request-target") {
      return this.serialize(() => this.handleRequestTarget(request));
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.serialize(() => this.handleStatus());
    }
    if (request.method === "POST" && url.pathname === "/reconcile") {
      return this.serialize(() => this.handleReconcile());
    }
    if (request.method === "POST" && url.pathname === "/materialize") {
      return this.serialize(() => this.handleMaterialize(request));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.serialize(async () => {
      try {
        const result = await this.coordinator.runNext(alarmInfo?.retryCount ?? 0);
        if (result.more_work) {
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        }
      } catch (error) {
        if (error instanceof MaterializationOutputConflictError) {
          console.error(
            "Project OS materialization blocked",
            structuredMaterializationError(this.projectId, error)
          );
          return;
        }
        if ((alarmInfo?.retryCount ?? 0) >= 5) {
          console.error(
            "Project OS materialization deferred after alarm retries",
            structuredMaterializationError(this.projectId, error)
          );
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_DEFER_DELAY_MS);
          return;
        }
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        throw error;
      }
    });
  }

  private async handleRequestTarget(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_materialization_target" }, { status: 400 });
    }

    if (!isMaterializationTargetRequestBody(body)) {
      return Response.json({ error: "invalid_materialization_target" }, { status: 400 });
    }
    if (body.project_id !== this.projectId) {
      return Response.json({ error: "project_binding_mismatch" }, { status: 409 });
    }

    this.coordinator.requestTarget(body.revision, body.projection_version);
    await this.ensureAlarmIfPending();
    return Response.json({
      project_id: this.projectId,
      requested: this.coordinator.status().requested
    });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.canonicalState();
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    await this.coordinator.reconcile(state.revision);
    await this.ensureAlarmIfPending();
    return Response.json(this.statusResponse(state));
  }

  private async handleReconcile(): Promise<Response> {
    const state = await this.canonicalState();
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    await this.coordinator.reconcile(state.revision);
    await this.ensureAlarmIfPending();
    return Response.json(this.statusResponse(state));
  }

  private async handleMaterialize(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_materialize_request" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || (body as { target?: unknown }).target !== "workspace-v2") {
      return Response.json({ error: "invalid_materialize_target" }, { status: 400 });
    }

    const state = await this.canonicalState();
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });

    const record = state.revision > 0
      ? await this.repository.readCommitRecord(state.project_id, state.revision)
      : null;
    if (record) {
      await this.coordinator.reconcile(state.revision);
      this.coordinator.requestTarget(state.revision, CURRENT_PROJECTION_VERSION);
      await this.coordinator.runUntilIdle();
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.repository.materializeV2(state);
    }

    return Response.json({
      project_id: state.project_id,
      revision: state.revision,
      materialized: true
    });
  }

  /**
   * Discover the newest canonical ProjectState without depending on projection.
   *
   * The machine state snapshot is a projection-time accelerator and can lag a
   * newly committed immutable record. Start from that snapshot when available,
   * then walk the contiguous immutable commit chain forward until the first
   * missing revision. This keeps MaterializationGuard independent from
   * ProjectGuard while preserving immutable commit truth as the authority.
   */
  private async canonicalState(): Promise<ProjectState | null> {
    let state = await this.repository.readProjectState(this.projectId);
    if (state && state.project_id !== this.projectId) {
      throw new Error(
        `MaterializationGuard state binding mismatch: expected ${this.projectId}, got ${state.project_id}`
      );
    }

    let nextRevision = (state?.revision ?? 0) + 1;
    while (true) {
      const record = await this.repository.readCommitRecord(this.projectId, nextRevision);
      if (!record) return state;

      const expectedPreviousRevision = state?.revision ?? 0;
      if (
        record.project_id !== this.projectId
        || record.previous_revision !== expectedPreviousRevision
        || record.new_revision !== nextRevision
        || record.state.project_id !== this.projectId
        || record.state.revision !== nextRevision
        || record.state.last_event_id !== record.event.event_id
        || record.receipt.status !== "committed"
        || record.receipt.project_id !== this.projectId
        || record.receipt.previous_revision !== expectedPreviousRevision
        || record.receipt.new_revision !== nextRevision
        || record.receipt.event_id !== record.event.event_id
      ) {
        throw new Error(
          `MaterializationGuard canonical commit binding mismatch for ${this.projectId} revision ${nextRevision}`
        );
      }

      state = record.state;
      nextRevision += 1;
    }
  }

  private statusResponse(state: ProjectState) {
    const status = this.coordinator.status();
    return {
      project_id: state.project_id,
      canonical_revision: state.revision,
      projection_version: CURRENT_PROJECTION_VERSION,
      materialized_head: status.head,
      requested: status.requested,
      active: status.active
        ? {
            revision: status.active.revision,
            projection_version: status.active.projection_version
          }
        : null,
      blocked_error: status.last_error,
      output_count: status.output_count,
      attempt_output_count: status.attempt_output_count
    };
  }

  private async ensureAlarmIfPending(): Promise<void> {
    const status = this.coordinator.status();
    if (!status.active && !status.requested) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isMaterializationTargetRequestBody(value: unknown): value is MaterializationTargetRequestBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MaterializationTargetRequestBody>;
  return typeof candidate.project_id === "string"
    && /^PRJ-[0-9]{4,}$/.test(candidate.project_id)
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision as number) >= 0
    && Number.isSafeInteger(candidate.projection_version)
    && (candidate.projection_version as number) >= 1;
}

function structuredMaterializationError(projectId: string, error: unknown) {
  return {
    project_id: projectId,
    projection_version: CURRENT_PROJECTION_VERSION,
    error_name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof MaterializationOutputConflictError
      ? { output_key: error.key, path: error.path }
      : {})
  };
}
