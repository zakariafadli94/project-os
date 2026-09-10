import { describe, expect, it } from "vitest";
import { advanceAuditCursor, auditCursorFromProgress, chooseQueue, parkActive, withAuditCursor } from "../src/convergence/audit";
import { initialProgress } from "../src/convergence/journal";

describe("convergence coalescence fairness", () => {
  it("reserves at least every other eligible slice for human continuity", () => {
    let last: "machine" | "human" = "human";
    const seen: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const next = chooseQueue(last, true, true);
      if (!next) throw new Error("lost_pending_work");
      seen.push(next);
      last = next;
    }

    expect(seen).toEqual(["machine", "human", "machine", "human", "machine", "human"]);
  });

  it("does not invent work when both queues are empty", () => {
    expect(chooseQueue("machine", false, false)).toBeNull();
  });

  it("parks an active target only after all effects are drained", () => {
    const progress = initialProgress("PRJ-9263", "2026-09-09T00:00:00.000Z", "writer-1");
    progress.active = { revision: 258, projection_version: 3 };

    expect(parkActive(progress)).toMatchObject({
      active: null,
      parked: [{ revision: 258, projection_version: 3 }]
    });
  });

  it("refuses to park a target with an uncertain provider effect", () => {
    const progress = initialProgress("PRJ-9264", "2026-09-09T00:00:00.000Z", "writer-1");
    progress.active = { revision: 258, projection_version: 3 };
    progress.effects["event:258"] = {
      id: "event:258", path: "/event", destination: "/event", kind: "create",
      object_id: null, expected_token: null, desired_hash: null, authorized_previous_hash: null,
      state: "uncertain", verified_token: null
    };

    expect(() => parkActive(progress)).toThrow("inflight_effects_not_drained");
  });

  it("marks an audit complete only after its final cursor page", () => {
    const started = advanceAuditCursor(null, "page-2", "2026-09-09T08:00:00.000Z");
    expect(started).toEqual({ started_at: "2026-09-09T08:00:00.000Z", cursor: "page-2", completed_at: null });
    expect(advanceAuditCursor(started, null, "2026-09-09T08:01:00.000Z"))
      .toEqual({ started_at: "2026-09-09T08:00:00.000Z", cursor: null, completed_at: "2026-09-09T08:01:00.000Z" });
  });

  it("stores typed audit state in a legacy-compatible progress cursor", () => {
    const progress = initialProgress("PRJ-9265", "2026-09-09T08:00:00.000Z", "writer-1");
    const updated = withAuditCursor(progress, "commit_audit", {
      started_at: "2026-09-09T08:00:00.000Z", cursor: "page-2", completed_at: null
    });
    expect(auditCursorFromProgress(updated, "commit_audit")).toMatchObject({ cursor: "page-2" });
    expect(auditCursorFromProgress(progress, "commit_audit")).toBeNull();
  });
});
