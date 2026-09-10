import type { MaterializationLedger } from "../materialization/ledger";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProjectRepository } from "../persistence/repository";
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import { WorkspaceProjectionWriter } from "../materialization/writer";
import { planProjection, type ProjectionPlan } from "../materialization/planner";
import { archiveProjectRoot, machineCommitRecordPath, workspaceProjectRoot } from "../persistence/layout";
import type {
  AttemptReservation,
  ConvergenceHealth,
  Layer,
  LayerHealth,
  Obligation,
  Progress,
  SliceBudget,
  SliceResult,
  Target
} from "./contract";
import { inspectDerivativeRepair, observeDerivative, repairDerivative } from "./derivatives";
import { discoverCanonical } from "./discovery";
import { FencedEffects } from "./fenced-effects";
import { publicState, unknownHealth } from "./health";
import { initialProgress, ConvergenceJournal } from "./journal";
import { deterministicRetryJitter, minimumWake, nextRetryAt } from "./retry";
import { sha256Canonical } from "../materialization/hash";
import {
  dispatchAlertDelivery,
  commitClock,
  dueAlerts,
  publishConvergenceTelemetry,
  type ConvergenceTelemetry,
  type NotificationPort
} from "./observability";
import { runHumanSlice } from "./human";
import { isConverged } from "./health";

export function nextConvergenceWake(existing: string | null, due: readonly (string | null)[]): string | null {
  return minimumWake([existing, ...due]);
}

/**
 * Narrow owner for convergence state. The Durable Object supplies the
 * serialization; this class intentionally has no static state, so a cold
 * start reconstructs all decisions from the external journal and commit log.
 */
export class ConvergenceEngine {
  constructor(private readonly input: {
    projectId: string;
    repository: ProjectRepository;
    runtime: ProjectOsPersistenceRuntime;
    journal: ConvergenceJournal;
    ledger: MaterializationLedger;
    now: () => number;
    deploymentSha?: string;
    enableHuman?: boolean;
    notification?: NotificationPort;
    telemetry?: ConvergenceTelemetry;
  }) {}

  async requestTarget(target: Target): Promise<void> {
    const existing = await this.ensureProgress();
    const progress = existing.progress;
    const requested = progress.requested;
    if (
      requested
      && (requested.revision > target.revision
        || (requested.revision === target.revision && requested.projection_version >= target.projection_version))
    ) return;
    await this.input.journal.save({ ...progress, requested: target }, existing.token);
  }

  async observe(budget: SliceBudget): Promise<ConvergenceHealth> {
    const checkpoint = await this.input.journal.load();
    const progress = checkpoint?.progress ?? initialProgress(
      this.input.projectId,
      new Date(this.input.now()).toISOString(),
      "observe"
    );
    const health = this.blankHealth(progress.first_observed_at);
    const requiredCalls = this.input.enableHuman ? 17 : 13;
    if (!budget.canStartEffect(requiredCalls + 1)) return health;
    const discovered = await discoverCanonical(
      this.input.repository,
      this.input.runtime,
      progress,
      budget
    );
    if (discovered && !discovered.complete) return health;
    const latestRevision = discovered?.record?.new_revision ?? progress.canonical_observed_revision;
    if (latestRevision === 0) return health;
    const records = [];
    const firstRevision = discovered ? progress.canonical_observed_revision + 1 : latestRevision;
    for (let revision = firstRevision; revision <= latestRevision; revision += 1) {
      if (!budget.canStartEffect(3)) return health;
      const record = discovered?.record?.new_revision === revision
        ? discovered.record
        : await this.input.repository.readCommitRecord(this.input.projectId, revision);
      if (!record) return health;
      records.push(record);
    }
    const record = records.at(-1);
    if (!record) return health;
    const latestDerivative: Record<"event" | "receipt", LayerHealth | null> = {
      event: null,
      receipt: null
    };
    const firstMissingDerivative: Partial<Record<"event" | "receipt", LayerHealth>> = {};
    for (const candidate of records) {
      for (const layer of ["event", "receipt"] as const) {
        const observed = await observeDerivative(layer, candidate, this.input.runtime, this.input.repository);
        latestDerivative[layer] = observed;
        if (observed.state !== "current" && firstMissingDerivative[layer] === undefined) {
          firstMissingDerivative[layer] = observed;
        }
      }
    }
    if (this.input.enableHuman) {
      const verified = await this.verifyCompletedTarget(record, budget, health);
      for (const layer of ["event", "receipt"] as const) {
        if (firstMissingDerivative[layer] !== undefined) health.layers[layer] = firstMissingDerivative[layer];
      }
      health.converged = verified && isConverged(health);
      return health;
    }
    health.layers.canonical = currentLayer(record.new_revision, this.input.now());
    for (const layer of ["event", "receipt"] as const) {
      health.layers[layer] = firstMissingDerivative[layer] ?? latestDerivative[layer]!;
    }
    for (const layer of ["state", "manifest"] as const) {
      health.layers[layer] = await observeDerivative(layer, record, this.input.runtime, this.input.repository);
    }
    if (machineLayersCurrent(health)) health.layers.scheduler = currentLayer(record.new_revision, this.input.now());
    health.converged = isConverged(health);
    return health;
  }

