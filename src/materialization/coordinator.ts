import type { CanonicalCommitRecord } from "../domain/commit-record";
import {
  CURRENT_PROJECTION_VERSION,
  MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH,
  type CompletedMaterializationRecord,
  type MaterializationGenerationRef,
  type MaterializationHead,
  type ProjectionOutputEvidence
} from "../domain/materialization";
import type { ProjectState } from "../domain/project-state";
import { archiveProjectRoot, machineMaterializationRecordPath, workspaceProjectRoot } from "../persistence/layout";
import { projectionIndexRootHash } from "./hash";
import {
  planProjection,
  type ProjectionBaseline as PlannerBaseline,
  type ProjectionPlan
} from "./planner";
import type { FinalVerificationItem, MaterializationLedgerStatus, MaterializationTarget } from "./ledger";
import { MaterializationOutputConflictError, type ProjectionWriteOutcome } from "./writer";
import type { SliceBudget } from "../convergence/contract";

export interface MaterializationRepositoryPort {
  readCommitRecord(projectId: string, revision: number): Promise<CanonicalCommitRecord | null>;
  readMaterializationHead(projectId: string): Promise<MaterializationHead | null>;
  readMaterializationRecord(
    projectId: string,
    revision: number,
    projectionVersion: number
  ): Promise<CompletedMaterializationRecord | null>;
  listMaterializationRecordRefs(projectId: string): Promise<MaterializationGenerationRef[]>;
  writeCompletedMaterializationRecord(record: CompletedMaterializationRecord): Promise<void>;
  writeMaterializationHead(head: MaterializationHead): Promise<void>;
  materializeCanonicalDerivatives(
    record: CanonicalCommitRecord,
    options?: { publishReceipt?: boolean; projectionVersion?: number }
  ): Promise<void>;
  writeCanonicalEvent?(record: CanonicalCommitRecord): Promise<void>;
  writeReceipt?(receipt: CanonicalCommitRecord["receipt"]): Promise<void>;
  /** Idempotently establishes the visible managed zones before active V2 output. */
  ensureManagedWorkspaceDirectories?(state: ProjectState): Promise<void>;
  /** Determines whether an interrupted archive move left one visible workspace root. */
  archiveWorkspaceLocation?(state: ProjectState): Promise<"active" | "archive" | "missing" | "conflict">;
  archiveHumanWorkspace?(state: ProjectState): Promise<void>;
}

export interface MaterializationLedgerPort {
  requestTarget(target: { revision: number; projection_version: number }): void;
  beginNextTarget(): MaterializationTarget | null;
  recordVerifiedOutput(key: string, evidence: ProjectionOutputEvidence): void;
  attemptOutputs(): Map<string, ProjectionOutputEvidence>;
  finalVerificationActive(): boolean;
  beginFinalVerification(items: readonly FinalVerificationItem[]): void;
  finalVerificationPending(): FinalVerificationItem[];
  completeFinalVerification(keys: readonly string[]): void;
  baselineOutputs(): Map<string, ProjectionOutputEvidence>;
  immutableDerivativesThrough(): number | null;
  markImmutableDerivativesThrough(revision: number): void;
  managedZoneBootstrapReady?(): boolean;
  markManagedZoneBootstrapReady?(): void;
  failActive(message: string): void;
  completeTarget(input: {
    revision: number;
    projection_version: number;
    outputs: ReadonlyMap<string, ProjectionOutputEvidence>;
    removed_outputs: readonly string[];
  }): void;
  restoreExternalBaseline(
    head: { revision: number; projection_version: number },
    outputs: ReadonlyMap<string, ProjectionOutputEvidence>
  ): void;
  status(): MaterializationLedgerStatus;
}

export interface ProjectionWriterPort {
  materialize(plan: ProjectionPlan, options: {
    workspaceRoot: string;
    alreadyVerified?: ReadonlyMap<string, ProjectionOutputEvidence>;
    onOutputVerified?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void>;
    onOutputOutcome?: (key: string, outcome: ProjectionWriteOutcome) => void | Promise<void>;
  }): Promise<Map<string, ProjectionOutputEvidence>>;
  materializeSlice?(plan: ProjectionPlan, options: {
    workspaceRoot: string;
    alreadyVerified?: ReadonlyMap<string, ProjectionOutputEvidence>;
    onOutputVerified?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void>;
    onOutputOutcome?: (key: string, outcome: ProjectionWriteOutcome) => void | Promise<void>;
  }, budget: SliceBudget): Promise<{ verified: Map<string, ProjectionOutputEvidence>; nextKey: string | null }>;
  verifyCritical?(plan: ProjectionPlan, workspaceRoot: string): Promise<void>;
  verifyOutputs?(outputs: ReadonlyMap<string, ProjectionOutputEvidence>, workspaceRoot: string): Promise<void>;
  verifyAbsentOutputs?(outputs: ReadonlyMap<string, ProjectionOutputEvidence>, workspaceRoot: string): Promise<void>;
}

