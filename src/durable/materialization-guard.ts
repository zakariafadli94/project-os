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
import { navigationReconcileSchema, navigationWorkFailureSchema, navigationWorkRefSchema, type NavigationCatalogRebuildRequest, type NavigationReconcileRequest, type NavigationWorkRef } from "../domain/zone-navigation";
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
import { initializeMaterializationSchema, MaterializationLedger, type CapacityLedgerSnapshot, type CapacityReservation } from "../materialization/ledger";
import {
  MaterializationOutputConflictError,
  parseProjectionConcurrency,
  WorkspaceProjectionWriter
} from "../materialization/writer";
import { parseLayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProjectRepository } from "../persistence/repository";
import { ExecutionJournal, executionHash } from "../execution/journal";
import type { ExecutionAdmission } from "../execution/contract";
import { ManagedDocumentRequestLedger } from "../documents/request-ledger";
import { ZoneNavigationEngine } from "../documents/zone-navigation";
import { ZoneNavigationInventory } from "../documents/zone-navigation-inventory";
import { ZoneNavigationSources } from "../documents/zone-navigation-sources";
import { machineDocumentRoot } from "../persistence/layout";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import { sha256Canonical } from "../materialization/hash";
import { canonicalJson } from "../rules/contract";
import type { RuleResource } from "../rules/contract";

const MATERIALIZATION_ALARM_DELAY_MS = 1_000;
const MATERIALIZATION_DEFER_DELAY_MS = 300_000;
const MATERIALIZATION_COVERAGE_CURSOR_KEY = "materialization-coverage-cursor";
const CANONICAL_STATE_CURSOR_KEY = "canonical-state-reconstruction-cursor";
const NAVIGATION_WORK_PREFIX = "navigation-work:";
const NAVIGATION_RETRY_PREFIX = "navigation-retry:";
const NAVIGATION_WORK_CURSOR_KEY = "navigation-work-cursor";
const NAVIGATION_WORK_SCAN_LIMIT = 16;

interface CapacityReservationRequest {
  request_id: string;
  request_hash: string;
  reservation_kind: "transaction" | "document" | "artifact";
  output_cost: number;
  canonical_revision: number;
  operation: string;
  resources: RuleResource[];
  dependency_classification: "resource_bound" | "unknown";
}

interface NavigationWorkSlice {
  ref: NavigationWorkRef;
  publish: boolean;
  failure_code?: string;
}