  async runSlice(budget: SliceBudget): Promise<SliceResult> {
    const startedAtMs = this.input.now();
    const checkpoint = await this.ensureProgress();
    const before = convergenceMetricTotals(checkpoint.progress);
    const finish = (result: SliceResult, commitObserved = false): SliceResult => {
      const after = convergenceMetricTotals(checkpoint.progress);
      publishConvergenceTelemetry(this.input.telemetry, {
        progress: checkpoint.progress,
        health: result.health,
        nowMs: this.input.now(),
        startedAtMs,
        providerCalls: result.provider_calls,
        deploymentSha: this.input.deploymentSha ?? "unknown",
        counters: {
          commit_observed: commitObserved ? 1 : 0,
          obligations_verified: Math.max(0, after.verified - before.verified),
          retries: Math.max(0, after.failureCount - before.failureCount),
          exhaustions: Math.max(0, after.exhausted - before.exhausted),
          layer_conflicts: Math.max(0, after.conflicts - before.conflicts),
          handoff_failures: Math.max(0, after.handoffFailures - before.handoffFailures),
          freshness_rejections: 0,
          conditional_write_conflicts: Math.max(0, after.conditionalWriteConflicts - before.conditionalWriteConflicts)
        }
      });
      return result;
    };
    // A due wake is consumed by this slice.  Any unfinished obligation below
    // must explicitly install its next wake; otherwise a completed recovery
    // would keep scheduling itself forever at the same timestamp.
    if (
      checkpoint.progress.next_alarm_at !== null
      && Date.parse(checkpoint.progress.next_alarm_at) <= this.input.now()
    ) checkpoint.progress.next_alarm_at = null;
    const health = this.blankHealth(checkpoint.progress.first_observed_at);
    const resumed = await this.resumeDueMachineObligation(checkpoint, budget, health);
    if (resumed) return finish(resumed);
    const resumedHuman = await this.resumePendingHumanSlice(checkpoint, budget, health);
    if (resumedHuman) return finish(resumedHuman);
    const discovered = await discoverCanonical(
      this.input.repository,
      this.input.runtime,
      checkpoint.progress,
      budget
    );
    if (!discovered?.record) {
      // Discovery only says that there is no *new* immutable commit. It is
      // not proof that the durable target is current, so re-observe it rather
      // than emitting a blank pending health record.
      const observed = await this.observe(budget);
      await this.persistDueIncidents(checkpoint.progress, observed);
      await this.input.journal.save(checkpoint.progress, checkpoint.token);
      const nextAlarmAt = checkpoint.progress.next_alarm_at;
      return finish({
        health: observed,
        more_work: nextAlarmAt !== null,
        next_alarm_at: nextAlarmAt,
        provider_calls: 32 - budget.calls_left
      });
    }

    const effects = new FencedEffects(this.input.runtime, this.input.journal, budget);
    let token = checkpoint.token;
    const progress = checkpoint.progress;
    const firstDiscoveredRevision = progress.canonical_observed_revision + 1;
    health.layers.canonical = currentLayer(discovered.record.new_revision, this.input.now());
    if (progress.commit_accepted_at === null) {
      let metadata = null;
      if (budget.canStartEffect(1)) {
        try {
          metadata = await this.input.runtime.objects.getMetadata(
            machineCommitRecordPath(this.input.projectId, discovered.record.new_revision)
          );
        } catch {
          // Timing data is never allowed to turn a valid immutable commit into
          // a failed repair slice. The explicit unknown clock remains honest.
        }
      }
      const clock = commitClock(null, metadata, progress.first_observed_at);
      progress.commit_accepted_at = clock.t0;
      health.commit_accepted_at = clock.t0;
      health.commit_time_code = clock.code;
    }
    const records = [];
    for (let revision = firstDiscoveredRevision; revision <= discovered.record.new_revision; revision += 1) {
      const record = await this.input.repository.readCommitRecord(this.input.projectId, revision);
      if (!record) throw new Error(`canonical_commit_missing_after_discovery:${revision}`);
      records.push(record);
    }

    const discoveredRecord = discovered.record;
    let allMachineRepairsCurrent = true;
    const repair = async (layer: "event" | "receipt" | "state" | "manifest", record: typeof discovered.record) => {
      const obligationId = await sha256Canonical({ project_id: this.input.projectId, layer, revision: record.new_revision });
      const existingObligation = progress.obligations[obligationId];
      if (
        existingObligation
        && (existingObligation.state === "retry_wait" || existingObligation.state === "exhausted")
        && existingObligation.next_attempt_at !== null
        && Date.parse(existingObligation.next_attempt_at) > this.input.now()
      ) {
        // An early request cannot bypass this immutable layer's persisted
        // retry deadline, although other newly discovered layers may proceed.
        allMachineRepairsCurrent = false;
        progress.next_alarm_at = minimumWake([progress.next_alarm_at, existingObligation.next_attempt_at]);
        health.layers[layer] = {
          ...pendingLayer(record.new_revision, this.input.now(), existingObligation.code ?? "retry_wait"),
          state: publicState(existingObligation.state),
          failure_count: existingObligation.failure_count,
          next_attempt_at: existingObligation.next_attempt_at
        };
        return;
      }
      if (layer === "receipt" && record.transaction.operation === "project.create") {
        const layerHealth = await observeDerivative(layer, record, this.input.runtime, this.input.repository);
        if (layerHealth.state === "current") {
          if (existingObligation) {
            progress.obligations[obligationId] = {
              ...existingObligation,
              state: "verified",
              next_attempt_at: null,
              last_verified_at: new Date(this.input.now()).toISOString(),
              code: null,
              continuation: null
            };
          }
          health.layers[layer] = layerHealth;
          return;
        }
        allMachineRepairsCurrent = false;
        const nextAttemptAt = new Date(this.input.now() + 60_000).toISOString();
        progress.obligations[obligationId] = {
          id: obligationId,
          layer,
          from_revision: record.previous_revision,
          target: { revision: record.new_revision, projection_version: CURRENT_PROJECTION_VERSION },
          incident: existingObligation?.incident ?? 1,
          state: "pending",
          first_pending_at: existingObligation?.first_pending_at ?? new Date(this.input.now()).toISOString(),
          next_attempt_at: nextAttemptAt,
          failure_count: existingObligation?.failure_count ?? 0,
          last_attempt_number: existingObligation?.last_attempt_number ?? 0,
          last_closed_attempt_number: existingObligation?.last_closed_attempt_number ?? 0,
          last_verified_at: null,
          code: "awaiting_registry_finalization",
          lease_until: null,
          continuation: null
        };
        progress.next_alarm_at = minimumWake([progress.next_alarm_at, nextAttemptAt]);
        health.layers[layer] = {
          ...layerHealth,
          state: "pending",
          failure_count: existingObligation?.failure_count ?? 0,
          next_attempt_at: nextAttemptAt,
          code: "awaiting_registry_finalization"
        };
        return;
      }
      if (!budget.canStartEffect(12)) {
        allMachineRepairsCurrent = false;
        const nextAttemptAt = new Date(this.input.now()).toISOString();
        progress.obligations[obligationId] = pendingMachineObligation({
          obligationId,
          layer,
          record,
          existing: existingObligation,
          nextAttemptAt,
          code: "slice_budget_pending"
        });
        progress.next_alarm_at = minimumWake([progress.next_alarm_at, nextAttemptAt]);
        health.layers[layer] = pendingLayer(record.new_revision, this.input.now(), "slice_budget_pending");
        return;
      }
      const inspection = await inspectDerivativeRepair(layer, record, effects, this.input.repository);
      if (inspection.current) {
        if (existingObligation) {
          progress.obligations[obligationId] = {
            ...existingObligation,
            state: "verified",
            next_attempt_at: null,
            last_verified_at: new Date(this.input.now()).toISOString(),
            code: null,
            lease_until: null,
            continuation: null
          };
        }
        health.layers[layer] = inspection.current;
        return;
      }
      if (!inspection.intent) throw new Error("derivative_repair_intent_missing");
      const uncheckpointed = await this.uncheckpointedAttempt({
        obligationId,
        layer,
        record,
        existing: existingObligation
      });
      if (uncheckpointed) {
        allMachineRepairsCurrent = false;
        const recovered = await retryFromUncheckpointedAttempt({
          existing: existingObligation,
          reservation: uncheckpointed,
          nowMs: this.input.now()
        });
        progress.obligations[obligationId] = recovered;
        progress.next_alarm_at = minimumWake([progress.next_alarm_at, recovered.next_attempt_at]);
        health.layers[layer] = {
          ...pendingLayer(record.new_revision, this.input.now(), recovered.code ?? "attempt_outcome_uncertain"),
          state: publicState(recovered.state),
          failure_count: recovered.failure_count,
          next_attempt_at: recovered.next_attempt_at
        };
        return;
      }
      // A cold restart reconstructs the in-memory fencing capability.  Prepare
      // every repair from the current checkpoint rather than trusting a stale
      // persisted effect marker from an interrupted writer.
      token = await effects.prepare(progress, token, inspection.intent);
      const reservation = await this.reserveAttempt({
        schema_version: "1.0" as const,
        project_id: this.input.projectId,
        obligation_id: obligationId,
        layer,
        from_revision: record.previous_revision,
        target: { revision: record.new_revision, projection_version: 3 },
        attempt_number: (existingObligation?.last_attempt_number ?? 0) + 1,
        incident: existingObligation?.incident ?? 1,
        incarnation: progress.incarnation,
        reserved_at: new Date(this.input.now()).toISOString(),
        lease_until: new Date(this.input.now() + 10_000).toISOString()
      });
      const layerHealth = await repairDerivative(layer, record, effects, this.input.repository, inspection.intent);
      if (layerHealth.state === "current") {
        health.layers[layer] = layerHealth;
        return;
      }

      allMachineRepairsCurrent = false;
      const failureCount = (existingObligation?.failure_count ?? 0) + 1;
      const retry = nextRetryAt({
        nowMs: this.input.now(),
        failureCount,
        jitter: await deterministicRetryJitter(obligationId, reservation.attempt_number),
        retryAfterMs: 0
      });
      progress.obligations[obligationId] = {
        id: obligationId,
        layer,
        from_revision: record.previous_revision,
        target: reservation.target,
        incident: reservation.incident,
        state: retry.state,
        first_pending_at: existingObligation?.first_pending_at ?? reservation.reserved_at,
        next_attempt_at: retry.at,
        failure_count: failureCount,
        last_attempt_number: reservation.attempt_number,
        last_closed_attempt_number: reservation.attempt_number,
        last_verified_at: null,
        code: layerHealth.code,
        lease_until: null,
        continuation: null
      };
      progress.next_alarm_at = minimumWake([progress.next_alarm_at, retry.at]);
      health.layers[layer] = {
        ...layerHealth,
        state: retry.state,
        failure_count: failureCount,
        next_attempt_at: retry.at
      };
    };

    for (const record of records) {
      await repair("event", record);
      await repair("receipt", record);
    }
    await repair("state", discovered.record);
    await repair("manifest", discovered.record);
    // The observed cursor is a durable completion watermark, never merely a
    // discovery watermark.  A crash before this checkpoint therefore resumes
    // the same immutable records instead of silently skipping their repairs.
    if (allMachineRepairsCurrent) {
      progress.canonical_observed_revision = discovered.record.new_revision;
    }
    let humanMoreWork = false;
    if (this.input.enableHuman && machineLayersCurrent(health)) {
      progress.active = { revision: discovered.record.new_revision, projection_version: 3 };
      const waitingHuman = Object.values(progress.obligations).find((obligation) =>
        obligation.layer === "human_handoff"
        && obligation.target.revision === discoveredRecord.new_revision
        && (obligation.state === "retry_wait" || obligation.state === "exhausted")
        && obligation.next_attempt_at !== null
        && Date.parse(obligation.next_attempt_at) > this.input.now()
      );
      const humanWake = waitingHuman?.next_attempt_at ?? new Date(this.input.now()).toISOString();
      progress.next_alarm_at = minimumWake([progress.next_alarm_at, humanWake]);
      humanMoreWork = true;
      for (const layer of ["human_state", "human_handoff", "generation", "head"] as const) {
        health.layers[layer] = layer === "human_handoff" && waitingHuman
          ? {
              ...pendingLayer(discoveredRecord.new_revision, this.input.now(), waitingHuman.code ?? "human_retry_wait"),
              state: publicState(waitingHuman.state),
              failure_count: waitingHuman.failure_count,
              next_attempt_at: waitingHuman.next_attempt_at
            }
          : pendingLayer(discovered.record.new_revision, this.input.now(), "human_slice_pending");
      }
    }
    if (!humanMoreWork && progress.next_alarm_at === null) {
      health.layers.scheduler = currentLayer(discovered.record.new_revision, this.input.now());
    }
    health.converged = isConverged(health);
    await this.persistDueIncidents(progress, health);
    await this.input.journal.save(progress, token);
    return finish({
      health,
      more_work: !discovered.complete || !allMachineRepairsCurrent || humanMoreWork || progress.next_alarm_at !== null,
      next_alarm_at: progress.next_alarm_at,
      provider_calls: 32 - budget.calls_left
    }, true);
  }

