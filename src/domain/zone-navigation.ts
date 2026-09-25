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

export const navigationReconcileSchema = z.strictObject({
  operation: z.literal("navigation.reconcile"),
  request_id: requestId,
  project_id: projectId,
  zone: navigationZoneSchema,
  expected_project_revision: z.number().int().nonnegative().safe(),
  expected_generation: z.number().int().nonnegative().safe(),
  expected_index: navigationIndexIdentitySchema.nullable(),
  created_at: z.string().min(1).max(128)
});
export type NavigationReconcileRequest = z.infer<typeof navigationReconcileSchema>;

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
    budget: import("../convergence/contract").SliceBudget;
  }): Promise<{
    entries: NavigationInventoryEntry[];
    gaps: NavigationCoverageGap[];
    snapshot_id: string;
    next_cursor: string | null;
  }>;
  /** Recheck the adapter's stable snapshot marker without a full unbounded scan. */
  verifySnapshot(input: { project_id: string; zone: NavigationZone; snapshot_id: string; budget: import("../convergence/contract").SliceBudget }): Promise<boolean>;
  /** Recheck this exact canonical resource/version; each provider request consumes budget. */
  verifyEntry(entry: NavigationInventoryEntry, budget: import("../convergence/contract").SliceBudget): Promise<boolean>;
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
  | { status: "conflict"; code: string }
  | { status: "finalized"; receipt: ZoneNavigationReceipt };
