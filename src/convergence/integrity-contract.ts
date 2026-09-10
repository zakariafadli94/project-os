export const INTEGRITY_SURFACES = [
  "commit",
  "transaction_committed",
  "event",
  "receipt",
  "state",
  "manifest",
  "generation",
  "head",
  "project",
  "plan",
  "roadmap",
  "handoff",
  "artifacts",
  "managed_document_heads",
  "index_search",
  "checkpoint"
] as const;

export type IntegrityInventorySurface = typeof INTEGRITY_SURFACES[number];
export type IntegritySurfaceState =
  | "current"
  | "intentionally_unchanged"
  | "pending"
  | "missing"
  | "unknown"
  | "blocked";

export interface IntegritySurfaceObservation {
  state: IntegritySurfaceState;
  identity: string | null;
  code: string | null;
}

export interface IntegrityProjectReport {
  project_id: string;
  surfaces: Partial<Record<IntegrityInventorySurface, IntegritySurfaceObservation>>;
  anomalies: string[];
}

export interface IntegrityInventoryReport {
  readonly: true;
  projects: IntegrityProjectReport[];
  complete: boolean;
  next_cursor: string | null;
}
