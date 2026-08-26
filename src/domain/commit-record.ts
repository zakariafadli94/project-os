import { mayRebaseStaleOperation } from "./concurrency-policy";
import type { DomainEvent } from "./event";
import type { ProjectState } from "./project-state";
import { normalizeProjectState } from "./project-state-normalizer";
import type { Receipt } from "./receipt";
import { parseTransaction, type Transaction } from "./transaction";

export interface CanonicalCommitRecord {
  schema_version: "1.0";
  project_id: string;
  previous_revision: number;
  new_revision: number;
  transaction: Transaction;
  state: ProjectState;
  event: DomainEvent;
  receipt: Receipt & { status: "committed"; event_id: string };
}

export function parseCanonicalCommitRecord(value: unknown): CanonicalCommitRecord {
  const input = requireRecord(value, "canonical commit record");
  if (input.schema_version !== "1.0") throw new Error("Unsupported canonical commit record schema_version");

  const projectId = requireString(input.project_id, "commit record project_id");
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("Invalid commit record project_id");

  const previousRevision = requireNonNegativeInteger(input.previous_revision, "previous_revision");
  const newRevision = requireNonNegativeInteger(input.new_revision, "new_revision");
  if (newRevision !== previousRevision + 1) {
    throw new Error("Canonical commit record revision must be contiguous");
  }

  const transaction = parseTransaction(input.transaction);
  const state = normalizeProjectState(input.state);
  const event = parseEvent(input.event);
  const receipt = parseCommittedReceipt(input.receipt);

  for (const [name, boundProjectId] of [
    ["transaction", transaction.project_id],
    ["state", state.project_id],
    ["event", event.project_id],
    ["receipt", receipt.project_id]
  ] as const) {
    if (boundProjectId !== projectId) {
      throw new Error(`Canonical commit record project binding mismatch for ${name}`);
    }
  }

  if (transaction.base_revision > previousRevision) {
    throw new Error("Transaction base revision cannot be ahead of commit previous_revision");
  }
  if (transaction.base_revision !== previousRevision && !mayRebaseStaleOperation(transaction.operation)) {
    throw new Error("Transaction base revision does not match commit previous_revision");
  }
  if (state.revision !== newRevision) {
    throw new Error("State revision does not match commit new_revision");
  }
  if (event.revision !== newRevision) {
    throw new Error("Event revision does not match commit new_revision");
  }
  if (receipt.previous_revision !== previousRevision || receipt.new_revision !== newRevision) {
    throw new Error("Receipt revisions do not match canonical commit record");
  }
  if (event.transaction_id !== transaction.transaction_id || receipt.transaction_id !== transaction.transaction_id) {
    throw new Error("Transaction binding mismatch inside canonical commit record");
  }
  if (event.type !== transaction.operation) {
    throw new Error("Event operation does not match transaction operation");
  }
  if (state.last_event_id !== event.event_id) {
    throw new Error("State last_event_id does not match commit event");
  }
  if (receipt.event_id !== event.event_id) {
    throw new Error("Receipt event_id does not match commit event");
  }

  return {
    schema_version: "1.0",
    project_id: projectId,
    previous_revision: previousRevision,
    new_revision: newRevision,
    transaction,
    state,
    event,
    receipt
  };
}

function parseEvent(value: unknown): DomainEvent {
  const input = requireRecord(value, "commit event");
  if (input.schema_version !== "1.0") throw new Error("Unsupported commit event schema_version");
  const eventId = requireString(input.event_id, "event_id");
  if (!/^EVT-[0-9]{6,}$/.test(eventId)) throw new Error("Invalid event_id");
  const projectId = requireString(input.project_id, "event project_id");
  const revision = requireNonNegativeInteger(input.revision, "event revision");
  const transactionId = requireString(input.transaction_id, "event transaction_id");
  const type = requireString(input.type, "event type") as DomainEvent["type"];
  const timestamp = requireString(input.timestamp, "event timestamp");
  const payload = requireRecord(input.payload, "event payload");
  return {
    schema_version: "1.0",
    event_id: eventId,
    project_id: projectId,
    revision,
    transaction_id: transactionId,
    type,
    timestamp,
    payload
  };
}

function parseCommittedReceipt(value: unknown): Receipt & { status: "committed"; event_id: string } {
  const input = requireRecord(value, "commit receipt");
  if (input.schema_version !== "1.0") throw new Error("Unsupported commit receipt schema_version");
  if (input.status !== "committed") throw new Error("Canonical commit record requires a committed receipt");
  const eventId = requireString(input.event_id, "receipt event_id");
  return {
    schema_version: "1.0",
    transaction_id: requireString(input.transaction_id, "receipt transaction_id"),
    status: "committed",
    project_id: requireString(input.project_id, "receipt project_id"),
    previous_revision: requireNonNegativeInteger(input.previous_revision, "receipt previous_revision"),
    new_revision: requireNonNegativeInteger(input.new_revision, "receipt new_revision"),
    event_id: eventId,
    ...(typeof input.committed_at === "string" ? { committed_at: input.committed_at } : {})
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}
