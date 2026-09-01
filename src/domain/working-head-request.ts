import { z } from "zod";
import { assertManagedRelativePath } from "./managed-document";

const requestId = z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentId = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionId = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const createdAt = z.string().min(1).max(128);
const logicalPath = z.string().min(1).transform((value, ctx) => {
  try {
    return assertManagedRelativePath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

const supersedeWorkingSchema = z.strictObject({
  operation: z.literal("working.supersede"),
  request_id: requestId,
  project_id: projectId,
  document_id: documentId,
  expected_version_id: versionId,
  new_logical_path: logicalPath,
  content: z.string(),
  content_sha256: hash,
  created_at: createdAt
});

const forkWorkingSchema = z.strictObject({
  operation: z.literal("working.fork"),
  request_id: requestId,
  project_id: projectId,
  source_document_id: documentId,
  expected_version_id: versionId,
  new_logical_path: logicalPath,
  content: z.string(),
  content_sha256: hash,
  created_at: createdAt
});

export const workingHeadRequestSchema = z.discriminatedUnion("operation", [
  supersedeWorkingSchema,
  forkWorkingSchema
]);

export type WorkingHeadRequest = z.infer<typeof workingHeadRequestSchema>;
export type SupersedeWorkingRequest = z.infer<typeof supersedeWorkingSchema>;
export type ForkWorkingRequest = z.infer<typeof forkWorkingSchema>;

export function parseWorkingHeadRequest(input: unknown): WorkingHeadRequest {
  return workingHeadRequestSchema.parse(input);
}

export function isWorkingHeadOperation(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const operation = (input as { operation?: unknown }).operation;
  return operation === "working.supersede" || operation === "working.fork";
}
