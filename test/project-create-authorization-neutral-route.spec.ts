import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-neutral";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const operatorToken = "neutral-project-create-operator-secret";
const operatorEnv = {
  ...testEnv,
  PROJECT_CREATE_OPERATOR_TOKEN: operatorToken
} as Env & { PROJECT_CREATE_OPERATOR_TOKEN: string };

function request(path: string, token: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("neutral project-create operator boundary", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("owns authorization issuance in the neutral worker while keeping generic transactions ingress-only", async () => {
    const authorization = await worker.fetch(request(
      "/v1/operator/project-create-authorizations",
      operatorToken,
      {
        schema_version: "1.0",
        authorization_id: "PCAUTH-NEUTRAL-000000000001",
        name: "Neutral authorized project",
        slug: "neutral-authorized-project",
        aliases: [],
        objective: "Prove authorization route ownership",
        project_kind: "real",
        issued_at: "2026-08-30T08:00:00.000Z",
        expires_at: "2026-08-30T08:30:00.000Z"
      }
    ), operatorEnv, createExecutionContext());
    expect(authorization.status).toBe(200);

    const generic = await worker.fetch(
      request("/v1/transactions", operatorToken, {}),
      operatorEnv,
      createExecutionContext()
    );
    expect(generic.status).toBe(401);
  });
});
