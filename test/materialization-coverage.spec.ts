import { describe, expect, it } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import {
  advanceMaterializationCoverageCursor,
  materializationCoversTarget,
  verifiedMaterializationCoverage,
  type MaterializationCoverageCursor
} from "../src/materialization/coverage";
import { commitFixture } from "./helpers/convergence-fixture";

describe("verified materialization coverage", () => {
  it("covers a coalesced 309 target with a verified 310 head but not a newer 312 target", () => {
    expect(materializationCoversTarget(
      { revision: 309, projection_version: 6 },
      { revision: 310, projection_version: 6 },
      [{ revision: 309, projection_version: 6 }]
    )).toBe(true);
    expect(materializationCoversTarget(
      { revision: 312, projection_version: 6 },
      { revision: 310, projection_version: 6 },
      [{ revision: 309, projection_version: 6 }]
    )).toBe(false);
  });

  it("does not infer coverage of 309 from a numerically newer 310 head", () => {
    expect(materializationCoversTarget(
      { revision: 309, projection_version: 6 },
      { revision: 310, projection_version: 6 },
      []
    )).toBe(false);
  });

  it("covers the exact head directly and never crosses projection generations", () => {
    expect(materializationCoversTarget(
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      [{ revision: 310, projection_version: CURRENT_PROJECTION_VERSION }]
    )).toBe(true);
    expect(materializationCoversTarget(
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION + 1 },
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      [{ revision: 309, projection_version: CURRENT_PROJECTION_VERSION }]
    )).toBe(false);
  });

  it("accepts only explicitly coalesced revisions with a contiguous, head-bound canonical chain", () => {
    const projectId = "PRJ-8391";
    const commits = commitFixture(projectId, 310);
    const completed = {
      project_id: projectId,
      target_revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION,
      source_event_id: commits[309]!.event.event_id,
      coalesced_revisions: [309]
    };
    const verified = verifiedMaterializationCoverage(completed, commits.slice(308), {
      project_id: projectId,
      revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION
    });
    expect(verified).toEqual([
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION }
    ]);
    expect(materializationCoversTarget(
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      verified
    )).toBe(true);
    expect(materializationCoversTarget(
      { revision: 312, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      verified
    )).toBe(false);
  });

  it("leaves the 309 obligation open without a coalescence claim or a valid commit chain", () => {
    const projectId = "PRJ-8392";
    const commits = commitFixture(projectId, 310);
    const completed = {
      project_id: projectId,
      target_revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION,
      source_event_id: commits[309]!.event.event_id,
      coalesced_revisions: []
    };
    expect(verifiedMaterializationCoverage(completed, commits.slice(308), {
      project_id: projectId,
      revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION
    })).toEqual([{ revision: 310, projection_version: CURRENT_PROJECTION_VERSION }]);

    const corruptLineage = commits.slice(308);
    corruptLineage[0] = { ...corruptLineage[0]!, previous_revision: 307 };
    expect(verifiedMaterializationCoverage({ ...completed, coalesced_revisions: [309] }, corruptLineage, {
      project_id: projectId,
      revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION
    })).toEqual([{ revision: 310, projection_version: CURRENT_PROJECTION_VERSION }]);
  });

  it("discovers a coalesced obligation through a verified materialization ancestor", () => {
    const projectId = "PRJ-8394";
    const commits = commitFixture(projectId, 312);
    const cursor: MaterializationCoverageCursor = {
      schema_version: "1.0",
      project_id: projectId,
      head_revision: 312,
      head_projection_version: CURRENT_PROJECTION_VERSION,
      head_event_id: commits[311]!.event.event_id,
      next_parent: { target_revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      child: {
        target_revision: 312,
        projection_version: CURRENT_PROJECTION_VERSION,
        chain_depth: 2,
        record_kind: "delta",
        parent: { target_revision: 310, projection_version: CURRENT_PROJECTION_VERSION }
      },
      visited: [`312:${CURRENT_PROJECTION_VERSION}`],
      covered_targets: [{ revision: 312, projection_version: CURRENT_PROJECTION_VERSION }],
      coalesced_claims: [],
      lineage_verification: null,
      complete: false
    };
    const ancestor = {
      project_id: projectId,
      target_revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION,
      chain_depth: 1,
      record_kind: "delta" as const,
      parent: { target_revision: 309, projection_version: CURRENT_PROJECTION_VERSION },
      source_event_id: commits[309]!.event.event_id,
      coalesced_revisions: [309]
    };

    expect(advanceMaterializationCoverageCursor(cursor, ancestor, commits[309]!)).toBe(true);
    expect(materializationCoversTarget(
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 312, projection_version: CURRENT_PROJECTION_VERSION },
      cursor.covered_targets
    )).toBe(false);
    const lineage = verifiedMaterializationCoverage({
      project_id: projectId,
      target_revision: 310,
      projection_version: CURRENT_PROJECTION_VERSION,
      source_event_id: ancestor.source_event_id,
      coalesced_revisions: [309]
    }, commits.slice(308, 310), {
      project_id: projectId, revision: 310, projection_version: CURRENT_PROJECTION_VERSION
    });
    expect(lineage).toEqual([
      { revision: 310, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION }
    ]);
    cursor.covered_targets.push(...lineage);
    expect(materializationCoversTarget(
      { revision: 309, projection_version: CURRENT_PROJECTION_VERSION },
      { revision: 312, projection_version: CURRENT_PROJECTION_VERSION },
      cursor.covered_targets
    )).toBe(true);
    expect(cursor.next_parent).toEqual({ target_revision: 309, projection_version: CURRENT_PROJECTION_VERSION });
  });

  it("refuses future-revision parents but permits same-revision reprojection ancestry", () => {
    const projectId = "PRJ-8398";
    const commits = commitFixture(projectId, 313);
    const child = {
      target_revision: 312,
      projection_version: CURRENT_PROJECTION_VERSION,
      chain_depth: 2,
      record_kind: "delta" as const,
      parent: { target_revision: 313, projection_version: CURRENT_PROJECTION_VERSION }
    };
    const cursor: MaterializationCoverageCursor = {
      schema_version: "1.0",
      project_id: projectId,
      head_revision: 312,
      head_projection_version: CURRENT_PROJECTION_VERSION,
      head_event_id: commits[311]!.event.event_id,
      next_parent: child.parent,
      child,
      visited: [`312:${CURRENT_PROJECTION_VERSION}`],
      covered_targets: [{ revision: 312, projection_version: CURRENT_PROJECTION_VERSION }],
      coalesced_claims: [],
      lineage_verification: null,
      complete: false
    };
    const futureParent = {
      project_id: projectId,
      target_revision: 313,
      projection_version: CURRENT_PROJECTION_VERSION,
      chain_depth: 1,
      record_kind: "delta" as const,
      parent: { target_revision: 312, projection_version: CURRENT_PROJECTION_VERSION },
      source_event_id: commits[312]!.event.event_id,
      coalesced_revisions: [312]
    };
    expect(advanceMaterializationCoverageCursor(cursor, futureParent, commits[312]!)).toBe(false);

    const reprojectionCursor: MaterializationCoverageCursor = {
      ...cursor,
      next_parent: { target_revision: 312, projection_version: CURRENT_PROJECTION_VERSION - 1 },
      child: {
        ...child,
        parent: { target_revision: 312, projection_version: CURRENT_PROJECTION_VERSION - 1 }
      }
    };
    const sameRevisionParent = {
      ...futureParent,
      target_revision: 312,
      projection_version: CURRENT_PROJECTION_VERSION - 1,
      chain_depth: 1,
      parent: null,
      source_event_id: commits[311]!.event.event_id
    };
    expect(advanceMaterializationCoverageCursor(reprojectionCursor, sameRevisionParent, commits[311]!)).toBe(true);
  });
});
