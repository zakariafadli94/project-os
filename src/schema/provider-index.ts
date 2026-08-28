import { z } from "zod";
import { providerIntegrityHashSchema } from "./provider-evidence";

const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const documentIdSchema = z.string().regex(/^DOC-[A-F0-9]{24}$/);
const versionIdSchema = z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/);

export const providerFileBindingV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  provider_id: z.string().min(1),
  object_id: z.string().min(1),
  document_id: documentIdSchema
});

export const referenceFingerprintV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectIdSchema,
  provider_id: z.string().min(1),
  integrity_hash: providerIntegrityHashSchema,
  document_id: documentIdSchema,
  version_id: versionIdSchema
});

export type ProviderFileBindingV2Record = z.infer<typeof providerFileBindingV2Schema>;
export type ReferenceFingerprintV2Record = z.infer<typeof referenceFingerprintV2Schema>;

export function parseProviderFileBindingV2(input: unknown): ProviderFileBindingV2Record {
  return providerFileBindingV2Schema.parse(input);
}

export function parseReferenceFingerprintV2(input: unknown): ReferenceFingerprintV2Record {
  return referenceFingerprintV2Schema.parse(input);
}
