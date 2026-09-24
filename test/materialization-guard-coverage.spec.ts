import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSliceBudget } from "../src/convergence/budget";
import type { Obligation, SliceBudget } from "../src/convergence/contract";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { CompletedMaterializationRecord } from "../src/domain/materialization";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

function obligation(revision: number, projectId: string): Obligation {
  return {
    id: `${revision}`.padStart(64, "0"), layer: "human_handoff", from_revision: 0,
    target: { revision, projection_version: CURRENT_PROJECTION_VERSION }, incident: 1,
    state: "pending", first_pending_at: "2026-09-24T00:00:00.000Z", next_attempt_at: null,
    failure_count: 0, last_attempt_number: 0, last_closed_attempt_number: 0, last_verified_at: null,
    code: null, lease_until: null, continuation: null
  };
}

function generations(projectId: string, commits: CanonicalCommitRecord[]): Map<string, CompletedMaterializationRecord> {
  const make = (revision: number, recordKind: "snapshot" | "delta", parent: number | null, depth: number, coalesced: number[]) => ({
    schema_version: "1.0" as const, project_id: projectId, target_revision: revision,
    projection_version: CURRENT_PROJECTION_VERSION, record_kind: recordKind,
    parent: parent === null ? null : { target_revision: parent, projection_version: CURRENT_PROJECTION_VERSION },
    chain_depth: depth, workspace_location: "active" as const, outputs: {}, removed_outputs: [],
    total_output_count: 0, result_root_hash: "a".repeat(64), coalesced_revisions: coalesced,
    source_event_id: commits[revision - 1]!.event.event_id, completed_at: "2026-09-24T00:00:00.000Z"
  });
  return new Map([
    [`310:${CURRENT_PROJECTION_VERSION}`, make(310, "delta", 308, 1, [309])],
    [`308:${CURRENT_PROJECTION_VERSION}`, make(308, "snapshot", null, 0, [])],
    [`312:${CURRENT_PROJECTION_VERSION}`, make(312, "delta", 310, 2, [])]
  ]);
}

async function collect(
  projectId: string,
  breakAt311 = false,
  cursorJson: string | null = null,
  budget?: SliceBudget,
  coalesced: number[] = [309],
  obligationOrder: number[] = [309, 310, 312, 307]
) {
  const commits = commitFixture(projectId, 312);
  if (breakAt311) commits[310] = { ...commits[310]!, previous_revision: 309 };
  const records = generations(projectId, commits);
  const ancestor = records.get(`310:${CURRENT_PROJECTION_VERSION}`)!;
  records.set(`310:${CURRENT_PROJECTION_VERSION}`, { ...ancestor, coalesced_revisions: coalesced });
  const repository = {
    readMaterializationRecord: async (_project: string, revision: number, version: number) => records.get(`${revision}:${version}`) ?? null,
    readCommitRecord: async (_project: string, revision: number) => commits[revision - 1] ?? null
  };
  const guard = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
  return runInDurableObject(guard, (instance) => (instance as any).collectVerifiedCoverage(
    repository, cursorJson, 312, CURRENT_PROJECTION_VERSION,
    budget ?? createSliceBudget(() => Date.now(), new AbortController().signal),
    Object.fromEntries(obligationOrder.map((revision) => [
      `target${revision}`,
      obligation(revision, projectId)
    ]))
  ) as Promise<{
    covered_targets: Array<{ revision: number; projection_version: number }>;
    lineage_verification: { target: { revision: number; projection_version: number }; next_revision: number } | null;
  } | null>);
}

describe("MaterializationGuard coverage acknowledgement proof", () => {
  it("covers actual 309/310/312 work through the generation ancestor and canonical lineage", async () => {
    installDropboxMock();
    const projectId = "PRJ-8395";
    const cursor = await collect(projectId);
    expect(cursor?.covered_targets).toEqual(expect.arrayContaining([
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 312, projection_version: CURRENT_PROJECTION_VERSION }
    ]));
  });

  it("refuses to cover coalesced 309 when canonical continuity to generation 310/head 312 has a hole", async () => {
    installDropboxMock();
    const projectId = "PRJ-8396";
    const cursor = await collect(projectId, true);
    expect(cursor?.covered_targets).not.toContainEqual({ revision: 309, projection_version: CURRENT_PROJECTION_VERSION });
    expect(cursor?.covered_targets).toContainEqual({ revision: 310, projection_version: CURRENT_PROJECTION_VERSION });
    expect(cursor?.covered_targets).toContainEqual({ revision: 312, projection_version: CURRENT_PROJECTION_VERSION });
  });

  it("resumes a bounded 309 proof before scanning another coalesced target", async () => {
    installDropboxMock();
    const projectId = "PRJ-8397";
    let checks = 0;
    const partialBudget: SliceBudget = {
      deadline_ms: Date.now() + 25_000, calls_left: 32, now: () => Date.now(), signal: new AbortController().signal,
      beforeHttp: () => undefined,
      canStartEffect: () => { checks += 1; return checks <= 5; }
    };
    const first = await collect(projectId, false, null, partialBudget, [307, 309]);
    expect(first?.lineage_verification).toMatchObject({ target: { revision: 309 }, next_revision: 311 });
    expect(first?.covered_targets).not.toContainEqual({ revision: 309, projection_version: CURRENT_PROJECTION_VERSION });

    const resumed = await collect(projectId, false, JSON.stringify(first), undefined, [307, 309]);
    expect(resumed?.covered_targets).toContainEqual({ revision: 309, projection_version: CURRENT_PROJECTION_VERSION });
    expect(resumed?.covered_targets).toContainEqual({ revision: 307, projection_version: CURRENT_PROJECTION_VERSION });
  });

  it("resumes the saved lineage target before obligations that reordered ahead of it", async () => {
    installDropboxMock();
    const projectId = "PRJ-8399";
    let checks = 0;
    const partialBudget: SliceBudget = {
      deadline_ms: Date.now() + 25_000, calls_left: 32, now: () => Date.now(), signal: new AbortController().signal,
      beforeHttp: () => undefined,
      canStartEffect: () => ++checks <= 5
    };
    const first = await collect(projectId, false, null, partialBudget, [307, 309]);
    expect(first?.lineage_verification?.target.revision).toBe(309);

    let resumeChecks = 0;
    const oneStepBudget: SliceBudget = {
      deadline_ms: Date.now() + 25_000, calls_left: 32, now: () => Date.now(), signal: new AbortController().signal,
      beforeHttp: () => undefined,
      canStartEffect: () => ++resumeChecks <= 2
    };
    const resumed = await collect(
      projectId,
      false,
      JSON.stringify(first),
      oneStepBudget,
      [307, 309],
      [307, 309, 310, 312]
    );
    expect(resumed?.lineage_verification).toMatchObject({ target: { revision: 309 }, next_revision: 312 });
  });
});
