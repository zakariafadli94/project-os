import { z } from "zod";
import {
  assertManagedRelativePath,
  assertReferenceCollectionPath,
  parseDocumentVersionRecord,
  parseManagedDocumentHead,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedDocumentProviderState,
  type ManagedProviderObservation
} from "../domain/managed-document";
import {
  parseProviderObservation,
  providerObservationSchema,
  upcastDropboxV1Observation,
  type ProviderObservation
} from "./provider-evidence";
import type { SchemaWriterStage } from "./writer-stage";
import { writesProviderV2 } from "./writer-stage";
import { unsupportedSchemaVersion } from "./version";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentIdSchema = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionIdSchema = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z.string().regex(/^[A-Z][A-Z0-9-]{7,}$/);
const kindSchema = z.enum(["reference", "work_product"]);
const stageSchema = z.enum(["reference", "working", "review", "published", "recovered_external"]);
const sourceSchema = z.enum(["project_os", "external_human", "input_ingest", "legacy_artifact_api"]);

const providerStateV2Schema = z.strictObject({
  reference: providerObservationSchema.optional(),
  working: providerObservationSchema.optional(),
  review: providerObservationSchema.optional(),
  published: providerObservationSchema.optional()
});

const headV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  document_id: documentIdSchema,
  kind: kindSchema,
  logical_path: z.string(),
  collection_path: z.string().optional(),
  reference_version_id: versionIdSchema.optional(),
  working_version_id: versionIdSchema.optional(),
  review_version_id: versionIdSchema.optional(),
  published_version_id: versionIdSchema.optional(),
  provider: providerStateV2Schema.optional(),
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
  validateHeadLifecycle(value, ctx);
});

const versionV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  document_id: documentIdSchema,
  version_id: versionIdSchema,
  parent_version_id: versionIdSchema.optional(),
  kind: kindSchema,
  stage: stageSchema,
  logical_path: z.string(),
  source: sourceSchema,
  created_at: z.string().min(1).max(128),
  immutable_payload_path: z.string().min(1),
  content_sha256: hashSchema.optional(),
  provider_evidence: providerObservationSchema.optional(),
  media_type: z.string().min(1).max(255).optional(),
  request_id: requestIdSchema.optional()
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
  if (!value.content_sha256 && !value.provider_evidence) {
    ctx.addIssue({ code: "custom", message: "A document version must carry canonical SHA-256 or complete provider integrity evidence" });
  }
});

export interface CurrentManagedProviderObservation extends ManagedProviderObservation {
  provider_id: string;
  object_id: string;
  revision_token: string;
  integrity_hash: { algorithm: string; value: string };
}

export interface CurrentManagedDocumentProviderState {
  reference?: CurrentManagedProviderObservation;
  working?: CurrentManagedProviderObservation;
  review?: CurrentManagedProviderObservation;
  published?: CurrentManagedProviderObservation;
}

export interface CurrentManagedDocumentHead extends Omit<ManagedDocumentHead, "provider"> {
  provider?: CurrentManagedDocumentProviderState;
}

export interface CurrentDocumentVersionRecord extends DocumentVersionRecord {
  provider_evidence?: ProviderObservation;
}

export type DocumentVersionWriteInput = Omit<CurrentDocumentVersionRecord, "schema_version"> & {
  schema_version: "1.0" | "2.0";
};

export interface ManagedDocumentHeadReadResult {
  sourceVersion: "1.0" | "2.0";
  head: CurrentManagedDocumentHead;
}

export interface DocumentVersionReadResult {
  sourceVersion: "1.0" | "2.0";
  record: CurrentDocumentVersionRecord;
}

