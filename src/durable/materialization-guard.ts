import { DurableObject } from "cloudflare:workers";
import {
  createSliceBudget,
  providerCheckpointScopeFor,
  providerReservedEffectScopeFor,
  providerRequestScopeFor
} from "../convergence/budget";
import { ConvergenceEngine } from "../convergence/engine";
import { unknownHealth } from "../convergence/health";
import type { ConvergenceHealth } from "../convergence/contract";
import { ConvergenceJournal } from "../convergence/journal";
import { convergenceModeForProject, type CapacityObservation } from "../convergence/rollout";
import { deploymentIdentity } from "../deployment/identity";
import {
  monitoringNotificationPort,
  workerLogConvergenceTelemetry
} from "../convergence/observability";
import { classifyCapacityWork } from "../convergence/capacity-work";
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import type { ProjectState } from "../domain/project-state";
import type { Env } from "../env";
import { MaterializationCoordinator } from "../materialization/coordinator";
import { ProviderOperationError } from "../persistence/provider/errors";
import {
  advanceCanonicalCoverageProof,
  advanceMaterializationCoverageCursor,
  materializationCoversTarget,
  parseMaterializationCoverageCursor,
  type MaterializationCoverageCursor
} from "../materialization/coverage";
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
const MATERIALIZATION_COVERAGE_CURSOR_KEY = "materialization-coverage-cursor";
const CANONICAL_STATE_CURSOR_KEY = "canonical-state-reconstruction-cursor";

interface CanonicalStateCursor {
  schema_version: "1.0";
  project_id: string;
  snapshot_revision: number;
  next_revision: number;
  state: ProjectState | null;
}

