import type { ProjectGovernanceProfile } from "../domain/project-governance";
import { machineProjectGovernanceProfilePath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import { parseProjectGovernanceProfile } from "../schema/project-governance";

export class GovernanceRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
  }

  async readProjectProfile(projectId: string): Promise<ProjectGovernanceProfile | null> {
    const raw = await this.runtime.objects.readText(machineProjectGovernanceProfilePath(projectId));
    if (raw === null) return null;
    const profile = parseProjectGovernanceProfile(JSON.parse(raw));
    if (profile.project_id !== projectId) {
      throw new Error(`Project governance profile binding mismatch: expected ${projectId}, got ${profile.project_id}`);
    }
    return profile;
  }

  async writeProjectProfile(profileInput: ProjectGovernanceProfile): Promise<void> {
    const profile = parseProjectGovernanceProfile(profileInput);
    const path = machineProjectGovernanceProfilePath(profile.project_id);
    const content = pretty(profile);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existingRaw = await this.runtime.objects.readText(path);
      if (existingRaw === null) throw error;
      const existing = parseProjectGovernanceProfile(JSON.parse(existingRaw));
      if (pretty(existing) !== content) {
        throw new Error(`Immutable project governance profile conflict with different content: ${path}`);
      }
    }
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