export interface ProjectionBaseline {
  head: MaterializationHead;
  outputs: Map<string, ProjectionOutputEvidence>;
  chain_depth: number;
}

export interface MaterializationCoordinatorOptions {
  projectId: string;
  repository: MaterializationRepositoryPort;
  ledger: MaterializationLedgerPort;
  writer: ProjectionWriterPort;
  projectionVersion?: number;
  workspaceRootFor?: (state: ProjectState) => string;
  now?: () => string;
  sliceBudget?: SliceBudget;
  canonicalDerivativesAlreadyCurrent?: boolean;
  verifyExistingCriticalPairOnly?: boolean;
}

export interface MaterializationRunResult {
  project_id: string;
  target_revision: number | null;
  projection_version: number;
  completed: boolean;
  repaired_head: boolean;
  more_work: boolean;
}

interface MaterializationAttemptMetrics {
  uploaded: number;
  contentHash: number;
  attemptReuse: number;
}

export class MaterializationCoordinator {
  private readonly projectId: string;
  private readonly repository: MaterializationRepositoryPort;
  private readonly ledger: MaterializationLedgerPort;
  private readonly writer: ProjectionWriterPort;
  private readonly projectionVersion: number;
  private readonly workspaceRootFor: (state: ProjectState) => string;
  private readonly now: () => string;
  private readonly sliceBudget: SliceBudget | undefined;
  private readonly canonicalDerivativesAlreadyCurrent: boolean;
  private readonly verifyExistingCriticalPairOnly: boolean;

  constructor(options: MaterializationCoordinatorOptions) {
    this.projectId = options.projectId;
    this.repository = options.repository;
    this.ledger = options.ledger;
    this.writer = options.writer;
    this.projectionVersion = options.projectionVersion ?? CURRENT_PROJECTION_VERSION;
    if (!Number.isSafeInteger(this.projectionVersion) || this.projectionVersion < 1) {
      throw new Error(`Invalid materialization coordinator projection version: ${this.projectionVersion}`);
    }
    this.workspaceRootFor = options.workspaceRootFor ?? ((state) => workspaceProjectRoot(state.project_id, state.slug));
    this.now = options.now ?? (() => new Date().toISOString());
    this.sliceBudget = options.sliceBudget;
    this.canonicalDerivativesAlreadyCurrent = options.canonicalDerivativesAlreadyCurrent ?? false;
    this.verifyExistingCriticalPairOnly = options.verifyExistingCriticalPairOnly ?? false;
  }

  requestTarget(revision: number, projectionVersion = this.projectionVersion): void {
    this.ledger.requestTarget({ revision, projection_version: projectionVersion });
  }

  status(): MaterializationLedgerStatus {
    return this.ledger.status();
  }

  async reconcile(canonicalRevision: number): Promise<MaterializationLedgerStatus> {
    if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 0) {
      throw new Error(`Invalid canonical revision for materialization reconciliation: ${canonicalRevision}`);
    }

    let externalHead = await this.repository.readMaterializationHead(this.projectId);
    if (!externalHead) {
      externalHead = await this.repairHeadFromCompletedRecords(canonicalRevision);
    }

    if (externalHead) {
      if (externalHead.target_revision > canonicalRevision) {
        throw new Error(`Materialization head is ahead of canonical revision for ${this.projectId}`);
      }
      const local = this.ledger.status().head;
      if (
        !local
        || local.revision !== externalHead.target_revision
        || local.projection_version !== externalHead.projection_version
      ) {
        const baseline = await rebuildProjectionBaseline(this.repository, externalHead);
        this.ledger.restoreExternalBaseline(
          { revision: externalHead.target_revision, projection_version: externalHead.projection_version },
          baseline.outputs
        );
      }
    }

