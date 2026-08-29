import { z } from "zod";
import {
  artifactRequestIdSchema,
  externalMutationCandidateRecordSchema,
  mutationArtifactRouteSnapshotSchema,
  mutationCandidateIdSchema,
  mutationDetectionSourceSchema,
  mutationIntentIdSchema,
  mutationIntentRecordSchema,
  parseExternalMutationCandidateRecord,
  parseMutationIntentRecord,
  projectIdSchema,
  sha256Schema,
  type ExternalMutationCandidateRecord,
  type MutationIntentRecord
} from "../domain/mutation-gate";
import {
  parseProviderObservation,
  providerIntegrityHashSchema,
  providerObservationSchema,
  upcastDropboxV1Observation,
  type ProviderObservation
} from "./provider-evidence";
import { writesProviderV2, type SchemaWriterStage } from "./writer-stage";
import { unsupportedSchemaVersion } from "./version";

const DROPBOX_PROVIDER_ID = "dropbox";
const DROPBOX_HASH_ALGORITHM = "dropbox-content-hash";

export const currentMutationProviderPreconditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("absent"),
    provider_id: z.string().min(1)
  }),
  z.strictObject({
    kind: z.literal("existing"),
    provider_id: z.string().min(1),
    object_id: z.string().min(1),
    revision_token: z.string().min(1),
    integrity_hash: providerIntegrityHashSchema,
    size: z.number().int().nonnegative().safe()
  })
]);

const intentV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
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
  provider_precondition: currentMutationProviderPreconditionSchema,
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
    ctx.addIssue({ code: "custom", path: ["route_snapshot"], message: "route_snapshot must match route_id" });
  }
  if (value.route_id && !value.route_snapshot) {
    ctx.addIssue({
      code: "custom",
      path: ["route_snapshot"],
      message: "new routed mutation intents require an immutable route snapshot"
    });
  }
});

const candidateV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  candidate_id: mutationCandidateIdSchema,
  project_id: projectIdSchema,
  source: z.literal("external_unverified"),
  detection_source: mutationDetectionSourceSchema,
  provider: providerObservationSchema,
  immutable_payload_path: z.string().min(1),
  detected_at: z.string().min(1).max(128)
}).superRefine((value, ctx) => {
  if (!isProjectWorkspacePath(value.project_id, value.provider.path)) {
    ctx.addIssue({
      code: "custom",
      path: ["provider", "path"],
      message: "provider.path must stay inside the bound project workspace"
    });
  }
  const expectedPrefix = `/PROJECT_OS/.project-os/projects/${value.project_id}/mutation-gate/`;
  if (!isSafeAbsolutePath(value.immutable_payload_path) || !value.immutable_payload_path.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["immutable_payload_path"],
      message: "immutable_payload_path must stay inside the bound project mutation-gate namespace"
    });
  }
});

export type CurrentMutationProviderPrecondition = z.infer<typeof currentMutationProviderPreconditionSchema>;

export type CurrentMutationIntentRecord = Omit<MutationIntentRecord, "schema_version" | "provider_precondition"> & {
  schema_version: "1.0";
  provider_precondition: CurrentMutationProviderPrecondition;
};

export type CurrentExternalMutationCandidateRecord = Omit<
  ExternalMutationCandidateRecord,
  "schema_version" | "provider_path" | "provider_file_id" | "provider_rev" | "provider_content_hash" | "size"
> & {
  schema_version: "1.0";
  provider: ProviderObservation;
};

export interface MutationIntentReadResult {
  sourceVersion: "1.0" | "2.0";
  record: CurrentMutationIntentRecord;
}

export interface ExternalMutationCandidateReadResult {
  sourceVersion: "1.0" | "2.0";
  record: CurrentExternalMutationCandidateRecord;
}

export function readMutationIntentRecord(input: unknown): MutationIntentReadResult {
  const raw = requireRecord(input, "MutationIntent");
  if (raw.schema_version === "1.0") {
    return { sourceVersion: "1.0", record: currentIntentFromV1(parseMutationIntentRecord(raw)) };
  }
  if (raw.schema_version === "2.0") {
    return { sourceVersion: "2.0", record: currentIntentFromV2(intentV2Schema.parse(raw)) };
  }
  return unsupportedSchemaVersion("MutationIntent", raw.schema_version);
}

export function encodeMutationIntentRecord(
  record: CurrentMutationIntentRecord,
  stage: SchemaWriterStage
): unknown {
  if (!writesProviderV2(stage)) {
    return mutationIntentRecordSchema.parse({
      ...record,
      schema_version: "1.0",
      provider_precondition: legacyPrecondition(record.provider_precondition)
    });
  }
  return intentV2Schema.parse({ ...record, schema_version: "2.0" });
}

export function readExternalMutationCandidateRecord(input: unknown): ExternalMutationCandidateReadResult {
  const raw = requireRecord(input, "ExternalMutationCandidate");
  if (raw.schema_version === "1.0") {
    return {
      sourceVersion: "1.0",
      record: currentCandidateFromV1(parseExternalMutationCandidateRecord(raw))
    };
  }
  if (raw.schema_version === "2.0") {
    const parsed = candidateV2Schema.parse(raw);
    return {
      sourceVersion: "2.0",
      record: {
        schema_version: "1.0",
        candidate_id: parsed.candidate_id,
        project_id: parsed.project_id,
        source: parsed.source,
        detection_source: parsed.detection_source,
        provider: parseProviderObservation(parsed.provider),
        immutable_payload_path: parsed.immutable_payload_path,
        detected_at: parsed.detected_at
      }
    };
  }
  return unsupportedSchemaVersion("ExternalMutationCandidate", raw.schema_version);
}