  private async ensureProgress() {
    const existing = await this.input.journal.load();
    if (existing) return existing;
    const now = new Date(this.input.now()).toISOString();
    const progress = initialProgress(this.input.projectId, now, crypto.randomUUID());
    const token = await this.input.journal.save(progress, null);
    return { progress, token };
  }

  private blankHealth(firstObservedAt?: string): ConvergenceHealth {
    const health = unknownHealth(
      this.input.projectId,
      firstObservedAt ?? new Date(this.input.now()).toISOString()
    );
    if (!this.input.enableHuman) markHumanLayersNotApplicable(health);
    return health;
  }

  private async resumeDueMachineObligation(
    checkpoint: { progress: Progress; token: string },
    budget: SliceBudget,
    health: ConvergenceHealth
  ): Promise<SliceResult | null> {
    const due = Object.values(checkpoint.progress.obligations).find((obligation) =>
      isMachineLayer(obligation.layer)
      && (obligation.state === "retry_wait" || obligation.state === "exhausted")
      && obligation.next_attempt_at !== null
      && Date.parse(obligation.next_attempt_at) <= this.input.now()
    );
    if (!due) return null;
    if (!isMachineLayer(due.layer)) return null;

    const record = await this.input.repository.readCommitRecord(this.input.projectId, due.target.revision);
    if (!record) throw new Error(`canonical_commit_missing_for_retry:${due.target.revision}`);
    const effects = new FencedEffects(this.input.runtime, this.input.journal, budget);
    const progress = checkpoint.progress;
    let token = checkpoint.token;
    if (!budget.canStartEffect(12)) {
      const nextAttemptAt = new Date(this.input.now()).toISOString();
      progress.obligations[due.id] = {
        ...due,
        state: "pending",
        next_attempt_at: nextAttemptAt,
        code: "slice_budget_pending",
        lease_until: null
      };
      progress.next_alarm_at = minimumWake([nextPendingWake(progress), nextAttemptAt]);
      health.layers[due.layer] = pendingLayer(record.new_revision, this.input.now(), "slice_budget_pending");
      await this.input.journal.save(progress, token);
      return {
        health,
        more_work: true,
        next_alarm_at: progress.next_alarm_at,
        provider_calls: 32 - budget.calls_left
      };
    }
    const inspection = await inspectDerivativeRepair(due.layer, record, effects, this.input.repository);
    if (inspection.current) {
      progress.obligations[due.id] = {
        ...due,
        state: "verified",
        next_attempt_at: null,
        last_verified_at: new Date(this.input.now()).toISOString(),
        code: null,
        lease_until: null
      };
      progress.next_alarm_at = progress.canonical_observed_revision < due.target.revision
        ? new Date(this.input.now()).toISOString()
        : nextPendingWake(progress);
      health.layers[due.layer] = inspection.current;
      await this.input.journal.save(progress, token);
      return {
        health,
        more_work: progress.next_alarm_at !== null,
        next_alarm_at: progress.next_alarm_at,
        provider_calls: 32 - budget.calls_left
      };
    }
    if (!inspection.intent) throw new Error("derivative_repair_intent_missing");
    const uncheckpointed = await this.uncheckpointedAttempt({
      obligationId: due.id,
      layer: due.layer,
      record,
      existing: due
    });
    if (uncheckpointed) {
      const recovered = await retryFromUncheckpointedAttempt({
        existing: due,
        reservation: uncheckpointed,
        nowMs: this.input.now()
      });
      progress.obligations[due.id] = recovered;
      progress.next_alarm_at = minimumWake([nextPendingWake(progress), recovered.next_attempt_at]);
      health.layers[due.layer] = {
        ...pendingLayer(record.new_revision, this.input.now(), recovered.code ?? "attempt_outcome_uncertain"),
        state: publicState(recovered.state),
        failure_count: recovered.failure_count,
        next_attempt_at: recovered.next_attempt_at
      };
      await this.persistDueIncidents(progress, health);
      await this.input.journal.save(progress, token);
      return {
        health,
        more_work: true,
        next_alarm_at: progress.next_alarm_at,
        provider_calls: 32 - budget.calls_left
      };
    }
    token = await effects.prepare(progress, token, inspection.intent);
    const attemptNumber = due.last_attempt_number + 1;
    await this.reserveAttempt({
      schema_version: "1.0",
      project_id: this.input.projectId,
      obligation_id: due.id,
      layer: due.layer,
      from_revision: due.from_revision,
      target: due.target,
      attempt_number: attemptNumber,
      incident: due.incident,
      incarnation: progress.incarnation,
      reserved_at: new Date(this.input.now()).toISOString(),
      lease_until: new Date(this.input.now() + 10_000).toISOString()
    });
    const layerHealth = await repairDerivative(due.layer, record, effects, this.input.repository, inspection.intent);
    if (layerHealth.state === "current") {
      progress.obligations[due.id] = {
        ...due,
        state: "verified",
        next_attempt_at: null,
        last_attempt_number: attemptNumber,
        last_closed_attempt_number: attemptNumber,
        last_verified_at: new Date(this.input.now()).toISOString(),
        code: null,
        lease_until: null
      };
      // A successful retry proves one layer only.  Keep the canonical cursor
      // behind it and schedule a full immutable-record verification pass.
      progress.next_alarm_at = progress.canonical_observed_revision < due.target.revision
        ? new Date(this.input.now()).toISOString()
        : nextPendingWake(progress);
      health.layers[due.layer] = layerHealth;
    } else {
      const failureCount = due.failure_count + 1;
      const retry = nextRetryAt({
        nowMs: this.input.now(),
        failureCount,
        jitter: await deterministicRetryJitter(due.id, attemptNumber),
        retryAfterMs: 0
      });
      progress.obligations[due.id] = {
        ...due,
        state: retry.state,
        next_attempt_at: retry.at,
        failure_count: failureCount,
        last_attempt_number: attemptNumber,
        last_closed_attempt_number: attemptNumber,
        code: layerHealth.code,
        lease_until: null
      };
      progress.next_alarm_at = minimumWake([nextPendingWake(progress), retry.at]);
      health.layers[due.layer] = {
        ...layerHealth,
        state: retry.state,
        failure_count: failureCount,
        next_attempt_at: retry.at
      };
    }
    await this.persistDueIncidents(progress, health);
    await this.input.journal.save(progress, token);
    return {
      health,
      more_work: progress.next_alarm_at !== null,
      next_alarm_at: progress.next_alarm_at,
      provider_calls: 32 - budget.calls_left
    };
  }

