import type { ProjectState } from "../domain/project-state";
import { workspaceManagedZoneRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderEntry } from "../persistence/provider/contract";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import { IntakeService } from "./intake-service";

export interface IntakeSweepSummary {
  archived: boolean;
  files_scanned: number;
  ingested: number;
  duplicates: number;
  failed: number;
}

export class IntakeSweep {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly intake: IntakeService;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.intake = new IntakeService(this.runtime);
  }

  async sweep(state: ProjectState, observedAt: string): Promise<IntakeSweepSummary> {
    const summary: IntakeSweepSummary = {
      archived: state.status === "archived",
      files_scanned: 0,
      ingested: 0,
      duplicates: 0,
      failed: 0
    };
    if (summary.archived) return summary;

    const root = workspaceManagedZoneRoot(state.project_id, state.slug, "inputs");
    await this.walk(state, root, root, observedAt, summary);
    return summary;
  }

  private async walk(
    state: ProjectState,
    root: string,
    directory: string,
    observedAt: string,
    summary: IntakeSweepSummary
  ): Promise<void> {
    const entries = [...await this.runtime.objects.listChildren(directory)]
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const path = this.safeChildPath(root, directory, entry);
      if (entry.kind === "folder") {
        await this.walk(state, root, path, observedAt, summary);
        continue;
      }
      if (entry.kind !== "file") continue;

      const metadata = await this.runtime.objects.getMetadata(path);
      if (!metadata) continue;
      summary.files_scanned += 1;
      const logicalPath = path.slice(root.length + 1);

      try {
        const result = await this.intake.process(state, {
          logicalPath,
          inputPath: path,
          metadata,
          detectedAt: observedAt
        });
        if (result === "ingested") summary.ingested += 1;
        else if (result === "duplicate") summary.duplicates += 1;
        else if (result === "failed") summary.failed += 1;
      } catch {
        summary.failed += 1;
      }
    }
  }

  private safeChildPath(root: string, directory: string, entry: ProviderEntry): string {
    const path = entry.path ?? `${directory}/${entry.name}`;
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new Error(`INPUT sweep provider path escaped project INPUTS root: ${path}`);
    }
    return path;
  }
}
