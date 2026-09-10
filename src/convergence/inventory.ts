import type {
  IntegrityInventoryReport,
  IntegrityInventorySurface,
  IntegrityProjectReport,
  IntegritySurfaceObservation
} from "./integrity-contract";

export type { IntegrityInventorySurface } from "./integrity-contract";

export interface IntegrityInventoryReader {
  listProjects(cursor: string | null, limit: number): Promise<{ projectIds: string[]; cursor: string | null }>;
  read(
    projectId: string,
    surface: IntegrityInventorySurface
  ): Promise<Pick<IntegritySurfaceObservation, "state" | "identity">>;
}

export async function auditIntegrityInventory(
  reader: IntegrityInventoryReader,
  options: { surfaces: readonly IntegrityInventorySurface[]; pageLimit: number; startCursor?: string | null }
): Promise<IntegrityInventoryReport> {
  if (!Number.isSafeInteger(options.pageLimit) || options.pageLimit < 1) {
    throw new Error("invalid_inventory_page_limit");
  }

  const projects: IntegrityProjectReport[] = [];
  let cursor: string | null = options.startCursor ?? null;
  let pages = 0;
  do {
    if (pages >= options.pageLimit) {
      return { readonly: true, projects, complete: false, next_cursor: cursor };
    }
    const page = await reader.listProjects(cursor, options.pageLimit);
    pages += 1;
    for (const projectId of page.projectIds) {
      const surfaces: IntegrityProjectReport["surfaces"] = {};
      for (const surface of options.surfaces) {
        try {
          const observed = await reader.read(projectId, surface);
          surfaces[surface] = { ...observed, code: null };
        } catch (error) {
          surfaces[surface] = {
            state: "unknown",
            identity: null,
            code: error instanceof Error ? error.message : "inventory_read_failed"
          };
        }
      }
      projects.push({ project_id: projectId, surfaces, anomalies: anomaliesFor(surfaces) });
    }
    cursor = page.cursor;
  } while (cursor !== null);

  return { readonly: true, projects, complete: true, next_cursor: null };
}

function anomaliesFor(surfaces: IntegrityProjectReport["surfaces"]): string[] {
  const anomalies: string[] = [];
  for (const surface of ["event", "receipt"] as const) {
    const observation = surfaces[surface];
    if (observation?.state === "missing" && observation.identity !== null) {
      anomalies.push(`missing_${surface}:${revisionIdentity(observation.identity)}`);
    }
  }
  return anomalies;
}

function revisionIdentity(identity: string): string {
  const match = identity.match(/REV-\d{6}/);
  return match?.[0] ?? identity;
}