  private async resumePendingHumanSlice(
    checkpoint: { progress: Progress; token: string },
    budget: SliceBudget,
    health: ConvergenceHealth
  ): Promise<SliceResult | null> {
    if (!this.input.enableHuman) return null;
    const status = this.input.ledger.status();
    const target = checkpoint.progress.active ?? status.active ?? status.requested;
    if (!target) return null;
    const existing = Object.values(checkpoint.progress.obligations).find((obligation) =>
      obligation.layer === "human_handoff" && obligation.target.revision === target.revision
    );
    if (
      existing
      && (existing.state === "retry_wait" || existing.state === "exhausted")
      && existing.next_attempt_at !== null
      && Date.parse(existing.next_attempt_at) > this.input.now()
    ) {
      health.layers.human_handoff = {
        ...pendingLayer(target.revision, this.input.now(), existing.code ?? "human_retry_wait"),
        state: existing.state,
        failure_count: existing.failure_count,
        next_attempt_at: existing.next_attempt_at
      };
      health.converged = false;
      // A human retry protects only the human slice. Discovery, machine
      // repair, and durable alert delivery must still progress while it waits.
      return null;
    }
    const record = await this.input.repository.readCommitRecord(this.input.projectId, target.revision);
    if (!record) throw new Error(`canonical_commit_missing_for_human_retry:${target.revision}`);
    if (existing?.continuation === "verify") {
      const progress = checkpoint.progress;
      const verified = await this.verifyCompletedTarget(record, budget, health);
      if (verified) {
        progress.obligations[existing.id] = { ...existing, continuation: null };
        progress.active = null;
        progress.next_alarm_at = nextPendingWake(progress);
      } else {
        progress.active = { revision: record.new_revision, projection_version: CURRENT_PROJECTION_VERSION };
        progress.next_alarm_at = new Date(this.input.now()).toISOString();
      }
      health.converged = verified && isConverged(health);
      await this.persistDueIncidents(progress, health);
      await this.input.journal.save(progress, checkpoint.token);
      return {
        health,
        more_work: !verified || progress.next_alarm_at !== null,
        next_alarm_at: progress.next_alarm_at,
        provider_calls: 32 - budget.calls_left
      };
    }
    const moreWork = await this.runHumanWithRetry(record, checkpoint.progress, budget, health);
    health.converged = isConverged(health);
    await this.persistDueIncidents(checkpoint.progress, health);
    await this.input.journal.save(checkpoint.progress, checkpoint.token);
    return {
      health,
      more_work: moreWork,
      next_alarm_at: checkpoint.progress.next_alarm_at,
      provider_calls: 32 - budget.calls_left
    };
  }

