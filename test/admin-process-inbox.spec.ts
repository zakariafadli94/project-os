import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("admin inbox processing", () => {
  beforeEach(() => installDropboxMock());

  it("requires auth and returns the immediate inbox processing summary", async () => {
    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
      method: "POST"
    }), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "shadow",
      inbox: "/PROJECT_OS/TRANSACTIONS/incoming",
      scanned: 0,
      processed: 0,
      failed: 0
    });
  });
});
