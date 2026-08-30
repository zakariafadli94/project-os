import { z } from "zod";

export const REFERRAL_TYPE_VALUES = [
  "anomaly",
  "dependency",
  "research",
  "information",
  "decision_request",
  "improvement_request",
  "deliverable_reference"
] as const;

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const referralIdSchema = z.string().regex(/^REF-[A-Z0-9-]{8,}$/);
const timestampSchema = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1);

const referralFields = {
  schema_version: z.literal("1.0"),
  referral_id: referralIdSchema,
  source_project_id: projectIdSchema,
  target_project_id: projectIdSchema,
  referral_type: z.enum(REFERRAL_TYPE_VALUES),
  title: nonEmpty,
  created_at: timestampSchema,
  source_refs: z.array(nonEmpty).default([]),
  body: nonEmpty
};

const referralWriteRequestSchema = z.strictObject(referralFields).superRefine((value, ctx) => {
  if (value.source_project_id === value.target_project_id) {
    ctx.addIssue({
      code: "custom",
      message: "Referral source and target projects must be different"
    });
  }
});

const referralEnvelopeSchema = z.strictObject({
  ...referralFields,
  canonical: z.literal(false)
}).superRefine((value, ctx) => {
  if (value.source_project_id === value.target_project_id) {
    ctx.addIssue({
      code: "custom",
      message: "Referral source and target projects must be different"
    });
  }
});

export type ReferralType = z.infer<typeof referralWriteRequestSchema>["referral_type"];
export type ReferralWriteRequest = z.infer<typeof referralWriteRequestSchema>;
export type ReferralEnvelope = z.infer<typeof referralEnvelopeSchema>;

export interface ReferralTransportReceipt {
  schema_version: "1.0";
  referral_id: string;
  status: "delivered" | "rejected";
  source_project_id: string;
  target_project_id: string;
  input_path?: string;
  delivered_at?: string;
  code?: string;
  message?: string;
}

export function parseReferralWriteRequest(input: unknown): ReferralWriteRequest {
  return referralWriteRequestSchema.parse(input);
}

export function parseReferralEnvelope(input: unknown): ReferralEnvelope {
  return referralEnvelopeSchema.parse(input);
}
