import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index-mutation-gate";

const testEnv = env as unknown as Env;

function request(projectId: string, token: string): Request {
  return new Request(`https://example.com/v1/admin/schema-status?project_id=${projectId}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
}

describe("schema rollout diagnostics", () => {
  it("returns compact v1-only pre-frontier status through authenticated admin ingress", async () => {
    const response = await worker.fetch(
      request("PRJ-9201", testEnv.INGRESS_TOKEN),
      testEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project_id: "PRJ-9201",
      active_writer_stage: "v1_only",
      frontier: "v1_only",
      storage_version: 1
    });
  });

  it("rejects malformed project ids and never exposes schema status without ingress auth", async () => {
    const unauthorized = await worker.fetch(
      request("PRJ-9202", "wrong-token"),
      testEnv,
      createExecutionContext()
    );
    expect(unauthorized.status).toBe(401);

    const malformed = await worker.fetch(
      request("not-a-project", testEnv.INGRESS_TOKEN),
      testEnv,
      createExecutionContext()
    );
    expect(malformed.status).toBe(400);
  });

  it("does not widen the ephemeral MutationGate operator token to schema diagnostics", async () => {
    const operatorToken = `${Date.now()}.${"a".repeat(64)}`;
    const operatorEnv = {
      ...testEnv,
      MUTATION_GATE_OPERATOR_TOKEN: operatorToken
    } as Env & { MUTATION_GATE_OPERATOR_TOKEN: string };

    const response = await worker.fetch(
      request("PRJ-9203", operatorToken),
      operatorEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(401);
  });
});
