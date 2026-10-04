import type { ProjectState } from "../domain/project-state";
import type { NormalizedAdmissionOperation } from "../admission/operation-context";
import { sha256Canonical } from "../materialization/hash";
import { MutationGateClassifier } from "../mutation-gate/classifier";
import { MutationCandidateEvidenceConflictError } from "../mutation-gate/repository";
import { MutationGateService, type MutationGateMode, type MutationGateProcessSummary } from "../mutation-gate/service";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import type {
  ProviderChangeEntry,
  ProviderChangePage,
  ProviderObjectMetadata
} from "../persistence/provider/contract";
import { ProviderCursorResetError, ProviderOperationError } from "../persistence/provider/errors";
import { InternalExecutionFailure } from "../execution/coordinator";
import { ManagedDocumentBootstrapper, type BootstrapManagedStage } from "./bootstrap";
import {
  initializeManagedDocumentChangeJobSchema,
  ManagedDocumentChangeJobStore,
  type ManagedDocumentChangeJob,
  type ManagedDocumentChangeJobInput,
  type ManagedDocumentFailureClassification,
  type ManagedDocumentDetectionSource
} from "./change-job-store";
import { sha256Text } from "./hash";
import { DocumentLedgerRepository } from "./repository";
import { PackageExternalDriftObserver } from "./external-drift";
import {
  ManagedDocumentReconciler,
  type ManagedDocumentReconcileSummary
} from "./reconciler";
import {
  StableWorkProductReconciler,
  type StableWorkProductReconcileResult
} from "./stable-work-product-reconciler";
import { zoneNavigationHeadPath } from "./zone-navigation";
import { zoneNavigationHeadSchema } from "../domain/zone-navigation";

const LEGACY_CURSOR_KEY = "managed-document-change-cursor-v1";
export const SCHEDULED_DOCUMENT_JOB_LIMIT = 1;
const PACKAGE_INDEX_FANOUT_LIMIT = 8;
const PACKAGE_INDEX_SNAPSHOT_CODE = "PACKAGE_CURRENT_INDEX_SNAPSHOT";

class MissingChangeTargetError extends Error {
  constructor(path: string) {
    super(`Provider listing confirms change target is absent: ${path}`);
    this.name = "MissingChangeTargetError";
  }
}

export interface ManagedDocumentCursorStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ManagedDocumentChangeSummary extends ManagedDocumentReconcileSummary, MutationGateProcessSummary {
  bootstrapped: number;
  cursor_reset: boolean;
  baseline: boolean;
  cursor_advanced: boolean;
  archived: boolean;
  jobs_registered: number;
  jobs_completed: number;
  jobs_pending: number;
  job_failures: number;
  jobs_quarantined: number;
  drift_findings: number;
  expected_changes: number;
  scheduled: boolean;
  scheduled_due: boolean;
  late_since: string | null;
  last_scheduled_verified_at: string | null;
  budget_yield: boolean;
  semantic_progress: number;
  unread_feed: boolean;
  executable_jobs: number;
  future_eligible_jobs: number;
  stopped_unresolved_jobs: number;
  verification_completed: boolean;
  earliest_eligible_at: number | null;
  feed_retry_at: number | null;
  safe_errors: string[];
}

export interface ManagedDocumentReconcileOptions {
  scheduled?: boolean;
  now?: string;
  /** Internal local-alarm cap; public POST caps remain scheduled=1/non-scheduled=256. */
  local_alarm_job_limit?: number;
  /** A verified pre-existing navigation head debt prevents daily verification completion. */
  scheduled_verification_blocked?: boolean;
}

export type ObservedPackageDriftAdmission = (
  state: ProjectState,
  operation: NormalizedAdmissionOperation,
  findingId: string,
  runtime: ProjectOsPersistenceRuntime
) => Promise<void>;

export type ObservedNavigationSourceMutation = (
  projectId: string,
  zone: "WORKING" | "REVIEW" | "DELIVERABLES",
  resourceId: string,
  runtime: ProjectOsPersistenceRuntime
) => Promise<void>;

interface BootstrapCandidate {
  change: ProviderChangeEntry;
  stage: BootstrapManagedStage;
  priority: number;
}

interface BootstrapResult {
  adopted: number;
  document_id?: string;
}

interface BootstrapBaselineResult {
  adopted: number;
  changed_document_ids: string[];
}

interface DrainPendingResult {
  attempted: number;
  deferred: boolean;
  budget_yield: boolean;
  cohort_max_ordinal: number | null;
}

export class ManagedDocumentChangeCoordinator {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly reconciler: ManagedDocumentReconciler;
  private readonly stableWorkProducts: StableWorkProductReconciler;
  private readonly bootstrapper: ManagedDocumentBootstrapper;
  private readonly mutationClassifier: MutationGateClassifier;
  private readonly mutationGate: MutationGateService;
  private readonly packageDrift: PackageExternalDriftObserver;
  private readonly jobs: ManagedDocumentChangeJobStore | null;
  private readonly legacyCursorStore: ManagedDocumentCursorStore | null;

  constructor(
    input: PersistenceInput,
    storage: DurableObjectStorage | ManagedDocumentCursorStore,
    private readonly gateMode: MutationGateMode = "observe",
    private readonly admitObservedPackageDrift?: ObservedPackageDriftAdmission,
    private readonly recordObservedNavigationSourceMutation?: ObservedNavigationSourceMutation,
    private readonly clock: () => number = Date.now
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.reconciler = new ManagedDocumentReconciler(this.runtime);
    this.stableWorkProducts = new StableWorkProductReconciler(this.runtime);
    this.bootstrapper = new ManagedDocumentBootstrapper(this.runtime);
    this.mutationClassifier = new MutationGateClassifier(this.runtime);
    this.mutationGate = new MutationGateService(this.runtime, gateMode);
    this.packageDrift = new PackageExternalDriftObserver(this.runtime);

    if (isDurableObjectStorage(storage)) {
      initializeManagedDocumentChangeJobSchema(storage);
      this.jobs = new ManagedDocumentChangeJobStore(storage);
      this.legacyCursorStore = null;
    } else {
      // Compatibility seam for focused provider-neutral unit tests that inject
      // only the historical cursor KV interface. Production ProjectGuard always
      // supplies full DurableObjectStorage and therefore always uses SQLite jobs.
      this.jobs = null;
      this.legacyCursorStore = storage;
    }
  }

