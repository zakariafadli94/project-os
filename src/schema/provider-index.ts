import { z } from "zod";
import { providerIntegrityHashSchema } from "./provider-evidence";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentIdSchema = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionIdSchema = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);
const dropboxFileIdSchema = z.string().regex(/^id:[A-Za-z0-9_-]+$/);
const dropboxContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const providerFileBindingV1Schema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  provider_file_id: dropboxFileIdSchema,
  document_id: documentIdSchema
});

export const providerFileBindingV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  provider_id: z.string().min(1),
  object_id: z.string().min(1),
  document_id: documentIdSchema
});

export const referenceFingerprintV1Schema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectIdSchema,
  provider_content_hash: dropboxContentHashSchema,
  document_id: documentIdSchema,
  version_id: versionIdSchema
});

export const referenceFingerprintV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  provider_id: z.string().min(1),
  integrity_hash: providerIntegrityHashSchema,
  document_id: documentIdSchema,
  version_id: versionIdSchema
});

export type ProviderFileBindingV1Record = z.infer<typeof providerFileBindingV1Schema>;
export type ProviderFileBindingV2Record = z.infer<typeof providerFileBindingV2Schema>;
export type ReferenceFingerprintV1Record = z.infer<typeof referenceFingerprintV1Schema>;
export type ReferenceFingerprintV2Record = z.infer<typeof referenceFingerprintV2Schema>;

export function parseProviderFileBindingV1(input: unknown): ProviderFileBindingV1Record {
  return providerFileBindingV1Schema.parse(input);
}

export function parseProviderFileBindingV2(input: unknown): ProviderFileBindingV2Record {
  return providerFileBindingV2Schema.parse(input);
}

export function parseReferenceFingerprintV1(input: unknown): ReferenceFingerprintV1Record {
  return referenceFingerprintV1Schema.parse(input);
}

export function parseReferenceFingerprintV2(input: unknown): ReferenceFingerprintV2Record {
  return referenceFingerprintV2Schema.parse(input);
}