export function readManagedDocumentHead(input: unknown): ManagedDocumentHeadReadResult {
  const raw = requireRecord(input, "ManagedDocumentHead");
  if (raw.schema_version === "1.0") {
    const parsed = parseManagedDocumentHead(raw);
    return {
      sourceVersion: "1.0",
      head: {
        ...parsed,
        ...(parsed.provider ? { provider: upcastProviderState(parsed.provider) } : {})
      }
    };
  }
  if (raw.schema_version === "2.0") {
    const parsed = headV2Schema.parse(raw);
    return {
      sourceVersion: "2.0",
      head: {
        ...withoutSchemaVersion(parsed),
        schema_version: "1.0",
        ...(parsed.provider ? { provider: currentProviderState(parsed.provider) } : {})
      }
    };
  }
  return unsupportedSchemaVersion("ManagedDocumentHead", raw.schema_version);
}

export function readDocumentVersionRecord(input: unknown): DocumentVersionReadResult {
  const raw = requireRecord(input, "DocumentVersionRecord");
  if (raw.schema_version === "1.0") {
    const parsed = parseDocumentVersionRecord(raw);
    const providerEvidence = completeV1VersionEvidence(parsed);
    return {
      sourceVersion: "1.0",
      record: {
        ...parsed,
        ...(providerEvidence ? { provider_evidence: providerEvidence } : {})
      }
    };
  }
  if (raw.schema_version === "2.0") {
    const parsed = versionV2Schema.parse(raw);
    const semantic = currentVersionFromV2(parsed);
    return { sourceVersion: "2.0", record: semantic };
  }
  return unsupportedSchemaVersion("DocumentVersionRecord", raw.schema_version);
}

export function encodeManagedDocumentHead(
  head: CurrentManagedDocumentHead,
  stage: SchemaWriterStage
): unknown {
  if (!writesProviderV2(stage)) {
    return parseManagedDocumentHead({
      ...head,
      schema_version: "1.0",
      ...(head.provider ? { provider: legacyProviderState(head.provider) } : {})
    });
  }

  return headV2Schema.parse({
    ...head,
    schema_version: "2.0",
    ...(head.provider ? { provider: neutralProviderState(head.provider) } : {})
  });
}

export function encodeDocumentVersionRecord(
  record: DocumentVersionWriteInput,
  stage: SchemaWriterStage
): unknown {
  if (!writesProviderV2(stage)) {
    const { provider_evidence: _providerEvidence, schema_version: _schemaVersion, ...rest } = record;
    return parseDocumentVersionRecord({ ...rest, schema_version: "1.0" });
  }

  const providerEvidence = record.provider_evidence ?? completeV1VersionEvidence(record);
  const {
    schema_version: _schemaVersion,
    provider_evidence: _semanticProviderEvidence,
    provider_content_hash: _providerContentHash,
    provider_file_id: _providerFileId,
    provider_rev: _providerRev,
    provider_path: _providerPath,
    size: _providerSize,
    ...business
  } = record;
  return versionV2Schema.parse({
    ...business,
    schema_version: "2.0",
    ...(providerEvidence ? { provider_evidence: providerEvidence } : {})
  });
}

function completeV1VersionEvidence(
  record: Pick<DocumentVersionRecord, "provider_path" | "provider_file_id" | "provider_rev" | "provider_content_hash" | "size">
): ProviderObservation | undefined {
  const values = [
    record.provider_path,
    record.provider_file_id,
    record.provider_rev,
    record.provider_content_hash,
    record.size
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (
    !record.provider_path
    || !record.provider_file_id
    || !record.provider_rev
    || !record.provider_content_hash
    || record.size === undefined
  ) {
    return undefined;
  }
  return upcastDropboxV1Observation(record);
}

function upcastProviderState(state: ManagedDocumentProviderState): CurrentManagedDocumentProviderState {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, currentObservation(upcastDropboxV1Observation(value))])
  ) as CurrentManagedDocumentProviderState;
}

function currentProviderState(state: Partial<Record<"reference" | "working" | "review" | "published", ProviderObservation>>): CurrentManagedDocumentProviderState {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, currentObservation(parseProviderObservation(value))])
  ) as CurrentManagedDocumentProviderState;
}

function neutralProviderState(state: CurrentManagedDocumentProviderState): Record<string, ProviderObservation> {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, neutralObservation(value)])
  );
}

