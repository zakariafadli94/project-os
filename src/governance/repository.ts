import type {
  ProjectCreateAuthorizationConsumption,
  ProjectCreateAuthorizationReceipt,
  ProjectCreateAuthorizationRecord,
  ProjectGovernanceProfile
} from "../domain/project-governance";
import {
  machineProjectCreateAuthorizationConsumptionPath,
  machineProjectCreateAuthorizationIssuedPath,
  machineProjectCreateAuthorizationReceiptPath,
  machineProjectGovernanceProfilePath
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import {
  parseProjectCreateAuthorizationConsumption,
  parseProjectCreateAuthorizationReceipt,
  parseProjectCreateAuthorizationRecord,
  parseProjectGovernanceProfile
} from "../schema/project-governance";

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
    await this.writeImmutable(
      machineProjectGovernanceProfilePath(profile.project_id),
      pretty(profile),
      (raw) => pretty(parseProjectGovernanceProfile(JSON.parse(raw))),
      "project governance profile"
    );
  }

  async readProjectCreateAuthorization(authorizationId: string): Promise<ProjectCreateAuthorizationRecord | null> {
    const raw = await this.runtime.objects.readText(machineProjectCreateAuthorizationIssuedPath(authorizationId));
    if (raw === null) return null;
    const record = parseProjectCreateAuthorizationRecord(JSON.parse(raw));
    if (record.authorization_id !== authorizationId) {
      throw new Error(`Project-create authorization binding mismatch: expected ${authorizationId}, got ${record.authorization_id}`);
    }
    return record;
  }

  async writeProjectCreateAuthorization(input: ProjectCreateAuthorizationRecord): Promise<void> {
    const record = parseProjectCreateAuthorizationRecord(input);
    await this.writeImmutable(
      machineProjectCreateAuthorizationIssuedPath(record.authorization_id),
      pretty(record),
      (raw) => pretty(parseProjectCreateAuthorizationRecord(JSON.parse(raw))),
      "project-create authorization"
    );
  }

  async readProjectCreateAuthorizationConsumption(
    authorizationId: string
  ): Promise<ProjectCreateAuthorizationConsumption | null> {
    const raw = await this.runtime.objects.readText(machineProjectCreateAuthorizationConsumptionPath(authorizationId));
    if (raw === null) return null;
    const record = parseProjectCreateAuthorizationConsumption(JSON.parse(raw));
    if (record.authorization_id !== authorizationId) {
      throw new Error(`Project-create authorization consumption binding mismatch: expected ${authorizationId}, got ${record.authorization_id}`);
    }
    return record;
  }

  async writeProjectCreateAuthorizationConsumption(input: ProjectCreateAuthorizationConsumption): Promise<void> {
    const record = parseProjectCreateAuthorizationConsumption(input);
    await this.writeImmutable(
      machineProjectCreateAuthorizationConsumptionPath(record.authorization_id),
      pretty(record),
      (raw) => pretty(parseProjectCreateAuthorizationConsumption(JSON.parse(raw))),
      "project-create authorization consumption"
    );
  }

  async readProjectCreateAuthorizationReceipt(authorizationId: string): Promise<ProjectCreateAuthorizationReceipt | null> {
    const raw = await this.runtime.objects.readText(machineProjectCreateAuthorizationReceiptPath(authorizationId));
    if (raw === null) return null;
    const receipt = parseProjectCreateAuthorizationReceipt(JSON.parse(raw));
    if (receipt.authorization_id !== authorizationId) {
      throw new Error(`Project-create authorization receipt binding mismatch: expected ${authorizationId}, got ${receipt.authorization_id}`);
    }
    return receipt;
  }

  async writeProjectCreateAuthorizationReceipt(input: ProjectCreateAuthorizationReceipt): Promise<void> {
    const receipt = parseProjectCreateAuthorizationReceipt(input);
    await this.writeImmutable(
      machineProjectCreateAuthorizationReceiptPath(receipt.authorization_id),
      pretty(receipt),
      (raw) => pretty(parseProjectCreateAuthorizationReceipt(JSON.parse(raw))),
      "project-create authorization receipt"
    );
  }

  private async writeImmutable(
    path: string,
    content: string,
    canonicalizeExisting: (raw: string) => string,
    label: string
  ): Promise<void> {
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existingRaw = await this.runtime.objects.readText(path);
      if (existingRaw === null) throw error;
      if (canonicalizeExisting(existingRaw) !== content) {
        throw new Error(`Immutable ${label} conflict with different content: ${path}`);
      }
    }
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
