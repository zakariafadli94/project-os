export interface MaintenanceJob {
  name: "inbox" | "convergence" | "search";
  run(signal: AbortSignal): Promise<unknown>;
}

export interface FleetCursor {
  schema_version: "1.0";
  after_project_id: string | null;
  pending_project_ids: string[];
  turn_started_at: string;
  last_success_at: string | null;
}

export interface FleetCursorStore {
  read(): Promise<{ cursor: FleetCursor; token: string }>;
  write(expectedToken: string | null, cursor: FleetCursor): Promise<{ cursor: FleetCursor; token: string }>;
}

export const FLEET_WAKE_CONCURRENCY = 4;

export interface FleetWakeOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

export function orderFleetProjects(
  projectIds: readonly string[],
  afterProjectId: string | null
): string[] {
  const ordered = [...new Set(projectIds)].sort();
  if (afterProjectId === null) return ordered;
  const index = ordered.indexOf(afterProjectId);
  if (index < 0) return ordered;
  return [...ordered.slice(index + 1), ...ordered.slice(0, index + 1)];
}

export function prepareFleetPage(
  cursor: FleetCursor,
  projectIds: readonly string[],
  now: string
): FleetCursor {
  if (cursor.pending_project_ids.length > 0) return cursor;
  return {
    ...cursor,
    pending_project_ids: orderFleetProjects(projectIds, cursor.after_project_id),
    turn_started_at: now
  };
}

export function retainEligibleFleetProjects(
  cursor: FleetCursor,
  eligibleProjectIds: readonly string[]
): FleetCursor {
  const eligible = new Set(eligibleProjectIds);
  const pendingProjectIds = cursor.pending_project_ids.filter((projectId) => eligible.has(projectId));
  if (pendingProjectIds.length === cursor.pending_project_ids.length) return cursor;
  return { ...cursor, pending_project_ids: pendingProjectIds };
}

export function acknowledgeFleetProjects(
  cursor: FleetCursor,
  acknowledgedProjectIds: readonly string[],
  now: string
): FleetCursor {
  const acknowledged = new Set(acknowledgedProjectIds);
  const delivered = cursor.pending_project_ids.filter((projectId) => acknowledged.has(projectId));
  if (delivered.length === 0) return cursor;
  return {
    ...cursor,
    after_project_id: delivered.at(-1) ?? cursor.after_project_id,
    pending_project_ids: cursor.pending_project_ids.filter((projectId) => !acknowledged.has(projectId)),
    last_success_at: now
  };
}

export async function runFleetWakePage(
  store: FleetCursorStore,
  projectIds: readonly string[],
  now: string,
  wake: (projectId: string, signal?: AbortSignal) => Promise<boolean>,
  options: FleetWakeOptions = {}
): Promise<{ cursor: FleetCursor; token: string }> {
  const current = await store.read();
  const page = prepareFleetPage(current.cursor, projectIds, now);
  const persisted = await store.write(current.token, page);
  const concurrency = options.concurrency ?? FLEET_WAKE_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("invalid_fleet_wake_concurrency");
  const pending = persisted.cursor.pending_project_ids;
  const succeeded = new Set<string>();
  let next = 0;
  const runWakeWorker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const projectId = pending[next];
      next += 1;
      if (projectId === undefined) return;
      if (await wake(projectId, options.signal)) succeeded.add(projectId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runWakeWorker));
  const acknowledged = pending.filter((projectId) => succeeded.has(projectId));
  const settled = acknowledgeFleetProjects(persisted.cursor, acknowledged, now);
  return store.write(persisted.token, settled);
}

export async function runMaintenanceJobs(
  jobs: readonly MaintenanceJob[],
  timeoutMs: number
): Promise<PromiseSettledResult<unknown>[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_maintenance_timeout");
  return Promise.allSettled(jobs.map(async (job) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${job.name}_timeout`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([job.run(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
}
