import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("inbox recovery observability", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("logs scheduled inbox scan lifecycle with a structured summary", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ctx = createExecutionContext();

    await worker.scheduled?.(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController,
      testEnv,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(info).toHaveBeenCalledWith(
      "Project OS scheduled inbox scan started",
      expect.objectContaining({
        cron: "*/5 * * * *",
        mode: "v2",
        inbox: "/PROJECT_OS/.project-os/transactions/incoming"
      })
    );
    expect(info).toHaveBeenCalledWith(
      "Project OS inbox scan completed",
      expect.objectContaining({ scanned: 0, processed: 0, failed: 0 })
    );
  });
});
