import type { ProjectState } from "../domain/project-state";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { IntakeService } from "./intake-service";
import {
  ManagedDocumentReconciler as BaseManagedDocumentReconciler,
  type ManagedDocumentReconcileSummary
} from "./reconciler";

export class ManagedDocumentReconciler {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly base: BaseManagedDocumentReconciler;
  private readonly intake: IntakeService;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.base = new BaseManagedDocumentReconciler(this.runtime);
    this.intake = new IntakeService(this.runtime);
  }

  async reconcileChanges(
    state: ProjectState,
    changes: ProviderChangeEntry[]
  ): Promise<ManagedDocumentReconcileSummary> {
    if (state.status === "archived") {
      return {
        scanned: changes.length,
        ignored: changes.length,
        captured: 0,
        ingested: 0,
        duplicates: 0,
        restored: 0,
        conflicts: 0
      };
    }

    const remaining: ProviderChangeEntry[] = [];
    let ingested = 0;
    let duplicates = 0;
    let ignored = 0;
    let conflicts = 0;

    for (const change of changes) {
      const logicalPath = inputLogicalPath(state, change);
      if (logicalPath === null || change.kind !== "file") {
        remaining.push(change);
        continue;
      }
      const metadata = await this.metadataFor(change);
      if (!metadata) {
        ignored += 1;
        continue;
      }
      const result = await this.intake.process(state, {
        logicalPath,
        inputPath: change.path,
        metadata,
        detectedAt: metadata.modifiedAt ?? new Date().toISOString()
      });
      if (result === "ingested") ingested += 1;
      else if (result === "duplicate") duplicates += 1;
      else if (result === "failed") conflicts += 1;
      else ignored += 1;
    }

    const baseSummary = await this.base.reconcileChanges(state, remaining);
    return {
      scanned: changes.length,
      ignored: baseSummary.ignored + ignored,
      captured: baseSummary.captured,
      ingested: baseSummary.ingested + ingested,
      duplicates: baseSummary.duplicates + duplicates,
      restored: baseSummary.restored,
      conflicts: baseSummary.conflicts + conflicts
    };
  }

  private async metadataFor(change: ProviderChangeEntry): Promise<ProviderObjectMetadata | null> {
    if (change.metadata) return change.metadata;
    return this.runtime.objects.getMetadata(change.path);
  }
}

function inputLogicalPath(state: ProjectState, change: ProviderChangeEntry): string | null {
  const prefix = `${workspaceProjectRoot(state.project_id, state.slug)}/INPUTS/`;
  if (!change.path.startsWith(prefix) || change.path.length <= prefix.length) return null;
  return change.path.slice(prefix.length);
}
