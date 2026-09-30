import { z } from "zod";
import { assertManagedRelativePath } from "./managed-document";

export const navigationZoneSchema = z.enum(["WORKING", "REVIEW", "DELIVERABLES"]);
export type NavigationZone = z.infer<typeof navigationZoneSchema>;

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const requestId = z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revisionToken = z.string().min(1).max(512);
const objectId = z.string().min(1).max(512);
const indexBasename = z.enum(["00-CURRENT-INDEX.md", "00-CURRENT.md"]);

export const navigationIndexIdentitySchema = z.strictObject({
  basename: indexBasename,
  object_id: objectId,
  revision_token: revisionToken,
  content_sha256: hash
});
export type NavigationIndexIdentity = z.infer<typeof navigationIndexIdentitySchema>;

export const navigationCatalogManifestIdentitySchema = z.strictObject({
  object_id: z.string().min(1).max(512),
  revision_token: z.string().min(1).max(512),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export type NavigationCatalogManifestIdentity = z.infer<typeof navigationCatalogManifestIdentitySchema>;

export const navigationReconcileSchema = z.strictObject({
  operation: z.literal("navigation.reconcile"),
  request_id: requestId,
  project_id: projectId,
  zone: navigationZoneSchema,
  expected_project_revision: z.number().int().nonnegative().safe(),
  expected_generation: z.number().int().nonnegative().safe(),
  expected_index: navigationIndexIdentitySchema.nullable(),
  purpose: z.literal("compact_catalog_rebuild").optional(),
  expected_source_generation: z.number().int().nonnegative().safe().optional(),
  expected_catalog_manifest: navigationCatalogManifestIdentitySchema.optional(),
  created_at: z.string().min(1).max(128)
}).superRefine((request, ctx) => {
  const isRebuild = request.purpose === "compact_catalog_rebuild";
  if (isRebuild !== (request.expected_catalog_manifest !== undefined) || isRebuild !== (request.expected_source_generation !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["purpose"], message: "compact catalog rebuild requires source generation and exact manifest identity" });
  }
  if (request.purpose === "compact_catalog_rebuild" && request.expected_index !== null) {
    ctx.addIssue({ code: "custom", path: ["expected_index"], message: "compact catalog rebuild cannot target a zone index" });
  }
});
export type NavigationReconcileRequest = z.infer<typeof navigationReconcileSchema>;
export type NavigationCatalogRebuildRequest = NavigationReconcileRequest & {
  purpose: "compact_catalog_rebuild";
  expected_source_generation: number;
  expected_catalog_manifest: NavigationCatalogManifestIdentity;
};

export const navigationCatalogChunkEvidenceSchema = z.strictObject({
  shard: z.number().int().nonnegative().max(63),
  object_id: objectId,
  revision_token: revisionToken,
  content_sha256: hash
});

export const navigationCatalogRebuildCertificateSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  purpose: z.literal("compact_catalog_rebuild"),
  project_id: projectId,
  request_id: requestId,
  request_hash: hash,
  zone: navigationZoneSchema,
  source_generation: z.number().int().nonnegative().safe(),
  source_snapshot_id: z.string().regex(/^source:[0-9]+$/),
  source_count: z.number().int().nonnegative().safe(),
  shards: z.array(z.number().int().nonnegative().max(63)).max(64),
  expected_manifest: navigationCatalogManifestIdentitySchema,
  published_manifest: navigationCatalogManifestIdentitySchema,
  chunk_evidence: z.array(navigationCatalogChunkEvidenceSchema).max(64),
  coverage_gaps: z.array(z.never()).length(0)
}).superRefine((certificate, ctx) => {
  if (certificate.source_snapshot_id !== `source:${certificate.source_generation}`) ctx.addIssue({ code: "custom", path: ["source_snapshot_id"], message: "catalog rebuild certificate snapshot does not match its source generation" });
  if (new Set(certificate.shards).size !== certificate.shards.length || certificate.shards.some((shard, index) => index > 0 && certificate.shards[index - 1] >= shard)) {
    ctx.addIssue({ code: "custom", path: ["shards"], message: "catalog rebuild certificate shards must be unique and ordered" });
  }
  if (certificate.shards.join(",") !== certificate.chunk_evidence.map((item) => item.shard).join(",")) {
    ctx.addIssue({ code: "custom", path: ["chunk_evidence"], message: "catalog rebuild certificate must contain physical evidence for every shard" });
  }
});
export type NavigationCatalogRebuildCertificate = z.infer<typeof navigationCatalogRebuildCertificateSchema>;

export const navigationCatalogRebuildProgressSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  purpose: z.literal("compact_catalog_rebuild"),
  project_id: projectId,
  request_id: requestId,
  request_hash: hash,
  zone: navigationZoneSchema,
  source_generation: z.number().int().nonnegative().safe(),
  source_snapshot_id: z.string().regex(/^source:[0-9]+$/).nullable(),
  cursor: z.string().nullable(),
  page_count: z.number().int().nonnegative().safe(),
  source_count: z.number().int().nonnegative().safe(),
  source_ids: z.array(z.string().min(1).max(512)).max(4096).default([]),
  shard_cursor: z.number().int().nonnegative().max(64),
  shard_count: z.number().int().nonnegative().max(64),
  publish_cursor: z.number().int().nonnegative().max(64).default(0),
  verify_shard_cursor: z.number().int().nonnegative().max(64).default(0),
  post_publish_verify_cursor: z.number().int().nonnegative().max(64).default(0),
  post_publish_failure_count: z.number().int().nonnegative().max(6).default(0),
  verify_page: z.number().int().nonnegative().safe().default(0),
  verify_entry: z.number().int().nonnegative().safe().default(0),
  verify_cursor: z.string().nullable().default(null),
  stage_page: z.number().int().nonnegative().safe().default(0),
  staging_entries: z.array(z.lazy(() => navigationInventoryEntrySchema)).max(256).default([]),
  staged_shards: z.array(z.number().int().nonnegative().max(63)).max(64).default([]),
  invalidated_manifest: navigationCatalogManifestIdentitySchema.nullable().default(null),
  chunk_evidence: z.array(navigationCatalogChunkEvidenceSchema).max(64).default([]),
  status: z.enum(["scanning", "verifying", "staging", "prepared", "publishing", "finalized", "conflict"]),
  finalization_ref: z.string().min(1).nullable(),
  coverage_gaps: z.array(z.strictObject({ resource_id: z.string().min(1).max(512), code: z.string().min(1).max(128) }))
}).superRefine((progress, ctx) => {
  if (progress.source_snapshot_id !== null && progress.source_snapshot_id !== `source:${progress.source_generation}`) ctx.addIssue({ code: "custom", path: ["source_snapshot_id"], message: "catalog rebuild progress snapshot does not match its source generation" });
  if (progress.status === "finalized" && !progress.finalization_ref) ctx.addIssue({ code: "custom", path: ["finalization_ref"], message: "finalized catalog rebuild must reference its certificate" });
  if (progress.status !== "finalized" && progress.finalization_ref !== null) ctx.addIssue({ code: "custom", path: ["finalization_ref"], message: "unfinished catalog rebuild cannot expose a certificate" });
  if (progress.coverage_gaps.length > 0 && progress.status === "prepared") ctx.addIssue({ code: "custom", path: ["coverage_gaps"], message: "catalog rebuild with source gaps cannot be prepared" });
});
export type NavigationCatalogRebuildProgress = z.infer<typeof navigationCatalogRebuildProgressSchema>;

export const navigationWorkRefSchema = z.strictObject({
  project_id: projectId,
  request_id: requestId,
  zone: navigationZoneSchema,
  expected_generation: z.number().int().nonnegative().safe(),
  source_snapshot_id: z.string().regex(/^source:[0-9]+$/),
  authority_ref: z.string().min(1).max(2048),
  request_hash: hash
});
export type NavigationWorkRef = z.infer<typeof navigationWorkRefSchema>;

export const navigationWorkFailureSchema = navigationWorkRefSchema.extend({
  failure_code: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/)
}).strict();