  readCheckpoint(now: string) {
    return this.jobs?.readCheckpoint(now) ?? Promise.resolve(null);
  }

  async reconcile(state: ProjectState, options: ManagedDocumentReconcileOptions = {}): Promise<ManagedDocumentChangeSummary> {
    if (!this.jobs) return this.reconcileLegacyTestSeam(state);

    const summary = emptySummary({ archived: state.status === "archived" }, this.mutationGateMode());
    if (state.status === "archived") return summary;
    if (options.scheduled) {
      const verification = this.jobs.scheduledVerification(options.now ?? new Date().toISOString());
      summary.scheduled = true;
      summary.scheduled_due = verification.due;
      summary.late_since = verification.late_since;
      summary.last_scheduled_verified_at = verification.last_verified_at;
      if (!verification.due) return summary;
    }
    const attemptAtMs = Date.parse(options.now ?? new Date().toISOString());
    if (!Number.isSafeInteger(attemptAtMs) || attemptAtMs < 0) throw new Error("Invalid managed document reconcile time");

    // Retry durable work first. A failed job remains pending, but never prevents
    // healthy siblings or later provider pages from being durably registered.
    const jobLimit = options.local_alarm_job_limit ?? (options.scheduled ? SCHEDULED_DOCUMENT_JOB_LIMIT : 256);
    if (!Number.isSafeInteger(jobLimit) || jobLimit < 1 || jobLimit > 8) {
      if (options.local_alarm_job_limit !== undefined) throw new Error("Invalid local document alarm job limit");
    }
    const priorContinuation = this.jobs.continuation();
    summary.unread_feed = priorContinuation.last_outcome?.unread_feed === true;
    summary.feed_retry_at = priorContinuation.feed_retry_at;
    const firstDrain = await this.drainPending(state, summary, jobLimit, attemptAtMs, null, true);
    if (firstDrain.budget_yield) {
      this.populateContinuationCounts(summary, attemptAtMs);
      summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
      return summary;
    }

    const root = workspaceProjectRoot(state.project_id, state.slug);
    let existingCursor = this.jobs.cursor();
    let cursorReset = false;
    let baseline = !existingCursor;
    let page: ProviderChangePage;
    let feedDeferred = priorContinuation.feed_retry_at !== null
      && priorContinuation.feed_retry_at > attemptAtMs;
    summary.feed_retry_at = feedDeferred ? priorContinuation.feed_retry_at : null;
    const priorFeedFailure = this.jobs.feedFailureCheckpoint();
    const feedProgressFingerprint = await this.jobs.feedProgressFingerprint(summary.jobs_registered + summary.jobs_completed);
    if (priorFeedFailure?.stopped && priorFeedFailure.progress_fingerprint === feedProgressFingerprint) {
      summary.unread_feed = true;
      summary.feed_retry_at = Number.MAX_SAFE_INTEGER;
      summary.safe_errors.push("identical_internal_feed_failure_limit");
      summary.cursor_reset = cursorReset;
      summary.baseline = baseline;
      this.populateContinuationCounts(summary, attemptAtMs);
      summary.stopped_unresolved_jobs = 1;
      summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
      return summary;
    }
    if (priorFeedFailure?.stopped && priorFeedFailure.progress_fingerprint !== feedProgressFingerprint) feedDeferred = false;
    if (feedDeferred) {
      page = { entries: [], cursor: existingCursor ?? "", has_more: true };
    } else {
      try {
        page = existingCursor
          ? await this.runtime.changeFeed.listChanges({ cursor: existingCursor })
          : await this.runtime.changeFeed.listChanges({ root });
      } catch (error) {
        if (isBudgetYield(error)) {
          summary.budget_yield = true;
          summary.unread_feed = true;
          summary.cursor_reset = cursorReset;
          summary.baseline = baseline;
          this.populateContinuationCounts(summary, attemptAtMs);
          summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
          return summary;
        }
        const classification = failureClassification(error);
        if (classification === "internal") {
          const failureFingerprint = await sha256Text(JSON.stringify(failureIdentity(error, classification)));
          const progressFingerprint = await this.jobs.feedProgressFingerprint(summary.jobs_registered + summary.jobs_completed);
          const failure = this.jobs.recordInternalFeedFailure(failureFingerprint, progressFingerprint);
          summary.unread_feed = true;
          summary.safe_errors.push(failure.stopped ? "identical_internal_feed_failure_limit" : "internal_feed_failure");
          summary.feed_retry_at = failure.stopped ? Number.MAX_SAFE_INTEGER : safeNextTime(this.clock(), 1_000);
          summary.cursor_reset = cursorReset;
          summary.baseline = baseline;
          this.populateContinuationCounts(summary, attemptAtMs);
          if (failure.stopped) summary.stopped_unresolved_jobs = 1;
          summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
          return summary;
        }
        this.jobs.breakInternalFeedFailureStreak();
        if (!(error instanceof ProviderCursorResetError)) {
          summary.unread_feed = true;
          summary.cursor_reset = cursorReset;
          summary.baseline = baseline;
          summary.safe_errors.push(safeErrorCode(error));
          const failureObservedAtMs = this.clock();
          const retryAfter = error instanceof ProviderOperationError && error.retryable
            ? error.diagnostics?.retryAfterMs : undefined;
          const delay = Number.isFinite(retryAfter) && (retryAfter ?? -1) >= 0
            ? Math.max(1_000, Math.ceil(retryAfter!)) : 1_000;
          summary.feed_retry_at = safeNextTime(failureObservedAtMs, delay);
          this.populateContinuationCounts(summary, attemptAtMs);
          summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
          return summary;
        }
        cursorReset = true;
        baseline = true;
        try {
          page = await this.runtime.changeFeed.listChanges({ root });
        } catch (retryError) {
          if (isBudgetYield(retryError)) {
            summary.budget_yield = true;
            summary.unread_feed = true;
          } else {
            const classification = failureClassification(retryError);
            if (classification === "internal") {
              const failureFingerprint = await sha256Text(JSON.stringify(failureIdentity(retryError, classification)));
              const progressFingerprint = await this.jobs.feedProgressFingerprint(summary.jobs_registered + summary.jobs_completed);
              const failure = this.jobs.recordInternalFeedFailure(failureFingerprint, progressFingerprint);
              summary.unread_feed = true;
              summary.safe_errors.push(failure.stopped ? "identical_internal_feed_failure_limit" : "internal_feed_failure");
              summary.feed_retry_at = failure.stopped ? Number.MAX_SAFE_INTEGER : safeNextTime(this.clock(), 1_000);
              summary.cursor_reset = cursorReset;
              summary.baseline = baseline;
              this.populateContinuationCounts(summary, attemptAtMs);
              if (failure.stopped) summary.stopped_unresolved_jobs = 1;
              summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
              return summary;
            }
            this.jobs.breakInternalFeedFailureStreak();
            summary.unread_feed = true;
            summary.cursor_reset = cursorReset;
            summary.baseline = baseline;
            summary.safe_errors.push(safeErrorCode(retryError));
            const failureObservedAtMs = this.clock();
            const retryAfter = retryError instanceof ProviderOperationError && retryError.retryable
              ? retryError.diagnostics?.retryAfterMs : undefined;
            summary.feed_retry_at = safeNextTime(failureObservedAtMs, Number.isFinite(retryAfter) && (retryAfter ?? -1) >= 0
              ? Math.max(1_000, Math.ceil(retryAfter!)) : 1_000);
          }
          this.populateContinuationCounts(summary, attemptAtMs);
          summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
          return summary;
        }
      }
    }

    if (!feedDeferred) this.jobs.breakInternalFeedFailureStreak();

    summary.unread_feed = page.has_more === true;

    const detectionSource: ManagedDocumentDetectionSource = cursorReset
      ? "cursor_reset"
      : baseline
        ? "baseline"
        : "incremental";
    const pageJobs = feedDeferred ? [] : await this.pageJobs(state, page, existingCursor, detectionSource);
    const registration = feedDeferred ? { inserted: 0, cursor_advanced: false } : this.jobs.registerPage({
      expected_cursor: existingCursor,
      next_cursor: page.cursor,
      reset_cursor: cursorReset,
      jobs: pageJobs
    });

    summary.jobs_registered += registration.inserted;
    summary.cursor_reset = cursorReset;
    summary.baseline = baseline;
    summary.cursor_advanced = registration.cursor_advanced;
    if (!feedDeferred) summary.feed_retry_at = null;

    // The cursor now represents only work that has already been journaled in
    // the ProjectGuard SQLite store. Execution may fail safely after this point.
    const remainingJobBudget = firstDrain.deferred ? 0 : Math.max(0, jobLimit - firstDrain.attempted);
    if (remainingJobBudget > 0) {
      const secondDrain = await this.drainPending(state, summary, remainingJobBudget, attemptAtMs,
        firstDrain.cohort_max_ordinal, true);
      summary.budget_yield = summary.budget_yield || secondDrain.budget_yield;
    }
    this.populateContinuationCounts(summary, attemptAtMs);
    if (options.scheduled && options.scheduled_verification_blocked !== true && !summary.budget_yield
      && !page.has_more && summary.jobs_pending === 0 && summary.job_failures === 0) {
      const completedAt = options.now ?? new Date().toISOString();
      this.jobs.completeScheduledVerification(completedAt);
      summary.late_since = null;
      summary.last_scheduled_verified_at = new Date(Date.parse(completedAt)).toISOString();
      summary.verification_completed = true;
    }
    summary.semantic_progress = summary.jobs_registered + summary.jobs_completed;
    return summary;
  }

