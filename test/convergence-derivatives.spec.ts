import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceVerifiedThrough } from "../src/convergence/discovery";
import { repairDerivative } from "../src/convergence/derivatives";
import { createSliceBudget } from "../src/convergence/budget";
import { FencedEffects } from "../src/convergence/fenced-effects";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { ProjectRepository } from "../src/persistence/repository";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { commitFixture } from "./helpers/convergence-fixture";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

describe("canonical derivative convergence", () => {
  it("keeps a contiguous cursor at the gap while later revisions remain verifiable", () => {
    expect(advanceVerifiedThrough(257, new Set([259, 260, 261]))).toBe(257);
    expect(advanceVerifiedThrough(257, new Set([258, 259, 260, 261]))).toBe(261);
  });

  it("repairs a missing state independently once its effect is reserved", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9258", 1)[0];
    const repository = new ProjectRepository(runtime, "v2");
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const progress = initialProgress(record.project_id, "2026-09-08T00:00:00.000Z", "writer-1");
    let token = await journal.save(progress, null);
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const effects = new FencedEffects(runtime, journal, budget);
    token = await effects.prepare(progress, token, {
      id: "state:1", path: `/PROJECT_OS/.project-os/projects/${record.project_id}/state.json`, destination: null,
      kind: "create", object_id: null, expected_token: null, desired_hash: null,
      authorized_previous_hash: null, state: "prepared", verified_token: null
    });

    const health = await repairDerivative("state", record, progress, effects, repository);
    expect(health.state).toBe("current");
    expect(mock.files.get(`/PROJECT_OS/.project-os/projects/${record.project_id}/state.json`)).toBe(
      repository.canonicalDerivativeText("state", record)
    );
    expect(token).toBeTruthy();
  });
});