  private async runHumanWithRetry(
    record: import("../domain/commit-record").CanonicalCommitRecord,
    progress: Progress,
    budget: SliceBudget,
    health: ConvergenceHealth
  ): Promise<boolean> {
    const layer = "human_handoff" as const;
    const obligationId = await sha256Canonical({
      project_id: this.input.projectId,
      layer,
      revision: record.new_revision
    });
    const existing = progress.obligations[obligationId];
    const attemptNumber = (existing?.last_attempt_number ?? 0) + 1;
    const reservation = await this.reserveAttempt({
      schema_version: "1.0",
      project_id: this.input.projectId,
      obligation_id: obligationId,
      layer,
      from_revision: record.previous_revision,
      target: { revision: record.new_revision, projection_version: 3 },
      attempt_number: attemptNumber,
      incident: existing?.incident ?? 1,
      incarnation: progress.incarnation,
      reserved_at: new Date(this.input.now()).toISOString(),
      lease_until: new Date(this.input.now() + 10_000).toISOString()
    });
    const reservedAt = reservation.reserved_at;
    try {
      const human = await runHumanSlice({
        record,
        repository: this.input.repository,
        runtime: this.input.runtime,
        ledger: this.input.ledger,
        budget: reserveCheckpointForJournal(budget),
        now: () => new Date(this.input.now()).toISOString()
      });
      for (const currentLayerName of ["human_state", "human_handoff", "generation", "head"] as const) {
        health.layers[currentLayerName] = human.complete
          ? currentLayer(record.new_revision, this.input.now())
          : pendingLayer(record.new_revision, this.input.now(), "human_slice_pending");
      }
      progress.obligations[obligationId] = {
        id: obligationId,
        layer,
        from_revision: record.previous_revision,
        target: { revision: record.new_revision, projection_version: 3 },
        incident: existing?.incident ?? 1,
        state: human.complete ? "verified" : "pending",
        first_pending_at: existing?.first_pending_at ?? reservedAt,
        next_attempt_at: null,
        failure_count: existing?.failure_count ?? 0,
        last_attempt_number: attemptNumber,
        last_closed_attempt_number: attemptNumber,
        last_verified_at: human.complete ? reservedAt : null,
        code: human.complete ? null : "human_slice_pending",
        lease_until: null,
        continuation: human.complete ? "verify" : null
      };
      progress.active = { revision: record.new_revision, projection_version: CURRENT_PROJECTION_VERSION };
      progress.next_alarm_at = human.complete
        ? new Date(this.input.now()).toISOString()
        : new Date(this.input.now()).toISOString();
      return human.complete || human.more_work;
    } catch {
      const failureCount = (existing?.failure_count ?? 0) + 1;
      const retry = nextRetryAt({
        nowMs: this.input.now(),
        failureCount,
        jitter: await deterministicRetryJitter(obligationId, attemptNumber),
        retryAfterMs: 0
      });
      progress.obligations[obligationId] = {
        id: obligationId,
        layer,
        from_revision: record.previous_revision,
        target: { revision: record.new_revision, projection_version: 3 },
        incident: existing?.incident ?? 1,
        state: retry.state,
        first_pending_at: existing?.first_pending_at ?? reservedAt,
        next_attempt_at: retry.at,
        failure_count: failureCount,
        last_attempt_number: attemptNumber,
        last_closed_attempt_number: attemptNumber,
        last_verified_at: null,
        code: "human_write_failed",
        lease_until: null,
        continuation: null
      };
      progress.active = { revision: record.new_revision, projection_version: 3 };
      progress.next_alarm_at = minimumWake([nextPendingWake(progress), retry.at]);
      for (const pendingLayerName of ["human_state", "human_handoff", "generation", "head"] as const) {
        health.layers[pendingLayerName] = {
          ...pendingLayer(record.new_revision, this.input.now(), "human_write_failed"),
          state: retry.state,
          failure_count: failureCount,
          next_attempt_at: retry.at
        };
      }
      return true;
    }
  }