  private populateContinuationCounts(summary: ManagedDocumentChangeSummary, nowMs: number): void {
    const counts = this.jobs?.eligibilityCounts(nowMs) ?? { executable: 0, future: 0, stopped: 0, earliest_eligible_at: null };
    summary.jobs_pending = this.jobs?.pendingCount() ?? 0;
    summary.executable_jobs = counts.executable;
    summary.future_eligible_jobs = counts.future;
    summary.stopped_unresolved_jobs = counts.stopped;
    summary.earliest_eligible_at = counts.earliest_eligible_at;
  }

  private async reconcileLegacyTestSeam(state: ProjectState): Promise<ManagedDocumentChangeSummary> {
    const summary = emptySummary({ archived: state.status === "archived" }, this.mutationGateMode());
    if (state.status === "archived") return summary;
    const cursorStore = this.legacyCursorStore;
    if (!cursorStore) throw new Error("Managed document legacy cursor test seam is unavailable");

    const root = workspaceProjectRoot(state.project_id, state.slug);
    let existingCursor = await cursorStore.get<string>(LEGACY_CURSOR_KEY);
    let cursorReset = false;
    let baseline = !existingCursor;
    let page: ProviderChangePage;

    try {
      page = existingCursor
        ? await this.runtime.changeFeed.listChanges({ cursor: existingCursor })
        : await this.runtime.changeFeed.listChanges({ root });
    } catch (error) {
      if (!(error instanceof ProviderCursorResetError)) throw error;
      cursorReset = true;
      baseline = true;
      await cursorStore.delete(LEGACY_CURSOR_KEY);
      existingCursor = undefined;
      page = await this.runtime.changeFeed.listChanges({ root });
    }

    const detectionSource = cursorReset ? "cursor_reset" : baseline ? "baseline" : "incremental";
    const unreserved: ProviderChangeEntry[] = [];
    for (const change of page.entries) {
      if (change.kind === "deleted") await this.recordArtifactDeletion(state, change.path);
      if (!await this.observeNavigationIndexDrift(state, change, summary)) unreserved.push(change);
    }
    const gate = await this.mutationGate.processChanges(state, unreserved, detectionSource);
    await this.recordArtifactDestinationMutations(state, gate.artifact_destination_paths ?? []);
    accumulateGate(summary, gate);
    const unhandled = await this.reconcileStableChanges(state, unreserved, summary);
    if (baseline) {
      const bootstrap = await this.bootstrapBaseline(state, unhandled);
      summary.bootstrapped += bootstrap.adopted;
      accumulateChangedDocumentIds(summary, bootstrap.changed_document_ids);
    }
    accumulateReconcile(summary, await this.reconciler.reconcileChanges(state, unhandled));

    summary.cursor_reset = cursorReset;
    summary.baseline = baseline;
    summary.cursor_advanced = page.cursor.length > 0 && page.cursor !== existingCursor;
    if (page.cursor.length > 0) await cursorStore.put(LEGACY_CURSOR_KEY, page.cursor);
    return summary;
  }

