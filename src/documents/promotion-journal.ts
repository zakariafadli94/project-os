import { z } from "zod";
import { machineDocumentPromotionPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { parseProviderObservation, providerObservationSchema } from "../schema/provider-evidence";

const promotionRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  request_id: z.string().regex(/^DOCREQ-[A-Z0-9-]{8,}$/),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  candidate_request_id: z.string().regex(/^ART-[A-Z0-9-]{10,}$/),
  document_id: z.string().regex(/^DOC-[A-F0-9]{24}$/),
  version_id: z.string().regex(/^VER-REQ-[A-F0-9]{24}$/),
  logical_path: z.string().min(1),
  destination_path: z.string().min(1),
  accepted: z.literal(true),
  published: z.literal(true),
  source: providerObservationSchema,
  destination: providerObservationSchema,
  created_at: z.string().min(1).max(128)
});

export type ManagedDocumentPromotionRecord = z.infer<typeof promotionRecordSchema>;

export class ManagedDocumentPromotionJournal {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}

  async write(input: ManagedDocumentPromotionRecord): Promise<void> {
    const record = promotionRecordSchema.parse(input);
    const content = pretty(record);
    const path = machineDocumentPromotionPath(record.project_id, record.request_id);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.read(record.project_id, record.request_id);
      if (!existing || pretty(existing) !== content) {
        throw new Error(`Immutable managed document promotion conflict: ${path}`);
      }
    }
  }

  async read(projectId: string, requestId: string): Promise<ManagedDocumentPromotionRecord | null> {
    const raw = await this.runtime.objects.readText(machineDocumentPromotionPath(projectId, requestId));
    if (raw === null) return null;
    const record = promotionRecordSchema.parse(JSON.parse(raw));
    if (record.project_id !== projectId || record.request_id !== requestId) {
      throw new Error(`Managed document promotion binding mismatch: ${projectId}/${requestId}`);
    }
    parseProviderObservation(record.source);
    parseProviderObservation(record.destination);
    return record;
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
