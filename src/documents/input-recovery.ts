import type { ProjectState } from "../domain/project-state";
import { workspaceManagedZoneRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderEntry } from "../persistence/provider/contract";
import { InputIntakeService, type InputIntakeResult } from "./input-intake-service";

export interface InputRecoveryServiceOptions {
  now?: () => string;
}

export interface InputRecoverySummary {
  scanned: number;
  completed: number;
  duplicate_cleaned: number;
  conflicts: number;
  withdrawn: number;
  failed: number;
}

interface DiscoveredInput {
  path: string;
  relativePath: string;
}

export class InputRecoveryService {
  private readonly intake: InputIntakeService;

  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    options: InputRecoveryServiceOptions = {}
  ) {
    this.intake = new InputIntakeService(runtime, options);
  }

  async recover(state: ProjectState): Promise<InputRecoverySummary> {
    const summary = emptySummary();
    if (state.status === "archived") return summary;

    const root = workspaceManagedZoneRoot(state.project_id, state.slug, "inputs");
    const inputs = await this.discover(root, "");
    summary.scanned = inputs.length;

    for (const input of inputs) {
      try {
        const metadata = await this.runtime.objects.getMetadata(input.path);
        if (!metadata) {
          summary.withdrawn += 1;
          continue;
        }
        applyResult(summary, await this.intake.ingest(state, {
          sourcePath: input.path,
          relativeInputPath: input.relativePath,
          metadata
        }));
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS explicit INPUTS recovery file failed", {
          project_id: state.project_id,
          path: input.path,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return summary;
  }

  private async discover(path: string, relativePrefix: string): Promise<DiscoveredInput[]> {
    const entries = await this.runtime.objects.listChildren(path);
    const discovered: DiscoveredInput[] = [];
    for (const entry of entries) {
      if (entry.kind === "deleted") continue;
      const childPath = providerPathFor(path, entry);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.kind === "folder") {
        discovered.push(...await this.discover(childPath, relativePath));
      } else if (entry.kind === "file") {
        discovered.push({ path: childPath, relativePath });
      }
    }
    return discovered;
  }
}

function providerPathFor(parent: string, entry: ProviderEntry): string {
  const path = entry.path ?? `${parent}/${entry.name}`;
  const expectedPrefix = `${parent}/`;
  if (!path.startsWith(expectedPrefix) || path.includes("//") || path.includes("\\")) {
    throw new Error(`Unsafe provider recovery path: ${path}`);
  }
  return path;
}

function applyResult(summary: InputRecoverySummary, result: InputIntakeResult): void {
  if (result.status === "completed") summary.completed += 1;
  else if (result.status === "duplicate_cleaned") summary.duplicate_cleaned += 1;
  else if (result.status === "conflict") summary.conflicts += 1;
  else summary.withdrawn += 1;
}

function emptySummary(): InputRecoverySummary {
  return {
    scanned: 0,
    completed: 0,
    duplicate_cleaned: 0,
    conflicts: 0,
    withdrawn: 0,
    failed: 0
  };
}