  private async pageJobs(
    state: ProjectState,
    page: ProviderChangePage,
    previousCursor: string | null,
    detectionSource: ManagedDocumentDetectionSource
  ): Promise<ManagedDocumentChangeJobInput[]> {
    return Promise.all(page.entries.map(async (change, index) => {
      const digest = await sha256Text(JSON.stringify({
        project_id: state.project_id,
        previous_cursor: previousCursor,
        next_cursor: page.cursor,
        index,
        change
      }));
      return {
        job_id: `CHGJOB-${digest.slice(0, 24).toUpperCase()}`,
        change,
        detection_source: detectionSource,
        priority: this.jobPriority(state, change, detectionSource)
      };
    }));
  }

  private jobPriority(
    state: ProjectState,
    change: ProviderChangeEntry,
    source: ManagedDocumentDetectionSource
  ): number {
    if (source === "incremental") return 10;
    return this.bootstrapCandidate(state, change)?.priority ?? 10;
  }

  private async drainPending(
    state: ProjectState,
    summary: ManagedDocumentChangeSummary,
    limit = 256,
    nowMs = Date.now(),
    cohortMaxOrdinal: number | null = null,
    beginCohort = false
  ): Promise<DrainPendingResult> {
    const jobs = this.jobs;
    if (!jobs) return { attempted: 0, deferred: false, budget_yield: false, cohort_max_ordinal: null };
    if (beginCohort) cohortMaxOrdinal = jobs.beginSelectionCohort(nowMs);
    let attempted = 0;
    let deferred = false;
    let budgetYield = false;
    while (attempted < limit) {
      const job = jobs.selectNextPending(cohortMaxOrdinal, nowMs);
      if (!job) break;
      attempted += 1;
      try {
        const actualKind = await this.actualChangeKind(job.change);
        if (actualKind === "folder") {
          if (job.change.kind === "file") {
            jobs.markQuarantined(job, "directory_used_as_file_target");
            summary.jobs_quarantined += 1;
          } else {
            jobs.markCompleted(job.job_id);
            summary.jobs_completed += 1;
          }
          continue;
        }
        const completed = await this.processJob(state, job, summary);
        if (!completed) {
          deferred = true;
          continue;
        }
        jobs.markCompleted(job.job_id);
        summary.jobs_completed += 1;
      } catch (error) {
        if (isBudgetYield(error)) {
          summary.budget_yield = true;
          budgetYield = true;
          deferred = true;
          break;
        }
        // The candidate id binds immutable Dropbox identity and revision. A
        // different observation for that same id cannot become valid by
        // retrying this job; preserve it as a visible quarantine instead of
        // consuming every scheduled slice forever.
        if (error instanceof MutationCandidateEvidenceConflictError) {
          jobs.markQuarantined(job, "mutation_candidate_evidence_conflict");
          summary.jobs_quarantined += 1;
          console.error("Project OS managed document change job quarantined", {
            project_id: state.project_id,
            job_id: job.job_id,
            path: job.change.path,
            code: "mutation_candidate_evidence_conflict",
            message: errorMessage(error)
          });
          continue;
        }
        if (error instanceof MissingChangeTargetError) {
          await this.recordArtifactDeletion(state, job.change.path);
          jobs.markQuarantined(job, "file_target_missing");
          summary.jobs_quarantined += 1;
          console.warn("Project OS managed document change job quarantined", {
            project_id: state.project_id,
            job_id: job.job_id,
            path: job.change.path,
            code: "file_target_missing"
          });
          continue;
        }
        const failureObservedAtMs = this.clock();
        if (!Number.isSafeInteger(failureObservedAtMs) || failureObservedAtMs < 0) {
          throw new Error("Invalid managed document failure observation time");
        }
        const classification = failureClassification(error);
        const failureFingerprint = await sha256Text(JSON.stringify(failureIdentity(error, classification)));
        const progressFingerprint = await this.jobProgressFingerprint(job);
        const hadStopFinding = jobs.driftFindingsForJob(job.job_id)
          .some(finding => finding.code === "identical_internal_failure_limit");
        const findingId = classification === "internal"
          ? `DRIFT-${(await sha256Text(`${job.job_id}:identical_internal_failure_limit`)).slice(0, 24).toUpperCase()}`
          : undefined;
        const retryAfterMs = error instanceof ProviderOperationError
          && error.retryable
          && Number.isFinite(error.diagnostics?.retryAfterMs)
          && (error.diagnostics?.retryAfterMs ?? -1) >= 0
          ? error.diagnostics?.retryAfterMs
          : undefined;
        const failure = jobs.recordFailure(job, errorMessage(error), {
          failure_fingerprint: failureFingerprint,
          progress_fingerprint: progressFingerprint,
          classification,
          now_ms: failureObservedAtMs,
          ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
          ...(findingId === undefined ? {} : { finding_id: findingId })
        }, new Date(failureObservedAtMs).toISOString());
        summary.job_failures += 1;
        if (failure.stopped && !hadStopFinding) summary.drift_findings += 1;
        console.error("Project OS managed document change job failed", {
          project_id: state.project_id,
          job_id: job.job_id,
          path: job.change.path,
          attempts: job.attempts + 1,
          message: errorMessage(error)
        });
      }
    }
    return { attempted, deferred, budget_yield: budgetYield, cohort_max_ordinal: cohortMaxOrdinal };
  }

