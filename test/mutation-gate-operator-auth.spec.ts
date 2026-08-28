import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";

const testEnv = env as unknown as Env;

function resolutionRequest(token: string): Request {
  return new Request("https://example.com/v1/mutation-candidates/resolve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: "{}"
  });
}

describe("MutationGate ephemeral operator authentication", () => {
  it("keeps the existing ingress token valid on candidate resolution", async () => {
    const response = await worker.fetch(
      resolutionRequest(testEnv.INGRESS_TOKEN),
      testEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_mutation_candidate_resolution" });
  });

  it("accepts a current operator token only on candidate resolution", async () => {
    const currentOperatorToken = `${Date.now()}.${"a".repeat(64)}`;
    const operatorEnv = {
      ...testEnv,
      MUTATION_GATE_OPERATOR_TOKEN: currentOperatorToken
    } as Env & { MUTATION_GATE_OPERATOR_TOKEN: string };

    const resolution = await worker.fetch(
      resolutionRequest(currentOperatorToken),
      operatorEnv,
      createExecutionContext()
    );
    expect(resolution.status).toBe(400);
    expect(await resolution.json()).toMatchObject({ error: "invalid_mutation_candidate_resolution" });

    const transaction = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentOperatorToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), operatorEnv, createExecutionContext());
    expect(transaction.status).toBe(401);
  });

  it("rejects expired, future-skewed, and missing operator tokens", async () => {
    const now = Date.now();
    const expiredToken = `${now - 16 * 60_000}.${"b".repeat(64)}`;
    const futureToken = `${now + 2 * 60_000}.${"c".repeat(64)}`;

    for (const token of [expiredToken, futureToken]) {
      const operatorEnv = {
        ...testEnv,
        MUTATION_GATE_OPERATOR_TOKEN: token
      } as Env & { MUTATION_GATE_OPERATOR_TOKEN: string };
      const response = await worker.fetch(
        resolutionRequest(token),
        operatorEnv,
        createExecutionContext()
      );
      expect(response.status).toBe(401);
    }

    const missing = await worker.fetch(
      resolutionRequest("undefined"),
      testEnv,
      createExecutionContext()
    );
    expect(missing.status).toBe(401);
  });
});
