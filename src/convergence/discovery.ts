import type { ProjectRepository } from "../persistence/repository";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { Progress, SliceBudget, VerifiedCanonical } from "./contract";
import type { CanonicalCommitRecord } from "../domain/commit-record";

const MAX_DISCOVERY_RECORDS = 128;

export function advanceVerifiedThrough(previous: number, verified: ReadonlySet<number>): number {
  let cursor = previous;
  while (verified.has(cursor + 1)) cursor += 1;
  return cursor;
}

/**
 * Walks only the immutable commit chain. A newer snapshot never makes a
 * missing commit authoritative, so a gap is visible instead of fast-forwarded.
 */
export async function discoverCanonical(
  repository: ProjectRepository,
  _runtime: ProjectOsPersistenceRuntime,
  progress: Progress,
  budget: SliceBudget
): Promise<VerifiedCanonical | null> {
  let cursor = progress.canonical_observed_revision;
  let latest: VerifiedCanonical | null = null;
  const records: CanonicalCommitRecord[] = [];

  for (let read = 0; read < MAX_DISCOVERY_RECORDS; read += 1) {
    if (!budget.canStartEffect(1)) {
      return latest ? { ...latest, complete: false } : null;
    }
    const record = await repository.readCommitRecord(progress.project_id, cursor + 1);
    if (record === null) return latest;
    if (record.previous_revision !== cursor || record.new_revision !== cursor + 1) {
      throw new Error("canonical_commit_chain_gap");
    }
    cursor = record.new_revision;
    records.push(record);
    latest = {
      project_id: record.project_id,
      state: record.state,
      record,
      records,
      baseline_kind: "commit",
      complete: true
    };
  }
  return latest ? { ...latest, complete: false } : null;
}