interface NavigationWorkCandidate {
  key: string;
  value: string;
  requestId: string;
}

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
  private queueDepth = 0;
  private wakeScheduleQueue?: Promise<void>;
  private selectedNavigationWorkRef?: NavigationWorkRef;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const projectId = ctx.id.name;
    if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
      throw new Error("MaterializationGuard requires a named PRJ-xxxx Durable Object instance");
    }
    this.projectId = projectId;
    initializeMaterializationSchema(ctx.storage);
    this.ledger = new MaterializationLedger(ctx.storage, projectId);
    this.layoutMode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    this.projectionConcurrency = parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/request-target") {
      return this.serialize(() => this.handleRequestTarget(request));
    }
    if (request.method === "POST" && url.pathname === "/navigation-work") {
      // This acknowledgement must not queue behind the long materialization
      // alarm: ProjectGuard may be holding its own serializer while enqueueing.
      return this.enqueueNavigationWork(request);
    }
    if (request.method === "GET" && url.pathname === "/navigation-work-status") {
      const requestId = url.searchParams.get("request_id");
      if (!requestId || !/^DOCREQ-[A-Z0-9-]{8,}$/.test(requestId)) {
        return Response.json({ error: "request_identity_required" }, { status: 400 });
      }
      const [work, retryRaw, alarmAt] = await Promise.all([
        this.ctx.storage.get<string>(this.navigationWorkKey(requestId)),
        this.ctx.storage.get<string>(`${NAVIGATION_RETRY_PREFIX}${requestId}`),
        this.ctx.storage.getAlarm()
      ]);
      const retry = retryRaw ? JSON.parse(retryRaw) as { stopped?: unknown; next_attempt_at?: unknown } : null;
      return Response.json({
        project_id: this.projectId,
        request_id: requestId,
        queued: work !== undefined,
        stopped: retry?.stopped === true,
        next_attempt_at: work !== undefined && retry?.stopped !== true && alarmAt !== null
          ? typeof retry?.next_attempt_at === "string" ? retry.next_attempt_at : new Date(alarmAt).toISOString()
          : null
      });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      if (this.queueDepth > 0) return this.busyReadResponse();
      return this.serialize(() => this.handleStatus());
    }
    if (request.method === "GET" && url.pathname === "/diagnostic-status") {
      if (this.queueDepth > 0) return this.busyReadResponse();
      return this.serialize(() => this.handleDiagnosticStatus());
    }
    if (request.method === "GET" && url.pathname === "/capacity") {
      // Capacity is a read-only projection of durable ledger/journal state.
      // Do not queue it behind the long-running maintenance serializer: callers
      // must be able to make an admission decision while effects are suspended.
      // Any missing or inconsistent durable evidence still fails closed in
      // handleCapacity/the admission caller.
      return this.handleCapacity();
    }
    if (request.method === "POST" && url.pathname === "/capacity-reservation") {
      return this.handleCapacityReservation(request);
    }
    if (request.method === "POST" && url.pathname === "/capacity-committed") {
      return this.handleCapacityReservationTransition(request, "reserved", "committed");
    }
    if (request.method === "POST" && url.pathname === "/capacity-handoff") {
      return this.handleCapacityReservationTransition(request, "committed", "handed_off");
    }
    if (request.method === "POST" && url.pathname === "/capacity-release") {
      return this.handleCapacityReservationTransition(request, "reserved", "released");
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
    this.selectedNavigationWorkRef = undefined;
    try {
      // Cloudflare consumes the firing alarm before invoking this handler. Keep
      // a durable retry in place before entering any long external I/O so a
      // crash cannot leave admitted work without its existing continuation.
      const convergenceMode = convergenceModeForProject(this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES, this.projectId);
      const navigationPending = (await this.ctx.storage.list({ prefix: NAVIGATION_WORK_PREFIX })).size > 0;
      const localWorkPending = this.capacityHasPendingWork(this.ledger.capacitySnapshot());
      const thisAlarmOwnsWork = navigationPending
        || ((this.layoutMode !== "v2" || convergenceMode === "repair") && localWorkPending);
      if (thisAlarmOwnsWork && await this.ctx.storage.getAlarm() === null) {
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
      }
      let navigation: NavigationWorkSlice | null = null;
      try {
        navigation = await this.serialize(() => this.runNavigationWorkSlice());
        this.selectedNavigationWorkRef = undefined;
      } catch (error) {
        if (error instanceof Error && error.message.includes("slice_budget_exhausted")) throw error;
        const ref = this.selectedNavigationWorkRef as NavigationWorkRef | undefined;
        this.selectedNavigationWorkRef = undefined;
        if (!ref) throw error;
        await this.reportNavigationWorkFailure(ref, error instanceof ProviderOperationError
          ? error.retryable ? "navigation_provider_temporary" : "navigation_provider_blocked"
          : "navigation_work_internal_failure");
      }
      if (navigation) {
        if (navigation.failure_code) {
          await this.reportNavigationWorkFailure(navigation.ref, navigation.failure_code);
        } else if (navigation.publish) {
          const response = await this.env.PROJECT_GUARD.getByName(this.projectId).fetch(
            "https://project-guard.internal/navigation-publish",
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(navigation.ref) }
          );
          const responseText = await response.text();
          let responseBody: Record<string, unknown> | null = null;
          try { responseBody = JSON.parse(responseText) as Record<string, unknown>; } catch { /* retry below */ }
          const terminalAck = responseBody?.project_id === this.projectId
            && responseBody.request_id === navigation.ref.request_id
            && (responseBody.status === "committed" || responseBody.status === "conflict");
          if (terminalAck && (response.ok || response.status === 409)) {
            await this.serialize(async () => {
              await this.ctx.storage.delete(this.navigationWorkKey(navigation.ref.request_id));
              await this.ctx.storage.delete(`navigation-context:${navigation.ref.request_id}`);
              const remaining = await this.ctx.storage.list({ prefix: NAVIGATION_WORK_PREFIX });
              if (remaining.size > 0) await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
            });
          } else {
            await this.serialize(() => this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS));
          }
        } else {
          await this.serialize(() => this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS));
        }
        // Continue to the existing materialization slice only after the
        // navigation callback has released PG and this DO's own queue.
      }
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
          // Once the writer has durably recorded its final output-verification
          // cursor, resume that bounded proof directly. Re-running discovery,
          // canonical-derivative and journal preflight work on every wake can
          // consume the calls needed for the four-view publication proof.
          // The coordinator retains the shared 32-call budget and fresh view
          // identity checks; successful publication is acknowledged by the
          // normal verified-head resume path on the next wake.
          if (this.ledger.finalVerificationActive()) {
            const { coordinator } = this.coordinatorForSlice(true, true);
            const result = await coordinator.runNext(alarmInfo?.retryCount ?? 0);
            if (result.more_work || result.completed) {
              await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
            }
            return result.completed || !result.more_work;
          }
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

  private navigationWorkKey(requestId: string): string {
    return `${NAVIGATION_WORK_PREFIX}${requestId}`;
  }

  private async enqueueNavigationWork(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "navigation_workref_invalid" }, { status: 400 }); }
    const parsed = navigationWorkRefSchema.safeParse(body);
    if (!parsed.success || parsed.data.project_id !== this.projectId) {
      return Response.json({ error: "navigation_workref_invalid" }, { status: 400 });
    }
    const ref = parsed.data;
    const authorityPath = `${await new ExecutionJournal(createProductionPersistence(this.env, this.projectId), this.projectId, "document", ref.request_id).root()}/admission.json`;
    if (ref.authority_ref !== authorityPath) return Response.json({ error: "navigation_authority_ref_invalid" }, { status: 409 });
    return this.withWakeScheduleLock(async () => {
      const failureRaw = await this.ctx.storage.get<string>(`${NAVIGATION_RETRY_PREFIX}${ref.request_id}`);
      if (failureRaw !== undefined) {
        const failure = JSON.parse(failureRaw) as { stopped?: unknown };
        if (failure.stopped === true) return Response.json({ error: "navigation_work_stopped" }, { status: 409 });
      }
      const key = this.navigationWorkKey(ref.request_id);
      const value = canonicalJson(ref);
      const existing = await this.ctx.storage.get<string>(key);
      if (existing !== undefined && existing !== value) return Response.json({ error: "navigation_workref_conflict" }, { status: 409 });
      if (existing === undefined) await this.ctx.storage.put(key, value);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + MATERIALIZATION_ALARM_DELAY_MS) {
        await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
      }
      return Response.json({ project_id: this.projectId, request_id: ref.request_id, status: "scheduled" }, { status: 202 });
    });
  }

  /** One bounded preparation slice. This runs under MG serialization, but the
   * later PG publication callback is deliberately made only after returning. */
  private async runNavigationWorkSlice(): Promise<NavigationWorkSlice | null> {
    const candidate = await this.selectNavigationWorkCandidate(Date.now());
    if (!candidate) {
      await this.withWakeScheduleLock(async () => {
        const wakeAt = await this.navigationWorkWakeAt(Date.now());
        if (Number.isFinite(wakeAt)) await this.ctx.storage.setAlarm(wakeAt);
      });
      return null;
    }
    const requestId = candidate.requestId;
    const ref = navigationWorkRefSchema.parse(JSON.parse(candidate.value));
    this.selectedNavigationWorkRef = ref;
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const runtime = createProductionPersistence(this.env, this.projectId);
    const contextKey = `navigation-context:${ref.request_id}`;
    const cachedContext = await this.ctx.storage.get<string>(contextKey);
    let request: NavigationReconcileRequest;
    let admission: ExecutionAdmission;
    let state: ProjectState;
    if (cachedContext !== undefined) {
      const saved = JSON.parse(cachedContext) as Record<string, unknown>;
      if (saved.schema_version !== "1.0" || canonicalJson(saved.ref) !== canonicalJson(ref)
        || typeof saved.state_hash !== "string" || await sha256Canonical(saved.state) !== saved.state_hash
        || canonicalJson(saved) !== cachedContext) throw new Error("navigation_work_context_invalid");
      request = navigationReconcileSchema.parse(saved.request);
      admission = saved.admission as ExecutionAdmission;
      state = normalizeProjectState(saved.state as ProjectState);
    } else {
      budget.beforeHttp();
      const intent = await new ManagedDocumentRequestLedger(runtime.objects).readRecoverableIntent(this.projectId, ref.request_id);
      if (!intent) throw new Error("navigation_work_intent_unavailable");
      request = navigationReconcileSchema.parse(JSON.parse(intent.request_json));
      const requestHash = await executionHash(request);
      const journal = new ExecutionJournal(runtime, this.projectId, "document", ref.request_id);
      budget.beforeHttp();
      const admitted = await journal.readAdmission();
      if (request.project_id !== this.projectId || request.request_id !== ref.request_id || request.zone !== ref.zone
        || request.expected_generation !== ref.expected_generation || requestHash !== ref.request_hash
        || !admitted || admitted.admission.project_id !== this.projectId || admitted.admission.request_id !== ref.request_id
        || admitted.admission.operation !== "navigation.reconcile" || admitted.admission.request_hash !== ref.request_hash
        || admitted.admission.verdict !== "allow" || admitted.admission.project_revision !== request.expected_project_revision
        || admitted.admission.resources.length !== 1
        || admitted.admission.resources[0]?.resource_id !== `navigation:${ref.zone}`
        || admitted.admission.resources[0]?.resource_type !== "navigation"
        || admitted.admission.resources[0]?.zone !== ref.zone
        || admitted.admission.resources[0]?.version !== String(ref.expected_generation)
        || ref.authority_ref !== `${await journal.root()}/admission.json`) {
        throw new Error("navigation_work_binding_invalid");
      }
      admission = admitted.admission;
      const frozenPath = `${machineDocumentRoot(this.projectId)}/requests/${ref.request_id}/navigation-admitted-state.json`;
      budget.beforeHttp();
      const frozenRaw = await runtime.objects.readText(frozenPath);
      if (frozenRaw === null) throw new Error("navigation_work_state_unavailable");
      const frozen = JSON.parse(frozenRaw) as Record<string, unknown>;
      if (frozen.schema_version !== "1.0" || frozen.project_id !== this.projectId || frozen.request_id !== ref.request_id
        || frozen.request_hash !== ref.request_hash || frozen.project_revision !== request.expected_project_revision
        || await sha256Canonical(frozen.state) !== frozen.state_hash || canonicalJson(frozen) !== frozenRaw) {
        throw new Error("navigation_work_state_invalid");
      }
      state = normalizeProjectState(frozen.state as ProjectState);
      const workContext = { schema_version: "1.0", ref, request, admission, state, state_hash: await sha256Canonical(state) };
      await this.ctx.storage.put(contextKey, canonicalJson(workContext));
    }
    const sources = new ZoneNavigationSources(runtime);
    const sourceState = await sources.readState(this.projectId, ref.zone, budget);
    // A stale source snapshot is a terminal publication decision made by
    // ProjectGuard, which writes the bound conflict receipt. Only conflicts
    // discovered by preparation itself must use the failure ledger below.
    if (`source:${sourceState.generation}` !== ref.source_snapshot_id) return { ref, publish: true };
    if (sourceState.in_flight_resource_ids.length > 0) return { ref, publish: false };
    if (request.purpose === "compact_catalog_rebuild") {
      const inventory = new ZoneNavigationInventory(runtime, sources);
      const result = await new ZoneNavigationEngine(runtime, inventory)
        .prepareCompactCatalogRebuild(request as NavigationCatalogRebuildRequest, state, admission, budget);
      if (result.status === "pending") return { ref, publish: false };
      if (result.status === "prepared") return { ref, publish: true };
      // The publisher verifies and settles a deterministic rebuild conflict.
      // Retrying it as an internal failure strands the admitted request.
      return { ref, publish: true };
    }
    const alreadyOwnedAdoption = sourceState.adoption_request_id === ref.request_id
      && sourceState.adoption_generation === sourceState.generation;
    // The fresh source-state read already proves this exact adoption owner.
    // Avoid rereading the same two provider records on every inventory slice;
    // inventory and each catalog CAS still recheck generation before effects.
    if (!sourceState.adopted && !alreadyOwnedAdoption
      && !await sources.beginAdoption(this.projectId, ref.zone, ref.request_id, sourceState.generation, budget)) {
      return { ref, publish: false };
    }
    const inventory = new ZoneNavigationInventory(runtime, sources);
    const result = await new ZoneNavigationEngine(runtime, inventory).reconcile(request, state, admission, budget, { deferPublication: true });
    if (result.status === "pending") return { ref, publish: false };
    if (result.status === "prepared" || result.status === "finalized") return { ref, publish: true };
    return { ref, publish: false, failure_code: result.code };
  }

  private async reportNavigationWorkFailure(ref: NavigationWorkRef, failureCode: string): Promise<void> {
    const report = navigationWorkFailureSchema.parse({ ...ref, failure_code: failureCode });
    const response = await this.env.PROJECT_GUARD.getByName(this.projectId).fetch(
      "https://project-guard.internal/navigation-publish",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) }
    );
    const body = await response.json<Record<string, unknown>>();
    if (!response.ok || body.project_id !== ref.project_id || body.request_id !== ref.request_id
      || (body.status !== "retry" && body.status !== "stopped")) throw new Error("navigation_work_failure_unacknowledged");
    if (body.status === "stopped") {
      await this.serialize(async () => {
        await this.ctx.storage.delete(this.navigationWorkKey(ref.request_id));
        await this.ctx.storage.delete(`navigation-context:${ref.request_id}`);
        await this.ctx.storage.put(`${NAVIGATION_RETRY_PREFIX}${ref.request_id}`, canonicalJson({ stopped: true, next_attempt_at: null }));
      });
      await this.withWakeScheduleLock(async () => {
        const wakeAt = await this.navigationWorkWakeAt(Date.now());
        if (Number.isFinite(wakeAt)) await this.ctx.storage.setAlarm(wakeAt);
      });
    } else {
      const retryAt = typeof body.next_attempt_at === "string" ? Date.parse(body.next_attempt_at) : Date.now() + MATERIALIZATION_ALARM_DELAY_MS;
      await this.withWakeScheduleLock(async () => {
        await this.ctx.storage.put(`${NAVIGATION_RETRY_PREFIX}${ref.request_id}`, canonicalJson({ stopped: false, next_attempt_at: new Date(retryAt).toISOString() }));
        const wakeAt = await this.navigationWorkWakeAt(Date.now());
        if (Number.isFinite(wakeAt)) await this.ctx.storage.setAlarm(wakeAt);
      });
    }
  }

  /** Select at most one bounded page in durable round-robin order. Backoff
   * entries are skipped, but remain in the queue and keep their exact retry. */
  private async selectNavigationWorkCandidate(now: number): Promise<NavigationWorkCandidate | null> {
    const cursor = await this.ctx.storage.get<string>(NAVIGATION_WORK_CURSOR_KEY);
    const after = await this.ctx.storage.list<string>({
      prefix: NAVIGATION_WORK_PREFIX,
      limit: NAVIGATION_WORK_SCAN_LIMIT + 1,
      ...(cursor ? { startAfter: cursor } : {})
    });
    const candidates = [...after.entries()] as [string, string][];
    const pageHasMore = candidates.length > NAVIGATION_WORK_SCAN_LIMIT;
    candidates.length = Math.min(candidates.length, NAVIGATION_WORK_SCAN_LIMIT);
    if (cursor && !pageHasMore && candidates.length < NAVIGATION_WORK_SCAN_LIMIT) {
      const before = await this.ctx.storage.list<string>({ prefix: NAVIGATION_WORK_PREFIX, limit: NAVIGATION_WORK_SCAN_LIMIT + 1 });
      for (const item of before.entries() as Iterable<[string, string]>) {
        if (item[0] > cursor || candidates.length >= NAVIGATION_WORK_SCAN_LIMIT) continue;
        candidates.push(item);
      }
    }
    for (const [key, value] of candidates) {
      const requestId = key.slice(NAVIGATION_WORK_PREFIX.length);
      const failureRaw = await this.ctx.storage.get<string>(`${NAVIGATION_RETRY_PREFIX}${requestId}`);
      if (failureRaw !== undefined) {
        const failure = JSON.parse(failureRaw) as { stopped?: unknown; next_attempt_at?: unknown };
        if (failure.stopped === true) {
          await this.ctx.storage.delete(key);
          await this.ctx.storage.delete(`navigation-context:${requestId}`);
          continue;
        }
        const retryAt = typeof failure.next_attempt_at === "string" ? Date.parse(failure.next_attempt_at) : Number.NaN;
        if (Number.isFinite(retryAt) && retryAt > now) continue;
        await this.ctx.storage.delete(`${NAVIGATION_RETRY_PREFIX}${requestId}`);
      }
      await this.ctx.storage.put(NAVIGATION_WORK_CURSOR_KEY, key);
      return { key, value, requestId };
    }
    const last = candidates[candidates.length - 1]?.[0];
    if (last) await this.ctx.storage.put(NAVIGATION_WORK_CURSOR_KEY, last);
    return null;
  }

  private async navigationWorkWakeAt(now: number): Promise<number> {
    const items = await this.ctx.storage.list<string>({ prefix: NAVIGATION_WORK_PREFIX, limit: NAVIGATION_WORK_SCAN_LIMIT + 1 });
    const entries = [...items.entries()] as [string, string][];
    if (entries.length > NAVIGATION_WORK_SCAN_LIMIT) return now + MATERIALIZATION_ALARM_DELAY_MS;
    let earliestRetry = Number.POSITIVE_INFINITY;
    for (const [key] of entries) {
      const requestId = key.slice(NAVIGATION_WORK_PREFIX.length);
      const raw = await this.ctx.storage.get<string>(`${NAVIGATION_RETRY_PREFIX}${requestId}`);
      if (raw === undefined) return now + MATERIALIZATION_ALARM_DELAY_MS;
      const failure = JSON.parse(raw) as { stopped?: unknown; next_attempt_at?: unknown };
      if (failure.stopped === true) continue;
      const retryAt = typeof failure.next_attempt_at === "string" ? Date.parse(failure.next_attempt_at) : Number.NaN;
      if (!Number.isFinite(retryAt)) return now + MATERIALIZATION_ALARM_DELAY_MS;
      earliestRetry = Math.min(earliestRetry, Math.max(now + MATERIALIZATION_ALARM_DELAY_MS, retryAt));
    }
    return earliestRetry;
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
    const saved = await this.convergenceJournal(
      createProductionPersistence(this.env, this.projectId),
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
    const saved = await this.convergenceJournal(
      createProductionPersistence(this.env, this.projectId),
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
    const saved = await this.convergenceJournal(runtime).load();
    return saved !== null && saved.progress.canonical_observed_revision >= record.new_revision;
  }

  /**
   * Internal, read-only admission probe. ProjectGuard uses it before a new
   * canonical commit only for an explicitly enabled repair writer. A missing
   * durable alarm while work is pending is an unavailable continuation.
   */
  private async handleCapacity(): Promise<Response> {
    const snapshot = this.ledger.capacitySnapshot();
    const required = snapshot.progress === null || !snapshot.provider_token || this.capacityHasPendingWork(snapshot);
    const continuationAvailable = await this.ensureCapacityWake(required);
    const current = this.ledger.capacitySnapshot();
    const observation = this.capacityObservation(current, continuationAvailable);
    if (!observation) return this.capacityUnavailableResponse("capacity_proof_unavailable");
    return Response.json(observation);
  }

  private async handleCapacityReservation(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const input = parseCapacityReservationRequest(body, this.projectId);
    if (!input) return Response.json({ error: "invalid_capacity_reservation" }, { status: 400 });
    const before = this.ledger.capacitySnapshot();
    const continuationAvailable = await this.ensureCapacityWake(
      before.progress === null || !before.provider_token || this.capacityHasPendingWork(before)
    );

    let result: { observation: CapacityObservation | null; code?: string; replay?: boolean };
    try {
      result = this.ledger.withCapacityReservation<{ observation: CapacityObservation | null; code?: string; replay?: boolean }>((snapshot) => {
        const existing = snapshot.reservations.find((item) => item.request_id === input.request_id);
        if (existing) {
          if (existing.request_hash !== input.request_hash || existing.operation !== input.operation
            || existing.dependency_classification !== input.dependency_classification
            || JSON.stringify(existing.resources) !== JSON.stringify(input.resources)
            || existing.reservation_kind !== input.reservation_kind
            || existing.output_cost !== input.output_cost) {
            return { value: { observation: null, code: "idempotency_payload_mismatch" } };
          }
          return { value: { observation: this.capacityObservation(snapshot, continuationAvailable, undefined, input), replay: true } };
        }
        const observation = this.capacityObservation(snapshot, continuationAvailable, input.canonical_revision, input);
        if (!observation) return { value: { observation: null, code: "capacity_proof_unavailable" } };
        if (this.hasPendingDependency(snapshot, input)) {
          return { value: { observation: { ...observation, reason: "dependency_pending" }, code: "dependency_pending" } };
        }
        if (!observation.within_qualified_envelope || !observation.continuation_available) {
          return { value: { observation, code: "convergence_capacity_exceeded" } };
        }
      const reservation = { ...input,
        target_revision: input.reservation_kind === "transaction" ? input.canonical_revision + 1 : null,
          created_at: new Date().toISOString()
        };
        const withReservation = { ...observation, queued_outputs: observation.queued_outputs + input.output_cost,
          within_qualified_envelope: observation.queued_outputs + input.output_cost <= 200,
          reason: observation.queued_outputs + input.output_cost > 200 ? "queued_outputs_exceeded" as const : observation.reason };
        if (!withReservation.within_qualified_envelope) {
          return { value: { observation: withReservation, code: "convergence_capacity_exceeded" } };
        }
        return { value: { observation: withReservation }, reservation };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "capacity_reservation_identity_conflict") {
        return Response.json({ error: "idempotency_payload_mismatch" }, { status: 409 });
      }
      return this.capacityUnavailableResponse("capacity_proof_unavailable");
    }
    if (result.code === "idempotency_payload_mismatch") return Response.json({ error: result.code }, { status: 409 });
    if (result.code === "capacity_proof_unavailable") return this.capacityUnavailableResponse(result.code);
    if (result.code || !result.observation) {
      return Response.json({ error: result.code ?? "capacity_proof_unavailable", ...(result.observation ?? {}) }, { status: 503 });
    }
    return Response.json({ status: result.replay ? "reserved" : "admitted", ...result.observation });
  }

  private async handleCapacityReservationTransition(
    request: Request,
    from: CapacityReservation["state"],
    to: CapacityReservation["state"] | "released"
  ): Promise<Response> {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const requestId = body?.request_id;
    const requestHash = body?.request_hash;
    if (typeof requestId !== "string" || !/^(?:TXN|DOCREQ|ART)-[A-Z0-9-]{8,}$/.test(requestId)
      || typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) {
      return Response.json({ error: "invalid_capacity_reservation_transition" }, { status: 400 });
    }
    const targetRevision = body?.target_revision;
    if (to !== "released" && (!Number.isSafeInteger(targetRevision) || (targetRevision as number) < 1)) {
      return Response.json({ error: "invalid_capacity_reservation_transition" }, { status: 400 });
    }
    const reservation = this.ledger.capacitySnapshot().reservations.find((item) => item.request_id === requestId);
    if (reservation && to !== "released" && reservation.target_revision !== targetRevision) {
      return Response.json({ error: "capacity_reservation_revision_conflict" }, { status: 409 });
    }
    if (to === "handed_off") {
      const status = this.ledger.status();
      const present = Number.isSafeInteger(targetRevision)
        && [status.head?.revision, status.active?.revision, status.requested?.revision]
          .some((revision) => revision !== null && revision !== undefined && revision >= (targetRevision as number));
      if (!present) return Response.json({ error: "materialization_handoff_unproven" }, { status: 503 });
    }
    try { this.ledger.transitionCapacityReservation(requestId, requestHash, from, to); }
    catch { return Response.json({ error: "capacity_reservation_state_conflict" }, { status: 409 }); }
    return Response.json({ status: to });
  }

  private capacityObservation(snapshot: CapacityLedgerSnapshot, continuationAvailable: boolean,
    expectedCanonicalRevision?: number, bootstrapRequest?: CapacityReservationRequest): CapacityObservation | null {
    const progress = snapshot.progress;
    if (!progress || !snapshot.provider_token) {
      if (!bootstrapRequest || bootstrapRequest.reservation_kind !== "transaction"
        || progress !== null || snapshot.provider_token !== null
        || bootstrapRequest.operation !== "project.create" || bootstrapRequest.canonical_revision !== 0
        || bootstrapRequest.resources.length !== 1
        || bootstrapRequest.resources[0]?.resource_type !== "project"
        || bootstrapRequest.resources[0]?.resource_id !== bootstrapRequest.request_id
        || bootstrapRequest.resources[0]?.zone !== "PROJECT"
        || bootstrapRequest.resources[0]?.version !== "0"
        || snapshot.status.head !== null || snapshot.status.requested !== null || snapshot.status.active !== null
        || snapshot.status.active_status !== null || snapshot.status.output_count !== 0
        || snapshot.status.attempt_output_count !== 0 || snapshot.status.last_error !== null) return null;
      const replay = snapshot.reservations.length === 1
        && snapshot.reservations[0]?.request_id === bootstrapRequest.request_id
        && snapshot.reservations[0]?.request_hash === bootstrapRequest.request_hash
        && snapshot.reservations[0]?.reservation_kind === "transaction"
        && snapshot.reservations[0]?.operation === "project.create"
        && snapshot.reservations[0]?.canonical_revision === 0
        && snapshot.reservations[0]?.target_revision === 1
        && snapshot.reservations[0]?.state === "reserved";
      if (snapshot.reservations.length > 0 && !replay) return null;
      return {
        queued_outputs: replay ? snapshot.reservations[0]!.output_cost : 0,
        oldest_pending_seconds: 0,
        continuation_available: continuationAvailable,
        within_qualified_envelope: true,
        canonical_revision: 0,
        materialized_revision: null,
        blocking_obligation: null,
        retry_after_seconds: null
      };
    }
    const status = snapshot.status;
    const obligations = Object.values(progress.obligations).filter((obligation) => obligation.state !== "verified");
    const work = classifyCapacityWork(obligations, Date.now());
    const knownRevision = Math.max(progress.canonical_observed_revision, status.head?.revision ?? 0,
      status.active?.revision ?? 0, status.requested?.revision ?? 0,
      ...snapshot.reservations.filter((reservation) => reservation.state !== "reserved" && reservation.target_revision !== null)
        .map((reservation) => reservation.target_revision as number));
    if (expectedCanonicalRevision !== undefined && expectedCanonicalRevision !== knownRevision) return null;
    if (progress.canonical_observed_revision < (status.head?.revision ?? 0)) return null;
    const representedRevision = Math.max(progress.canonical_observed_revision, status.head?.revision ?? 0,
      status.active?.revision ?? 0, status.requested?.revision ?? 0);
    const unrepresented = snapshot.reservations.filter((reservation) => reservation.reservation_kind === "transaction"
      && reservation.target_revision !== null
      && reservation.target_revision > representedRevision);
    const inFlightEffects = snapshot.reservations.filter((reservation) => reservation.reservation_kind !== "transaction");
    const queuedOutputs = Math.max(work.executable.length,
      status.active === null ? 0 : status.attempt_output_count,
      status.requested === null ? 0 : Math.max(1, status.output_count)) + unrepresented.length
        + inFlightEffects.reduce((total, reservation) => total + reservation.output_cost, 0);
    const oldestPendingSeconds = Math.max(work.oldest_pending_seconds, ...[...unrepresented, ...inFlightEffects].map((reservation) =>
      Math.max(0, (Date.now() - Date.parse(reservation.created_at)) / 1_000)));
    const continuationRequired = status.active !== null || status.requested !== null
      || work.executable.length > 0 || unrepresented.length > 0 || inFlightEffects.length > 0;
    const blocking = work.terminal[0] ?? work.executable[0] ?? obligations[0] ?? null;
    return {
      queued_outputs: queuedOutputs, oldest_pending_seconds: oldestPendingSeconds,
      continuation_available: !continuationRequired || continuationAvailable,
      within_qualified_envelope: queuedOutputs <= 200 && oldestPendingSeconds <= 600,
      reason: continuationRequired && !continuationAvailable ? "continuation_unavailable"
        : queuedOutputs > 200 ? "queued_outputs_exceeded"
          : oldestPendingSeconds > 600 ? "oldest_pending_exceeded"
            : work.terminal.length > 0 ? "repair_required" : undefined,
      canonical_revision: knownRevision, materialized_revision: status.head?.revision ?? null,
      blocking_obligation: blocking ? { layer: blocking.layer, target_revision: blocking.target.revision, code: blocking.code } : null,
      retry_after_seconds: blocking?.next_attempt_at && !work.terminal.includes(blocking)
        && Number.isFinite(Date.parse(blocking.next_attempt_at))
        ? Math.max(0, Math.ceil((Date.parse(blocking.next_attempt_at) - Date.now()) / 1_000)) : null
    };
  }

  private async ensureCapacityWake(required: boolean): Promise<boolean> {
    let alarm = await this.ctx.storage.getAlarm();
    if (required && alarm === null) {
      try { await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS); }
      catch { return false; }
      alarm = await this.ctx.storage.getAlarm();
    }
    return !required || alarm !== null;
  }

  private capacityHasPendingWork(snapshot: CapacityLedgerSnapshot): boolean {
    return snapshot.status.active !== null || snapshot.status.requested !== null
      || Object.values(snapshot.progress?.obligations ?? {}).some((obligation) => obligation.state !== "verified")
      || snapshot.reservations.length > 0;
  }

  private hasPendingDependency(snapshot: CapacityLedgerSnapshot, input: CapacityReservationRequest): boolean {
    const live = snapshot.reservations.filter((reservation) => reservation.state !== "reserved"
      || reservation.reservation_kind !== "transaction");
    if (live.length === 0) return false;
    if (input.dependency_classification !== "resource_bound") return true;
    // Canonical task/decision/deliverable references describe business state,
    // not a dependency on the projected physical document. Physical publish
    // requests retain their exact provider/version checks at the document
    // service boundary; only an explicit physical resource can be gated here.
    const physical = input.resources.filter((resource) => resource.resource_type === "document" || resource.resource_type === "package");
    if (physical.length === 0) return false;
    const prior = new Set(live.flatMap((reservation) => reservation.resources.map((resource) => `${resource.resource_type}:${resource.resource_id}`)));
    return physical.some((resource) => prior.has(`${resource.resource_type}:${resource.resource_id}`));
  }

  private capacityUnavailableResponse(code: string): Response {
    return Response.json({ status: "unavailable", freshness: "unknown", error: code }, { status: 503, headers: { "Retry-After": "1" } });
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
      const journal = this.convergenceJournal(
        createProductionPersistence(this.env, this.projectId),
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

    // The direct legacy writer is disabled outside the explicit repair
    // rollout. Refuse it before reconstructing canonical state: the refusal
    // depends only on this bound DO identity and rollout configuration, and
    // must remain deterministic even for an unproven legacy snapshot.
    const convergenceMode = convergenceModeForProject(
      this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES,
      this.projectId
    );
    if (this.layoutMode === "v2" && convergenceMode !== "repair") {
      return Response.json({
        error: "convergence_writer_inactive",
        project_id: this.projectId,
        mode: convergenceMode
      }, { status: 409 });
    }

    const { coordinator, repository, canonicalRepository, budget } = this.coordinatorForSlice();
    const state = await this.canonicalState(canonicalRepository, budget);
    if (!state.complete) return this.canonicalStatePendingResponse();
    const canonicalState = state.state;
    if (!canonicalState) return Response.json({ error: "project_not_initialized" }, { status: 404 });

    const record = canonicalState.revision > 0
      ? await repository.readCommitRecord(canonicalState.project_id, canonicalState.revision)
      : null;
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
        const journal = this.convergenceJournal(
          createProductionPersistence(this.env, this.projectId),
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
    const journal = this.convergenceJournal(runtime);
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
    const journal = this.convergenceJournal(readRuntime);
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
    await this.convergenceJournal(checkpointRuntime).save(saved.progress, saved.token);
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
    const saved = await this.convergenceJournal(
      createProductionPersistence(this.env, this.projectId),
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
    return this.withWakeScheduleLock(async () => {
      const navigationWake = await this.navigationWorkWakeAt(Date.now());
      const navigationPending = Number.isFinite(navigationWake);
      if (!moreWork) {
        if (navigationPending && Number.isFinite(navigationWake)) await this.ctx.storage.setAlarm(navigationWake);
        else await this.ctx.storage.deleteAlarm();
        return;
      }
      const now = Date.now();
      const requested = nextAlarmAt === null ? Number.NaN : Date.parse(nextAlarmAt);
      const convergenceWakeAt = Number.isFinite(requested) && requested > now
        ? requested
        : now + MATERIALIZATION_ALARM_DELAY_MS;
      const existing = await this.ctx.storage.getAlarm();
      const wakeAt = Math.min(convergenceWakeAt, navigationWake);
      // `nextAlarmAt` is the journal's earliest durable deadline. An older
      // generic materialization alarm must not shorten a retry/backoff window;
      // if another durable concern were earlier it would already be reflected
      // in that same minimum wake.
      if (existing !== wakeAt) {
        await this.ctx.storage.setAlarm(wakeAt);
      }
    });
  }

  /** Serialize only the short navigation-work storage/alarm transaction. This
   * is deliberately separate from the long provider/convergence FIFO. */
  private async withWakeScheduleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.wakeScheduleQueue ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    this.wakeScheduleQueue = previous.then(() => held);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      this.queueDepth -= 1;
      release();
    }
  }

  private busyReadResponse(): Response {
    return Response.json({
      status: "unavailable",
      freshness: "unknown",
      code: "MATERIALIZATION_BUSY",
      retry_after_seconds: 1
    }, { status: 503, headers: { "Retry-After": "1" } });
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
        journal: this.convergenceJournal(checkpointPersistence),
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

  private convergenceJournal(runtime: ProjectOsPersistenceRuntime): ConvergenceJournal {
    return new ConvergenceJournal(runtime, this.projectId, (progress, token) => {
      this.ledger.restoreConvergenceCheckpoint(progress, token);
    });
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

function parseCapacityReservationRequest(value: Record<string, unknown> | null, projectId: string): CapacityReservationRequest | null {
  if (!value || value.project_id !== projectId
    || typeof value.request_id !== "string" || !/^(?:TXN|DOCREQ|ART)-[A-Z0-9-]{8,}$/.test(value.request_id)
    || typeof value.request_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.request_hash)
    || !Number.isSafeInteger(value.canonical_revision) || (value.canonical_revision as number) < 0
    || typeof value.operation !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value.operation)
    || (value.reservation_kind !== undefined && !["transaction", "document", "artifact"].includes(String(value.reservation_kind)))
    || (value.output_cost !== undefined && (!Number.isSafeInteger(value.output_cost) || (value.output_cost as number) < 1 || (value.output_cost as number) > 200))
    || (value.dependency_classification !== "resource_bound" && value.dependency_classification !== "unknown")
    || !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 32) return null;
  const resources: RuleResource[] = [];
  for (const candidate of value.resources) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.resource_id !== "string" || item.resource_id.length < 1 || item.resource_id.length > 512
      || typeof item.resource_type !== "string" || !/^[a-z][a-z0-9_]*$/.test(item.resource_type)
      || typeof item.zone !== "string" || item.zone.length < 1 || item.zone.length > 64
      || typeof item.version !== "string" || item.version.length > 512
      || (item.expected_version !== undefined && typeof item.expected_version !== "string")
      || (item.relative_path !== undefined && typeof item.relative_path !== "string")
      || (item.artifact_operation !== undefined && item.artifact_operation !== "REVIEW_CANDIDATE")) return null;
    resources.push({
      resource_id: item.resource_id,
      resource_type: item.resource_type,
      zone: item.zone,
      version: item.version,
      ...(typeof item.expected_version === "string" ? { expected_version: item.expected_version } : {}),
      ...(typeof item.relative_path === "string" ? { relative_path: item.relative_path } : {}),
      ...(item.artifact_operation === "REVIEW_CANDIDATE" ? { artifact_operation: "REVIEW_CANDIDATE" } : {})
    });
  }
  return {
    request_id: value.request_id,
    request_hash: value.request_hash,
    reservation_kind: (value.reservation_kind ?? "transaction") as CapacityReservationRequest["reservation_kind"],
    output_cost: (value.output_cost ?? 1) as number,
    canonical_revision: value.canonical_revision as number,
    operation: value.operation,
    resources,
    dependency_classification: value.dependency_classification
  };
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