  private async jobProgressFingerprint(job: ManagedDocumentChangeJob): Promise<string> {
    const findings = this.jobs?.driftFindingsForJob(job.job_id) ?? [];
    return sha256Text(JSON.stringify({
      job_id: job.job_id,
      change: job.change,
      detection_source: job.detection_source,
      priority: job.priority,
      findings: findings.map(finding => ({
        finding_id: finding.finding_id,
        path: finding.path,
        change_kind: finding.change_kind,
        status: finding.status,
        code: finding.code,
        request_id: finding.request_id,
        resource: finding.resource ? {
          resource_type: finding.resource.resource_type,
          resource_id: finding.resource.resource_id,
          version: finding.resource.version,
          zone: finding.resource.zone
        } : null
      }))
    }));
  }

  private async actualChangeKind(change: ProviderChangeEntry): Promise<ProviderChangeEntry["kind"]> {
    if (change.kind !== "file") return change.kind;
    if (this.runtime.objects.getEntryKind) {
      const kind = await this.runtime.objects.getEntryKind(change.path);
      if (kind === null) throw new MissingChangeTargetError(change.path);
      return kind;
    }
    const separator = change.path.lastIndexOf("/");
    if (separator <= 0) return change.kind;
    const parent = change.path.slice(0, separator);
    const entry = (await this.runtime.objects.listChildren(parent)).find((candidate) => candidate.path === change.path);
    if (!entry) throw new MissingChangeTargetError(change.path);
    return entry.kind;
  }

  private async processJob(
    state: ProjectState,
    job: ManagedDocumentChangeJob,
    summary: ManagedDocumentChangeSummary
  ): Promise<boolean> {
    if (job.change.kind === "deleted") await this.recordArtifactDeletion(state, job.change.path);
    if (await this.observeNavigationIndexDrift(state, job.change, summary, job.job_id)) return true;

    // MutationGate remains the first semantic observer for every non-navigation change.
    const gate = await this.mutationGate.processChanges(state, [job.change], job.detection_source);
    await this.recordArtifactDestinationMutations(state, gate.artifact_destination_paths ?? []);
    accumulateGate(summary, gate);

    const packageDrift = await this.observePackageDrift(state, job.change, summary, job.job_id);
    if (packageDrift === "deferred") return false;
    if (packageDrift === "handled") return true;

    const stable = await this.stableWorkProducts.reconcile(state, job.change);
    if (stable.handled) {
      accumulateStable(summary, stable);
      return true;
    }

    if (job.detection_source !== "incremental") {
      const bootstrap = await this.bootstrapOne(state, job.change);
      summary.bootstrapped += bootstrap.adopted;
      if (bootstrap.document_id) accumulateChangedDocumentIds(summary, [bootstrap.document_id]);
    }

    const reconciled = await this.reconciler.reconcileChanges(state, [job.change]);
    accumulateReconcile(summary, reconciled);
    return true;
  }

  private async reconcileStableChanges(
    state: ProjectState,
    changes: ProviderChangeEntry[],
    summary: ManagedDocumentChangeSummary
  ): Promise<ProviderChangeEntry[]> {
    const unhandled: ProviderChangeEntry[] = [];
    for (const change of changes) {
      if (await this.observeNavigationIndexDrift(state, change, summary)) continue;
      if ((await this.observePackageDrift(state, change, summary)) !== "unhandled") continue;
      const stable = await this.stableWorkProducts.reconcile(state, change);
      if (stable.handled) accumulateStable(summary, stable);
      else unhandled.push(change);
    }
    return unhandled;
  }

