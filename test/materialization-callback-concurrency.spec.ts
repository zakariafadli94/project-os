import { afterEach, expect, it, vi } from "vitest";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SubrequestResilientProjectGuard } from "../src/durable/project-guard-subrequest-resilient";

afterEach(() => vi.restoreAllMocks());

// Keep both production actors' outer queues and alarm scheduling real. Replace
// only the slice/provider work so the competing requests meet deterministically.
it.each(["repair", "legacy"])("finishes %s finalization while ProjectGuard is waiting for materialization status", async (mode) => {
  let statusEntered!: () => void;
  const statusStarted = new Promise<void>((resolve) => { statusEntered = resolve; });
  const project = Object.assign(Object.create(DiagnosticProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    persistence: {},
    searchSyncStore: null
  }) as DiagnosticProjectGuard;
  const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
    projectId: "PRJ-0007",
    layoutMode: mode === "legacy" ? "legacy" : "v2",
    env: { PROJECT_OS_CONVERGENCE_PROJECT_MODES: mode === "repair" ? '{"PRJ-0007":"repair"}' : undefined },
    ctx: { storage: { setAlarm: async () => {} } },
    resumeConvergenceFromVerifiedHead: async () => {},
    ensureConvergenceRequestedFromLedger: async () => false,
    convergenceEngineForSlice: () => ({ engine: { runSlice: async () => {
      await statusStarted;
      return { more_work: false, health: { converged: true }, next_alarm_at: null };
    } }, budget: {} }),
    coordinatorForSlice: () => ({ coordinator: { runNext: async () => {
      await statusStarted;
      return { completed: true, more_work: false };
    } } }),
    scheduleConvergenceContinuation: async () => {},
    handleStatus: async () => Response.json({ materialized_revision: 82 }),
    notifyProjectGuardOfCurrentHead: async () => {
      const response = await project.fetch(new Request("https://project-guard.internal/finalize-materialization", { method: "POST" }));
      expect(response.status).toBe(200);
    }
  }) as MaterializationGuard;
  vi.spyOn(SubrequestResilientProjectGuard.prototype, "fetch").mockImplementation(async (request) => {
    if (new URL(request.url).pathname === "/materialization-status") {
      statusEntered();
      return materialization.fetch(new Request("https://materialization-guard.internal/status"));
    }
    return Response.json({ finalized_revisions: [82] });
  });
  const alarm = materialization.alarm();
  const status = project.fetch(new Request("https://project-guard.internal/materialization-status"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([alarm, status.then((response) => response.json())]).then(([, body]) => body),
      new Promise((resolve) => { timer = setTimeout(() => resolve("cross_actor_deadlock"), 200); })
    ]);
    expect(result).toEqual({ materialized_revision: 82 });
  } finally {
    if (timer) clearTimeout(timer);
  }
});
