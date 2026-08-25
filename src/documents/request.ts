import { z } from "zod";

const requestId = z.string().regex(/^[A-Z][A-Z0-9-]{7,}$/);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentId = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionId = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const createdAt = z.string().min(1).max(128);
const relativePath = z.string().min(1).max(512);
const collectionPath = z.string().min(1).max(256);

const commonLifecycle = {
  request_id: requestId,
  project_id: projectId,
  document_id: documentId,
  expected_version_id: versionId.optional(),
  created_at: createdAt
} as const;

export const managedDocumentRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("working.write"),
    request_id: requestId,
    project_id: projectId,
    logical_path: relativePath,
    content: z.string(),
    content_sha256: hash,
    expected_version_id: versionId.optional(),
    created_at: createdAt
  }),
  z.strictObject({
    operation: z.literal("review.write"),
    ...commonLifecycle,
    content: z.string(),
    content_sha256: hash
  }),
  z.strictObject({ operation: z.literal("review.promote"), ...commonLifecycle }),
  z.strictObject({ operation: z.literal("publish"), ...commonLifecycle }),
  z.strictObject({ operation: z.literal("reopen"), ...commonLifecycle }),
  z.strictObject({
    operation: z.literal("reference.classify"),
    ...commonLifecycle,
    collection_path: collectionPath
  })
]);

export type ManagedDocumentRequest = z.infer<typeof managedDocumentRequestSchema>;

export function parseManagedDocumentRequest(input: unknown): ManagedDocumentRequest {
  return managedDocumentRequestSchema.parse(input);
}
