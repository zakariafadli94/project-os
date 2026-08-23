import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;

describe("continuity control plane", () => {
  it("exposes authenticated stable-by-default continuity status without changing user workflow", async () => {
    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/continuity"), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/continuity", {
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      contract_version: "1.0",
      mode: "stable",
      effective_path: "stable",
      candidate_available: false,
      ready_for_candidate: false,
      blockers: ["CANDIDATE_NOT_AVAILABLE"],
      user_workflow_change_required: false
    });
  });
});
