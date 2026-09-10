import { DurableObject } from "cloudflare:workers";
import { createSliceBudget, providerRequestScopeFor } from "../convergence/budget";
import { ConvergenceEngine } from "../convergence/engine";
import { unknownHealth } from "../convergence/health";
import type { ConvergenceHealth } from "../convergence/contract";
import { ConvergenceJournal } from "../convergence/journal";
import { convergenceModeForProject, type CapacityObservation } from "../convergence/rollout";
import { deploymentIdentity } from "../deployment/identity";
import {
  monitoringNotificationPort,
  oldestPendingAgeMs,
  workerLogConvergenceTelemetry
} from "../convergence/observability";
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
  private readonly ledger: MaterializationLedger;
  private readonly layoutMode: ReturnType<typeof parseLayoutMode>;
  private readonly projectionConcurrency: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const projectId = ctx.id.name;
    if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
      throw new Error("MaterializationGuard requires a named PRJ-xxxx Durable Object instance");
    }
    this.projectId = projectId;
    initializeMaterializationSchema(ctx.storage);
    this.ledger = new MaterializationLedger(ctx.storage);
    this.layoutMode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    this.projectionConcurrency = parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/request-target") {
      return this.serialize(() => this.handleRequestTarget(request));
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.serialize(() => this.handleStatus());
    }
    if (request.method === "GET" && url.pathname === "/capacity") {
      return this.serialize(() => this.handleCapacity());
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
        if (convergenceModeForProject(this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES, this.projectId) === "repair") {
          const { engine, budget } = this.convergenceEngineForSlice();
          const result = await engine.runSlice(budget);
          await this.scheduleConvergenceContinuation(result.more_work, result.next_alarm_at);
          return;
        }
        const { coordinator } = this.coordinatorForSlice();
        const result = await coordinator.runNext(alarmInfo?.retryCount ?? 0);
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

    this.ledger.requestTarget({ revision: body.revision, projection_version: body.projection_version });
    await this.ensureAlarmIfPending();
    return Response.json({
      project_id: this.projectId,
      requested: this.ledger.status().requested
    });
  }

  private async handleStatus(): Promise<Response> {
    const { coordinator, repository } = this.coordinatorForSlice(false);
    const state = await this.canonicalState(repository);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    await coordinator.reconcile(state.revision);
    await this.ensureAlarmIfPending();
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    const convergence = convergenceMode !== "off"
      ? await this.observeConvergence()
      : undefined;
    return Response.json(this.statusResponse(state, convergence));
  }

  /**
   * Internal, read-only admission probe. ProjectGuard uses it before a new
   * canonical commit only for an explicitly enabled repair writer. A missing
   * durable alarm while work is pending is an unavailable continuation.
   */
  private async handleCapacity(): Promise<Response> {
    const status = this.ledger.status();
    const saved = await new ConvergenceJournal(
      createProductionPersistence(this.env, this.projectId),
      this.projectId
    ).load();
    const pending = Object.values(saved?.progress.obligations ?? {})
      .filter((obligation) => obligation.state !== "verified");
    const continuationRequired = status.active !== null || status.requested !== null || pending.length > 0;
    const alarm = await this.ctx.storage.getAlarm();
    const queuedOutputs = pending.length
      + (status.active === null ? 0 : status.attempt_output_count)
      + (status.requested === null ? 0 : Math.max(1, status.output_count));
    const oldestPendingSeconds = saved === null
      ? 0
      : oldestPendingAgeMs(saved.progress, Date.now()) / 1_000;
    const observation: CapacityObservation = {
      queued_outputs: queuedOutputs,
      oldest_pending_seconds: oldestPendingSeconds,
      continuation_available: !continuationRequired || alarm !== null,
      within_qualified_envelope: queuedOutputs <= 200 && oldestPendingSeconds <= 600
    };
    return Response.json(observation);
  }

  private async handleReconcile(): Promise<Response> {
    const { coordinator, repository } = this.coordinatorForSlice(false);
    const state = await this.canonicalState(repository);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    if (convergenceMode === "repair") {
      const journal = new ConvergenceJournal(
        createProductionPersistence(this.env, this.projectId),
        this.projectId
      );
      const saved = await journal.load();
      const hasPendingConvergence = saved !== null && (
        saved.progress.active !== null
        || saved.progress.requested !== null
        || Object.values(saved.progress.obligations).some((obligation) => obligation.state !== "verified")
      );
      if (hasPendingConvergence) {
        await this.scheduleConvergenceContinuation(true, saved.progress.next_alarm_at);
      } else {
        const head = await repository.readMaterializationHead(this.projectId);
        const headCurrent = head !== null
          && head.target_revision === state.revision
          && head.projection_version === CURRENT_PROJECTION_VERSION;
        if (!headCurrent) {
          const { engine } = this.convergenceEngineForSlice();
          await engine.requestTarget({ revision: state.revision, projection_version: CURRENT_PROJECTION_VERSION });
          await this.scheduleConvergenceContinuation(true, new Date().toISOString());
        }
      }
      return Response.json(this.statusResponse(state));
    }
    await coordinator.reconcile(state.revision);
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

    const { coordinator, repository } = this.coordinatorForSlice();
    const state = await this.canonicalState(repository);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });

    const record = state.revision > 0
      ? await repository.readCommitRecord(state.project_id, state.revision)
      : null;
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    if (this.layoutMode === "v2" && convergenceMode !== "repair") {
      return Response.json({
        error: "convergence_writer_inactive",
        project_id: state.project_id,
        mode: convergenceMode
      }, { status: 409 });
    }
    if (record) {
      if (convergenceMode === "repair") {
        const { engine, budget } = this.convergenceEngineForSlice();
        const result = await engine.runSlice(budget);
        if (result.more_work || !result.health.converged) {
          await this.scheduleConvergenceContinuation(true, result.next_alarm_at);
          return Response.json({
            project_id: state.project_id,
            revision: state.revision,
            materialized: false,
            status: "pending"
          }, { status: 202 });
        }
        await this.ctx.storage.deleteAlarm();
        return Response.json({
          project_id: state.project_id,
          revision: state.revision,
          materialized: true,
          status: "current"
        });
      }
      await coordinator.reconcile(state.revision);
      coordinator.requestTarget(state.revision, CURRENT_PROJECTION_VERSION);
      let result = await coordinator.runNext();
      for (let slice = 0; result.more_work && slice < 127; slice += 1) {
        result = await this.coordinatorForSlice().coordinator.runNext();
      }
      if (result.more_work) {
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        return Response.json({
          project_id: state.project_id,
          revision: state.revision,
          materialized: false,
          status: "pending"
        }, { status: 202 });
      }
      await this.ctx.storage.deleteAlarm();
    } else {
      if (this.layoutMode === "v2" && convergenceMode === "repair") {
        return Response.json({
          error: "historical_baseline_unavailable",
          project_id: state.project_id
        }, { status: 409 });
      }
      await repository.materializeV2(state);
    }

    const response: { project_id: string; revision: number; materialized: true; status?: "current" } = {
      project_id: state.project_id,
      revision: state.revision,
      materialized: true
    };
    if (convergenceMode === "repair") response.status = "current";
    return Response.json(response);
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
  private async canonicalState(repository: ProjectRepository): Promise<ProjectState | null> {
    let state = await repository.readProjectState(this.projectId);
    if (state && state.project_id !== this.projectId) {
      throw new Error(
        `MaterializationGuard state binding mismatch: expected ${this.projectId}, got ${state.project_id}`
      );
    }

    let nextRevision = (state?.revision ?? 0) + 1;
    while (true) {
      const record = await repository.readCommitRecord(this.projectId, nextRevision);
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

  private statusResponse(state: ProjectState, convergence?: ConvergenceHealth) {
    const status = this.ledger.status();
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
      attempt_output_count: status.attempt_output_count,
      convergence: convergence ?? unknownHealth(state.project_id, new Date().toISOString())
    };
  }

  private async ensureAlarmIfPending(): Promise<void> {
    const status = this.ledger.status();
    if (!status.active && !status.requested) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    }
  }

  private async observeConvergence(): Promise<ConvergenceHealth> {
    const { engine, budget } = this.convergenceEngineForSlice();
    return engine.observe(budget);
  }

  /**
   * Preserve the journal's earliest durable wake-up. A retry window is a
   * provider-protection invariant, not a hint that may be shortened by an
   * alarm invocation.
   */
  private async scheduleConvergenceContinuation(moreWork: boolean, nextAlarmAt: string | null): Promise<void> {
    if (!moreWork) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const requested = nextAlarmAt === null ? Number.NaN : Date.parse(nextAlarmAt);
    const wakeAt = Number.isFinite(requested) && requested > now
      ? requested
      : now + MATERIALIZATION_ALARM_DELAY_MS;
    const existing = await this.ctx.storage.getAlarm();
    // `nextAlarmAt` is the journal's earliest durable deadline. An older
    // generic materialization alarm must not shorten a retry/backoff window;
    // if another durable concern were earlier it would already be reflected
    // in that same minimum wake.
    if (existing !== wakeAt) {
      await this.ctx.storage.setAlarm(wakeAt);
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

  private coordinatorForSlice(bounded = true): { coordinator: MaterializationCoordinator; repository: ProjectRepository } {
    const budget = bounded ? createSliceBudget(() => Date.now(), new AbortController().signal) : undefined;
    const persistence = createProductionPersistence(
      this.env,
      this.projectId,
      budget ? providerRequestScopeFor(budget) : undefined
    );
    const repository = new ProjectRepository(persistence, this.layoutMode);
    return {
      repository,
      coordinator: new MaterializationCoordinator({
        projectId: this.projectId,
        repository,
        ledger: this.ledger,
        writer: new WorkspaceProjectionWriter(persistence, this.projectionConcurrency),
        projectionVersion: CURRENT_PROJECTION_VERSION,
        ...(budget ? { sliceBudget: budget } : {})
      })
    };
  }

  private convergenceEngineForSlice(): { engine: ConvergenceEngine; budget: ReturnType<typeof createSliceBudget> } {
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const persistence = createProductionPersistence(this.env, this.projectId, providerRequestScopeFor(budget));
    const repository = new ProjectRepository(persistence, this.layoutMode);
    return {
      budget,
      engine: new ConvergenceEngine({
        projectId: this.projectId,
        repository,
        runtime: persistence,
        journal: new ConvergenceJournal(persistence, this.projectId),
        ledger: this.ledger,
        now: () => Date.now(),
        deploymentSha: deploymentIdentity(this.env).git_sha ?? "unknown",
        enableHuman: true,
        notification: monitoringNotificationPort({
          endpoint: this.env.PROJECT_OS_MONITORING_WEBHOOK_URL,
          token: this.env.PROJECT_OS_MONITORING_WEBHOOK_TOKEN
        }),
        telemetry: workerLogConvergenceTelemetry()
      })
    };
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
