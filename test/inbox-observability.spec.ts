import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("scheduled maintenance observability", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("logs inbox and materialization maintenance lifecycle with structured summaries", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ctx = createExecutionContext();

    await worker.scheduled?.(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController,
      testEnv,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(info).toHaveBeenCalledWith(
      "Project OS scheduled maintenance started",
      expect.objectContaining({
        cron: "*/5 * * * *",
        mode: "v2",
        inbox: "/PROJECT_OS/.project-os/transactions/incoming"
      })
    );
    expect(info).toHaveBeenCalledWith(
      "Project OS scheduled maintenance completed",
      expect.objectContaining({
        inbox: expect.objectContaining({ scanned: 0, processed: 0, failed: 0 }),
        materialization: expect.objectContaining({ scanned: 0, scheduled: 0, current: 0, failed: 0 })
      })
    );
  });
});
