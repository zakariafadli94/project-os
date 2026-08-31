import type { InputIntakePhase, InputIntakeRecord } from "./input-intake";
import type { ObjectPersistence } from "../persistence/provider/contract";

export interface InputIntakeSourceBinding {
  schema_version: "1.0";
  project_id: string;
  provider_id: string;
  source_path: string;
  intake_id: string;
  revision_token: string;
}

export class InputIntakeRepository {
  constructor(private readonly _objects: ObjectPersistence) {}

  async read(_projectId: string, _intakeId: string): Promise<InputIntakeRecord | null> {
    throw new Error("input intake repository read not implemented");
  }

  async create(_record: InputIntakeRecord): Promise<InputIntakeRecord> {
    throw new Error("input intake repository create not implemented");
  }

  async advance(
    _projectId: string,
    _intakeId: string,
    _phase: InputIntakePhase,
    _updatedAt: string
  ): Promise<InputIntakeRecord> {
    throw new Error("input intake repository advance not implemented");
  }

  async bindSourcePath(
    _record: InputIntakeRecord,
    _options: { expectedIntakeId?: string } = {}
  ): Promise<InputIntakeSourceBinding> {
    throw new Error("input intake source binding not implemented");
  }

  async readSourcePathBinding(
    _projectId: string,
    _providerId: string,
    _sourcePath: string
  ): Promise<InputIntakeSourceBinding | null> {
    throw new Error("input intake source binding read not implemented");
  }
}
