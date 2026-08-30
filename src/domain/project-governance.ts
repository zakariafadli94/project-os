import { z } from "zod";

export const PROJECT_KIND_VALUES = [
  "real",
  "synthetic_probe",
  "synthetic_stress_test"
] as const;

const projectKindSchema = z.enum(PROJECT_KIND_VALUES);

export type ProjectKind = z.infer<typeof projectKindSchema>;
export type ProjectKindView = ProjectKind | "unknown_legacy";

export interface ProjectGovernanceProfile {
  schema_version: "1.0";
  project_id: string;
  project_kind: ProjectKind;
  authorization_id: string;
  parent_project_id?: string;
  improvement_package_id?: string;
  created_at: string;
}

export interface ProjectCreateAuthorizationRecord {
  schema_version: "1.0";
  authorization_id: string;
  name: string;
  slug: string;
  aliases: string[];
  objective: string;
  project_kind: ProjectKind;
  parent_project_id?: string;
  improvement_package_id?: string;
  issued_at: string;
  expires_at: string;
  consumed_at?: string;
  allocated_project_id?: string;
}

export interface ProjectCreateAuthorizationConsumption {
  schema_version: "1.0";
  authorization_id: string;
  transaction_id: string;
  allocated_project_id: string;
  consumed_at: string;
}

export interface ProjectCreateAuthorizationReceipt {
  schema_version: "1.0";
  authorization_id: string;
  status: "issued" | "rejected";
  issued_at?: string;
  expires_at?: string;
  code?: string;
  message?: string;
}

export function parseProjectKind(input: unknown): ProjectKind {
  return projectKindSchema.parse(input);
}
