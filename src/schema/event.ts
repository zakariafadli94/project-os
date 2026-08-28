import { z } from "zod";
import type { DomainEvent } from "../domain/event";
import { operationValues } from "../domain/transaction";
import { unsupportedSchemaVersion } from "./version";

const eventSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  event_id: z.string().regex(/^EVT-[0-9]{6,}$/),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  revision: z.number().int().nonnegative(),
  transaction_id: z.string().regex(/^TXN-[A-Z0-9-]{10,}$/),
  type: z.enum(operationValues),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown())
});

function requireRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("DomainEvent must be an object");
  }
  return input as Record<string, unknown>;
}

export function readDomainEvent(input: unknown): DomainEvent {
  const raw = requireRecord(input);
  if (raw.schema_version !== "1.0") {
    return unsupportedSchemaVersion("DomainEvent", raw.schema_version);
  }
  return eventSchema.parse(raw) as DomainEvent;
}