export function encodeExternalMutationCandidateRecord(
  record: CurrentExternalMutationCandidateRecord,
  stage: SchemaWriterStage
): unknown {
  if (!writesProviderV2(stage)) {
    const provider = legacyDropboxObservation(record.provider);
    return externalMutationCandidateRecordSchema.parse({
      schema_version: "1.0",
      candidate_id: record.candidate_id,
      project_id: record.project_id,
      source: record.source,
      detection_source: record.detection_source,
      provider_path: provider.path,
      provider_file_id: provider.file_id,
      provider_rev: provider.rev,
      provider_content_hash: provider.content_hash,
      size: provider.size,
      immutable_payload_path: record.immutable_payload_path,
      detected_at: record.detected_at
    });
  }
  return candidateV2Schema.parse({
    schema_version: "2.0",
    candidate_id: record.candidate_id,
    project_id: record.project_id,
    source: record.source,
    detection_source: record.detection_source,
    provider: record.provider,
    immutable_payload_path: record.immutable_payload_path,
    detected_at: record.detected_at
  });
}

function currentIntentFromV1(record: MutationIntentRecord): CurrentMutationIntentRecord {
  const { provider_precondition, ...business } = record;
  return {
    ...business,
    schema_version: "1.0",
    provider_precondition: provider_precondition.kind === "absent"
      ? { kind: "absent", provider_id: DROPBOX_PROVIDER_ID }
      : {
          kind: "existing",
          provider_id: DROPBOX_PROVIDER_ID,
          object_id: provider_precondition.file_id,
          revision_token: provider_precondition.rev,
          integrity_hash: { algorithm: DROPBOX_HASH_ALGORITHM, value: provider_precondition.content_hash },
          size: provider_precondition.size
        }
  };
}

function currentIntentFromV2(record: z.infer<typeof intentV2Schema>): CurrentMutationIntentRecord {
  const { schema_version: _schemaVersion, ...rest } = record;
  return { ...rest, schema_version: "1.0" };
}

function currentCandidateFromV1(record: ExternalMutationCandidateRecord): CurrentExternalMutationCandidateRecord {
  const provider = upcastDropboxV1Observation({
    provider_path: record.provider_path,
    provider_file_id: record.provider_file_id,
    provider_rev: record.provider_rev,
    provider_content_hash: record.provider_content_hash,
    size: record.size
  });
  return {
    schema_version: "1.0",
    candidate_id: record.candidate_id,
    project_id: record.project_id,
    source: record.source,
    detection_source: record.detection_source,
    provider,
    immutable_payload_path: record.immutable_payload_path,
    detected_at: record.detected_at
  };
}

function legacyPrecondition(precondition: CurrentMutationProviderPrecondition): MutationIntentRecord["provider_precondition"] {
  if (precondition.provider_id !== DROPBOX_PROVIDER_ID) {
    throw new Error(`MutationIntent V1 cannot encode provider ${precondition.provider_id}`);
  }
  if (precondition.kind === "absent") return { kind: "absent" };
  const provider = legacyDropboxObservation({
    provider_id: precondition.provider_id,
    path: "/placeholder",
    object_id: precondition.object_id,
    revision_token: precondition.revision_token,
    integrity_hash: precondition.integrity_hash,
    size: precondition.size
  });
  return {
    kind: "existing",
    file_id: provider.file_id,
    rev: provider.rev,
    content_hash: provider.content_hash,
    size: provider.size
  };
}

function legacyDropboxObservation(provider: ProviderObservation): {
  path: string;
  file_id: string;
  rev: string;
  content_hash: string;
  size: number;
} {
  if (provider.provider_id !== DROPBOX_PROVIDER_ID) {
    throw new Error(`V1 MutationGate evidence cannot encode provider ${provider.provider_id}`);
  }
  if (!/^id:[A-Za-z0-9_-]+$/.test(provider.object_id)) {
    throw new Error(`V1 MutationGate evidence requires a Dropbox file id: ${provider.object_id}`);
  }
  if (provider.integrity_hash.algorithm !== DROPBOX_HASH_ALGORITHM || !/^[a-f0-9]{64}$/.test(provider.integrity_hash.value)) {
    throw new Error("V1 MutationGate evidence requires Dropbox content-hash semantics");
  }
  return {
    path: provider.path,
    file_id: provider.object_id,
    rev: provider.revision_token,
    content_hash: provider.integrity_hash.value,
    size: provider.size
  };
}

function requireRecord(input: unknown, family: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${family} must be an object`);
  }
  return input as Record<string, unknown>;
}

function isProjectWorkspacePath(projectId: string, value: string): boolean {
  const prefix = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-`;
  return isSafeAbsolutePath(value) && value.startsWith(prefix);
}

function isSafeAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("//") || /[\u0000-\u001F\u007F\\]/.test(value)) return false;
  const segments = value.split("/").slice(1);
  return segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}
