import { z } from "zod";
import { assertManagedRelativePath, assertReferenceCollectionPath } from "./managed-document";
import { packageRefSchema, packageZoneSchema } from "./document-package";
import { navigationReconcileSchema } from "./zone-navigation";

const requestId = z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/);
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentId = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionId = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const candidateRequestId = z.string().regex(/^ART-[A-Z0-9-]{10,}$/);
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

const reviewCandidatePromotionSchema = z.strictObject({
  operation: z.literal("review_candidate.promote"),
  request_id: requestId,
  project_id: projectId,
  candidate_request_id: candidateRequestId,
  logical_path: logicalPath,
  expected_project_revision: z.number().int().nonnegative().safe(),
  accepted: z.literal(true),
  created_at: createdAt
});

const referenceClassifySchema = z.strictObject({
  operation: z.literal("reference.classify"),
  ...lifecycleBase,
  collection_path: collectionPath
});

const documentArchiveSchema = z.strictObject({
  operation: z.literal("document.archive"),
  request_id: requestId,
  project_id: projectId,
  document_id: documentId,
  stage: z.enum(["working", "review", "published"]),
  expected_version_id: versionId,
  archive_group: z.string().max(323).regex(/^[A-Z0-9][A-Z0-9_-]{0,79}(?:\/[A-Z0-9][A-Z0-9_-]{0,79}){0,3}$/).optional(),
  created_at: createdAt
});

const instanceRepairProvider = z.strictObject({
  object_id: z.string().regex(/^id:[A-Za-z0-9_-]+$/),
  revision_token: z.string().min(1).max(256),
  path: z.string().min(1),
  size: z.number().int().nonnegative().safe()
}).superRefine((value, ctx) => {
  if (!value.path.startsWith("/") || !value.path.includes("/WORKING/") || value.path.includes("..")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "repair provider path must be a safe WORKING path" });
  }
});

const instanceRepairSchema = z.strictObject({
  operation: z.literal("document.instance.repair"),
  request_id: requestId,
  project_id: projectId,
  document_id: documentId,
  version_id: versionId,
  logical_path: logicalPath,
  expected_project_revision: z.number().int().nonnegative().safe(),
  expected_source_generation: z.number().int().nonnegative().safe(),
  expected_version_record_sha256: hash,
  content_sha256: hash,
  historical_provider: instanceRepairProvider,
  current_provider: instanceRepairProvider,
  created_at: createdAt
}).superRefine((value, ctx) => {
  if (!value.historical_provider.path.endsWith(`/WORKING/${value.logical_path}`)) {
    ctx.addIssue({ code: "custom", path: ["historical_provider", "path"], message: "historical provider path must match the WORKING logical path" });
  }
  if (!value.current_provider.path.endsWith(`/WORKING/${value.logical_path}`)) {
    ctx.addIssue({ code: "custom", path: ["current_provider", "path"], message: "current provider path must match the WORKING logical path" });
  }
  if (value.historical_provider.object_id === value.current_provider.object_id
    && value.historical_provider.revision_token === value.current_provider.revision_token
    && value.historical_provider.path === value.current_provider.path
    && value.historical_provider.size === value.current_provider.size) {
    ctx.addIssue({ code: "custom", path: ["current_provider"], message: "instance repair requires a distinct current provider identity" });
  }
});

export const managedDocumentRequestSchema = z.discriminatedUnion("operation", [
  navigationReconcileSchema,
  z.strictObject({ operation: z.literal("package.replace"), request_id: requestId, project_id: projectId, candidate: packageRefSchema, zone: packageZoneSchema, expected_navigation_generation: z.number().int().nonnegative().safe(), expected_project_revision: z.number().int().nonnegative().safe(), created_at: createdAt }),
  z.strictObject({ operation: z.literal("package.freeze"), request_id: requestId, project_id: projectId, document_id: documentId, expected_version_id: versionId, content_sha256: hash, expected_project_revision: z.number().int().nonnegative().safe(), created_at: createdAt }),
  workingWriteSchema,
  reviewPromoteSchema,
  reviewWriteSchema,
  reviewCandidatePromotionSchema,
  publishSchema,
  reopenSchema,
  referenceClassifySchema,
  documentArchiveSchema,
  instanceRepairSchema
]);

export type ManagedDocumentRequest = z.infer<typeof managedDocumentRequestSchema>;

export function parseManagedDocumentRequest(input: unknown): ManagedDocumentRequest {
  return managedDocumentRequestSchema.parse(input);
}
