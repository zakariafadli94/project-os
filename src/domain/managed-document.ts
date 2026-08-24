import { z } from "zod";

export type ManagedDocumentZone = "inputs" | "references" | "working" | "review" | "deliverables";
export type ManagedDocumentKind = "reference" | "work_product";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentIdSchema = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionIdSchema = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const providerFileIdSchema = z.string().regex(/^id:[A-Za-z0-9_-]+$/);

const RESERVED_WORKSPACE_ROOTS = new Set([
  ".project-os",
  "ARCHIVES",
  "CONSTRAINTS",
  "DECISIONS",
  "DELIVERABLES",
  "INPUTS",
  "MEETINGS",
  "REFERENCES",
  "RESEARCH",
  "REVIEW",
  "SPECS",
  "TASKS",
  "WORKING"
]);

export interface ManagedDocumentHead {
  schema_version: "1.0";
  project_id: string;
  document_id: string;
  kind: ManagedDocumentKind;
  logical_path: string;
  collection_path?: string;
  reference_version_id?: string;
  working_version_id?: string;
  review_version_id?: string;
  published_version_id?: string;
  reconciliation_status: "clean" | "conflict";
}

export interface DocumentVersionRecord {
  schema_version: "1.0";
  project_id: string;
  document_id: string;
  version_id: string;
  parent_version_id?: string;
  kind: ManagedDocumentKind;
  stage: "reference" | "working" | "review" | "published" | "recovered_external";
  logical_path: string;
  source: "project_os" | "external_human" | "input_ingest" | "legacy_artifact_api";
  created_at: string;
  immutable_payload_path: string;
  content_sha256?: string;
  provider_content_hash?: string;
  provider_file_id?: string;
  provider_rev?: string;
  size?: number;
  media_type?: string;
  request_id?: string;
}

const headSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  document_id: documentIdSchema,
  kind: z.enum(["reference", "work_product"]),
  logical_path: z.string(),
  collection_path: z.string().optional(),
  reference_version_id: versionIdSchema.optional(),
  working_version_id: versionIdSchema.optional(),
  review_version_id: versionIdSchema.optional(),
  published_version_id: versionIdSchema.optional(),
  reconciliation_status: z.enum(["clean", "conflict"])
}).superRefine((value, ctx) => {
  try {
    assertManagedRelativePath(value.logical_path);
  } catch (error) {
    ctx.addIssue({ code: "custom", path: ["logical_path"], message: errorMessage(error) });
  }

  if (value.collection_path !== undefined) {
    try {
      assertReferenceCollectionPath(value.collection_path);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["collection_path"], message: errorMessage(error) });
    }
  }

  if (value.kind === "reference") {
    if (value.working_version_id || value.review_version_id || value.published_version_id) {
      ctx.addIssue({ code: "custom", message: "Reference document heads cannot carry work-product lifecycle pointers" });
    }
  } else if (value.reference_version_id || value.collection_path) {
    ctx.addIssue({ code: "custom", message: "Work-product document heads cannot carry reference-only fields" });
  }
});

const versionRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  document_id: documentIdSchema,
  version_id: versionIdSchema,
  parent_version_id: versionIdSchema.optional(),
  kind: z.enum(["reference", "work_product"]),
  stage: z.enum(["reference", "working", "review", "published", "recovered_external"]),
  logical_path: z.string(),
  source: z.enum(["project_os", "external_human", "input_ingest", "legacy_artifact_api"]),
  created_at: z.string().min(1).max(128),
  immutable_payload_path: z.string().min(1),
  content_sha256: hashSchema.optional(),
  provider_content_hash: hashSchema.optional(),
  provider_file_id: providerFileIdSchema.optional(),
  provider_rev: z.string().min(1).max(256).optional(),
  size: z.number().int().nonnegative().safe().optional(),
  media_type: z.string().min(1).max(255).optional(),
  request_id: z.string().regex(/^[A-Z][A-Z0-9-]{7,}$/).optional()
}).superRefine((value, ctx) => {
  try {
    assertManagedRelativePath(value.logical_path);
  } catch (error) {
    ctx.addIssue({ code: "custom", path: ["logical_path"], message: errorMessage(error) });
  }

  const expectedPrefix = `/PROJECT_OS/.project-os/projects/${value.project_id}/documents/`;
  if (!value.immutable_payload_path.startsWith(expectedPrefix) || hasUnsafeSegments(value.immutable_payload_path)) {
    ctx.addIssue({
      code: "custom",
      path: ["immutable_payload_path"],
      message: "immutable_payload_path must stay inside the bound project document namespace"
    });
  }

  if (value.kind === "reference" && value.stage !== "reference" && value.stage !== "recovered_external") {
    ctx.addIssue({ code: "custom", path: ["stage"], message: "Reference documents cannot use work-product stages" });
  }
  if (value.kind === "work_product" && value.stage === "reference") {
    ctx.addIssue({ code: "custom", path: ["stage"], message: "Work products cannot use the reference stage" });
  }

  if (!value.content_sha256 && !value.provider_content_hash) {
    ctx.addIssue({
      code: "custom",
      message: "A document version must carry canonical SHA-256 or provider content evidence"
    });
  }
});

export function parseManagedDocumentHead(input: unknown): ManagedDocumentHead {
  return headSchema.parse(input) as ManagedDocumentHead;
}

export function parseDocumentVersionRecord(input: unknown): DocumentVersionRecord {
  return versionRecordSchema.parse(input) as DocumentVersionRecord;
}

export async function documentIdFor(projectId: string, logicalPath: string): Promise<string> {
  projectIdSchema.parse(projectId);
  const path = assertManagedRelativePath(logicalPath);
  return `DOC-${(await sha256Hex(`${projectId}\n${path}`)).slice(0, 24).toUpperCase()}`;
}

export async function externalVersionIdFor(providerRev: string): Promise<string> {
  const normalized = z.string().min(1).max(256).parse(providerRev);
  return `VER-EXT-${(await sha256Hex(normalized)).slice(0, 24).toUpperCase()}`;
}

export function assertManagedRelativePath(value: string): string {
  const safe = assertSafeRelative(value, "managed document path", 16, 512);
  const root = safe.split("/")[0];
  if (RESERVED_WORKSPACE_ROOTS.has(root)) {
    throw new Error(`managed document path must be relative to its managed zone, not start with reserved root ${root}`);
  }
  return safe;
}

export function assertReferenceCollectionPath(value: string): string {
  const safe = assertSafeRelative(value, "reference collection path", 4, 256);
  const root = safe.split("/")[0];
  if (RESERVED_WORKSPACE_ROOTS.has(root)) {
    throw new Error(`reference collection path cannot use reserved workspace root ${root}`);
  }
  return safe;
}

function assertSafeRelative(value: string, label: string, maxDepth: number, maxLength: number): string {
  if (!value || value.length > maxLength || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  const segments = value.split("/");
  if (segments.length > maxDepth || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

function hasUnsafeSegments(value: string): boolean {
  return value.split("/").some((segment) => segment === "." || segment === "..");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
