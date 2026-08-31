import { z } from "zod";

const requestId = z.string().regex(/^REF-[A-Z0-9-]{10,}$/);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1);
const relativePath = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}, "relative_path must be a safe relative referral path");

export const referralWriteRequestSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  request_id: requestId,
  source_project_id: projectId,
  target_project_id: projectId,
  relative_path: relativePath,
  content: z.string(),
  content_sha256: hash,
  created_at: timestamp,
  referral_type: nonEmpty.optional(),
  topic: nonEmpty.optional()
}).refine(
  (value) => value.source_project_id !== value.target_project_id,
  { message: "Referral source and target projects must differ", path: ["target_project_id"] }
);

export type ReferralWriteRequest = z.infer<typeof referralWriteRequestSchema>;

export interface ReferralWriteReceipt {
  request_id: string;
  source_project_id: string;
  target_project_id: string;
  relative_path: string;
  content_sha256: string;
  status: "committed" | "conflict" | "rejected";
  code?: string;
  message?: string;
}

export function parseReferralWriteRequest(input: unknown): ReferralWriteRequest {
  return referralWriteRequestSchema.parse(input);
}