  private async persistDueIncidents(progress: Progress, health: ConvergenceHealth): Promise<void> {
    const alerts = await dueAlerts(
      progress,
      health,
      this.input.now(),
      this.input.deploymentSha ?? "unknown"
    );
    for (const alert of alerts) {
      const persisted = await this.input.journal.readIncident(alert.incident_id);
      const durableAlert = persisted ?? alert;
      if (!persisted) await this.input.journal.recordIncident(durableAlert);
      const previous = progress.alerts[durableAlert.incident_id] ?? {
        incident: durableAlert.incident,
        layers: durableAlert.layers,
        created_at: durableAlert.created_at,
        notification_pending: true,
        delivered_at: null,
        resolved_at: null,
        next_attempt_at: null,
        failure_count: 0
      };
      progress.alerts[durableAlert.incident_id] = await dispatchAlertDelivery({
        alert: durableAlert,
        previous,
        journal: this.input.journal,
        port: this.input.notification,
        nowMs: this.input.now()
      });
    }
    for (const alert of Object.values(progress.alerts)) {
      if (alert.resolved_at !== null) continue;
      const linked = Object.values(progress.obligations).filter((obligation) =>
        obligation.incident === alert.incident && alert.layers.includes(obligation.layer)
      );
      if (linked.length > 0 && linked.every((obligation) => obligation.state === "verified")) {
        alert.resolved_at = new Date(this.input.now()).toISOString();
      }
    }
    progress.next_alarm_at = minimumWake([
      progress.next_alarm_at,
      ...Object.values(progress.alerts)
        .filter((alert) => alert.notification_pending && alert.resolved_at === null)
        .map((alert) => alert.next_attempt_at)
    ]);
  }

