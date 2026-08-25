import { z } from "zod";

export const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
export const artifactRequestIdSchema = z.string().regex(/^ART-[A-Z0-9-]{10,}$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const mutationIntentIdSchema = z.string().regex(/^MUTINT-[A-F0-9]{24}$/);
export const mutationCandidateIdSchema = z.string().regex(/^MUTCAND-[A-F0-9]{24}$/);
export const mutationResolutionIdSchema = z.string().regex(/^MUTRES-[A-F0-9]{24}$/);
export const mutationDetectionSourceSchema = z.enum(["incremental", "baseline", "cursor_reset"]);
export const mutationCandidateResolutionOperationSchema = z.enum([
  "candidate.adopt_artifact",
  "candidate.adopt_working",
  "candidate.reject"
]);

export type MutationDetectionSource = z.infer<typeof mutationDetectionSourceSchema>;
export type MutationCandidateResolutionOperation = z.infer<typeof mutationCandidateResolutionOperationSchema>;

export const mutationArtifactRouteSnapshotSchema = z.strictObject({
  route_id: z.string().regex(/^ROUTE-[A-Z0-9-]{4,}$/),
  source_prefix: z.string().min(1),
  target_prefix: z.string().min(1),
  archive_prefix: z.string().min(1).optional(),
  exclusive: z.boolean(),
  decision_ids: z.array(z.string().regex(/^DEC-[A-Z0-9]{4,}$/)),
  created_at: z.string().min(1).max(128),
  updated_at: z.string().min(1).max(128)
});

export type MutationArtifactRouteSnapshot = z.infer<typeof mutationArtifactRouteSnapshotSchema>;

export const mutationIntentRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  intent_id: mutationIntentIdSchema,
  project_id: projectIdSchema,
  kind: z.literal("artifact"),
  request_id: artifactRequestIdSchema,
  request_sha256: sha256Schema,
  request_json: z.string().min(2),
  base_project_revision: z.number().int().nonnegative().safe(),
  destination_path: z.string().min(1),
  archive_path: z.string().min(1).optional(),
  route_id: z.string().regex(/^ROUTE-[A-Z0-9-]{4,}$/).optional(),
  route_snapshot: mutationArtifactRouteSnapshotSchema.optional(),
  expected_content_sha256: sha256Schema,
  mode: z.enum(["create", "replace"]),
  recorded_at: z.string().min(1).max(128)
}).superRefine((value, ctx) => {
  if (!isProjectWorkspacePath(value.project_id, value.destination_path)) {
    ctx.addIssue({
      code: "custom",
      path: ["destination_path"],
      message: "destination_path must stay inside the bound project workspace"
    });
  }
  if (value.archive_path !== undefined && !isProjectWorkspacePath(value.project_id, value.archive_path)) {
    ctx.addIssue({
      code: "custom",
      path: ["archive_path"],
      message: "archive_path must stay inside the bound project workspace"
    });
  }
  if (value.route_snapshot && value.route_id !== value.route_snapshot.route_id) {
    ctx.addIssue({
      code: "custom",
      path: ["route_snapshot"],
      message: "route_snapshot must match route_id"
    });
  }
  if (value.route_id && !value.route_snapshot) {
    ctx.addIssue({
      code: "custom",
      path: ["route_snapshot"],
      message: "new routed mutation intents require an immutable route snapshot"
    });
  }
});

export type MutationIntentRecord = z.infer<typeof mutationIntentRecordSchema>;

export const externalMutationCandidateRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  candidate_id: mutationCandidateIdSchema,
  project_id: projectIdSchema,
  source: z.literal("external_unverified"),
  detection_source: mutationDetectionSourceSchema,
  provider_path: z.string().min(1),
  provider_file_id: z.string().regex(/^id:[A-Za-z0-9_-]+$/),
  provider_rev: z.string().min(1).max(256),
  provider_content_hash: sha256Schema,
  size: z.number().int().nonnegative().safe(),
  immutable_payload_path: z.string().min(1),
  detected_at: z.string().min(1).max(128)
}).superRefine((value, ctx) => {
  if (!isProjectWorkspacePath(value.project_id, value.provider_path)) {
    ctx.addIssue({
      code: "custom",
      path: ["provider_path"],
      message: "provider_path must stay inside the bound project workspace"
    });
  }
  const expectedPrefix = `/PROJECT_OS/.project-os/projects/${value.project_id}/mutation-gate/`;
  if (!isSafeAbsoluteDropboxPath(value.immutable_payload_path) || !value.immutable_payload_path.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["immutable_payload_path"],
      message: "immutable_payload_path must stay inside the bound project mutation-gate namespace"
    });
  }
});

export type ExternalMutationCandidateRecord = z.infer<typeof externalMutationCandidateRecordSchema>;

export const externalMutationResolutionRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  resolution_id: mutationResolutionIdSchema,
  project_id: projectIdSchema,
  candidate_id: mutationCandidateIdSchema,
  action: z.enum(["adopt_as_artifact", "adopt_as_working", "reject"]),
  downstream_request_id: z.string().min(1).optional(),
  downstream_receipt_status: z.enum(["committed", "conflict", "rejected"]).optional(),
  resolved_at: z.string().min(1).max(128)
});

export type ExternalMutationResolutionRecord = z.infer<typeof externalMutationResolutionRecordSchema>;

export function parseMutationIntentRecord(input: unknown): MutationIntentRecord {
  return mutationIntentRecordSchema.parse(input);
}

export function parseExternalMutationCandidateRecord(input: unknown): ExternalMutationCandidateRecord {
  return externalMutationCandidateRecordSchema.parse(input);
}

export function parseExternalMutationResolutionRecord(input: unknown): ExternalMutationResolutionRecord {
  return externalMutationResolutionRecordSchema.parse(input);
}

export async function mutationIntentIdFor(projectId: string, requestId: string): Promise<string> {
  projectIdSchema.parse(projectId);
  artifactRequestIdSchema.parse(requestId);
  return `MUTINT-${(await sha256Hex(`${projectId}\n${requestId}`)).slice(0, 24).toUpperCase()}`;
}

export async function mutationCandidateIdFor(input: {
  projectId: string;
  providerFileId: string;
  providerRev: string;
}): Promise<string> {
  projectIdSchema.parse(input.projectId);
  z.string().regex(/^id:[A-Za-z0-9_-]+$/).parse(input.providerFileId);
  z.string().min(1).max(256).parse(input.providerRev);
  return `MUTCAND-${(await sha256Hex(`${input.projectId}\n${input.providerFileId}\n${input.providerRev}`)).slice(0, 24).toUpperCase()}`;
}

export async function mutationResolutionIdFor(
  projectId: string,
  candidateId: string,
  operation: MutationCandidateResolutionOperation
): Promise<string> {
  projectIdSchema.parse(projectId);
  mutationCandidateIdSchema.parse(candidateId);
  mutationCandidateResolutionOperationSchema.parse(operation);
  return `MUTRES-${(await sha256Hex(`${projectId}\n${candidateId}\n${operation}`)).slice(0, 24).toUpperCase()}`;
}

function isProjectWorkspacePath(projectId: string, value: string): boolean {
  const prefix = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-`;
  return isSafeAbsoluteDropboxPath(value) && value.startsWith(prefix);
}

function isSafeAbsoluteDropboxPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("//") || /[\u0000-\u001F\u007F\\]/.test(value)) return false;
  const segments = value.split("/").slice(1);
  return segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