interface CanonicalStateResult {
  state: ProjectState | null;
  complete: boolean;
}

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
    if (request.method === "GET" && url.pathname === "/diagnostic-status") {
      return this.serialize(() => this.handleDiagnosticStatus());
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
    let notifying = false;
    try {
      const notify = await this.serialize(async () => {
        if (await this.ctx.storage.get<string>(CANONICAL_STATE_CURSOR_KEY)) {
          const { canonicalRepository, budget } = this.coordinatorForSlice();
          await this.canonicalState(canonicalRepository, budget);
          // Keep canonical reconstruction isolated to its own shared-budget
          // wake. The following wake may safely start materialization work.
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
          return false;
        }
        const convergenceMode = convergenceModeForProject(
          this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
          this.projectId
        );
        if (convergenceMode === "repair") {
          if (!await this.resumeConvergenceFromVerifiedHead()) return false;
          if (await this.ensureConvergenceRequestedFromLedger()) {
            await this.scheduleConvergenceContinuation(true, new Date().toISOString());
            return;
          }
          const { engine, budget } = this.convergenceEngineForSlice();
          const result = await engine.runSlice(budget);
          await this.scheduleConvergenceContinuation(result.more_work, result.next_alarm_at);
          // A newer target may still be converging while the published head
          // already proves earlier committed transactions.  Finalization of
          // those covered receipts must not wait for unrelated later output.
          return true;
        }
        // A V2 project is owned exclusively by the convergence writer once it
        // is activated. Before activation, legacy queued targets must not let
        // the old coordinator write (or perpetually re-arm itself).
        // The V2 writer is inactive outside the explicit repair rollout, but
        // a previously published V2 head can still certify committed work.
        // Keep the retired writer idle while always delivering that harmless,
        // idempotent finalization callback.
        if (this.layoutMode === "v2") return true;
        const { coordinator } = this.coordinatorForSlice();
        const result = await coordinator.runNext(alarmInfo?.retryCount ?? 0);
        // A synchronous /materialize can finish the target before this alarm
        // runs. In that case runNext reports idle, not completed, but the
        // already-published head still needs its deferred finalization.
        if (result.more_work) {
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        }
        return result.completed || !result.more_work;
      });
      // ProjectGuard may already be waiting for this actor's status/capacity.
      // Never retain our queue while calling back into its serialized boundary.
      if (notify) {
        notifying = true;
        const finalized = await this.notifyProjectGuardOfCurrentHead();
        if (!finalized) {
          await this.serialize(() => this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS));
        }
      }
    } catch (error) {
      return this.serialize(async () => {
        // A concurrent request may have armed an earlier wake or a provider
        // backoff while the callback was outside our queue. That durable wake
        // will retry finalization too; do not replace it with our stale retry.
        const existingWake = notifying ? await this.ctx.storage.getAlarm() : null;
        const retryDelayMs = materializationRetryDelayMs(error);
        const retryAt = Date.now() + retryDelayMs;
        if (existingWake !== null && existingWake > Date.now() && existingWake <= retryAt) {
          console.error("Project OS finalization retry retained earlier wake", structuredMaterializationError(this.projectId, error));
          return;
        }
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
        await this.ctx.storage.setAlarm(retryAt);
        // Transient provider errors already have a durable retry alarm. Letting
        // the platform retry the failed alarm invocation can replace that
        // provider-directed wake with its shorter automatic backoff.
        if (error instanceof ProviderOperationError && error.retryable) return;
        throw error;
      });
    }
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
    if (convergenceModeForProject(this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES, this.projectId) === "repair") {
      const { engine } = this.convergenceEngineForSlice();
      await engine.requestTarget({ revision: body.revision, projection_version: body.projection_version });
    }
    await this.ensureAlarmIfPending();
    return Response.json({
      project_id: this.projectId,
      requested: this.ledger.status().requested
    });
  }

  private async handleStatus(): Promise<Response> {
    const { coordinator, canonicalRepository, budget } = this.coordinatorForSlice();
    const state = await this.canonicalState(canonicalRepository, budget);
    if (!state.complete) return this.canonicalStatePendingResponse();
    const canonicalState = state.state;
    if (!canonicalState) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    await coordinator.reconcile(canonicalState.revision);
    await this.ensureAlarmIfPending();
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    const convergence = convergenceMode !== "off"
      ? await this.observeConvergence()
      : undefined;
    return Response.json(this.statusResponse(canonicalState, convergence));
  }

  /**
   * Returns only durable convergence and materialization cursors. Unlike the
   * operational status endpoint, this diagnostic path never reconciles,
   * schedules, or repairs; it is safe to use while investigating a stalled
   * writer without perturbing its next slice.
   */
  private async handleDiagnosticStatus(): Promise<Response> {
    const { canonicalRepository, budget } = this.coordinatorForSlice();
    const state = await this.canonicalState(canonicalRepository, budget, false);
    if (!state.complete) return this.canonicalStatePendingResponse(false);
    const canonicalState = state.state;
    if (!canonicalState) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const status = this.ledger.status();
    const saved = await new ConvergenceJournal(
      createProductionPersistence(this.env, this.projectId),
      this.projectId
    ).load();
    const human = Object.values(saved?.progress.obligations ?? {}).find((obligation) =>
      obligation.layer === "human_handoff" && obligation.target.revision === canonicalState.revision
    );
    return Response.json({
      ...this.statusResponse(canonicalState),
      diagnostic: {
        read_only: true,
        active_status: status.active_status,
        final_verification_pending_count: this.ledger.finalVerificationPending().length,
        final_verification_pending: this.ledger.finalVerificationPending().map((item) => ({
          key: item.key,
          expected: item.expected
        })),
        managed_zones_ready: this.ledger.managedZoneBootstrapReady(),
        human_handoff: human
          ? {
              state: human.state,
              first_pending_at: human.first_pending_at,
              next_attempt_at: human.next_attempt_at,
              code: human.code,
              last_attempt_number: human.last_attempt_number
            }
          : null,
        last_queue: saved?.progress.last_queue ?? null,
        convergence_canonical_observed_revision: saved?.progress.canonical_observed_revision ?? null,
        convergence_requested: saved?.progress.requested ?? null,
        convergence_active: saved?.progress.active ?? null,
        pending_obligations: Object.values(saved?.progress.obligations ?? {})
          .filter((obligation) => obligation.state !== "verified")
          .map((obligation) => ({
            layer: obligation.layer,
            state: obligation.state,
            target_revision: obligation.target.revision,
            next_attempt_at: obligation.next_attempt_at,
            code: obligation.code
          })),
        next_alarm_at: saved?.progress.next_alarm_at ?? null
      }
    });
  }

  private async hasDurablyVerifiedCurrentTarget(record: import("../domain/commit-record").CanonicalCommitRecord): Promise<boolean> {
    const target = { revision: record.new_revision, projection_version: CURRENT_PROJECTION_VERSION };
    const head = this.ledger.status().head;
    if (!head || head.revision !== target.revision || head.projection_version !== target.projection_version) {
      return false;
    }
    const saved = await new ConvergenceJournal(
      createProductionPersistence(this.env, this.projectId),
      this.projectId
    ).load();
    if (!saved) return false;
    const progress = saved.progress;
    const targetObligations = Object.values(progress.obligations).filter((obligation) =>
      obligation.target.revision === target.revision
      && obligation.target.projection_version === target.projection_version
    );
    return progress.canonical_observed_revision >= target.revision
      && progress.active === null
      && progress.requested === null
      && progress.next_alarm_at === null
      && targetObligations.some((obligation) => obligation.layer === "human_handoff" && obligation.state === "verified")
      && targetObligations.every((obligation) => obligation.state === "verified");
  }

  private async hasCanonicallyBoundCurrentHead(record: import("../domain/commit-record").CanonicalCommitRecord): Promise<boolean> {
    const runtime = createProductionPersistence(this.env, this.projectId);
    const repository = new ProjectRepository(runtime, this.layoutMode);
    const providerHead = await repository.readMaterializationHead(this.projectId);
    if (!providerHead
      || providerHead.target_revision !== record.new_revision
      || providerHead.projection_version !== CURRENT_PROJECTION_VERSION) return false;
    const completed = await repository.readMaterializationRecord(
      this.projectId,
      providerHead.target_revision,
      providerHead.projection_version
    );
    if (!completed
      || completed.result_root_hash !== providerHead.result_root_hash
      || completed.workspace_location !== providerHead.workspace_location
      || completed.completed_at !== providerHead.completed_at) return false;
    // This helper only admits the record at the head's own revision. A
    // coalesced revision can prove an earlier transaction, never the head
    // commit itself; accepting it here would let a malformed record replace
    // the canonical event binding.
    return completed.source_event_id === record.event.event_id;
  }

  private async hasCurrentDurableHead(record: import("../domain/commit-record").CanonicalCommitRecord): Promise<boolean> {
    const localHead = this.ledger.status().head;
    if (!localHead
      || localHead.revision !== record.new_revision
      || localHead.projection_version !== CURRENT_PROJECTION_VERSION
      || !await this.hasCanonicallyBoundCurrentHead(record)) return false;
    const runtime = createProductionPersistence(this.env, this.projectId);
    const saved = await new ConvergenceJournal(runtime, this.projectId).load();
    return saved !== null && saved.progress.canonical_observed_revision >= record.new_revision;
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
    const outstanding = Object.values(saved?.progress.obligations ?? {})
      .filter((obligation) => obligation.state !== "verified");
    const work = classifyCapacityWork(outstanding, Date.now());
    const pending = work.executable;
    const continuationRequired = status.active !== null || status.requested !== null || pending.length > 0;
    const alarm = await this.ctx.storage.getAlarm();
    const queuedOutputs = Math.max(
      pending.length,
      status.active === null ? 0 : status.attempt_output_count,
      status.requested === null ? 0 : Math.max(1, status.output_count)
    );
    const oldestPendingSeconds = work.oldest_pending_seconds;
    const runtime = createProductionPersistence(this.env, this.projectId);
    const repository = new ProjectRepository(runtime, this.layoutMode);
    const [head, canonicalState] = await Promise.all([
      repository.readMaterializationHead(this.projectId),
      repository.readProjectState(this.projectId)
    ]);
    const blocking = work.terminal[0]
      ?? pending[0]
      ?? outstanding[0]
      ?? null;
    const continuationAvailable = !continuationRequired || alarm !== null;
    const withinQualifiedEnvelope = queuedOutputs <= 200 && oldestPendingSeconds <= 600;
    const reason = !continuationAvailable
      ? "continuation_unavailable"
      : queuedOutputs > 200
        ? "queued_outputs_exceeded"
        : oldestPendingSeconds > 600
          ? "oldest_pending_exceeded"
          : work.terminal.length > 0
            ? "repair_required"
            : undefined;
    const observation: CapacityObservation = {
      queued_outputs: queuedOutputs,
      oldest_pending_seconds: oldestPendingSeconds,
      continuation_available: continuationAvailable,
      within_qualified_envelope: withinQualifiedEnvelope,
      reason,
      canonical_revision: Math.max(
        canonicalState?.revision ?? 0,
        saved?.progress.canonical_observed_revision ?? 0,
        status.active?.revision ?? 0,
        status.requested?.revision ?? 0,
        ...outstanding.map((obligation) => obligation.target.revision)
      ),
      materialized_revision: head?.target_revision ?? null,
      blocking_obligation: blocking === null ? null : {
        layer: blocking.layer,
        target_revision: blocking.target.revision,
        code: blocking.code
      },
      retry_after_seconds: blocking?.next_attempt_at && !work.terminal.includes(blocking)
        && Number.isFinite(Date.parse(blocking.next_attempt_at))
        ? Math.max(0, Math.ceil((Date.parse(blocking.next_attempt_at) - Date.now()) / 1_000))
        : null
    };
    return Response.json(observation);
  }

  private async handleReconcile(): Promise<Response> {
    const { coordinator, repository, canonicalRepository, budget } = this.coordinatorForSlice();
    const state = await this.canonicalState(canonicalRepository, budget);
    if (!state.complete) return this.canonicalStatePendingResponse();
    const canonicalState = state.state;
    if (!canonicalState) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    if (convergenceMode === "repair") {
      const journal = new ConvergenceJournal(
        createProductionPersistence(this.env, this.projectId),
        this.projectId
      );
      if (!await this.resumeConvergenceFromVerifiedHead()) {
        return Response.json({ project_id: this.projectId, status: "pending", reason: "baseline_reconstruction_pending" }, { status: 202 });
      }
      const saved = await journal.load();
      const head = await repository.readMaterializationHead(this.projectId);
      const headCurrent = head !== null
      && head.target_revision === canonicalState.revision
        && head.projection_version === CURRENT_PROJECTION_VERSION;
      const hasPendingConvergence = saved !== null && (
        saved.progress.active !== null
        || saved.progress.requested !== null
        || Object.values(saved.progress.obligations).some((obligation) => obligation.state !== "verified")
      );
      const currentRecord = headCurrent && canonicalState.revision > 0
        ? await repository.readCommitRecord(this.projectId, canonicalState.revision)
        : null;
      if (currentRecord && await this.hasCurrentDurableHead(currentRecord)) {
        // This request may have come through ProjectGuard. Notify from the
        // alarm after the response, so the two Durable Objects cannot wait
        // synchronously on each other.
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        return Response.json(this.statusResponse(canonicalState));
      }
      // A stale obligation can only be verified against a current physical
      // generation. Always request that generation first; otherwise the
      // verifier can keep retrying an old head forever without doing the work
      // that would make its own condition true.
      if (!headCurrent) {
        const { engine } = this.convergenceEngineForSlice();
        await engine.requestTarget({ revision: canonicalState.revision, projection_version: CURRENT_PROJECTION_VERSION });
        await this.scheduleConvergenceContinuation(
          true,
          hasPendingConvergence && saved?.progress.next_alarm_at
            ? saved.progress.next_alarm_at
            : new Date().toISOString()
        );
      } else if (hasPendingConvergence) {
        await this.scheduleConvergenceContinuation(true, saved.progress.next_alarm_at);
      }
      return Response.json(this.statusResponse(canonicalState));
    }
        await coordinator.reconcile(canonicalState.revision);
    // In the default V2 rollout there is no active writer once a head is
    // current, so ensureAlarmIfPending intentionally has nothing to wake.
    // The head can nevertheless cover committed transactions that still need
    // their idempotent ProjectGuard finalization certificate. Fleet
    // reconciliation is the durable recovery boundary for that callback.
    if (this.layoutMode === "v2") {
      const head = await repository.readMaterializationHead(this.projectId);
      const currentRecord = head
        && head.target_revision === canonicalState.revision
        && head.projection_version === CURRENT_PROJECTION_VERSION
        ? await repository.readCommitRecord(this.projectId, canonicalState.revision)
        : null;
      if (currentRecord && await this.hasCanonicallyBoundCurrentHead(currentRecord)) {
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        return Response.json(this.statusResponse(canonicalState));
      }
    }
    await this.ensureAlarmIfPending();
    return Response.json(this.statusResponse(canonicalState));
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

    const { coordinator, repository, canonicalRepository, budget } = this.coordinatorForSlice();
    const state = await this.canonicalState(canonicalRepository, budget);
    if (!state.complete) return this.canonicalStatePendingResponse();
    const canonicalState = state.state;
    if (!canonicalState) return Response.json({ error: "project_not_initialized" }, { status: 404 });

    const record = canonicalState.revision > 0
      ? await repository.readCommitRecord(canonicalState.project_id, canonicalState.revision)
      : null;
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    if (this.layoutMode === "v2" && convergenceMode !== "repair") {
      return Response.json({
        error: "convergence_writer_inactive",
        project_id: canonicalState.project_id,
        mode: convergenceMode
      }, { status: 409 });
    }
    if (record) {
      if (convergenceMode === "repair") {
        if (!await this.resumeConvergenceFromVerifiedHead()) {
          return Response.json({
            project_id: canonicalState.project_id,
            revision: canonicalState.revision,
            materialized: false,
            status: "pending"
          }, { status: 202 });
        }
        // resumeConvergenceFromVerifiedHead has already closed covered
        // obligations, but only after re-observing the four mutable views when
        // this head actually needed an acknowledgement.
        const providerHeadCurrent = await this.hasCurrentDurableHead(record);
        if (providerHeadCurrent && await this.hasDurablyVerifiedCurrentTarget(record)) {
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
          return Response.json({
            project_id: canonicalState.project_id,
            revision: canonicalState.revision,
            materialized: true,
            status: "current"
          });
        }
        const target = { revision: canonicalState.revision, projection_version: CURRENT_PROJECTION_VERSION };
        const journal = new ConvergenceJournal(
          createProductionPersistence(this.env, this.projectId),
          this.projectId
        );
        const saved = await journal.load();
        const targetKnown = [saved?.progress.active, saved?.progress.requested].some((candidate) =>
          candidate !== null
          && candidate !== undefined
          && candidate.revision >= target.revision
          && candidate.projection_version >= target.projection_version
        );
        if (!targetKnown) {
          const requester = this.convergenceEngineForSlice();
          await requester.engine.requestTarget(target);
        }
        const { engine, budget } = this.convergenceEngineForSlice();
        const result = await engine.runSlice(budget);
        // A recovery slice may spend its bounded request budget discovering
        // that no durable work remains. Re-observe with a fresh read-only
        // budget before reporting "pending"; otherwise a verified canary is
        // indistinguishable from an unfinished one to this admin endpoint.
        const health = result.more_work || result.health.converged
          ? result.health
          : await (() => {
              const verification = this.convergenceEngineForSlice();
              return verification.engine.observe(verification.budget);
            })();
        if (result.more_work || !health.converged) {
          await this.scheduleConvergenceContinuation(true, result.next_alarm_at);
          return Response.json({
            project_id: canonicalState.project_id,
            revision: canonicalState.revision,
            materialized: false,
            status: "pending"
          }, { status: 202 });
        }
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        return Response.json({
          project_id: canonicalState.project_id,
          revision: canonicalState.revision,
          materialized: true,
          status: "current"
        });
      }
      await coordinator.reconcile(canonicalState.revision);
      coordinator.requestTarget(canonicalState.revision, CURRENT_PROJECTION_VERSION);
      let result = await coordinator.runNext();
      for (let slice = 0; result.more_work && slice < 127; slice += 1) {
        result = await this.coordinatorForSlice().coordinator.runNext();
      }
      if (result.more_work) {
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
        return Response.json({
          project_id: canonicalState.project_id,
          revision: canonicalState.revision,
          materialized: false,
          status: "pending"
        }, { status: 202 });
      }
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    } else {
      if (this.layoutMode === "v2" && convergenceMode === "repair") {
        return Response.json({
          error: "historical_baseline_unavailable",
          project_id: canonicalState.project_id
        }, { status: 409 });
      }
      await repository.materializeV2(canonicalState);
    }

    const response: { project_id: string; revision: number; materialized: true; status?: "current" } = {
      project_id: canonicalState.project_id,
      revision: canonicalState.revision,
      materialized: true
    };
    if (convergenceMode === "repair") response.status = "current";
    return Response.json(response);
  }

  private async notifyProjectGuardOfCurrentHead(): Promise<boolean> {
    const repository = new ProjectRepository(
      createProductionPersistence(this.env, this.projectId),
      this.layoutMode
    );
    const head = await this.serialize(() => repository.readMaterializationHead(this.projectId));
    if (!head) return true;
    const response = await this.env.PROJECT_GUARD.getByName(this.projectId).fetch(
      "https://project-guard.internal/finalize-materialization",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_revision: head.target_revision,
          projection_version: head.projection_version
        })
      }
    );
    if (response.status === 202) return false;
    if (!response.ok) throw new Error(`ProjectGuard finalization notification returned ${response.status}`);
    return this.serialize(() => this.resumeConvergenceFromVerifiedHead());
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
  private async canonicalState(
    repository: Pick<ProjectRepository, "readProjectState" | "readCommitRecord">,
    budget: import("../convergence/contract").SliceBudget = createSliceBudget(() => Date.now(), new AbortController().signal),
    persist = true
  ): Promise<CanonicalStateResult> {
    let snapshot = await repository.readProjectState(this.projectId);
    if (snapshot && snapshot.project_id !== this.projectId) {
      throw new Error(`MaterializationGuard state binding mismatch: expected ${this.projectId}, got ${snapshot.project_id}`);
    }
    const snapshotRevision = snapshot?.revision ?? 0;
    const rawCursor = await this.ctx.storage.get<string>(CANONICAL_STATE_CURSOR_KEY);
    let cursor = parseCanonicalStateCursor(rawCursor, this.projectId, snapshotRevision);
    let state = snapshot;
    let nextRevision = snapshotRevision + 1;

    if (cursor) {
      if (cursor.state?.revision === snapshotRevision
        && JSON.stringify(cursor.state) !== JSON.stringify(snapshot)) {
        throw new Error(`MaterializationGuard canonical reconstruction snapshot binding mismatch for ${this.projectId}`);
      }
      if (cursor.state && cursor.state.revision > snapshotRevision) {
        if (!budget.canStartEffect(4)) return { state: null, complete: false };
        try {
          const frontier = await repository.readCommitRecord(this.projectId, cursor.state.revision);
          if (!frontier || !isCanonicalCommitBinding(frontier, this.projectId, cursor.state.revision)
            || JSON.stringify(frontier.state) !== JSON.stringify(cursor.state)) {
            throw new Error(`MaterializationGuard canonical reconstruction cursor binding mismatch for ${this.projectId}`);
          }
        } catch (error) {
          if (isSliceBudgetExhaustion(error)) return { state: null, complete: false };
          throw error;
        }
      }
      state = cursor.state;
      nextRevision = cursor.next_revision;
    } else {
      if (snapshotRevision > 0) {
        if (!budget.canStartEffect(4)) return { state: null, complete: false };
        try {
          const root = await repository.readCommitRecord(this.projectId, snapshotRevision);
          if (!root || !isCanonicalCommitBinding(root, this.projectId, snapshotRevision)
            || JSON.stringify(root.state) !== JSON.stringify(snapshot)) {
            throw new Error(`MaterializationGuard canonical snapshot binding mismatch for ${this.projectId}`);
          }
        } catch (error) {
          if (isSliceBudgetExhaustion(error)) return { state: null, complete: false };
          throw error;
        }
      }
      cursor = {
        schema_version: "1.0",
        project_id: this.projectId,
        snapshot_revision: snapshotRevision,
        next_revision: nextRevision,
        state
      };
    }

    while (budget.canStartEffect(4)) {
      let record: Awaited<ReturnType<ProjectRepository["readCommitRecord"]>>;
      try {
        record = await repository.readCommitRecord(this.projectId, nextRevision);
      } catch (error) {
        if (isSliceBudgetExhaustion(error)) {
          if (persist) await this.ctx.storage.put(CANONICAL_STATE_CURSOR_KEY, JSON.stringify(cursor));
          return { state: null, complete: false };
        }
        throw error;
      }
      if (!record) {
        if (persist) await this.ctx.storage.delete(CANONICAL_STATE_CURSOR_KEY);
        return { state, complete: true };
      }
      const expectedPreviousRevision = state?.revision ?? 0;
      if (!isCanonicalCommitBinding(record, this.projectId, nextRevision, expectedPreviousRevision)) {
        throw new Error(`MaterializationGuard canonical commit binding mismatch for ${this.projectId} revision ${nextRevision}`);
      }

      state = record.state;
      nextRevision += 1;
      cursor = { ...cursor, next_revision: nextRevision, state };
      // Persist after each verified immutable step. A crash can repeat at most
      // the frontier check, never mistake an incomplete walk for current.
      if (persist) await this.ctx.storage.put(CANONICAL_STATE_CURSOR_KEY, JSON.stringify(cursor));
    }
    if (persist) await this.ctx.storage.put(CANONICAL_STATE_CURSOR_KEY, JSON.stringify(cursor));
    return { state: null, complete: false };
  }

  private async canonicalStatePendingResponse(schedule = true): Promise<Response> {
    if (schedule) await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    return Response.json({
      project_id: this.projectId,
      status: "pending",
      reason: "canonical_state_reconstruction_pending"
    }, { status: 202 });
  }

  private async resumeConvergenceFromVerifiedHead(): Promise<boolean> {
    const { coordinator, repository, budget } = this.coordinatorForSlice();
    const runtime = createProductionPersistence(this.env, this.projectId, providerRequestScopeFor(budget));
    const journal = new ConvergenceJournal(runtime, this.projectId);
    const head = await repository.readMaterializationHead(this.projectId);
    if (head === null || head.projection_version !== CURRENT_PROJECTION_VERSION) return true;
    const tip = await repository.readMaterializationRecord(
      this.projectId,
      head.target_revision,
      head.projection_version
    );
    if (
      tip === null
      || !tip.current_views_proof
      || tip.result_root_hash !== head.result_root_hash
      || tip.workspace_location !== head.workspace_location
      || tip.completed_at !== head.completed_at
    ) throw new Error(`Materialization resume point binding mismatch for ${this.projectId}`);
    const canonical = await repository.readCommitRecord(this.projectId, head.target_revision);
    if (canonical === null || tip.source_event_id !== canonical.event.event_id) {
      throw new Error(`Materialization resume point canonical binding mismatch for ${this.projectId}`);
    }
    const baseline = await coordinator.rebuildExistingHeadBaseline(head.target_revision, head);
    if (baseline === "pending" || baseline.reconstructed) {
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
      return false;
    }
    const saved = await journal.load();
    const covered = (target: { revision: number; projection_version: number } | null | undefined): boolean =>
      target !== null && target !== undefined
      && target.revision <= head.target_revision
      && target.projection_version <= head.projection_version;
    const acknowledgementRequired = saved === null
      || saved.progress.canonical_observed_revision < head.target_revision
      || covered(saved.progress.active)
      || covered(saved.progress.requested)
      || Object.values(saved.progress.obligations).some((obligation) =>
        obligation.layer === "human_handoff"
        && obligation.state !== "verified"
        && covered(obligation.target)
      );
    if (acknowledgementRequired) {
      try {
        const viewsVerified = await coordinator.verifyExistingHeadCurrentViews(tip, canonical, baseline.baseline.outputs);
        if (!viewsVerified) {
          await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
          return false;
        }
      } catch (error) {
        const transient = error instanceof ProviderOperationError && error.retryable
          || error instanceof Error && (
            error.name === "AbortError"
            || error.name === "TimeoutError"
            || /slice_budget_exhausted|fetch failed|network (?:error|failure|unavailable)|timed? out|\bECONN(?:RESET|REFUSED|TIMEDOUT)\b|\bEAI_AGAIN\b|\bENOTFOUND\b/i.test(error.message)
          );
        if (!transient) throw error;
        await this.ctx.storage.setAlarm(Date.now() + materializationRetryDelayMs(error));
        return false;
      }
      if (saved !== null) await this.acknowledgeVerifiedHumanHead(head.target_revision, head.projection_version);
    }
    const refreshed = await journal.load();
    if (refreshed === null || refreshed.progress.canonical_observed_revision < head.target_revision) {
      await journal.resumeFromVerifiedMaterialization(head.target_revision);
    }
    return true;
  }

  private async acknowledgeVerifiedHumanHead(revision: number, projectionVersion: number): Promise<void> {
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const readRuntime = createProductionPersistence(
      this.env,
      this.projectId,
      providerRequestScopeFor(budget)
    );
    const checkpointRuntime = createProductionPersistence(
      this.env,
      this.projectId,
      providerCheckpointScopeFor(budget)
    );
    const repository = new ProjectRepository(readRuntime, this.layoutMode);
    const journal = new ConvergenceJournal(readRuntime, this.projectId);
    const saved = await journal.load();
    if (!saved) return;
    const storedCursor = await this.ctx.storage.get<string>(MATERIALIZATION_COVERAGE_CURSOR_KEY);
    const cursor = await this.collectVerifiedCoverage(
      repository,
      typeof storedCursor === "string" ? storedCursor : null,
      revision,
      projectionVersion,
      budget,
      saved.progress.obligations
    );
    if (!cursor) return;
    const verifiedAt = new Date().toISOString();
    for (const [id, obligation] of Object.entries(saved.progress.obligations)) {
      if (obligation.layer !== "human_handoff" || !materializationCoversTarget(
        obligation.target,
        { revision, projection_version: projectionVersion },
        cursor.covered_targets
      )) continue;
      saved.progress.obligations[id] = {
        ...obligation,
        state: "verified",
        next_attempt_at: null,
        last_verified_at: verifiedAt,
        code: null,
        lease_until: null,
        continuation: null
      };
    }
    const verifiedTarget = { revision, projection_version: projectionVersion };
    if (saved.progress.active && materializationCoversTarget(saved.progress.active, verifiedTarget, cursor.covered_targets)) {
      saved.progress.active = null;
    }
    if (saved.progress.requested && materializationCoversTarget(saved.progress.requested, verifiedTarget, cursor.covered_targets)) {
      saved.progress.requested = null;
    }
    const remaining = Object.values(saved.progress.obligations).filter((obligation) => obligation.state !== "verified");
    saved.progress.next_alarm_at = remaining.length === 0 && cursor.complete
      ? null
      : remaining.map((obligation) => obligation.next_attempt_at ?? verifiedAt).sort()[0] ?? verifiedAt;
    // The verified cursor is durable evidence used by the following journal
    // acknowledgement. Persist it first so a crash can only cause harmless
    // re-verification, never an acknowledged target with a missing cursor.
    await this.ctx.storage.put(MATERIALIZATION_COVERAGE_CURSOR_KEY, JSON.stringify(cursor));
    await new ConvergenceJournal(checkpointRuntime, this.projectId).save(saved.progress, saved.token);
    if ((!cursor.complete || cursor.lineage_verification !== null)
      && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    }
  }

  private async collectVerifiedCoverage(
    repository: ProjectRepository,
    cursorJson: string | null,
    revision: number,
    projectionVersion: number,
    budget: import("../convergence/contract").SliceBudget,
    obligations: Record<string, import("../convergence/contract").Obligation>
  ): Promise<MaterializationCoverageCursor | null> {
    if (!budget.canStartEffect(10)) return null;
    const [completed, headCommit] = await Promise.all([
      repository.readMaterializationRecord(this.projectId, revision, projectionVersion),
      repository.readCommitRecord(this.projectId, revision)
    ]);
    if (!completed || !headCommit || completed.source_event_id !== headCommit.event.event_id) return null;

    const stored = parseMaterializationCoverageCursor(
      cursorJson,
      this.projectId,
      revision,
      projectionVersion,
      headCommit.event.event_id
    );
    let cursor = stored ?? {
      schema_version: "1.0" as const,
      project_id: this.projectId,
      head_revision: revision,
      head_projection_version: projectionVersion,
      head_event_id: headCommit.event.event_id,
      next_parent: completed.parent,
      child: {
        target_revision: completed.target_revision,
        projection_version: completed.projection_version,
        chain_depth: completed.chain_depth,
        record_kind: completed.record_kind,
        parent: completed.parent
      },
      visited: [`${revision}:${projectionVersion}`],
      covered_targets: [{ revision, projection_version: projectionVersion }],
      coalesced_claims: completed.coalesced_revisions
        .filter((candidate) => Number.isSafeInteger(candidate) && candidate >= 1 && candidate < revision)
        .map((candidate) => ({
          target: { revision: candidate, projection_version: projectionVersion },
          source_revision: revision,
          source_event_id: completed.source_event_id ?? ""
        })),
      lineage_verification: null,
      complete: completed.record_kind === "snapshot" || completed.parent === null
    } satisfies MaterializationCoverageCursor;

    if (!cursor.complete) {
      // The shared scoped provider budget allows at most 28 effect reads and
      // reserves four calls for checkpoint persistence. Each ancestor costs
      // one immutable record read and one canonical event-binding read.
      while (cursor.next_parent !== null && budget.canStartEffect(10)) {
        const parentRef = cursor.next_parent;
        const key = `${parentRef.target_revision}:${parentRef.projection_version}`;
        if (cursor.visited.includes(key)) break;
        try {
          const parent = await repository.readMaterializationRecord(
            this.projectId,
            parentRef.target_revision,
            parentRef.projection_version
          );
          if (!parent) break;
          const commit = await repository.readCommitRecord(this.projectId, parent.target_revision);
          if (!commit || !advanceMaterializationCoverageCursor(cursor, parent, commit)) break;
        } catch {
          // Keep the last durable cursor and retry from this exact parent on
          // the next scheduled pass. No unread ancestor is treated as absent.
          break;
        }
      }
    }

    const pendingTargets = Object.values(obligations)
      .filter((obligation) => obligation.layer === "human_handoff" && obligation.state !== "verified")
      .map((obligation) => obligation.target);
    const resumeTarget = cursor.lineage_verification?.target;
    const resumeIndex = resumeTarget
      ? pendingTargets.findIndex((target) => target.revision === resumeTarget.revision
        && target.projection_version === resumeTarget.projection_version)
      : -1;
    if (resumeTarget && resumeIndex >= 0) {
      const [savedTarget] = pendingTargets.splice(resumeIndex, 1);
      pendingTargets.unshift(savedTarget!);
    } else if (resumeTarget) {
      cursor.lineage_verification = null;
    }
    for (const candidate of pendingTargets) {
      const claim = cursor.coalesced_claims.find((entry) => entry.target.revision === candidate.revision
        && entry.target.projection_version >= candidate.projection_version);
      if (!claim) continue;
      if (cursor.covered_targets.some((covered) => covered.revision === candidate.revision
        && covered.projection_version >= candidate.projection_version)
        ) continue;
      let verification = cursor.lineage_verification;
      if (!verification || verification.target.revision !== candidate.revision
        || verification.target.projection_version !== candidate.projection_version
        || verification.source_revision !== claim.source_revision
        || verification.source_event_id !== claim.source_event_id) {
        verification = {
          project_id: this.projectId,
          target: candidate,
          source_revision: claim.source_revision,
          source_event_id: claim.source_event_id,
          next_revision: candidate.revision
        };
        cursor.lineage_verification = verification;
      }
      while (verification.next_revision <= verification.source_revision && budget.canStartEffect(5)) {
        try {
          const commit = await repository.readCommitRecord(this.projectId, verification.next_revision);
          if (!commit) break;
          const step = advanceCanonicalCoverageProof(verification, commit);
          if (step === "invalid") {
            cursor.lineage_verification = null;
            break;
          }
          if (step === "complete") {
            cursor.covered_targets.push(candidate);
            cursor.lineage_verification = null;
            break;
          }
        } catch {
          // Keep the bounded checkpoint and retry the same canonical revision.
          break;
        }
      }
      // A partial lineage cursor is the durable continuation. Do not replace
      // it with a later target and starve this target across slices.
      if (cursor.lineage_verification !== null) break;
    }
    cursor.covered_targets = uniqueTargets(cursor.covered_targets);
    cursor.coalesced_claims = [...new Map(cursor.coalesced_claims.map((claim) => [
      `${claim.target.revision}:${claim.target.projection_version}:${claim.source_revision}:${claim.source_event_id}`, claim
    ])).values()];
    return cursor;
  }

  private async ensureConvergenceRequestedFromLedger(): Promise<boolean> {
    const status = this.ledger.status();
    const target = status.requested ?? (status.active
      ? { revision: status.active.revision, projection_version: status.active.projection_version }
      : null);
    if (!target) return false;
    const saved = await new ConvergenceJournal(
      createProductionPersistence(this.env, this.projectId),
      this.projectId
    ).load();
    const known = [saved?.progress.active, saved?.progress.requested].some((candidate) =>
      candidate !== null
      && candidate !== undefined
      && candidate.revision >= target.revision
      && candidate.projection_version >= target.projection_version
    );
    if (known) return false;
    const { engine } = this.convergenceEngineForSlice();
    await engine.requestTarget(target);
    return true;
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

  private coordinatorForSlice(
    bounded = true,
    convergenceOwned = false
  ): {
    coordinator: MaterializationCoordinator;
    repository: ProjectRepository;
    canonicalRepository: ProjectRepository;
    budget: ReturnType<typeof createSliceBudget>;
  } {
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const persistence = createProductionPersistence(
      this.env,
      this.projectId,
      bounded ? providerRequestScopeFor(budget) : undefined
    );
    const canonicalRepository = bounded
      ? new ProjectRepository(persistence, this.layoutMode)
      : new ProjectRepository(
          createProductionPersistence(this.env, this.projectId, providerRequestScopeFor(budget)),
          this.layoutMode
        );
    const repository = new ProjectRepository(persistence, this.layoutMode);
    return {
      repository,
      canonicalRepository,
      budget,
      coordinator: new MaterializationCoordinator({
        projectId: this.projectId,
        repository,
        ledger: this.ledger,
        writer: new WorkspaceProjectionWriter(persistence, this.projectionConcurrency),
        projectionVersion: CURRENT_PROJECTION_VERSION,
        canonicalDerivativesAlreadyCurrent: convergenceOwned,
        verifyExistingCriticalPairOnly: convergenceOwned,
        ...(convergenceOwned ? { finalVerificationBatchMax: 8 } : {}),
        ...(bounded ? { sliceBudget: budget } : {})
      })
    };
  }

  private convergenceEngineForSlice(): { engine: ConvergenceEngine; budget: ReturnType<typeof createSliceBudget> } {
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const persistence = createProductionPersistence(this.env, this.projectId, providerRequestScopeFor(budget));
    const checkpointPersistence = createProductionPersistence(
      this.env,
      this.projectId,
      providerCheckpointScopeFor(budget)
    );
    const effectPersistence = createProductionPersistence(
      this.env,
      this.projectId,
      providerReservedEffectScopeFor(budget)
    );
    const repository = new ProjectRepository(persistence, this.layoutMode);
    const humanRepository = new ProjectRepository(effectPersistence, this.layoutMode);
    return {
      budget,
      engine: new ConvergenceEngine({
        projectId: this.projectId,
        repository,
        runtime: persistence,
        effectRuntime: effectPersistence,
        humanRepository,
        humanProjectionConcurrency: this.projectionConcurrency,
        journal: new ConvergenceJournal(checkpointPersistence, this.projectId),
        ledger: this.ledger,
        now: () => Date.now(),
        deploymentSha: deploymentIdentity(this.env).git_sha ?? "unknown",
        enableHuman: true,
        discoveryMaxRecords: 1,
        finalVerificationBatchMax: 8,
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

function uniqueTargets(targets: readonly { revision: number; projection_version: number }[]) {
  const unique = new Map<string, { revision: number; projection_version: number }>();
  for (const target of targets) unique.set(`${target.revision}:${target.projection_version}`, target);
  return [...unique.values()];
}

function parseCanonicalStateCursor(
  raw: string | undefined,
  projectId: string,
  snapshotRevision: number
): CanonicalStateCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CanonicalStateCursor>;
    if (value.schema_version !== "1.0"
      || value.project_id !== projectId
      || value.snapshot_revision !== snapshotRevision
      || !Number.isSafeInteger(value.next_revision)
      || (value.next_revision as number) < 1) return null;
    const state = value.state ?? null;
    if (state !== null && (state.project_id !== projectId
      || !Number.isSafeInteger(state.revision)
      || state.revision < snapshotRevision
      || state.revision + 1 !== value.next_revision
      || typeof state.last_event_id !== "string")) return null;
    if (state === null && (snapshotRevision !== 0 || value.next_revision !== 1)) return null;
    return value as CanonicalStateCursor;
  } catch {
    return null;
  }
}

function isCanonicalCommitBinding(
  record: import("../domain/commit-record").CanonicalCommitRecord,
  projectId: string,
  revision: number,
  expectedPreviousRevision = revision - 1
): boolean {
  return record.project_id === projectId
    && record.previous_revision === expectedPreviousRevision
    && record.new_revision === revision
    && record.state.project_id === projectId
    && record.state.revision === revision
    && record.state.last_event_id === record.event.event_id
    && record.receipt.status === "committed"
    && record.receipt.project_id === projectId
    && record.receipt.previous_revision === expectedPreviousRevision
    && record.receipt.new_revision === revision
    && record.receipt.event_id === record.event.event_id;
}

function isSliceBudgetExhaustion(error: unknown): boolean {
  return error instanceof Error && error.message.includes("slice_budget_exhausted");
}

function materializationRetryDelayMs(error: unknown): number {
  if (error instanceof ProviderOperationError && error.retryable) {
    const retryAfterMs = error.diagnostics?.retryAfterMs;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.max(MATERIALIZATION_ALARM_DELAY_MS, Math.min(24 * 60 * 60 * 1_000, retryAfterMs));
    }
  }
  return MATERIALIZATION_ALARM_DELAY_MS;
}
