import { describe, expect, it } from "vitest";
import { minimumWake } from "../src/convergence/retry";
import { ConvergenceEngine, nextConvergenceWake } from "../src/convergence/engine";
import { createSliceBudget } from "../src/convergence/budget";
import { ConvergenceJournal } from "../src/convergence/journal";
import { ProjectRepository } from "../src/persistence/repository";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { commitFixture } from "./helpers/convergence-fixture";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { afterEach, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("convergence engine scheduling", () => {
  it("does not postpone an already-due continuation", () => {
    expect(nextConvergenceWake("2026-09-08T00:00:05.000Z", ["2026-09-08T00:00:02.000Z", null])).toBe(
      minimumWake(["2026-09-08T00:00:05.000Z", "2026-09-08T00:00:02.000Z"])
    );
  });

  it("rebuilds each machine derivative from the immutable commit record", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9258", 1)[0];
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository,
      runtime,
      journal: new ConvergenceJournal(runtime, record.project_id),
      ledger: {} as never,
      now: () => Date.parse("2026-09-08T00:00:00.000Z")
    });

    const result = await engine.runSlice(createSliceBudget(() => Date.now(), new AbortController().signal));
    expect(result.health.layers.event.state).toBe("current");
    expect(result.health.layers.receipt.state).toBe("current");
    expect(result.health.layers.state.state).toBe("current");
    expect(result.health.layers.manifest.state).toBe("current");
  });
});
