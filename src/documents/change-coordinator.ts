import type { ProjectState } from "../domain/project-state";
import { MutationGateClassifier } from "../mutation-gate/classifier";
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
import { ProviderCursorResetError } from "../persistence/provider/errors";
import { ManagedDocumentBootstrapper, type BootstrapManagedStage } from "./bootstrap";
import {
  initializeManagedDocumentChangeJobSchema,
  ManagedDocumentChangeJobStore,
  type ManagedDocumentChangeJob,
  type ManagedDocumentChangeJobInput,
  type ManagedDocumentDetectionSource
} from "./change-job-store";
import { sha256Text } from "./hash";
import {
  ManagedDocumentReconciler,
  type ManagedDocumentReconcileSummary
} from "./reconciler";

const LEGACY_CURSOR_KEY = "managed-document-change-cursor-v1";

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
}

interface BootstrapCandidate {
  change: ProviderChangeEntry;
  stage: BootstrapManagedStage;
  priority: number;
}

export class ManagedDocumentChangeCoordinator {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly reconciler: ManagedDocumentReconciler;
  private readonly bootstrapper: ManagedDocumentBootstrapper;
  private readonly mutationClassifier: MutationGateClassifier;
  private readonly mutationGate: MutationGateService;
  private readonly jobs: ManagedDocumentChangeJobStore | null;
  private readonly legacyCursorStore: ManagedDocumentCursorStore | null;

  constructor(
    input: PersistenceInput,
    storage: DurableObjectStorage | ManagedDocumentCursorStore,
    private readonly gateMode: MutationGateMode = "observe"
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.reconciler = new ManagedDocumentReconciler(this.runtime);
    this.bootstrapper = new ManagedDocumentBootstrapper(this.runtime);
    this.mutationClassifier = new MutationGateClassifier(this.runtime);
    this.mutationGate = new MutationGateService(this.runtime, gateMode);

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

  async reconcile(state: ProjectState): Promise<ManagedDocumentChangeSummary> {
    if (!this.jobs) return this.reconcileLegacyTestSeam(state);

    const summary = emptySummary({ archived: state.status === "archived" }, this.mutationGateMode());
    if (state.status === "archived") return summary;

    // Retry durable work first. A failed job remains pending, but never prevents
    // healthy siblings or later provider pages from being durably registered.
    await this.drainPending(state, summary);

    const root = workspaceProjectRoot(state.project_id, state.slug);
    let existingCursor = this.jobs.cursor();
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
      page = await this.runtime.changeFeed.listChanges({ root });
    }

    const detectionSource: ManagedDocumentDetectionSource = cursorReset
      ? "cursor_reset"
      : baseline
        ? "baseline"
        : "incremental";
    const pageJobs = await this.pageJobs(state, page, existingCursor, detectionSource);
    const registration = this.jobs.registerPage({
      expected_cursor: existingCursor,
      next_cursor: page.cursor,
      reset_cursor: cursorReset,
      jobs: pageJobs
    });

    summary.jobs_registered += registration.inserted;
    summary.cursor_reset = cursorReset;
    summary.baseline = baseline;
    summary.cursor_advanced = registration.cursor_advanced;

    // The cursor now represents only work that has already been journaled in
    // the ProjectGuard SQLite store. Execution may fail safely after this point.
    await this.drainPending(state, summary);
    summary.jobs_pending = this.jobs.pendingCount();
    return summary;
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
    const gate = await this.mutationGate.processChanges(state, page.entries, detectionSource);
    accumulateGate(summary, gate);
    if (baseline) summary.bootstrapped += await this.bootstrapBaseline(state, page.entries);
    accumulateReconcile(summary, await this.reconciler.reconcileChanges(state, page.entries));

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

  private async drainPending(state: ProjectState, summary: ManagedDocumentChangeSummary): Promise<void> {
    const jobs = this.jobs;
    if (!jobs) return;
    const pending = jobs.pending();
    for (const job of pending) {
      try {
        await this.processJob(state, job, summary);
        jobs.markCompleted(job.job_id);
        summary.jobs_completed += 1;
      } catch (error) {
        jobs.markFailed(job.job_id, errorMessage(error));
        summary.job_failures += 1;
        console.error("Project OS managed document change job failed", {
          project_id: state.project_id,
          job_id: job.job_id,
          path: job.change.path,
          attempts: job.attempts + 1,
          message: errorMessage(error)
        });
      }
    }
  }

  private async processJob(
    state: ProjectState,
    job: ManagedDocumentChangeJob,
    summary: ManagedDocumentChangeSummary
  ): Promise<void> {
    // MutationGate remains the first semantic observer for every stored change.
    const gate = await this.mutationGate.processChanges(state, [job.change], job.detection_source);
    accumulateGate(summary, gate);

    if (job.detection_source !== "incremental") {
      summary.bootstrapped += await this.bootstrapOne(state, job.change);
    }

    const reconciled = await this.reconciler.reconcileChanges(state, [job.change]);
    accumulateReconcile(summary, reconciled);
  }

  private async bootstrapBaseline(state: ProjectState, changes: ProviderChangeEntry[]): Promise<number> {
    const candidates = changes
      .map((change) => this.bootstrapCandidate(state, change))
      .filter((candidate): candidate is BootstrapCandidate => candidate !== null)
      .sort((a, b) => a.priority - b.priority || a.change.path.localeCompare(b.change.path));
    let adopted = 0;
    for (const candidate of candidates) adopted += await this.bootstrapOne(state, candidate.change);
    return adopted;
  }

  private async bootstrapOne(state: ProjectState, change: ProviderChangeEntry): Promise<number> {
    const candidate = this.bootstrapCandidate(state, change);
    if (!candidate) return 0;
    const metadata = await this.metadataFor(candidate.change);
    if (!metadata) return 0;

    if (candidate.stage === "published") {
      const classification = await this.mutationClassifier.classify(state, candidate.change.path, metadata);
      if (classification.kind !== "not_final_zone") return 0;
    }

    const result = await this.bootstrapper.bootstrapExistingManagedPath(
      state,
      candidate.change.path,
      metadata,
      candidate.stage
    );
    return result.adopted ? 1 : 0;
  }

  private bootstrapCandidate(state: ProjectState, change: ProviderChangeEntry): BootstrapCandidate | null {
    if (change.kind !== "file") return null;
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!change.path.startsWith(root)) return null;
    const relative = change.path.slice(root.length);

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
  if (source.last_candidate_detection_source) {
    target.last_candidate_detection_source = source.last_candidate_detection_source;
  }
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
  target.changed_document_ids = [...new Set([
    ...target.changed_document_ids,
    ...source.changed_document_ids
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
    job_failures: 0
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
