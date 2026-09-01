import { z } from "zod";

export type SearchRecordKind = "canonical_entity" | "managed_document";
export type SearchEntityType = "project" | "phase" | "task" | "decision" | "research" | "constraint" | "deliverable";
export type SearchZone = "references" | "working" | "review" | "deliverables";
export type SearchFreshness = "current" | "lagging" | "rebuilding" | "unknown" | "failed";
export type SearchMatchKind = "exact_id" | "exact_title" | "title_prefix" | "lexical" | "structured";

export type SearchAuthorityRef =
  | {
      kind: "canonical_entity";
      project_id: string;
      entity_type: SearchEntityType;
      entity_id: string;
      canonical_revision: number;
    }
  | {
      kind: "managed_document";
      project_id: string;
      document_id: string;
      version_id: string;
      logical_path: string;
      content_sha256?: string;
    };

export interface CanonicalSearchRecord {
  project_id: string;
  record_id: string;
  record_kind: "canonical_entity";
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  status?: string;
  phase_id?: string;
  body_text: string;
  content_hash: string;
  canonical_revision: number;
  updated_at?: string;
  authority_ref: Extract<SearchAuthorityRef, { kind: "canonical_entity" }>;
}

export interface ManagedDocumentSearchRecord {
  project_id: string;
  record_id: string;
  record_kind: "managed_document";
  document_id: string;
  version_id: string;
  title: string;
  logical_path: string;
  zone: SearchZone;
  stage_or_collection: string;
  reconciliation_status: "clean" | "conflict";
  body_text?: string;
  media_type?: string;
  content_hash: string;
  updated_at?: string;
  authority_ref: Extract<SearchAuthorityRef, { kind: "managed_document" }>;
}

export type SearchRecord = CanonicalSearchRecord | ManagedDocumentSearchRecord;

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const recordKindSchema = z.enum(["canonical_entity", "managed_document"]);
const entityTypeSchema = z.enum(["project", "phase", "task", "decision", "research", "constraint", "deliverable"]);
const zoneSchema = z.enum(["references", "working", "review", "deliverables"]);

function uniqueArray<T extends z.ZodTypeAny>(schema: T, max: number) {
  return z.array(schema).max(max).refine(
    (values) => new Set(values).size === values.length,
    { message: "values must be unique" }
  );
}

export const searchQuerySchema = z.strictObject({
  project_ids: uniqueArray(projectIdSchema, 100).min(1),
  text: z.string().max(512).optional(),
  record_kinds: uniqueArray(recordKindSchema, 2).optional(),
  entity_types: uniqueArray(entityTypeSchema, 7).optional(),
  zones: uniqueArray(zoneSchema, 4).optional(),
  statuses: uniqueArray(z.string().min(1), 32).optional(),
  limit: z.number().int().min(1).max(100).default(20)
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export function parseSearchQuery(input: unknown): SearchQuery {
  return searchQuerySchema.parse(input);
}

export interface SearchHit {
  project_id: string;
  record_id: string;
  record_kind: SearchRecordKind;
  title: string;
  status?: string;
  entity_type?: SearchEntityType;
  entity_id?: string;
  document_id?: string;
  version_id?: string;
  logical_path?: string;
  zone?: SearchZone;
  stage_or_collection?: string;
  snippet?: string;
  score: number;
  match_kind: SearchMatchKind;
  content_hash: string;
  canonical_revision?: number;
  authority_ref: SearchAuthorityRef;
}

export interface CanonicalSnapshotRequest {
  project_id: string;
  canonical_revision: number;
  snapshot_hash: string;
  records: CanonicalSearchRecord[];
}

export interface DocumentBatchRequest {
  project_id: string;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation: number;
  full_snapshot: boolean;
  snapshot_hash: string;
  records: ManagedDocumentSearchRecord[];
  removed_document_ids: string[];
}

export interface SearchIndexProjectStatus {
  project_id: string;
  freshness: SearchFreshness;
  active_generation: number | null;
  canonical_revision_indexed: number;
  canonical_snapshot_hash?: string;
  document_epoch?: string;
  document_epoch_started_at?: string;
  document_generation_indexed: number;
  document_snapshot_hash?: string;
  rebuild_state: string;
  last_error?: string;
  updated_at?: string;
}
