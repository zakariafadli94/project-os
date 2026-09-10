import { describe, expect, it, vi } from "vitest";
import { createSliceBudget } from "../src/convergence/budget";
import { FencedEffects } from "../src/convergence/fenced-effects";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

describe("fenced convergence effects", () => {
  it("uses the durable preparation held by its serialized owner without a second journal read", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const journal = new ConvergenceJournal(runtime, "PRJ-9272");
    const progress = initialProgress("PRJ-9272", "1970-01-01T00:00:00.000Z", "writer-1");
    const token = await journal.save(progress, null);
    const effects = new FencedEffects(runtime, journal, createSliceBudget(() => 0, new AbortController().signal));
    const intent = {
      id: "state:1", path: "/PROJECT_OS/.project-os/projects/PRJ-9272/state.json",
      destination: "/PROJECT_OS/.project-os/projects/PRJ-9272/state.json", kind: "create" as const,
      object_id: null, expected_token: null, desired_hash: null, authorized_previous_hash: null,
      state: "prepared" as const, verified_token: null
    };
    await effects.prepare(progress, token, intent);
    const reread = vi.spyOn(journal, "load");

    await effects.replace(intent, "{\"revision\":1}\n");

    expect(reread).not.toHaveBeenCalled();
  });
});
