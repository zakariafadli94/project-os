import type { Target } from "../convergence/contract";
import type { CanonicalCommitRecord } from "../domain/commit-record";
import type { CompletedMaterializationRecord, MaterializationGenerationRef } from "../domain/materialization";

export interface MaterializationCoverageCursor {
  schema_version: "1.0";
  project_id: string;
  head_revision: number;
  head_projection_version: number;
  head_event_id: string;
  next_parent: MaterializationGenerationRef | null;
  child: Pick<CompletedMaterializationRecord,
    "target_revision" | "projection_version" | "chain_depth" | "record_kind" | "parent">;
  visited: string[];
  covered_targets: Target[];
  coalesced_claims: { target: Target; source_revision: number; source_event_id: string }[];
  lineage_verification: {
    project_id: string;
    target: Target;
    source_revision: number;
    source_event_id: string;
    next_revision: number;
  } | null;
  complete: boolean;
}

export function advanceMaterializationCoverageCursor(
  cursor: MaterializationCoverageCursor,
  parent: Pick<CompletedMaterializationRecord,
    "project_id" | "target_revision" | "projection_version" | "chain_depth" | "record_kind" | "parent" | "source_event_id" | "coalesced_revisions">,
  commit: Pick<CanonicalCommitRecord, "project_id" | "new_revision" | "event">
): boolean {
  const expected = cursor.next_parent;
  const key = `${parent.target_revision}:${parent.projection_version}`;
  if (!expected
    || cursor.visited.includes(key)
    || parent.project_id !== cursor.project_id
    || parent.target_revision !== expected.target_revision
    || parent.target_revision > cursor.child.target_revision
    || parent.projection_version !== expected.projection_version
    || cursor.child.record_kind !== "delta"
    || cursor.child.parent?.target_revision !== parent.target_revision
    || cursor.child.parent.projection_version !== parent.projection_version
    || cursor.child.chain_depth !== parent.chain_depth + 1
    || commit.project_id !== cursor.project_id
    || commit.new_revision !== parent.target_revision
    || parent.source_event_id !== commit.event.event_id) return false;

  cursor.covered_targets.push({
    revision: parent.target_revision,
    projection_version: parent.projection_version
  });
  for (const candidate of parent.coalesced_revisions) {
    if (Number.isSafeInteger(candidate) && candidate >= 1 && candidate < parent.target_revision) {
      cursor.coalesced_claims.push({
        target: { revision: candidate, projection_version: parent.projection_version },
        // The ancestry walk proves this claim's generation lineage. Bind its
        // canonical proof all the way through the verified requested head.
        source_revision: cursor.head_revision,
        source_event_id: cursor.head_event_id
      });
    }
  }
  cursor.visited.push(key);
  cursor.child = {
    target_revision: parent.target_revision,
    projection_version: parent.projection_version,
    chain_depth: parent.chain_depth,
    record_kind: parent.record_kind,
    parent: parent.parent
  };
  cursor.next_parent = parent.parent;
  cursor.complete = parent.record_kind === "snapshot" || parent.parent === null;
  return true;
}

/**
 * A newer verified generation covers an older target only when the immutable
 * materialization lineage explicitly records that target as coalesced. The
 * caller is responsible for validating the record and canonical commit chain
 * before supplying `coalescedRevisions`.
 */
export function materializationCoversTarget(
  candidate: Target,
  verified: Target,
  coveredTargets: readonly Target[]
): boolean {
  if (candidate.projection_version > verified.projection_version) return false;
  return coveredTargets.some((covered) => covered.revision === candidate.revision
    && covered.projection_version >= candidate.projection_version);
}

/** Validate the record/head/event and contiguous canonical lineage before
 * allowing a coalesced revision to acknowledge durable work. */
export function verifiedMaterializationCoverage(
  completed: Pick<CompletedMaterializationRecord,
    "project_id" | "target_revision" | "projection_version" | "source_event_id" | "coalesced_revisions">,
  lineage: readonly Pick<CanonicalCommitRecord,
    "project_id" | "previous_revision" | "new_revision" | "event">[],
  expected: { project_id: string; revision: number; projection_version: number }
): Target[] {
  const head = lineage.at(-1);
  if (completed.project_id !== expected.project_id
    || completed.target_revision !== expected.revision
    || completed.projection_version !== expected.projection_version
    || !head
    || head.project_id !== expected.project_id
    || head.new_revision !== expected.revision
    || completed.source_event_id !== head.event.event_id) return [];

  const coalesced = [...new Set(completed.coalesced_revisions)]
    .filter((candidate) => Number.isSafeInteger(candidate)
      && candidate >= 1
      && candidate < expected.revision
      && expected.revision - candidate <= 200)
    .sort((left, right) => left - right);
  if (coalesced.length === 0) {
    return [{ revision: expected.revision, projection_version: expected.projection_version }];
  }

  const first = coalesced[0]!;
  const chain = lineage.filter((record) => record.new_revision >= first);
  if (chain.length !== expected.revision - first + 1
    || chain.some((record, index) => record.project_id !== expected.project_id
      || record.new_revision !== first + index
      || record.previous_revision !== first + index - 1)) {
    return [{ revision: expected.revision, projection_version: expected.projection_version }];
  }
  return [
    { revision: expected.revision, projection_version: expected.projection_version },
    ...coalesced.map((revision) => ({ revision, projection_version: expected.projection_version }))
  ];
}

