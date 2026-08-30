import { z } from "zod";
import {
  PROJECT_KIND_VALUES,
  type ProjectGovernanceProfile
} from "../domain/project-governance";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const authorizationIdSchema = z.string().regex(/^PCAUTH-[A-Z0-9-]{12,}$/);
const improvementPackageIdSchema = z.string().regex(/^IMP-[A-Z0-9-]{4,}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const projectGovernanceProfileSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  project_kind: z.enum(PROJECT_KIND_VALUES),
  authorization_id: authorizationIdSchema,
  parent_project_id: projectIdSchema.optional(),
  improvement_package_id: improvementPackageIdSchema.optional(),
  created_at: timestampSchema
}).superRefine((value, ctx) => {
  if (
    (value.project_kind === "synthetic_probe" || value.project_kind === "synthetic_stress_test")
    && !value.parent_project_id
    && !value.improvement_package_id
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Synthetic project governance requires a parent project or improvement package"
    });
  }
});

export function parseProjectGovernanceProfile(input: unknown): ProjectGovernanceProfile {
  return projectGovernanceProfileSchema.parse(input);
}