const safeLogicalPath = z.string().min(1).transform((value, ctx) => {
  try {
    return assertManagedRelativePath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
}).superRefine((value, ctx) => {
  if (value.toLocaleLowerCase("en-US") === "00-current.md" || value.toLocaleLowerCase("en-US") === "00-current-index.md") {
    ctx.addIssue({ code: "custom", message: "navigation index cannot reference itself" });
  }
});

export const navigationInventoryEntrySchema = z.strictObject({
  project_id: projectId,
  zone: navigationZoneSchema,
  resource_id: z.string().min(1).max(512),
  version: z.string().min(1).max(512),
  logical_path: safeLogicalPath,
  path: z.string().min(1).max(2048),
  expected: z.strictObject({
    object_id: objectId,
    revision_token: revisionToken,
    content_sha256: hash,
    size: z.number().int().nonnegative().safe()
  })
});
export type NavigationInventoryEntry = z.infer<typeof navigationInventoryEntrySchema>;

export const navigationCoverageGapSchema = z.strictObject({
  resource_id: z.string().min(1).max(512),
  code: z.string().min(1).max(128)
});
export type NavigationCoverageGap = z.infer<typeof navigationCoverageGapSchema>;

export interface NavigationInventoryPort {
  /** Each provider request must consume `budget.beforeHttp()` before it starts. */
  listPage(input: {
    project_id: string;
    zone: NavigationZone;
    cursor: string | null;
    limit: number;
    mode?: "canonical_catalog_rebuild";
    budget: import("../convergence/contract").SliceBudget;
  }): Promise<{
    entries: NavigationInventoryEntry[];
    /** Server-generated exact entries whose canonical physical bytes were verified in this source snapshot. */
    verified_entries?: { resource_id: string; entry_hash: string; persisted: boolean }[];
    gaps: NavigationCoverageGap[];
    snapshot_id: string;
    next_cursor: string | null;
  }>;
  /** Recheck the adapter's stable snapshot marker without a full unbounded scan. */
  verifySnapshot(input: { project_id: string; zone: NavigationZone; snapshot_id: string; budget: import("../convergence/contract").SliceBudget }): Promise<boolean>;
  /** Recheck this exact canonical resource/version; each provider request consumes budget. */
  verifyEntry(entry: NavigationInventoryEntry, budget: import("../convergence/contract").SliceBudget): Promise<boolean>;
  /** Optional bounded proof continuation for legacy entries requiring multi-page validation. */
  verifyEntryPage?(entry: NavigationInventoryEntry, cursor: string | null, budget: import("../convergence/contract").SliceBudget): Promise<{ status: "pending"; cursor: string } | { status: "verified" } | { status: "conflict" }>;
  /** True only when verifyEntry itself checks canonical bytes and stable provider identity. */
  readonly verificationIncludesPhysicalIntegrity?: boolean;
  /** Persist a verified exact source entry for bounded reuse in later reconciliations. */
  recordVerifiedEntry?(entry: NavigationInventoryEntry, snapshot_id: string, budget: import("../convergence/contract").SliceBudget): Promise<void>;
  /** Persist a compact catalog completion marker only after every snapshot entry was verified. */
  completeSnapshot?(input: { project_id: string; zone: NavigationZone; snapshot_id: string; budget: import("../convergence/contract").SliceBudget }): Promise<boolean | "pending" | { status: "conflict"; code: string }>;
}

export interface NavigationPostcheckPort {
  run(input: {
    request: NavigationReconcileRequest;
    admission: import("../execution/contract").ExecutionAdmission;
    check_id: string;
    budget: import("../convergence/contract").SliceBudget;
  }): Promise<{ verdict: "allow" | "deny" | "unavailable"; evidence_refs: string[] }>;
}

export const zoneNavigationHeadSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  zone: navigationZoneSchema,
  generation: z.number().int().positive().safe(),
  source_request_id: requestId,
  index: navigationIndexIdentitySchema,
  finalization_ref: z.string().min(1),
  source_snapshot_id: z.string().min(1).max(512),
  source_count: z.number().int().nonnegative().safe(),
  coverage_gaps: z.array(navigationCoverageGapSchema)
});
export type ZoneNavigationHead = z.infer<typeof zoneNavigationHeadSchema>;

export const zoneNavigationReceiptSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  status: z.literal("committed"),
  project_id: projectId,
  request_id: requestId,
  zone: navigationZoneSchema,
  generation: z.number().int().positive().safe(),
  head_ref: z.string().min(1),
  finalization_ref: z.string().min(1),
  index: navigationIndexIdentitySchema,
  source_snapshot_id: z.string().min(1),
  source_count: z.number().int().nonnegative().safe(),
  coverage_gaps: z.array(navigationCoverageGapSchema)
});
export type ZoneNavigationReceipt = z.infer<typeof zoneNavigationReceiptSchema>;

export type ZoneNavigationResult =
  | { status: "pending"; cursor: string | null }
  | { status: "prepared"; source_snapshot_id: string }
  | { status: "conflict"; code: string }
  | { status: "finalized"; receipt: ZoneNavigationReceipt };
