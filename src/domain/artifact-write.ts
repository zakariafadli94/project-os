import { z } from "zod";

const requestId = z.string().regex(/^ART-[A-Z0-9-]{10,}$/);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.includes("//")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}, "relative_path must be a safe relative artifact path");

const artifactBase = {
  request_id: requestId,
  project_id: projectId,
  relative_path: relativePath,
  content_sha256: hash,
  mode: z.enum(["create", "replace"])
} as const;

export const inlineArtifactWriteRequestSchema = z.strictObject({
  ...artifactBase,
  content: z.string()
});

const stagedSourceSchema = z.strictObject({
  kind: z.literal("staged_provider_object"),
  path: z.string().min(1),
  object_id: z.string().min(1),
  revision_token: z.string().min(1),
  size: z.number().int().nonnegative().safe(),
  integrity: z.strictObject({
    algorithm: z.string().min(1),
    value: z.string().min(1)
  })
});

export const stagedArtifactWriteRequestSchema = z.strictObject({
  ...artifactBase,
  source: stagedSourceSchema
}).superRefine((value, ctx) => {
  const prefix = `/PROJECT_OS/.project-os/artifacts/staging/${value.request_id}/`;
  const fileName = value.source.path.startsWith(prefix) ? value.source.path.slice(prefix.length) : "";
  if (!fileName || fileName.includes("/") || fileName.startsWith(".") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "path"],
      message: "source.path must be a safe file owned by the artifact request staging directory"
    });
  }
});

export const reviewCandidateRequestSchema = z.strictObject({
  ...artifactBase,
  operation: z.literal("REVIEW_CANDIDATE"),
  mode: z.literal("create"),
  base_revision: z.number().int().nonnegative().safe(),
  relative_path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  media_type: z.enum(["application/pdf", "image/png", "image/jpeg", "application/zip"]),
  source: stagedSourceSchema.extend({ provider_id: z.string().min(1) })
}).superRefine((value, ctx) => {
  if (value.source.path !== `/PROJECT_OS/.project-os/artifacts/staging/${value.request_id}/${value.relative_path}`) {
    ctx.addIssue({ code: "custom", path: ["source", "path"], message: "Review source must match request_id staging directory and filename exactly" });
  }
});

export const artifactWriteRequestSchema = z.union([
  inlineArtifactWriteRequestSchema,
  stagedArtifactWriteRequestSchema,
  reviewCandidateRequestSchema
]);

export type InlineArtifactWriteRequest = z.infer<typeof inlineArtifactWriteRequestSchema>;
export type StagedArtifactWriteRequest = z.infer<typeof stagedArtifactWriteRequestSchema> | ReviewCandidateRequest;
export type ArtifactWriteRequest = z.infer<typeof artifactWriteRequestSchema>;

export interface ArtifactWriteReceipt {
  operation?: "REVIEW_CANDIDATE";
  accepted?: false;
  published?: false;
  final_observation?: { provider_id: string; path: string; object_id: string; revision_token: string; size: number; integrity: { algorithm: string; value: string } };
  request_id: string;
  project_id: string;
  relative_path: string;
  content_sha256: string;
  status: "committed" | "conflict" | "rejected";
  code?: string;
  message?: string;
}

export function parseArtifactWriteRequest(input: unknown): ArtifactWriteRequest {
  return artifactWriteRequestSchema.parse(input);
}

export function isStagedArtifactWriteRequest(
  request: ArtifactWriteRequest
): request is StagedArtifactWriteRequest {
  return "source" in request;
}

export type ReviewCandidateRequest = z.infer<typeof reviewCandidateRequestSchema>;
export function isReviewCandidate(request: ArtifactWriteRequest): request is ReviewCandidateRequest {
  return "operation" in request && request.operation === "REVIEW_CANDIDATE";
}
