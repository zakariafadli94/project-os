import { z } from "zod";
import { assertManagedRelativePath, assertReferenceCollectionPath } from "./managed-document";

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
const collectionPath = z.string().min(1).transform((value, ctx) => {
  try {
    return assertReferenceCollectionPath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

const workingWriteSchema = z.strictObject({
  operation: z.literal("working.write"),
  request_id: requestId,
  project_id: projectId,
  logical_path: logicalPath,
  content: z.string(),
  content_sha256: hash,
  expected_version_id: versionId.optional(),
  created_at: createdAt
});

const lifecycleBase = {
  request_id: requestId,
  project_id: projectId,
  document_id: documentId,
  expected_version_id: versionId.optional(),
  created_at: createdAt
};

const reviewPromoteSchema = z.strictObject({ operation: z.literal("review.promote"), ...lifecycleBase });
const publishSchema = z.strictObject({ operation: z.literal("publish"), ...lifecycleBase });
const reopenSchema = z.strictObject({ operation: z.literal("reopen"), ...lifecycleBase });

const reviewWriteSchema = z.strictObject({
  operation: z.literal("review.write"),
  ...lifecycleBase,
  content: z.string(),
  content_sha256: hash
});

const referenceClassifySchema = z.strictObject({
  operation: z.literal("reference.classify"),
  ...lifecycleBase,
  collection_path: collectionPath
});

export const managedDocumentRequestSchema = z.discriminatedUnion("operation", [
  workingWriteSchema,
  reviewPromoteSchema,
  reviewWriteSchema,
  publishSchema,
  reopenSchema,
  referenceClassifySchema
]);

export type ManagedDocumentRequest = z.infer<typeof managedDocumentRequestSchema>;

export function parseManagedDocumentRequest(input: unknown): ManagedDocumentRequest {
  return managedDocumentRequestSchema.parse(input);
}