    if (
      !externalHead
      || externalHead.target_revision < canonicalRevision
      || externalHead.projection_version !== this.projectionVersion
    ) {
      this.requestTarget(canonicalRevision, this.projectionVersion);
    }
    return this.ledger.status();
  }

  async runNext(retryCount = 0): Promise<MaterializationRunResult> {
    const target = this.ledger.beginNextTarget();
    if (!target) {
      return {
        project_id: this.projectId,
        target_revision: null,
        projection_version: this.projectionVersion,
        completed: false,
        repaired_head: false,
        more_work: false
      };
    }

    const existingRecord = await this.repository.readMaterializationRecord(
      this.projectId,
      target.revision,
      target.projection_version
    );
    if (existingRecord) {
      const repaired = await this.finishExistingCompletedRecord(existingRecord);
      return {
        project_id: this.projectId,
        target_revision: target.revision,
        projection_version: target.projection_version,
        completed: true,
        repaired_head: repaired,
        more_work: this.hasMoreWork()
      };
    }

    const record = await this.repository.readCommitRecord(this.projectId, target.revision);
    if (!record) {
      const message = `Canonical commit record missing for ${this.projectId} revision ${target.revision}`;
      this.ledger.failActive(message);
      throw new Error(message);
    }

    const startedAt = Date.now();
    let plan: ProjectionPlan | null = null;
    let verifiedCount = 0;
    const metrics: MaterializationAttemptMetrics = { uploaded: 0, contentHash: 0, attemptReuse: 0 };
    const priorAttempts = this.ledger.attemptOutputs();

    try {
      if (await this.materializeOneCoalescedImmutableDerivative(target)) {
        return {
          project_id: this.projectId,
          target_revision: target.revision,
          projection_version: target.projection_version,
          completed: false,
          repaired_head: false,
          more_work: true
        };
      }

      if (priorAttempts.size === 0 && !this.canonicalDerivativesAlreadyCurrent) {
        await this.repository.materializeCanonicalDerivatives(record, {
          ...(record.transaction.operation === "project.create" ? { publishReceipt: false } : {}),
          projectionVersion: target.projection_version
        });
      }

      // The convergence engine has already repaired the machine derivatives,
      // so it does not call `materializeCanonicalDerivatives`.  Keep its
      // managed-zone bootstrap nevertheless: visible INPUTS/REFERENCES/
      // WORKING/REVIEW/DELIVERABLES must exist before the human writer starts
      // publishing an active V2 projection.  It is intentionally skipped for
      // archives, which must never recreate an active workspace structure.
      if (
        priorAttempts.size === 0
        && record.state.status !== "archived"
        && this.repository.ensureManagedWorkspaceDirectories
      ) {
        if (this.ledger.managedZoneBootstrapReady?.() !== true && this.sliceBudget && !this.sliceBudget.canStartEffect(7)) {
          return {
            project_id: this.projectId,
            target_revision: target.revision,
            projection_version: target.projection_version,
            completed: false,
            repaired_head: false,
            more_work: true
          };
        }
        if (this.ledger.managedZoneBootstrapReady?.() !== true) {
          await this.repository.ensureManagedWorkspaceDirectories(record.state);
          this.ledger.markManagedZoneBootstrapReady?.();
        }
      }

      const baseline = await this.loadExternalBaseline(target.revision);
      if (baseline) {
        const local = this.ledger.status().head;
        if (
          !local
          || local.revision !== baseline.head.target_revision
          || local.projection_version !== baseline.head.projection_version
        ) {
          this.ledger.restoreExternalBaseline(
            { revision: baseline.head.target_revision, projection_version: baseline.head.projection_version },
            baseline.outputs
          );
          this.ledger.requestTarget({ revision: target.revision, projection_version: target.projection_version });
          this.ledger.beginNextTarget();
        }
      }

      const plannerBaseline: PlannerBaseline | null = baseline
        ? { projection_version: baseline.head.projection_version, outputs: baseline.outputs }
        : null;
      plan = await planProjection(record, plannerBaseline, target.projection_version);
      const attempts = this.ledger.attemptOutputs();
      const archived = record.state.status === "archived";
      const activeRoot = this.workspaceRootFor(record.state);
      const archiveRoot = archiveProjectRoot(record.state.project_id, record.state.slug);
      let workspaceRoot = activeRoot;
      let workspaceLocation: "active" | "archive" = "active";
      let moveAfterWrite = false;

      if (archived) {
        workspaceLocation = "archive";
        const baselineAlreadyArchived = baseline?.head.workspace_location === "archive";
        const observedLocation = this.repository.archiveWorkspaceLocation
          ? await this.repository.archiveWorkspaceLocation(record.state)
          : null;
        if (observedLocation === "conflict") {
          throw new MaterializationOutputConflictError(
            "workspace:archive",
            activeRoot,
            `Archived workspace move is inconsistent: both roots exist for ${this.projectId}`
          );
        }
        if (baselineAlreadyArchived || observedLocation === "archive") {
          workspaceRoot = archiveRoot;
        } else if (attempts.size > 0) {
          await this.archiveWorkspaceOrConflict(record.state, activeRoot);
          workspaceRoot = archiveRoot;
        } else {
          moveAfterWrite = true;
        }
      }

      let verified = attempts;
      let fullOutputs: Map<string, ProjectionOutputEvidence> | null = null;
      if (!(this.sliceBudget && this.ledger.finalVerificationActive())) {
        const writerOptions: Parameters<ProjectionWriterPort["materialize"]>[1] = {
          workspaceRoot,
          alreadyVerified: attempts,
          onOutputOutcome: (_key, outcome) => countOutcome(metrics, outcome),
          onOutputVerified: (key, evidence) => this.ledger.recordVerifiedOutput(key, evidence)
        };
        const sliced = this.sliceBudget && this.writer.materializeSlice
          ? await this.writer.materializeSlice(plan, writerOptions, this.sliceBudget)
          : null;
        verified = sliced
          ? sliced.verified
          : await this.writer.materialize(plan, writerOptions);
        verifiedCount = verified.size;

        if (sliced?.nextKey !== null && sliced?.nextKey !== undefined) {
          return pendingMaterializationResult(this.projectId, target);
        }

        if (archived && moveAfterWrite) {
          await this.archiveWorkspaceOrConflict(record.state, activeRoot);
        }
        if (this.sliceBudget) {
          const missing = [...plan.changed_outputs.keys()].filter((key) => !verified.has(key));
          if (missing.length > 0) {
            throw new Error(`Final materialization verification is missing changed outputs: ${missing.join(", ")}`);
          }
          fullOutputs = applyPlanToBaseline(baseline?.outputs ?? new Map(), plan, verified);
          this.ledger.beginFinalVerification(finalVerificationItems(fullOutputs, plan));
        }
      }

      if (this.sliceBudget) {
        const finalVerificationComplete = await this.verifyFinalOutputBatch(archived ? archiveRoot : workspaceRoot);
        if (!finalVerificationComplete) return pendingMaterializationResult(this.projectId, target);
        verified = this.ledger.attemptOutputs();
        verifiedCount = verified.size;
      }

      if (!this.writer.verifyCritical) {
        throw new Error("Materialization requires final critical-output verification");
      }
      await this.writer.verifyCritical(plan, archived ? archiveRoot : activeRoot);

      fullOutputs ??= applyPlanToBaseline(baseline?.outputs ?? new Map(), plan, verified);
      const resultRootHash = await projectionIndexRootHash(fullOutputs);
      const snapshot = baseline === null
        || baseline.head.projection_version !== target.projection_version
        || baseline.chain_depth >= MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH;
      const changedEvidence = snapshot
        ? fullOutputs
        : changedEvidenceFromBaseline(baseline.outputs, fullOutputs);
      const completedAt = this.now();
      const completedRecord: CompletedMaterializationRecord = {
        schema_version: "1.0",
        project_id: this.projectId,
        target_revision: target.revision,
        projection_version: target.projection_version,
        record_kind: snapshot ? "snapshot" : "delta",
        parent: snapshot || baseline === null
          ? null
          : {
              target_revision: baseline.head.target_revision,
              projection_version: baseline.head.projection_version
            },
        chain_depth: snapshot || baseline === null ? 0 : baseline.chain_depth + 1,
        workspace_location: workspaceLocation,
        outputs: Object.fromEntries([...changedEvidence.entries()].sort(([a], [b]) => a.localeCompare(b))),
        removed_outputs: snapshot ? [] : [...plan.removed_outputs].sort(),
        total_output_count: fullOutputs.size,
        result_root_hash: resultRootHash,
        coalesced_revisions: [...target.coalesced_revisions],
        source_event_id: record.event.event_id,
        completed_at: completedAt
      };

      await this.repository.writeCompletedMaterializationRecord(completedRecord);
      const head = headFor(completedRecord);
      await this.repository.writeMaterializationHead(head);
      await this.writer.verifyCritical(plan, archived ? archiveRoot : activeRoot);
      const publishedHead = await this.repository.readMaterializationHead(this.projectId);
      if (!publishedHead || !samePublishedHead(publishedHead, head)) {
        throw new Error(`Materialization head changed after publication for ${this.projectId}`);
      }
      this.ledger.completeTarget({
        revision: target.revision,
        projection_version: target.projection_version,
        outputs: changedEvidence,
        removed_outputs: plan.removed_outputs
      });

      logMaterializationAttempt("info", record, target, plan, metrics, verifiedCount, retryCount, startedAt, "complete");
      return {
        project_id: this.projectId,
        target_revision: target.revision,
        projection_version: target.projection_version,
        completed: true,
        repaired_head: false,
        more_work: this.hasMoreWork()
      };
    } catch (error) {
      if (this.sliceBudget && isSliceBudgetExhaustion(error)) {
        logMaterializationAttempt("info", record, target, plan, metrics, verifiedCount, retryCount, startedAt, "pending");
        return {
          project_id: this.projectId,
          target_revision: target.revision,
          projection_version: target.projection_version,
          completed: false,
          repaired_head: false,
          more_work: true
        };
      }
      this.ledger.failActive(error instanceof Error ? error.message : String(error));
      logMaterializationAttempt("error", record, target, plan, metrics, verifiedCount, retryCount, startedAt, "failed");
      throw error;
    }
  }

  async runUntilIdle(maxRuns = 128): Promise<MaterializationLedgerStatus> {
    for (let run = 0; run < maxRuns; run += 1) {
      const result = await this.runNext();
      if (!result.more_work) return this.ledger.status();
    }
    throw new Error(`Materialization did not become idle after ${maxRuns} runs for ${this.projectId}`);
  }

  /**
   * Coalescence skips redundant human views, never immutable evidence. These
   * two writes deliberately avoid the workspace writer and its directory work.
   */
  private async materializeOneCoalescedImmutableDerivative(target: MaterializationTarget): Promise<boolean> {
    if (!this.repository.writeCanonicalEvent || !this.repository.writeReceipt) return false;
    const through = this.ledger.immutableDerivativesThrough();
    const revision = [...target.coalesced_revisions]
      .sort((left, right) => left - right)
      .find((candidate) => through === null || candidate > through);
    if (revision === undefined) return false;
    if (this.sliceBudget && !this.sliceBudget.canStartEffect(4)) return true;
    const record = await this.repository.readCommitRecord(this.projectId, revision);
    if (!record) {
      throw new Error(`Canonical coalesced commit record missing for ${this.projectId} revision ${revision}`);
    }
    await this.repository.writeCanonicalEvent(record);
    await this.repository.writeReceipt(record.receipt);
    this.ledger.markImmutableDerivativesThrough(revision);
    return true;
  }

  private async loadExternalBaseline(canonicalRevision: number): Promise<ProjectionBaseline | null> {
    let head = await this.repository.readMaterializationHead(this.projectId);
    if (!head) head = await this.repairHeadFromCompletedRecords(canonicalRevision);
    if (!head) return null;

    const localHead = this.ledger.status().head;
    if (
      localHead
      && localHead.revision === head.target_revision
      && localHead.projection_version === head.projection_version
    ) {
      const tip = await this.repository.readMaterializationRecord(
        this.projectId,
        head.target_revision,
        head.projection_version
      );
      const outputs = this.ledger.baselineOutputs();
      if (tip && await matchesCachedBaseline(head, tip, outputs)) {
        return { head, outputs, chain_depth: tip.chain_depth };
      }
    }

    return rebuildProjectionBaseline(this.repository, head);
  }

  private async repairHeadFromCompletedRecords(canonicalRevision: number): Promise<MaterializationHead | null> {
    const refs = await this.repository.listMaterializationRecordRefs(this.projectId);
    const candidates = refs
      .filter((ref) => ref.target_revision <= canonicalRevision)
      .sort((a, b) => b.projection_version - a.projection_version || b.target_revision - a.target_revision);

    for (const ref of candidates) {
      const record = await this.repository.readMaterializationRecord(
        this.projectId,
        ref.target_revision,
        ref.projection_version
      );
      if (!record) continue;
      const candidateHead = headFor(record);
      try {
        const baseline = await rebuildProjectionBaseline(this.repository, candidateHead);
        await this.restoreAndVerifyCompletedProjection(record, baseline);
        await this.repository.writeMaterializationHead(candidateHead);
        return candidateHead;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async finishExistingCompletedRecord(record: CompletedMaterializationRecord): Promise<boolean> {
    const head = headFor(record);
    const baseline = await rebuildProjectionBaseline(this.repository, head);
    await this.restoreAndVerifyCompletedProjection(record, baseline);
    const currentHead = await this.repository.readMaterializationHead(this.projectId);
    const needsRepair = !currentHead
      || isHeadAheadOf(head, currentHead)
      || (
        sameHeadTarget(currentHead, head)
        && currentHead.result_root_hash !== record.result_root_hash
      );
    if (needsRepair) await this.repository.writeMaterializationHead(head);
    this.ledger.restoreExternalBaseline(
      { revision: record.target_revision, projection_version: record.projection_version },
      baseline.outputs
    );
    return needsRepair;
  }

  private async restoreAndVerifyCompletedProjection(
    record: CompletedMaterializationRecord,
    baseline: ProjectionBaseline
  ): Promise<void> {
    const canonical = await this.repository.readCommitRecord(this.projectId, record.target_revision);
    if (!canonical) {
      throw new Error(`Canonical commit record missing for completed materialization ${this.projectId} revision ${record.target_revision}`);
    }
    const root = record.workspace_location === "archive"
      ? archiveProjectRoot(canonical.state.project_id, canonical.state.slug)
      : this.workspaceRootFor(canonical.state);
    if (!this.writer.verifyOutputs) {
      throw new Error("Completed materialization repair requires full-output verification");
    }
    const outputs = this.verifyExistingCriticalPairOnly
      ? criticalPairEvidence(baseline.outputs)
      : baseline.outputs;
    await this.writer.verifyOutputs(outputs, root);
  }

  private async archiveWorkspaceOrConflict(state: ProjectState, activeRoot: string): Promise<void> {
    if (!this.repository.archiveHumanWorkspace) {
      throw new Error("Archive materialization requires repository archive support");
    }
    try {
      await this.repository.archiveHumanWorkspace(state);
    } catch (error) {
      if (error instanceof Error && /Archived workspace move is inconsistent/.test(error.message)) {
        throw new MaterializationOutputConflictError(
          "workspace:archive",
          activeRoot,
          error.message
        );
      }
      throw error;
    }
  }

  private async verifyFinalOutputBatch(workspaceRoot: string): Promise<boolean> {
    if (!this.sliceBudget || !this.writer.verifyOutputs) {
      throw new Error("Bounded materialization requires final output verification");
    }
    const pending = this.ledger.finalVerificationPending();
    if (pending.length === 0) return true;
    const attempts = this.ledger.attemptOutputs();
    const batchSize = selectFinalVerificationBatchSize(this.sliceBudget, pending.length);
    if (batchSize === 0) return false;
    const batch = pending.slice(0, batchSize);
    const present = new Map(batch
      .filter((item) => item.expected === "present")
      .map((item) => [item.key, item.evidence] as const));
    const absent = new Map(batch
      .filter((item) => item.expected === "absent")
      .map((item) => [item.key, item.evidence] as const));
    for (const [key, evidence] of present) {
      const attempt = attempts.get(key);
      if (attempt && attempt.content_hash !== evidence.content_hash) {
        throw new Error(`Final materialization verification evidence diverged for ${key}`);
      }
    }
    if (present.size > 0) await this.writer.verifyOutputs(present, workspaceRoot);
    if (absent.size > 0) {
      if (!this.writer.verifyAbsentOutputs) {
        throw new Error("Bounded materialization requires final removed-output verification");
      }
      await this.writer.verifyAbsentOutputs(absent, workspaceRoot);
    }
    // Do not clear the last batch before record/head publication. A cold
    // restart in this interval will observe it again rather than trust a
    // completed cursor with no published generation.
    if (batch.length === pending.length) return true;
    this.ledger.completeFinalVerification(batch.map((item) => item.key));
    return false;
  }

  private hasMoreWork(): boolean {
    const status = this.ledger.status();
    return status.active !== null || status.requested !== null;
  }
}

function finalVerificationItems(
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>,
  plan: ProjectionPlan
): FinalVerificationItem[] {
  const items: FinalVerificationItem[] = [...outputs.entries()].map(([key, evidence]) => ({
    key,
    expected: "present",
    evidence
  }));
  for (const key of plan.removed_outputs) {
    const evidence = plan.removed_output_evidence?.get(key);
    if (!evidence) {
      throw new Error(`Final materialization verification is missing removed-output evidence for ${key}`);
    }
    items.push({ key, expected: "absent", evidence });
  }
  return items;
}

/**
 * Final output reads must never take the journal reserve. If this is the last
 * batch, also reserve the immutable record/head publication and its critical
 * post-publication checks. Earlier batches consume only provider reads, then
 * durably retain their remaining-key cursor for the next fresh slice.
 */
function selectFinalVerificationBatchSize(budget: SliceBudget, pendingCount: number): number {
  const publicationCalls = 8;
  for (let size = pendingCount; size >= 1; size -= 1) {
    const isFinalBatch = size === pendingCount;
    if (budget.canStartEffect(size + (isFinalBatch ? publicationCalls : 0))) return size;
  }
  return 0;
}

function pendingMaterializationResult(
  projectId: string,
  target: MaterializationTarget
): MaterializationRunResult {
  return {
    project_id: projectId,
    target_revision: target.revision,
    projection_version: target.projection_version,
    completed: false,
    repaired_head: false,
    more_work: true
  };
}

function criticalPairEvidence(
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>
): Map<string, ProjectionOutputEvidence> {
  const pair = new Map(
    [...outputs].filter(([, evidence]) =>
      evidence.relative_path === "STATE.md" || evidence.relative_path === "HANDOFF.md"
    )
  );
  const paths = new Set([...pair.values()].map((evidence) => evidence.relative_path));
  if (pair.size !== 2 || paths.size !== 2 || !paths.has("STATE.md") || !paths.has("HANDOFF.md")) {
    throw new Error("Completed materialization record is missing the critical STATE/HANDOFF pair");
  }
  return pair;
}

export async function rebuildProjectionBaseline(
  repository: Pick<MaterializationRepositoryPort, "readMaterializationRecord">,
  head: MaterializationHead
): Promise<ProjectionBaseline> {
  const expectedHeadPath = machineMaterializationRecordPath(
    head.project_id,
    head.target_revision,
    head.projection_version
  );
  if (head.record_path !== expectedHeadPath) {
    throw new Error(`Materialization head record path binding mismatch for ${head.project_id}`);
  }

  const chain: CompletedMaterializationRecord[] = [];
  const visited = new Set<string>();
  let revision = head.target_revision;
  let projectionVersion = head.projection_version;

  for (let depth = 0; depth <= MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH; depth += 1) {
    const key = `${revision}:${projectionVersion}`;
    if (visited.has(key)) throw new Error(`Materialization parent chain cycle for ${head.project_id}`);
    visited.add(key);
    const record = await repository.readMaterializationRecord(head.project_id, revision, projectionVersion);
    if (!record) throw new Error(`Materialization parent/record missing for ${head.project_id} ${key}`);
    chain.push(record);
    if (record.record_kind === "snapshot") break;
    if (!record.parent) throw new Error(`Materialization delta parent missing for ${head.project_id} ${key}`);
    revision = record.parent.target_revision;
    projectionVersion = record.parent.projection_version;
  }

  if (chain.at(-1)?.record_kind !== "snapshot") {
    throw new Error(`Materialization chain exceeds reconstruction bound for ${head.project_id}`);
  }

  chain.reverse();
  const outputs = new Map<string, ProjectionOutputEvidence>();
  for (let index = 0; index < chain.length; index += 1) {
    const record = chain[index];
    if (index === 0) {
      if (record.record_kind !== "snapshot" || record.chain_depth !== 0 || record.parent !== null) {
        throw new Error(`Invalid materialization snapshot root for ${head.project_id}`);
      }
    } else {
      const parent = chain[index - 1];
      if (
        record.record_kind !== "delta"
        || record.parent?.target_revision !== parent.target_revision
        || record.parent?.projection_version !== parent.projection_version
        || record.chain_depth !== parent.chain_depth + 1
      ) {
        throw new Error(`Invalid materialization parent chain for ${head.project_id}`);
      }
    }

    for (const key of record.removed_outputs) outputs.delete(key);
    for (const [key, evidence] of Object.entries(record.outputs)) outputs.set(key, evidence);
    if (outputs.size !== record.total_output_count) {
      throw new Error(`Materialization output count mismatch for ${head.project_id} revision ${record.target_revision}`);
    }
    const root = await projectionIndexRootHash(outputs);
    if (root !== record.result_root_hash) {
      throw new Error(`Materialization result root mismatch for ${head.project_id} revision ${record.target_revision}`);
    }
  }

  const final = chain.at(-1)!;
  if (
    final.target_revision !== head.target_revision
    || final.projection_version !== head.projection_version
    || final.result_root_hash !== head.result_root_hash
    || final.workspace_location !== head.workspace_location
  ) {
    throw new Error(`Materialization head/final record mismatch for ${head.project_id}`);
  }

  return { head, outputs, chain_depth: final.chain_depth };
}

async function matchesCachedBaseline(
  head: MaterializationHead,
  tip: CompletedMaterializationRecord,
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>
): Promise<boolean> {
  return tip.project_id === head.project_id
    && tip.target_revision === head.target_revision
    && tip.projection_version === head.projection_version
    && tip.result_root_hash === head.result_root_hash
    && tip.workspace_location === head.workspace_location
    && tip.total_output_count === outputs.size
    && await projectionIndexRootHash(outputs) === head.result_root_hash;
}

function applyPlanToBaseline(
  baseline: ReadonlyMap<string, ProjectionOutputEvidence>,
  plan: ProjectionPlan,
  verified: ReadonlyMap<string, ProjectionOutputEvidence>
): Map<string, ProjectionOutputEvidence> {
  const outputs = new Map(baseline);
  for (const key of plan.removed_outputs) outputs.delete(key);
  for (const [key, evidence] of plan.carried_forward) outputs.set(key, evidence);
  for (const [key, output] of plan.changed_outputs) {
    const evidence = verified.get(key);
    if (!evidence) throw new Error(`Changed projection output was not verified: ${key}`);
    outputs.set(key, evidence);
    if (evidence.relative_path !== output.relative_path || evidence.input_hash !== output.input_hash) {
      throw new Error(`Verified projection evidence binding mismatch: ${key}`);
    }
  }
  const expected = new Set(plan.expected_output_keys);
  for (const key of outputs.keys()) {
    if (!expected.has(key)) outputs.delete(key);
  }
  if (outputs.size !== expected.size) {
    throw new Error(`Projection output set is incomplete for ${plan.project_id} revision ${plan.target_revision}`);
  }
  return outputs;
}

function changedEvidenceFromBaseline(
  baseline: ReadonlyMap<string, ProjectionOutputEvidence>,
  current: ReadonlyMap<string, ProjectionOutputEvidence>
): Map<string, ProjectionOutputEvidence> {
  const changed = new Map<string, ProjectionOutputEvidence>();
  for (const [key, evidence] of current) {
    const previous = baseline.get(key);
    if (!previous || !sameEvidence(previous, evidence)) changed.set(key, evidence);
  }
  return changed;
}

function sameEvidence(a: ProjectionOutputEvidence, b: ProjectionOutputEvidence): boolean {
  return a.relative_path === b.relative_path
    && a.input_hash === b.input_hash
    && a.content_hash === b.content_hash
    && a.source_revision === b.source_revision;
}

function countOutcome(metrics: MaterializationAttemptMetrics, outcome: ProjectionWriteOutcome): void {
  if (outcome === "uploaded") metrics.uploaded += 1;
  else if (outcome === "content_hash") metrics.contentHash += 1;
  else metrics.attemptReuse += 1;
}

function logMaterializationAttempt(
  level: "info" | "error",
  record: CanonicalCommitRecord,
  target: MaterializationTarget,
  plan: ProjectionPlan | null,
  metrics: MaterializationAttemptMetrics,
  verifiedCount: number,
  retryCount: number,
  startedAt: number,
  finalState: "complete" | "pending" | "failed"
): void {
  const payload = {
    project_id: record.project_id,
    target_revision: target.revision,
    projection_version: target.projection_version,
    generation_id: generationId(record.project_id, target.revision, target.projection_version),
    source_transaction_id: record.transaction.transaction_id,
    source_event_id: record.event.event_id,
    outputs_planned: plan?.expected_output_keys.length ?? 0,
    outputs_carried_forward: plan?.carried_forward.size ?? 0,
    outputs_rendered: plan?.changed_outputs.size ?? 0,
    outputs_skipped_content_hash: metrics.contentHash,
    outputs_uploaded: metrics.uploaded,
    outputs_verified: verifiedCount,
    retry_count: retryCount,
    coalesced_revisions: [...target.coalesced_revisions],
    duration_ms: Math.max(0, Date.now() - startedAt),
    final_state: finalState
  };
  if (level === "info") console.info("Project OS materialization attempt", payload);
  else console.error("Project OS materialization attempt", payload);
}

function isSliceBudgetExhaustion(error: unknown): boolean {
  return error instanceof Error && error.message.includes("slice_budget_exhausted");
}

function generationId(projectId: string, revision: number, projectionVersion: number): string {
  return `${projectId}:REV-${revision.toString().padStart(6, "0")}:PV-${projectionVersion.toString().padStart(4, "0")}`;
}

function sameHeadTarget(left: MaterializationHead, right: MaterializationHead): boolean {
  return left.target_revision === right.target_revision
    && left.projection_version === right.projection_version;
}

function isHeadAheadOf(candidate: MaterializationHead, current: MaterializationHead): boolean {
  return candidate.projection_version > current.projection_version
    || (
      candidate.projection_version === current.projection_version
      && candidate.target_revision > current.target_revision
    );
}

function samePublishedHead(left: MaterializationHead, right: MaterializationHead): boolean {
  return left.target_revision === right.target_revision
    && left.projection_version === right.projection_version
    && left.workspace_location === right.workspace_location
    && left.record_path === right.record_path
    && left.result_root_hash === right.result_root_hash;
}

function headFor(record: CompletedMaterializationRecord): MaterializationHead {
  return {
    schema_version: "1.0",
    project_id: record.project_id,
    target_revision: record.target_revision,
    projection_version: record.projection_version,
    workspace_location: record.workspace_location,
    record_path: machineMaterializationRecordPath(
      record.project_id,
      record.target_revision,
      record.projection_version
    ),
    result_root_hash: record.result_root_hash,
    completed_at: record.completed_at
  };
}
