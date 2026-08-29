import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-neutral";

const testEnv = env as unknown as Env;
const gitSha = "a".repeat(40);

describe("production deployment identity", () => {
  it("exposes the serving Worker version and exact Git SHA on health", async () => {
    const versionedEnv = {
      ...testEnv,
      CF_VERSION_METADATA: {
        id: "11111111-2222-4333-8444-555555555555",
        tag: `git-${gitSha}`,
        timestamp: "2026-08-29T02:00:00.000Z"
      }
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://project-os.example/health"),
      versionedEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      worker_version_id: "11111111-2222-4333-8444-555555555555",
      worker_version_tag: `git-${gitSha}`,
      git_sha: gitSha
    });
  });

  it("fails attribution closed when a serving version is not tagged by the authoritative promoter", async () => {
    const untaggedEnv = {
      ...testEnv,
      CF_VERSION_METADATA: {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        tag: "cloudflare-build",
        timestamp: "2026-08-29T02:01:00.000Z"
      }
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://project-os.example/health"),
      untaggedEnv,
      createExecutionContext()
    );

    expect(await response.json()).toEqual({
      status: "ok",
      worker_version_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      worker_version_tag: "cloudflare-build",
      git_sha: null
    });
  });
});
