import type { Operation } from "./transaction";

export interface DomainEvent {
  schema_version: "1.0";
  event_id: string;
  project_id: string;
  revision: number;
  transaction_id: string;
  type: Operation;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function eventIdForRevision(revision: number): string {
  return `EVT-${revision.toString().padStart(6, "0")}`;
}