function legacyProviderState(state: CurrentManagedDocumentProviderState): ManagedDocumentProviderState {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, legacyObservation(value)])
  ) as ManagedDocumentProviderState;
}

function neutralObservation(value: CurrentManagedProviderObservation): ProviderObservation {
  if (value.provider_id && value.object_id && value.revision_token && value.integrity_hash) {
    return parseProviderObservation({
      provider_id: value.provider_id,
      path: value.path,
      object_id: value.object_id,
      revision_token: value.revision_token,
      integrity_hash: value.integrity_hash,
      size: value.size
    });
  }
  return upcastDropboxV1Observation(value);
}

function currentObservation(value: ProviderObservation): CurrentManagedProviderObservation {
  return {
    path: value.path,
    file_id: value.object_id,
    rev: value.revision_token,
    content_hash: value.integrity_hash.value,
    size: value.size,
    provider_id: value.provider_id,
    object_id: value.object_id,
    revision_token: value.revision_token,
    integrity_hash: value.integrity_hash
  };
}

function legacyObservation(value: CurrentManagedProviderObservation): ManagedProviderObservation {
  if (value.provider_id !== "dropbox" || value.integrity_hash.algorithm !== "dropbox-content-hash") {
    throw new Error(`Cannot encode provider ${value.provider_id}/${value.integrity_hash.algorithm} as managed-document V1 evidence`);
  }
  return {
    path: value.path,
    file_id: value.object_id,
    rev: value.revision_token,
    content_hash: value.integrity_hash.value,
    size: value.size
  };
}

function currentVersionFromV2(parsed: z.infer<typeof versionV2Schema>): CurrentDocumentVersionRecord {
  const providerEvidence = parsed.provider_evidence ? parseProviderObservation(parsed.provider_evidence) : undefined;
  return {
    ...withoutSchemaVersion(parsed),
    schema_version: "1.0",
    ...(providerEvidence
      ? {
          provider_evidence: providerEvidence,
          provider_content_hash: providerEvidence.integrity_hash.value,
          provider_file_id: providerEvidence.object_id,
          provider_rev: providerEvidence.revision_token,
          provider_path: providerEvidence.path,
          size: providerEvidence.size
        }
      : {})
  };
}

function validateHeadLifecycle(
  value: z.infer<typeof headV2Schema>,
  ctx: z.RefinementCtx
): void {
  if (value.kind === "reference") {
    if (value.working_version_id || value.review_version_id || value.published_version_id) {
      ctx.addIssue({ code: "custom", message: "Reference document heads cannot carry work-product lifecycle pointers" });
    }
    if (value.provider?.working || value.provider?.review || value.provider?.published) {
      ctx.addIssue({ code: "custom", path: ["provider"], message: "Reference heads cannot carry work-product provider observations" });
    }
  } else {
    if (value.reference_version_id || value.collection_path) {
      ctx.addIssue({ code: "custom", message: "Work-product document heads cannot carry reference-only fields" });
    }
    if (value.provider?.reference) {
      ctx.addIssue({ code: "custom", path: ["provider", "reference"], message: "Work-product heads cannot carry reference provider observations" });
    }
  }
  const pairs = [
    [value.reference_version_id, value.provider?.reference, "reference"],
    [value.working_version_id, value.provider?.working, "working"],
    [value.review_version_id, value.provider?.review, "review"],
    [value.published_version_id, value.provider?.published, "published"]
  ] as const;
  for (const [pointer, observation, stage] of pairs) {
    if (!pointer && observation) {
      ctx.addIssue({ code: "custom", path: ["provider", stage], message: `Provider observation ${stage} requires its version pointer` });
    }
  }
}

function withoutSchemaVersion<T extends { schema_version: string }>(value: T): Omit<T, "schema_version"> {
  const { schema_version: _schemaVersion, ...rest } = value;
  return rest;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasUnsafeSegments(path: string): boolean {
  return /[\u0000-\u001F\u007F\\]/.test(path)
    || path.includes("//")
    || path.split("/").some((segment) => segment === "." || segment === "..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
