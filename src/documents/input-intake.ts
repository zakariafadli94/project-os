export type InputIntakePhase =
  | "DETECTED"
  | "SNAPSHOTTED"
  | "REFERENCE_COMMITTED"
  | "SOURCE_REMOVED"
  | "COMPLETE"
  | "DUPLICATE_CLEANED"
  | "WITHDRAWN"
  | "CONFLICT";

export interface InputIntakeRecord {
  schema_version: "1.0";
  intake_id: string;
  project_id: string;
  phase: InputIntakePhase;
  source: {
    provider_id: string;
    object_id: string;
    revision_token: string;
    integrity_hash: { algorithm: string; value: string };
    size: number;
    provider_path: string;
    relative_input_path: string;
  };
  detected_at: string;
  updated_at: string;
}

export async function inputIntakeIdFor(_input: {
  projectId: string;
  providerId: string;
  objectId: string;
  revisionToken: string;
}): Promise<string> {
  throw new Error("input intake id not implemented");
}

export function parseInputIntakeRecord(_input: unknown): InputIntakeRecord {
  throw new Error("input intake record parsing not implemented");
}

export function nextInputIntakeRecord(
  _record: InputIntakeRecord,
  _phase: InputIntakePhase,
  _updatedAt: string
): InputIntakeRecord {
  throw new Error("input intake transition not implemented");
}
