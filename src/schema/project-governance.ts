import { z } from "zod";
import {
  PROJECT_KIND_VALUES,
  type ProjectCreateAuthorizationConsumption,
  type ProjectCreateAuthorizationReceipt,
  type ProjectCreateAuthorizationRecord,
  type ProjectGovernanceProfile
} from "../domain/project-governance";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const authorizationIdSchema = z.string().regex(/^PCAUTH-[A-Z0-9-]{12,}$/);
const transactionIdSchema = z.string().regex(/^TXN-[A-Z0-9-]{10,}$/);
const improvementPackageIdSchema = z.string().regex(/^IMP-[A-Z0-9-]{4,}$/);
const timestampSchema = z.string().datetime({ offset: true });
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonEmptySchema = z.string().trim().min(1);

export const projectGovernanceProfileSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  project_kind: z.enum(PROJECT_KIND_VALUES),
  authorization_id: authorizationIdSchema,
  parent_project_id: projectIdSchema.optional(),
  improvement_package_id: improvementPackageIdSchema.optional(),
  created_at: timestampSchema
}).superRefine(requireSyntheticBinding);

export const projectCreateAuthorizationRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  authorization_id: authorizationIdSchema,
  name: nonEmptySchema,
  slug: slugSchema,
  aliases: z.array(nonEmptySchema).default([]),
  objective: nonEmptySchema,
  project_kind: z.enum(PROJECT_KIND_VALUES),
  parent_project_id: projectIdSchema.optional(),
  improvement_package_id: improvementPackageIdSchema.optional(),
  issued_at: timestampSchema,
  expires_at: timestampSchema,
  consumed_at: timestampSchema.optional(),
  allocated_project_id: projectIdSchema.optional()
}).superRefine(requireSyntheticBinding);

export const projectCreateAuthorizationConsumptionSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  authorization_id: authorizationIdSchema,
  transaction_id: transactionIdSchema,
  allocated_project_id: projectIdSchema,
  consumed_at: timestampSchema
});

export const projectCreateAuthorizationReceiptSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  authorization_id: authorizationIdSchema,
  status: z.enum(["issued", "rejected"]),
  issued_at: timestampSchema.optional(),
  expires_at: timestampSchema.optional(),
  code: nonEmptySchema.optional(),
  message: nonEmptySchema.optional()
});

export function parseProjectGovernanceProfile(input: unknown): ProjectGovernanceProfile {
  return projectGovernanceProfileSchema.parse(input);
}

export function parseProjectCreateAuthorizationRecord(input: unknown): ProjectCreateAuthorizationRecord {
  return projectCreateAuthorizationRecordSchema.parse(input);
}

export function parseProjectCreateAuthorizationConsumption(input: unknown): ProjectCreateAuthorizationConsumption {
  return projectCreateAuthorizationConsumptionSchema.parse(input);
}

export function parseProjectCreateAuthorizationReceipt(input: unknown): ProjectCreateAuthorizationReceipt {
  return projectCreateAuthorizationReceiptSchema.parse(input);
}

function requireSyntheticBinding(
  value: { project_kind: string; parent_project_id?: string; improvement_package_id?: string },
  ctx: z.RefinementCtx
): void {
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
}