  private async observePackageDrift(
    state: ProjectState,
    change: ProviderChangeEntry,
    summary: ManagedDocumentChangeSummary,
    jobId?: string
  ): Promise<"unhandled" | "handled" | "deferred"> {
    const existingFindings = this.jobs && jobId ? this.jobs.driftFindingsForJob(jobId) : [];
    const priorSnapshot = existingFindings.find((finding) => finding.code === PACKAGE_INDEX_SNAPSHOT_CODE);
    const drift = await this.packageDrift.observe(state, change, priorSnapshot?.request_id ?? undefined);
    if (!drift.handled) return "unhandled";
    if (priorSnapshot && !drift.resources) return "deferred";
    if (drift.resources && drift.snapshot_request_id && this.jobs && jobId) {
      const snapshotId = await this.packageIndexSnapshotFindingId(jobId, change.path);
      if (!existingFindings.some((finding) => finding.finding_id === snapshotId)) {
        this.jobs.recordDriftFinding({
          finding_id: snapshotId,
          job_id: jobId,
          path: change.path,
          change_kind: change.kind,
          status: "unexpected_conflict",
          code: PACKAGE_INDEX_SNAPSHOT_CODE,
          request_id: drift.snapshot_request_id,
          observed_at: new Date().toISOString()
        });
        summary.drift_findings += 1;
        if (drift.status === "unexpected_conflict") summary.conflicts += 1;
      }
      const doneIds = new Set(existingFindings.map((finding) => finding.finding_id));
      let processed = 0;
      for (const resource of drift.resources) {
        const findingId = await this.packageIndexResourceFindingId(jobId, change.path, drift.snapshot_request_id, resource);
        if (doneIds.has(findingId)) continue;
        if (processed >= PACKAGE_INDEX_FANOUT_LIMIT) return "deferred";
          await this.recordObservedNavigationSourceMutation?.(state.project_id, resource.zone as "WORKING" | "REVIEW" | "DELIVERABLES", `package:${resource.resource_id}`, this.runtime);
        if (this.admitObservedPackageDrift) {
          await this.admitObservedPackageDrift(state, {
            project_id: state.project_id,
            operation: "package.drift.observe",
            resources: [resource],
            request_hash: await sha256Canonical({
              project_id: state.project_id,
              finding_id: findingId,
              change,
              resource,
              expected_request_id: drift.snapshot_request_id
            })
          }, findingId, this.runtime);
        }
        this.jobs.recordDriftFinding({
          finding_id: findingId,
          job_id: jobId,
          path: change.path,
          change_kind: change.kind,
          status: drift.status ?? "unexpected_conflict",
          code: drift.code ?? "PACKAGE_UNEXPECTED_MUTATION",
          request_id: drift.snapshot_request_id,
          resource,
          observed_at: new Date().toISOString()
        });
        doneIds.add(findingId);
        processed += 1;
        summary.drift_findings += 1;
        if (drift.status === "unexpected_conflict") summary.conflicts += 1;
        else if (drift.status === "expected_reconciled") summary.expected_changes += 1;
        else summary.ignored += 1;
      }
      return "handled";
    }
    if (drift.resource) {
      await this.recordObservedNavigationSourceMutation?.(
        state.project_id,
        drift.resource.zone as "WORKING" | "REVIEW" | "DELIVERABLES",
        `package:${drift.resource.resource_id}`,
        this.runtime
      );
    }
    summary.drift_findings += 1;
    if (drift.status === "expected_reconciled") summary.expected_changes += 1;
    else if (drift.status === "unexpected_conflict") summary.conflicts += 1;
    else summary.ignored += 1;
    if (drift.status && drift.code) {
      const findingId = `DRIFT-${(await sha256Text(JSON.stringify({
        project_id: state.project_id,
        job_id: jobId ?? "legacy",
        path: change.path,
        status: drift.status,
        code: drift.code
      }))).slice(0, 24).toUpperCase()}`;
      if (this.jobs && jobId) {
        this.jobs.recordDriftFinding({
          finding_id: findingId,
          job_id: jobId,
          path: change.path,
          change_kind: change.kind,
          status: drift.status,
          code: drift.code,
          ...(drift.request_id ? { request_id: drift.request_id } : {}),
          ...(drift.resource ? { resource: drift.resource } : {}),
          observed_at: new Date().toISOString()
        });
      }
      if (drift.resource && this.admitObservedPackageDrift) {
        await this.admitObservedPackageDrift(state, {
          project_id: state.project_id,
          operation: "package.drift.observe",
          resources: [drift.resource],
          request_hash: await sha256Canonical({
            project_id: state.project_id,
            finding_id: findingId,
            change,
            resource: drift.resource,
            expected_request_id: drift.request_id ?? null
          })
        }, findingId, this.runtime);
      }
    }
    return "handled";
  }

  private async packageIndexSnapshotFindingId(jobId: string, path: string): Promise<string> {
    return `DRIFT-${(await sha256Text(JSON.stringify({ jobId, path, code: PACKAGE_INDEX_SNAPSHOT_CODE }))).slice(0, 24).toUpperCase()}`;
  }

  private async packageIndexResourceFindingId(jobId: string, path: string, snapshotRequestId: string, resource: import("../rules/contract").RuleResource): Promise<string> {
    return `DRIFT-${(await sha256Text(JSON.stringify({ jobId, path, snapshotRequestId, resource }))).slice(0, 24).toUpperCase()}`;
  }

  private async recordArtifactDestinationMutations(state: ProjectState, paths: string[]): Promise<void> {
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    for (const path of paths) {
      if (!path.startsWith(root)) continue;
      const relative = path.slice(root.length);
      const match = /^(WORKING|REVIEW|DELIVERABLES)\/(.+)$/.exec(relative);
      if (!match) continue;
      const zone = match[1].toUpperCase() as "WORKING" | "REVIEW" | "DELIVERABLES";
      if (/^(00-CURRENT-INDEX\.md|00-CURRENT\.md)$/i.test(match[2])) continue;
      await this.recordObservedNavigationSourceMutation?.(
        state.project_id,
        zone,
        `artifact:${await sha256Text(path)}`,
        this.runtime
      );
    }
  }