  private async verifyCompletedTarget(
    record: import("../domain/commit-record").CanonicalCommitRecord,
    budget: SliceBudget,
    health: ConvergenceHealth
  ): Promise<boolean> {
    // Four stable derivative observations, generation/head reads, and the
    // critical pair verification all fit inside a fresh bounded slice.
    if (!budget.canStartEffect(16)) {
      markHumanLayersPending(health, record.new_revision, this.input.now(), "verification_budget_pending");
      return false;
    }
    health.layers.canonical = currentLayer(record.new_revision, this.input.now());
    for (const layer of ["event", "receipt", "state", "manifest"] as const) {
      health.layers[layer] = await observeDerivative(layer, record, this.input.runtime, this.input.repository);
    }
    const head = await this.input.repository.readMaterializationHead(this.input.projectId);
    const generation = head
      && head.target_revision === record.new_revision
      && head.projection_version === CURRENT_PROJECTION_VERSION
      ? await this.input.repository.readMaterializationRecord(
          this.input.projectId,
          head.target_revision,
          head.projection_version
        )
      : null;
    if (!head || !generation || generation.result_root_hash !== head.result_root_hash) {
      markHumanLayersPending(health, record.new_revision, this.input.now(), "generation_or_head_not_current");
      return false;
    }
    const fullPlan = await planProjection(record, null, CURRENT_PROJECTION_VERSION);
    const criticalPlan: ProjectionPlan = {
      ...fullPlan,
      changed_outputs: new Map([...fullPlan.changed_outputs].filter(([, output]) => output.critical)),
      removed_outputs: [],
      removed_output_evidence: undefined
    };
    const root = head.workspace_location === "archive"
      ? archiveProjectRoot(record.state.project_id, record.state.slug)
      : workspaceProjectRoot(record.state.project_id, record.state.slug);
    try {
      await new WorkspaceProjectionWriter(this.input.runtime, 1).verifyCritical(criticalPlan, root);
    } catch {
      markHumanLayersPending(health, record.new_revision, this.input.now(), "critical_pair_not_current");
      return false;
    }
    for (const layer of ["human_state", "human_handoff", "generation", "head"] as const) {
      health.layers[layer] = currentLayer(record.new_revision, this.input.now());
    }
    health.layers.scheduler = currentLayer(record.new_revision, this.input.now());
    return machineLayersCurrent(health);
  }

  private async reserveAttempt(candidate: AttemptReservation): Promise<AttemptReservation> {
    const existing = await this.input.journal.readAttempt(candidate.obligation_id, candidate.attempt_number);
    if (existing) {
      if (
        existing.project_id !== candidate.project_id
        || existing.layer !== candidate.layer
        || existing.from_revision !== candidate.from_revision
        || existing.target.revision !== candidate.target.revision
        || existing.target.projection_version !== candidate.target.projection_version
        || existing.incident !== candidate.incident
        || existing.incarnation !== candidate.incarnation
      ) throw new Error("journal_attempt_binding_conflict");
      return existing;
    }
    await this.input.journal.reserve(candidate);
    return candidate;
  }

  /**
   * A reservation is immutable proof that an effect may have crossed the
   * provider boundary. If its progress checkpoint was lost, never issue the
   * same logical retry again until the reservation has been turned into a
   * durable retry state.
   */
  private async uncheckpointedAttempt(input: {
    obligationId: string;
    layer: "event" | "receipt" | "state" | "manifest";
    record: import("../domain/commit-record").CanonicalCommitRecord;
    existing: Obligation | undefined;
  }): Promise<AttemptReservation | null> {
    const attemptNumber = (input.existing?.last_attempt_number ?? 0) + 1;
    const reservation = await this.input.journal.readAttempt(input.obligationId, attemptNumber);
    if (!reservation) return null;
    if (
      reservation.project_id !== this.input.projectId
      || reservation.layer !== input.layer
      || reservation.from_revision !== input.record.previous_revision
      || reservation.target.revision !== input.record.new_revision
      || reservation.target.projection_version !== CURRENT_PROJECTION_VERSION
      || reservation.incident !== (input.existing?.incident ?? 1)
    ) throw new Error("journal_attempt_binding_conflict");
    return reservation;
  }
}

