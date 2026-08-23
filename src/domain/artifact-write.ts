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

export const artifactWriteRequestSchema = z.strictObject({
  request_id: requestId,
  project_id: projectId,
  relative_path: relativePath,
  content: z.string(),
  content_sha256: hash,
  mode: z.enum(["create", "replace"])
});

export type ArtifactWriteRequest = z.infer<typeof artifactWriteRequestSchema>;

export interface ArtifactWriteReceipt {
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