export function advanceCanonicalCoverageProof(
  state: { project_id: string; source_revision: number; source_event_id: string; next_revision: number },
  commit: Pick<CanonicalCommitRecord, "project_id" | "previous_revision" | "new_revision" | "event">
): "invalid" | "partial" | "complete" {
  if (commit.project_id !== state.project_id
    || commit.new_revision !== state.next_revision
    || commit.previous_revision !== commit.new_revision - 1) return "invalid";
  if (commit.new_revision === state.source_revision) {
    return commit.event.event_id === state.source_event_id ? "complete" : "invalid";
  }
  if (commit.new_revision > state.source_revision) return "invalid";
  state.next_revision += 1;
  return "partial";
}

export function parseMaterializationCoverageCursor(
  raw: string | null,
  projectId: string,
  headRevision: number,
  headProjectionVersion: number,
  headEventId: string
): MaterializationCoverageCursor | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const cursor = value as Partial<MaterializationCoverageCursor>;
  const lineage = cursor.lineage_verification;
  if (lineage === undefined || !(lineage === null || (Boolean(lineage)
    && lineage.project_id === projectId
    && validMaterializationTarget(lineage.target)
    && Number.isSafeInteger(lineage.source_revision)
    && lineage.source_revision === headRevision
    && lineage.target.revision <= lineage.next_revision
    && lineage.next_revision <= headRevision
    && Number.isSafeInteger(lineage.next_revision)
    && lineage.source_event_id === headEventId))) return null;
  const validTarget = (target: unknown): target is Target => Boolean(target)
    && typeof target === "object"
    && Number.isSafeInteger((target as Target).revision)
    && (target as Target).revision >= 0
    && Number.isSafeInteger((target as Target).projection_version)
    && (target as Target).projection_version >= 1;
  const validParent = (parent: unknown): parent is MaterializationGenerationRef | null => parent === null
    || (Boolean(parent)
      && typeof parent === "object"
      && Number.isSafeInteger((parent as MaterializationGenerationRef).target_revision)
      && (parent as MaterializationGenerationRef).target_revision >= 0
      && Number.isSafeInteger((parent as MaterializationGenerationRef).projection_version)
      && (parent as MaterializationGenerationRef).projection_version >= 1);
  if (cursor.schema_version !== "1.0"
    || cursor.project_id !== projectId
    || cursor.head_revision !== headRevision
    || cursor.head_projection_version !== headProjectionVersion
    || cursor.head_event_id !== headEventId
    || !Array.isArray(cursor.visited)
    || !cursor.visited.every((key) => typeof key === "string")
    || !Array.isArray(cursor.covered_targets)
    || !cursor.covered_targets.every(validTarget)
    || !Array.isArray(cursor.coalesced_claims)
    || !cursor.coalesced_claims.every((claim) => Boolean(claim && typeof claim === "object"
      && validTarget(claim.target)
      && Number.isSafeInteger(claim.source_revision)
      && claim.source_revision === headRevision
      && claim.source_event_id === headEventId))
    || typeof cursor.complete !== "boolean"
    || typeof cursor.head_event_id !== "string"
    || !cursor.child
    || !Number.isSafeInteger(cursor.child.target_revision)
    || !Number.isSafeInteger(cursor.child.projection_version)
    || !Number.isSafeInteger(cursor.child.chain_depth)
    || !["snapshot", "delta"].includes(cursor.child.record_kind ?? "")
    || !validParent(cursor.child.parent)
    || !validParent(cursor.next_parent)) return null;
  return cursor as MaterializationCoverageCursor;
}

function validMaterializationTarget(value: unknown): value is Target {
  return Boolean(value) && typeof value === "object"
    && Number.isSafeInteger((value as Target).revision)
    && (value as Target).revision >= 0
    && Number.isSafeInteger((value as Target).projection_version)
    && (value as Target).projection_version >= 1;
}
