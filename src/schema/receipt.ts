import { z } from "zod";
import type { Receipt } from "../domain/receipt";
import { unsupportedSchemaVersion } from "./version";

const receiptSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  transaction_id: z.string().regex(/^TXN-[A-Z0-9-]{10,}$/),
  status: z.enum(["committed", "rejected", "conflict"]),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  previous_revision: z.number().int().nonnegative(),
  new_revision: z.number().int().nonnegative(),
  event_id: z.string().regex(/^EVT-[0-9]{6,}$/).optional(),
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  committed_at: z.string().datetime({ offset: true }).optional()
});

function requireRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Receipt must be an object");
  }
  return input as Record<string, unknown>;
}

export function readReceipt(input: unknown): Receipt {
  const raw = requireRecord(input);
  if (raw.schema_version !== "1.0") {
    return unsupportedSchemaVersion("Receipt", raw.schema_version);
  }
  return receiptSchema.parse(raw);
}

export function readCommittedReceipt(
  input: unknown
): Receipt & { status: "committed"; event_id: string } {
  const receipt = readReceipt(input);
  if (receipt.status !== "committed") {
    throw new Error("Canonical commit record requires a committed receipt");
  }
  if (!receipt.event_id) {
    throw new Error("Committed receipt requires event_id");
  }
  return receipt as Receipt & { status: "committed"; event_id: string };
}
