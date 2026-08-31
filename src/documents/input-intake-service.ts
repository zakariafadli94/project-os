import type { ProjectState } from "../domain/project-state";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";

export interface InputIntakeServiceOptions {
  now?: () => string;
}

export interface InputIntakeRequest {
  sourcePath: string;
  relativeInputPath: string;
  metadata: ProviderObjectMetadata;
}

export interface InputIntakeResult {
  status: "completed" | "duplicate_cleaned" | "withdrawn" | "conflict";
  intake_id: string;
  resumed: boolean;
  document_id?: string;
  version_id?: string;
}

export class InputIntakeService {
  constructor(
    private readonly _runtime: ProjectOsPersistenceRuntime,
    private readonly _options: InputIntakeServiceOptions = {}
  ) {}

  async ingest(_state: ProjectState, _request: InputIntakeRequest): Promise<InputIntakeResult> {
    throw new Error("input intake service not implemented");
  }
}
