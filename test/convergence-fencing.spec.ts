import { afterEach, describe, expect, it, vi } from "vitest";
import { createSliceBudget } from "../src/convergence/budget";
import { observeText } from "../src/convergence/fenced-effects";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

describe("convergence fencing", () => {
  it("invalidates the old provider precondition even for identical replacement bytes", async () => {
    const mock = installDropboxMock();
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9258-synthetic-convergence/STATE.md";
    await mock.writeExternal(path, "authorized-258");
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const runtime = persistenceFromDropbox(new DropboxClient({
      appKey: "key", appSecret: "secret", refreshToken: "refresh"
    }, { requestScope: { deadlineMs: budget.deadline_ms, signal: budget.signal, beforeHttp: () => budget.beforeHttp() } }));

    const before = await observeText(runtime, path);
    if (!before) throw new Error("missing fixture");
    await runtime.conditionalWrite.writeTextConditional(path, "authorized-258", before.token);
    const after = await observeText(runtime, path);

    expect(after?.token).not.toBe(before.token);
    await expect(runtime.conditionalWrite.writeTextConditional(path, "old-257", before.token)).rejects.toThrow();
    expect(mock.files.get(path)).toBe("authorized-258");
  });
});