  private async recordArtifactDeletion(state: ProjectState, path: string): Promise<void> {
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!path.startsWith(root)) return;
    const relative = path.slice(root.length);
    const match = /^(WORKING|REVIEW|DELIVERABLES)\/(.+)$/.exec(relative);
    if (!match || !await this.mutationGate.hasArtifactDestinationBinding(state.project_id, path)) return;
    const zone = match[1].toUpperCase() as "WORKING" | "REVIEW" | "DELIVERABLES";
    await this.recordObservedNavigationSourceMutation?.(state.project_id, zone, `artifact:${await sha256Text(path)}`, this.runtime);
  }

  private async observeNavigationIndexDrift(
    state: ProjectState,
    change: ProviderChangeEntry,
    summary: ManagedDocumentChangeSummary,
    jobId?: string
  ): Promise<boolean> {
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!change.path.startsWith(root)) return false;
    const relative = change.path.slice(root.length);
    const reserved = /^(WORKING|REVIEW|DELIVERABLES)\/(00-CURRENT-INDEX\.md|00-CURRENT\.md)$/i.exec(relative);
    if (!reserved) return false;
    const zone = reserved[1].toUpperCase() as "WORKING" | "REVIEW" | "DELIVERABLES";
    const rawHead = await this.runtime.objects.readText(zoneNavigationHeadPath(state.project_id, zone));
    // Before adoption, legacy files are bootstrap input, not external mutations
    // of a governed navigation generation. They remain reserved from bootstrap.
    if (rawHead === null) return true;
    const parsedHead = zoneNavigationHeadSchema.safeParse(JSON.parse(rawHead));
    if (!parsedHead.success || parsedHead.data.project_id !== state.project_id || parsedHead.data.zone !== zone) {
      await this.recordNavigationIndexDrift(state, change, summary, jobId);
      return true;
    }
    const expected = parsedHead.data.index;
    let matchesPublishedIdentity = change.kind === "file"
      && change.metadata?.objectId === expected.object_id
      && change.metadata?.revisionToken === expected.revision_token;
    if (!matchesPublishedIdentity && change.kind === "file") {
      // Change feeds may replay an older notification after our own write. Check
      // current canonical identity before declaring drift; never infer from path.
      const current = await this.runtime.objects.getMetadata(change.path);
      matchesPublishedIdentity = current?.objectId === expected.object_id && current.revisionToken === expected.revision_token;
    }
    if (matchesPublishedIdentity) return true;
    await this.recordNavigationIndexDrift(state, change, summary, jobId);
    return true;
  }

  private async recordNavigationIndexDrift(
    state: ProjectState,
    change: ProviderChangeEntry,
    summary: ManagedDocumentChangeSummary,
    jobId?: string
  ): Promise<void> {
    summary.drift_findings += 1;
    summary.conflicts += 1;
    if (this.jobs) {
      const resolvedJobId = jobId ?? `CHGJOB-${(await sha256Text(JSON.stringify({ project_id: state.project_id, path: change.path, kind: change.kind }))).slice(0, 24).toUpperCase()}`;
      const findingId = `DRIFT-${(await sha256Text(JSON.stringify({ project_id: state.project_id, job_id: resolvedJobId, path: change.path, code: "navigation_index_external_change" }))).slice(0, 24).toUpperCase()}`;
      this.jobs.recordDriftFinding({
        finding_id: findingId,
        job_id: resolvedJobId,
        path: change.path,
        change_kind: change.kind,
        status: "unexpected_conflict",
        code: "navigation_index_external_change",
        observed_at: new Date().toISOString()
      });
    }
  }

  private async bootstrapBaseline(
    state: ProjectState,
    changes: ProviderChangeEntry[]
  ): Promise<BootstrapBaselineResult> {
    const candidates = changes
      .map((change) => this.bootstrapCandidate(state, change))
      .filter((candidate): candidate is BootstrapCandidate => candidate !== null)
      .sort((a, b) => a.priority - b.priority || a.change.path.localeCompare(b.change.path));
    let adopted = 0;
    const changedDocumentIds = new Set<string>();
    for (const candidate of candidates) {
      const result = await this.bootstrapOne(state, candidate.change);
      adopted += result.adopted;
      if (result.document_id) changedDocumentIds.add(result.document_id);
    }
    return { adopted, changed_document_ids: [...changedDocumentIds].sort() };
  }

  private async bootstrapOne(state: ProjectState, change: ProviderChangeEntry): Promise<BootstrapResult> {
    if (await new DocumentLedgerRepository(this.runtime).ownsPackageProjection(state, change.path)) return { adopted: 0 };
    const candidate = this.bootstrapCandidate(state, change);
    if (!candidate) return { adopted: 0 };
    const metadata = await this.metadataFor(candidate.change);
    if (!metadata) return { adopted: 0 };

    if (candidate.stage === "published") {
      const classification = await this.mutationClassifier.classify(state, candidate.change.path, metadata);
      if (classification.kind !== "not_final_zone") return { adopted: 0 };
    }

    const result = await this.bootstrapper.bootstrapExistingManagedPath(
      state,
      candidate.change.path,
      metadata,
      candidate.stage
    );
    return result.adopted
      ? { adopted: 1, document_id: result.head.document_id }
      : { adopted: 0 };
  }

  private bootstrapCandidate(state: ProjectState, change: ProviderChangeEntry): BootstrapCandidate | null {
    if (change.kind !== "file") return null;
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!change.path.startsWith(root)) return null;
    const relative = change.path.slice(root.length);
    if (/^(WORKING|REVIEW|DELIVERABLES)\/(00-CURRENT-INDEX\.md|00-CURRENT\.md)$/i.test(relative)) return null;
    if (relative.toUpperCase().startsWith("REVIEW/CANDIDATES/")) return null;

    if (relative.startsWith("DELIVERABLES/") && relative.length > "DELIVERABLES/".length) {
      const managedRelative = relative.slice("DELIVERABLES/".length);
      if (isProjectedDeliverableMetadata(state, managedRelative)) return null;
      return { change, stage: "published", priority: 0 };
    }
    if (relative.startsWith("WORKING/") && relative.length > "WORKING/".length) {
      return { change, stage: "working", priority: 1 };
    }
    if (relative.startsWith("REVIEW/") && relative.length > "REVIEW/".length) {
      return { change, stage: "review", priority: 2 };
    }
    if (relative.startsWith("REFERENCES/") && relative.length > "REFERENCES/".length) {
      return { change, stage: "reference", priority: 3 };
    }
    return null;
  }

  private async metadataFor(change: ProviderChangeEntry): Promise<ProviderObjectMetadata | null> {
    if (change.metadata) return change.metadata;
    return this.runtime.objects.getMetadata(change.path);
  }

  private mutationGateMode(): MutationGateMode {
    return this.gateMode;
  }
}

