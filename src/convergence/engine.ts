import type { MaterializationLedger } from "../materialization/ledger";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProjectRepository } from "../persistence/repository";
import type { ConvergenceHealth, SliceBudget, SliceResult, Target } from "./contract";
import { repairDerivative } from "./derivatives";
import { discoverCanonical } from "./discovery";
import { FencedEffects } from "./fenced-effects";
import { unknownHealth } from "./health";
import { initialProgress, ConvergenceJournal } from "./journal";
import { minimumWake } from "./retry";
import { sha256Canonical } from "../materialization/hash";

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

  async observe(_budget: SliceBudget): Promise<ConvergenceHealth> {
    const progress = await this.input.journal.load();
    return unknownHealth(
      this.input.projectId,
      progress?.progress.first_observed_at ?? new Date(this.input.now()).toISOString()
    );
  }

  async runSlice(budget: SliceBudget): Promise<SliceResult> {
    const checkpoint = await this.ensureProgress();
    const discovered = await discoverCanonical(
      this.input.repository,
      this.input.runtime,
      checkpoint.progress,
      budget
    );
    const health = await this.observe(budget);
    if (!discovered?.record) {
      return { health, more_work: false, next_alarm_at: null, provider_calls: 32 - budget.calls_left };
    }

    const effects = new FencedEffects(this.input.runtime, this.input.journal, budget);
    let token = checkpoint.token;
    const progress = checkpoint.progress;
    progress.canonical_observed_revision = discovered.record.new_revision;
    for (const layer of ["event", "receipt", "state", "manifest"] as const) {
      const id = `${layer}:${discovered.record.new_revision}`;
      if (progress.effects[id]?.state !== "prepared") {
        token = await effects.prepare(progress, token, {
          id,
          path: "",
          destination: null,
          kind: "create",
          object_id: null,
          expected_token: null,
          desired_hash: null,
          authorized_previous_hash: null,
          state: "prepared",
          verified_token: null
        });
      }
      const reservation = {
        schema_version: "1.0" as const,
        project_id: this.input.projectId,
        obligation_id: await sha256Canonical({ project_id: this.input.projectId, layer, revision: discovered.record.new_revision }),
        layer,
        from_revision: discovered.record.previous_revision,
        target: { revision: discovered.record.new_revision, projection_version: 3 },
        attempt_number: 1,
        incident: 1,
        incarnation: progress.incarnation,
        reserved_at: new Date(this.input.now()).toISOString(),
        lease_until: new Date(this.input.now() + 10_000).toISOString()
      };
      await this.input.journal.reserve(reservation);
      health.layers[layer] = await repairDerivative(layer, discovered.record, progress, effects, this.input.repository);
    }
    await this.input.journal.save(progress, token);
    health.converged = false;
    return {
      health,
      more_work: !discovered.complete,
      next_alarm_at: null,
      provider_calls: 32 - budget.calls_left
    };
  }

  private async ensureProgress() {
    const existing = await this.input.journal.load();
    if (existing) return existing;
    const now = new Date(this.input.now()).toISOString();
    const progress = initialProgress(this.input.projectId, now, crypto.randomUUID());
    const token = await this.input.journal.save(progress, null);
    return { progress, token };
  }
}
