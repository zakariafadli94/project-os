import { afterEach, expect, it, vi } from "vitest";
import { MaterializationGuard } from "../src/durable/materialization-guard";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SubrequestResilientProjectGuard } from "../src/durable/project-guard-subrequest-resilient";

afterEach(() => vi.restoreAllMocks());

it("preserves a wake scheduled by another request while finalization is unavailable", async () => {
  const targetWake = Date.now() + 60_000;
  let nextAlarm: number | null = null;
  let entered!: () => void;
  let fail!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { fail = resolve; });
  const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
    projectId: "PRJ-0007", layoutMode: "legacy", env: {},
    ctx: { storage: {
      getAlarm: async () => nextAlarm,
      setAlarm: async (at: number) => { nextAlarm = at; }
    } },
    coordinatorForSlice: () => ({ coordinator: { runNext: async () => ({ completed: true, more_work: false }) } }),
    notifyProjectGuardOfCurrentHead: async () => { entered(); await pending; throw new Error("temporary_unavailable"); },
    handleRequestTarget: async () => { nextAlarm = targetWake; return Response.json({ requested: true }); }
  }) as MaterializationGuard;
  const alarm = materialization.alarm().catch(() => {});
  await started;
  await materialization.fetch(new Request("https://materialization-guard.internal/request-target", { method: "POST" }));
  fail();
  await alarm;
  expect(nextAlarm).toBe(targetWake);
});

it("rearms immediately when ProjectGuard bounds a finalization callback", async () => {
  let nextAlarm: number | null = null;
  const before = Date.now();
  const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
    projectId: "PRJ-0008", layoutMode: "legacy", env: {},
    ctx: { storage: {
      getAlarm: async () => nextAlarm,
      setAlarm: async (at: number) => { nextAlarm = at; }
    } },
    coordinatorForSlice: () => ({ coordinator: { runNext: async () => ({ completed: true, more_work: false }) } }),
    notifyProjectGuardOfCurrentHead: async () => false
  }) as MaterializationGuard;

  await materialization.alarm();

  expect(nextAlarm).not.toBeNull();
  expect(nextAlarm!).toBeGreaterThanOrEqual(before + 900);
  expect(nextAlarm!).toBeLessThan(before + 5_000);
});

it("notifies ProjectGuard of an existing head while repair convergence continues", async () => {
  const materialization = Object.assign(Object.create(MaterializationGuard.prototype), {
    projectId: "PRJ-0003",
    layoutMode: "v2",
    env: { PROJECT_OS_CONVERGENCE_PROJECT_MODES: '{"PRJ-0003":"repair"}' },
    ctx: { storage: { setAlarm: async () => {} } },
    resumeConvergenceFromVerifiedHead: async () => {},
    ensureConvergenceRequestedFromLedger: async () => false,
    convergenceEngineForSlice: () => ({
      engine: { runSlice: async () => ({ more_work: true, health: { converged: false }, next_alarm_at: null }) },
      budget: {}
    }),
    scheduleConvergenceContinuation: async () => {}
  }) as MaterializationGuard;
  const notify = vi.spyOn(materialization as any, "notifyProjectGuardOfCurrentHead").mockResolvedValue(true);

  await materialization.alarm();

  expect(notify).toHaveBeenCalledOnce();
});

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