function accumulateGate(target: ManagedDocumentChangeSummary, source: MutationGateProcessSummary): void {
  target.candidates += source.candidates;
  target.policy_violations += source.policy_violations;
  if (source.artifact_destination_paths?.length) {
    target.artifact_destination_paths = [...new Set([...(target.artifact_destination_paths ?? []), ...source.artifact_destination_paths])];
  }
  if (source.last_candidate_detection_source) {
    target.last_candidate_detection_source = source.last_candidate_detection_source;
  }
}

function accumulateStable(target: ManagedDocumentChangeSummary, source: StableWorkProductReconcileResult): void {
  target.scanned += 1;
  target.captured += source.captured;
  target.restored += source.restored;
  target.conflicts += source.conflicts;
  if (source.captured === 0 && source.restored === 0 && source.conflicts === 0) target.ignored += 1;
  if (source.document_id) accumulateChangedDocumentIds(target, [source.document_id]);
}

function accumulateReconcile(target: ManagedDocumentChangeSummary, source: ManagedDocumentReconcileSummary): void {
  target.scanned += source.scanned;
  target.ignored += source.ignored;
  target.captured += source.captured;
  target.ingested += source.ingested;
  target.duplicates += source.duplicates;
  target.restored += source.restored;
  target.conflicts += source.conflicts;
  target.intake_completed += source.intake_completed;
  target.duplicate_cleaned += source.duplicate_cleaned;
  target.withdrawn += source.withdrawn;
  target.intake_resumed += source.intake_resumed;
  accumulateChangedDocumentIds(target, source.changed_document_ids);
}

function accumulateChangedDocumentIds(target: ManagedDocumentChangeSummary, source: readonly string[]): void {
  target.changed_document_ids = [...new Set([
    ...target.changed_document_ids,
    ...source
  ])].sort();
}

function isProjectedDeliverableMetadata(state: ProjectState, relativePath: string): boolean {
  if (relativePath.includes("/") || !relativePath.endsWith(".md")) return false;
  return Object.prototype.hasOwnProperty.call(state.deliverables, relativePath.slice(0, -3));
}

function emptySummary(flags: { archived: boolean }, mode: MutationGateMode): ManagedDocumentChangeSummary {
  return {
    scanned: 0,
    ignored: 0,
    captured: 0,
    ingested: 0,
    duplicates: 0,
    restored: 0,
    conflicts: 0,
    intake_completed: 0,
    duplicate_cleaned: 0,
    withdrawn: 0,
    intake_resumed: 0,
    changed_document_ids: [],
    candidates: 0,
    mutation_gate_mode: mode,
    policy_violations: 0,
    bootstrapped: 0,
    cursor_reset: false,
    baseline: false,
    cursor_advanced: false,
    archived: flags.archived,
    jobs_registered: 0,
    jobs_completed: 0,
    jobs_pending: 0,
    job_failures: 0,
    jobs_quarantined: 0,
    drift_findings: 0,
    expected_changes: 0,
    scheduled: false,
    scheduled_due: false,
    late_since: null,
    last_scheduled_verified_at: null,
    budget_yield: false,
    semantic_progress: 0,
    unread_feed: false,
    executable_jobs: 0,
    future_eligible_jobs: 0,
    stopped_unresolved_jobs: 0,
    verification_completed: false,
    earliest_eligible_at: null,
    feed_retry_at: null,
    safe_errors: []
  };
}

function isDurableObjectStorage(
  value: DurableObjectStorage | ManagedDocumentCursorStore
): value is DurableObjectStorage {
  const candidate = value as Partial<DurableObjectStorage>;
  return typeof candidate.transactionSync === "function" && candidate.sql !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBudgetYield(error: unknown): boolean {
  return error instanceof Error && /(?:^|:)\s*slice_budget_exhausted\s*$/.test(error.message);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ProviderOperationError) return error.retryable ? "provider_retryable" : "provider_blocked";
  if (error instanceof Error && error.name === "ProviderCursorResetError") return "provider_cursor_reset";
  return "feed_error";
}

function safeNextTime(now: number, delay: number): number {
  const next = now + delay;
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}

function failureClassification(error: unknown): ManagedDocumentFailureClassification {
  if (error instanceof InternalExecutionFailure) return "internal";
  if (error instanceof ProviderOperationError) return error.retryable ? "provider_retryable" : "provider_blocked";
  return "unknown";
}

function failureIdentity(error: unknown, classification: ManagedDocumentFailureClassification): unknown {
  if (error instanceof InternalExecutionFailure) {
    return { classification, name: "InternalExecutionFailure", code: error.code, stage: error.stage };
  }
  if (error instanceof ProviderOperationError) {
    return {
      classification,
      name: error.name,
      code: error.diagnostics?.code ?? null,
      status: error.diagnostics?.status ?? null
    };
  }
  return {
    classification,
    name: error instanceof Error && error.name ? error.name : typeof error,
    message: errorMessage(error)
  };
}