function convergenceMetricTotals(progress: Progress): {
  verified: number;
  failureCount: number;
  exhausted: number;
  conflicts: number;
  handoffFailures: number;
  conditionalWriteConflicts: number;
} {
  return Object.values(progress.obligations).reduce((totals, obligation) => {
    const code = obligation.code ?? "";
    return {
      verified: totals.verified + (obligation.state === "verified" ? 1 : 0),
      failureCount: totals.failureCount + obligation.failure_count,
      exhausted: totals.exhausted + (obligation.state === "exhausted" ? 1 : 0),
      conflicts: totals.conflicts + (code.includes("conflict") ? 1 : 0),
      handoffFailures: totals.handoffFailures + (obligation.layer === "human_handoff" ? obligation.failure_count : 0),
      conditionalWriteConflicts: totals.conditionalWriteConflicts
        + (code.includes("conditional") && code.includes("conflict") ? 1 : 0)
    };
  }, {
    verified: 0,
    failureCount: 0,
    exhausted: 0,
    conflicts: 0,
    handoffFailures: 0,
    conditionalWriteConflicts: 0
  });
}

function isMachineLayer(layer: Layer): layer is "event" | "receipt" | "state" | "manifest" {
  return layer === "event" || layer === "receipt" || layer === "state" || layer === "manifest";
}

function nextPendingWake(progress: Progress): string | null {
  return minimumWake(Object.values(progress.obligations)
    .filter((obligation) => obligation.state !== "verified" && obligation.next_attempt_at !== null)
    .map((obligation) => obligation.next_attempt_at));
}

function machineLayersCurrent(health: ConvergenceHealth): boolean {
  return (["event", "receipt", "state", "manifest"] as const)
    .every((layer) => health.layers[layer].state === "current");
}

function currentLayer(revision: number, nowMs: number): ConvergenceHealth["layers"][Layer] {
  const evidence = { revision, identity: null, hash: null, projection_version: 3, root_hash: null };
  return {
    state: "current", applicable: true, expected: evidence, observed: evidence,
    last_verified_at: new Date(nowMs).toISOString(), first_pending_at: null,
    next_attempt_at: null, failure_count: 0, code: null, verified_through: revision,
    missing_count: 0, first_missing_id: null, observation_complete: true
  };
}

function pendingLayer(revision: number, nowMs: number, code: string): ConvergenceHealth["layers"][Layer] {
  const evidence = { revision, identity: null, hash: null, projection_version: 3, root_hash: null };
  return {
    state: "pending", applicable: true, expected: evidence,
    observed: { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
    last_verified_at: null, first_pending_at: new Date(nowMs).toISOString(),
    next_attempt_at: null, failure_count: 0, code, verified_through: null,
    missing_count: 1, first_missing_id: null, observation_complete: true
  };
}

function pendingMachineObligation(input: {
  obligationId: string;
  layer: "event" | "receipt" | "state" | "manifest";
  record: import("../domain/commit-record").CanonicalCommitRecord;
  existing: Obligation | undefined;
  nextAttemptAt: string;
  code: string;
}): Obligation {
  return {
    id: input.obligationId,
    layer: input.layer,
    from_revision: input.record.previous_revision,
    target: { revision: input.record.new_revision, projection_version: CURRENT_PROJECTION_VERSION },
    incident: input.existing?.incident ?? 1,
    state: "pending",
    first_pending_at: input.existing?.first_pending_at ?? input.nextAttemptAt,
    next_attempt_at: input.nextAttemptAt,
    failure_count: input.existing?.failure_count ?? 0,
    last_attempt_number: input.existing?.last_attempt_number ?? 0,
    last_closed_attempt_number: input.existing?.last_closed_attempt_number ?? 0,
    last_verified_at: null,
    code: input.code,
    lease_until: null,
    continuation: null
  };
}

async function retryFromUncheckpointedAttempt(input: {
  existing: Obligation | undefined;
  reservation: AttemptReservation;
  nowMs: number;
}): Promise<Obligation> {
  const failureCount = (input.existing?.failure_count ?? 0) + 1;
  const retry = nextRetryAt({
    nowMs: Date.parse(input.reservation.reserved_at),
    failureCount,
    jitter: await deterministicRetryJitter(input.reservation.obligation_id, input.reservation.attempt_number),
    retryAfterMs: 0
  });
  const nextAttemptAt = new Date(Math.max(
    Date.parse(retry.at),
    Date.parse(input.reservation.lease_until),
    input.nowMs
  )).toISOString();
  return {
    id: input.reservation.obligation_id,
    layer: input.reservation.layer,
    from_revision: input.reservation.from_revision,
    target: input.reservation.target,
    incident: input.reservation.incident,
    state: retry.state,
    first_pending_at: input.existing?.first_pending_at ?? input.reservation.reserved_at,
    next_attempt_at: nextAttemptAt,
    failure_count: failureCount,
    last_attempt_number: input.reservation.attempt_number,
    last_closed_attempt_number: input.reservation.attempt_number,
    last_verified_at: null,
    code: "attempt_outcome_uncertain",
    lease_until: null,
    continuation: null
  };
}

function markHumanLayersNotApplicable(health: ConvergenceHealth): void {
  for (const layer of ["human_state", "human_handoff", "generation", "head"] as const) {
    health.layers[layer] = { ...health.layers[layer], applicable: false };
  }
}

function markHumanLayersPending(health: ConvergenceHealth, revision: number, nowMs: number, code: string): void {
  for (const layer of ["human_state", "human_handoff", "generation", "head"] as const) {
    health.layers[layer] = pendingLayer(revision, nowMs, code);
  }
}

/** A convergence slice must retain one physical call for its external journal checkpoint. */
function reserveCheckpointForJournal(budget: SliceBudget): SliceBudget {
  return {
    ...budget,
    canStartEffect(requiredCalls: number) {
      return budget.canStartEffect(requiredCalls + 1);
    }
  };
}
