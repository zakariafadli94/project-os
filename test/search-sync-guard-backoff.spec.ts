import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;
const FAILURE_COUNT_KEY = "search-sync-failure-count-v1";
const FAST_RETRY_DELAY_MS = 1_000;
const DEFER_DELAY_MS = 300_000;

async function retryState(projectId: string): Promise<{ failureCount: number; alarmAt: number | null }> {
  const stub = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
  return runInDurableObject(stub, async (_instance, state) => ({
    failureCount: await state.storage.get<number>(FAILURE_COUNT_KEY) ?? 0,
    alarmAt: await state.storage.getAlarm()
  }));
}

function failingProjectGuard(status = 503): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => Response.json({ error: "search_down" }, { status }))
  };
}

describe("SearchSyncGuard durable retry backoff", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bounds fast retries and defers persistent failures after five attempts", async () => {
    const projectId = "PRJ-7191";
    const stub = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    vi.spyOn(testEnv.PROJECT_GUARD, "getByName").mockReturnValue(failingProjectGuard() as never);

    expect((await stub.fetch("https://search-sync.internal/wake", { method: "POST" })).status).toBe(200);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const before = Date.now();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const state = await retryState(projectId);
      expect(state.failureCount).toBe(attempt);
      expect(state.alarmAt).not.toBeNull();
      expect(state.alarmAt! - before).toBeGreaterThanOrEqual(FAST_RETRY_DELAY_MS - 100);
      expect(state.alarmAt! - before).toBeLessThan(30_000);
    }

    const beforeDeferred = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const deferred = await retryState(projectId);
    expect(deferred.failureCount).toBe(6);
    expect(deferred.alarmAt).not.toBeNull();
    expect(deferred.alarmAt! - beforeDeferred).toBeGreaterThanOrEqual(DEFER_DELAY_MS - 5_000);
  });

  it("persists failure state across a simulated eviction boundary", async () => {
    const projectId = "PRJ-7192";
    const stub = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    vi.spyOn(testEnv.PROJECT_GUARD, "getByName").mockReturnValue(failingProjectGuard() as never);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(FAILURE_COUNT_KEY, 5);
      await state.storage.setAlarm(Date.now() + FAST_RETRY_DELAY_MS);
    });

    // A new Durable Object execution must recover the retry count from storage,
    // not from an in-memory field that would disappear after eviction.
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = await retryState(projectId);
    expect(state.failureCount).toBe(6);
    expect(state.alarmAt).not.toBeNull();
    expect(state.alarmAt! - before).toBeGreaterThanOrEqual(DEFER_DELAY_MS - 5_000);
  });

  it("resets durable failure state after a successful drain and keeps successful continuation fast", async () => {
    const projectId = "PRJ-7193";
    const stub = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    let mode: "fail" | "done" | "more" = "fail";
    const guard = {
      fetch: vi.fn(async () => {
        if (mode === "fail") return Response.json({ error: "search_down" }, { status: 503 });
        return Response.json({ more_work: mode === "more" });
      })
    };
    vi.spyOn(testEnv.PROJECT_GUARD, "getByName").mockReturnValue(guard as never);

    await stub.fetch("https://search-sync.internal/wake", { method: "POST" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await retryState(projectId)).failureCount).toBe(2);

    mode = "done";
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await retryState(projectId)).toEqual({ failureCount: 0, alarmAt: null });

    mode = "more";
    await stub.fetch("https://search-sync.internal/wake", { method: "POST" });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const continued = await retryState(projectId);
    expect(continued.failureCount).toBe(0);
    expect(continued.alarmAt).not.toBeNull();
    expect(continued.alarmAt! - before).toBeGreaterThanOrEqual(FAST_RETRY_DELAY_MS - 100);
    expect(continued.alarmAt! - before).toBeLessThan(30_000);
  });

  it("coalesces wake requests without shortening an existing failure backoff", async () => {
    const projectId = "PRJ-7194";
    const stub = testEnv.SEARCH_SYNC_GUARD.getByName(projectId);
    vi.spyOn(testEnv.PROJECT_GUARD, "getByName").mockReturnValue(failingProjectGuard() as never);

    await stub.fetch("https://search-sync.internal/wake", { method: "POST" });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    const beforeWake = await retryState(projectId);
    expect(beforeWake.failureCount).toBe(6);
    expect(beforeWake.alarmAt).not.toBeNull();

    expect((await stub.fetch("https://search-sync.internal/wake", { method: "POST" })).status).toBe(200);
    const afterWake = await retryState(projectId);
    expect(afterWake.failureCount).toBe(6);
    expect(afterWake.alarmAt).toBe(beforeWake.alarmAt);
  });
});
