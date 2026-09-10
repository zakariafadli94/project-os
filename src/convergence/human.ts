import type { CanonicalCommitRecord } from "../domain/commit-record";
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import {
  MaterializationCoordinator,
  type MaterializationLedgerPort
} from "../materialization/coordinator";
import { WorkspaceProjectionWriter } from "../materialization/writer";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProjectRepository } from "../persistence/repository";
import type { SliceBudget } from "./contract";

export interface HumanSliceInput {
  record: CanonicalCommitRecord;
  repository: ProjectRepository;
  runtime: ProjectOsPersistenceRuntime;
  ledger: MaterializationLedgerPort;
  budget?: SliceBudget;
  now?: () => string;
}

/**
 * Human projections share the convergence target with machine derivatives,
 * but retain the existing generation/head fencing in MaterializationCoordinator.
 */
export async function runHumanSlice(input: HumanSliceInput): Promise<{ complete: boolean; more_work: boolean }> {
  try {
    const coordinator = new MaterializationCoordinator({
      projectId: input.record.project_id,
      repository: input.repository,
      ledger: input.ledger,
      writer: new WorkspaceProjectionWriter(input.runtime, 1),
      projectionVersion: CURRENT_PROJECTION_VERSION,
      canonicalDerivativesAlreadyCurrent: true,
      ...(input.now ? { now: input.now } : {}),
      ...(input.budget ? { sliceBudget: input.budget } : {})
    });
    const active = coordinator.status().active;
    if (
      !active
      || active.revision !== input.record.new_revision
      || active.projection_version !== CURRENT_PROJECTION_VERSION
    ) {
      await coordinator.reconcile(input.record.new_revision);
    }
    coordinator.requestTarget(input.record.new_revision, CURRENT_PROJECTION_VERSION);
    const result = await coordinator.runNext();
    return { complete: result.completed, more_work: result.more_work };
  } catch (error) {
    if (input.budget && isSliceBudgetExhaustion(error)) return { complete: false, more_work: true };
    throw error;
  }
}

function isSliceBudgetExhaustion(error: unknown): boolean {
  return error instanceof Error && error.message.includes("slice_budget_exhausted");
}
