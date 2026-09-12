import { afterEach, describe, expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({ code: "INTERNAL_RENDER_A", calls: 0 }));
vi.mock("../src/convergence/human", () => ({ runHumanSlice: async () => { fault.calls++; throw new Error(fault.code); } }));
import { ConvergenceEngine, stableHumanFailureIdentity } from "../src/convergence/engine";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { unknownHealth } from "../src/convergence/health";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { commitFixture } from "./helpers/convergence-fixture";
afterEach(() => vi.restoreAllMocks());

function setup() {
  fault.code = "INTERNAL_RENDER_A"; fault.calls = 0;
  const mock = installDropboxMock();
  const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
  const projectId = "PRJ-8297";
  const journal = new ConvergenceJournal(runtime, projectId);
  const progress = initialProgress(projectId, new Date(0).toISOString(), "writer-test");
  const outputs = new Map();
  let now = 0;
  const engine = new ConvergenceEngine({ projectId, runtime, journal, repository: {} as never, ledger: { attemptOutputs: () => outputs } as never, now: () => now, enableHuman: true });
  const run = async () => {
    now += 1_000_000;
    await (engine as any).runHumanWithRetry(commitFixture(projectId, 1)[0], progress, { deadline_ms: now + 1000, calls_left: 100, now: () => now, signal: new AbortController().signal, beforeHttp: () => {}, canStartEffect: () => true }, unknownHealth(projectId, new Date(now).toISOString()));
  };
  return { progress, outputs, mock, run };
}

describe("shared convergence internal-failure boundary", () => {
  it("fingerprints stable diagnostic codes, excluding free text, time and provider request IDs", () => {
    const first = Object.assign(new Error("failure at 1 request abc"), { code: "INTERNAL_RENDER" });
    const later = Object.assign(new Error("failure at 2 request def"), { code: "INTERNAL_RENDER" });
    expect(stableHumanFailureIdentity(first)).toBe(stableHumanFailureIdentity(later));
    expect(stableHumanFailureIdentity(first)).not.toBe(stableHumanFailureIdentity(Object.assign(new Error("other"), { code: "INTERNAL_OTHER" })));
  });
  it("stops six identical human internal failures and writes an existing-format incident", async () => {
    const { run, progress, mock } = setup();
    for (let i = 0; i < 7; i++) await run();
    expect(fault.calls).toBe(6);
    expect(Object.values(progress.obligations)[0]).toMatchObject({ state: "blocked", code: "identical_internal_failure_limit", next_attempt_at: null });
    expect([...mock.files.entries()].some(([path, body]) => path.includes("/incidents/") && JSON.parse(body).code === "identical_internal_failure_limit")).toBe(true);
  });
  it("does not combine changed internal diagnostics or new verified output progress", async () => {
    const { run, progress, outputs } = setup();
    for (let i = 0; i < 5; i++) await run();
    fault.code = "INTERNAL_RENDER_B";
    await run();
    expect((Object.values(progress.obligations)[0] as any).internal_failure.count).toBe(1);
    outputs.set("new-verified", { content_hash: "a".repeat(64) });
    await run();
    expect((Object.values(progress.obligations)[0] as any).internal_failure.count).toBe(1);
  });
  it("keeps ordinary provider retry behavior unchanged after six failures", async () => {
    const { run, progress } = setup();
    fault.code = "provider transient retry";
    for (let i = 0; i < 7; i++) await run();
    expect(fault.calls).toBe(7);
    expect(Object.values(progress.obligations)[0].state).toBe("exhausted");
    expect(Object.values(progress.obligations)[0].next_attempt_at).not.toBeNull();
  });
  it("loss of cached verified outputs is not new progress that resets an internal failure streak", async () => {
    const { run, progress, outputs } = setup();
    outputs.set("verified-before-crash", { content_hash: "a".repeat(64) });
    for (let i = 0; i < 5; i++) await run();
    outputs.clear();
    await run();
    expect(Object.values(progress.obligations)[0].state).toBe("blocked");
    await run();
    expect(fault.calls).toBe(6);
  });
});
