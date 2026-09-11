import { describe, expect, it } from "vitest";
import {
  acknowledgeFleetProjects,
  retainEligibleFleetProjects,
  runFleetWakePage,
  prepareFleetPage,
  orderFleetProjects,
  runMaintenanceJobs
} from "../src/convergence/fleet";
import type { FleetCursor } from "../src/convergence/fleet";
import { fleetLastSuccessMetric } from "../src/convergence/observability";

describe("convergence fleet maintenance", () => {
  it("rotates after the acknowledged project so every project receives the next wake", () => {
    expect(orderFleetProjects([
      "PRJ-0003",
      "PRJ-0001",
      "PRJ-0002"
    ], "PRJ-0001")).toEqual([
      "PRJ-0002",
      "PRJ-0003",
      "PRJ-0001"
    ]);
  });

  it("does not deliver the same project twice when registry input is duplicated", () => {
    expect(orderFleetProjects([
      "PRJ-0002",
      "PRJ-0001",
      "PRJ-0002"
    ], null)).toEqual(["PRJ-0001", "PRJ-0002"]);
  });

  it("prunes a project archived while it is already pending", () => {
    expect(retainEligibleFleetProjects({
      schema_version: "1.0",
      after_project_id: "PRJ-0001",
      pending_project_ids: ["PRJ-0002", "PRJ-0003"],
      turn_started_at: "2026-09-09T07:00:00.000Z",
      last_success_at: null
    }, ["PRJ-0002"])).toMatchObject({ pending_project_ids: ["PRJ-0002"] });
  });

  it("keeps an unacknowledged project pending while advancing acknowledged peers", () => {
    const page = prepareFleetPage({
      schema_version: "1.0",
      after_project_id: "PRJ-0001",
      pending_project_ids: [],
      turn_started_at: "2026-09-09T07:00:00.000Z",
      last_success_at: null
    }, ["PRJ-0001", "PRJ-0002", "PRJ-0003"], "2026-09-09T07:01:00.000Z");
    expect(page.pending_project_ids).toEqual(["PRJ-0002", "PRJ-0003", "PRJ-0001"]);

    expect(acknowledgeFleetProjects(page, ["PRJ-0003", "PRJ-0001"], "2026-09-09T07:02:00.000Z"))
      .toMatchObject({
        after_project_id: "PRJ-0001",
        pending_project_ids: ["PRJ-0002"],
        last_success_at: "2026-09-09T07:02:00.000Z"
      });
  });

  it("persists a page before waking projects and retains only failed wakes", async () => {
    const writes: Array<{ token: string | null; cursor: { pending_project_ids: string[] } }> = [];
    let current: { cursor: FleetCursor; token: string } = {
      cursor: {
        schema_version: "1.0" as const,
        after_project_id: "PRJ-0001",
        pending_project_ids: [],
        turn_started_at: "2026-09-09T07:00:00.000Z",
        last_success_at: null
      },
      token: "token-0"
    };
    const result = await runFleetWakePage({
      read: async () => current,
      write: async (token, cursor) => {
        writes.push({ token, cursor });
        current = { cursor, token: `token-${writes.length}` };
        return current;
      }
    }, ["PRJ-0001", "PRJ-0002", "PRJ-0003"], "2026-09-09T07:01:00.000Z", async (projectId) => projectId !== "PRJ-0003");

    expect(writes[0]).toMatchObject({ token: "token-0", cursor: { pending_project_ids: ["PRJ-0002", "PRJ-0003", "PRJ-0001"] } });
    expect(result.cursor.pending_project_ids).toEqual(["PRJ-0003"]);
  });

  it("wakes up to four fleet projects concurrently before acknowledging the page", async () => {
    let current: { cursor: FleetCursor; token: string } = {
      cursor: {
        schema_version: "1.0", after_project_id: null,
        pending_project_ids: [], turn_started_at: "2026-09-09T07:00:00.000Z", last_success_at: null
      },
      token: "token-0"
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const running = runFleetWakePage({
      read: async () => current,
      write: async (_token, cursor) => {
        current = { cursor, token: "token-1" };
        return current;
      }
    }, ["PRJ-0001", "PRJ-0002", "PRJ-0003", "PRJ-0004", "PRJ-0005"], "2026-09-09T07:01:00.000Z", async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maxInFlight).toBe(4);
    release();
    await running;
  });

  it("does not launch another wake after the maintenance signal is aborted", async () => {
    let current: { cursor: FleetCursor; token: string } = {
      cursor: {
        schema_version: "1.0", after_project_id: null,
        pending_project_ids: [], turn_started_at: "2026-09-09T07:00:00.000Z", last_success_at: null
      },
      token: "token-0"
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const controller = new AbortController();
    const running = runFleetWakePage({
      read: async () => current,
      write: async (_token, cursor) => {
        current = { cursor, token: "token-1" };
        return current;
      }
    }, ["PRJ-0001", "PRJ-0002", "PRJ-0003", "PRJ-0004", "PRJ-0005"], "2026-09-09T07:01:00.000Z", async (projectId) => {
      started.push(projectId);
      await gate;
      return true;
    }, { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    release();
    await running;

    expect(started).toHaveLength(4);
  });

  it("starts convergence and search while inbox remains unresolved", async () => {
    const started: string[] = [];
    let release!: () => void;
    const inbox = new Promise<void>((resolve) => { release = resolve; });

    const running = runMaintenanceJobs([
      { name: "inbox", run: async () => { started.push("inbox"); await inbox; } },
      { name: "convergence", run: async () => { started.push("convergence"); } },
      { name: "search", run: async () => { started.push("search"); } }
    ], 10_000);

    await Promise.resolve();
    expect(started).toEqual(["inbox", "convergence", "search"]);
    release();
    expect((await running).every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("reports an unknown fleet-success age instead of treating a missing cursor as current", () => {
    expect(fleetLastSuccessMetric({
      lastSuccessAt: null,
      nowMs: Date.parse("2026-09-09T08:00:00.000Z"),
      deploymentSha: "e".repeat(40)
    })).toMatchObject({
      name: "fleet_last_success_age",
      kind: "gauge",
      value: -1,
      labels: { layer: "scheduler", code: "fleet_success_unknown", cause: "fleet_success_unknown" },
      fields: {
        project_id: null,
        target_revision: null,
        observed_revision: null,
        deployment_sha: "e".repeat(40),
        provider_calls: 0
      }
    });
  });
});
