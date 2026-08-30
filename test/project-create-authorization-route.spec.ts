import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  machineProjectCreateAuthorizationIssuedPath,
  machineProjectCreateAuthorizationReceiptPath
} from "../src/persistence/layout";
import worker from "../src/index-mutation-gate";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authorizationId = "PCAUTH-ROUTE-000000000001";
const body = {
  schema_version: "1.0",
  authorization_id: authorizationId,
  name: "Authorized project",
  slug: "authorized-project",
  aliases: ["authorized"],
  objective: "Prove independent project creation authorization",
  project_kind: "real",
  issued_at: "2026-08-30T08:00:00.000Z",
  expires_at: "2026-08-30T08:30:00.000Z"
} as const;

function request(token: string, payload: unknown = body): Request {
  return new Request("https://example.com/v1/operator/project-create-authorizations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

describe("project-create authorization operator route", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("requires the dedicated operator token and does not accept the normal ingress token", async () => {
    const operatorEnv = {
      ...testEnv,
      PROJECT_CREATE_OPERATOR_TOKEN: "project-create-operator-secret"
    } as Env & { PROJECT_CREATE_OPERATOR_TOKEN: string };

    const denied = await worker.fetch(
      request(testEnv.INGRESS_TOKEN),
      operatorEnv,
      createExecutionContext()
    );
    expect(denied.status).toBe(401);

    const allowed = await worker.fetch(
      request(operatorEnv.PROJECT_CREATE_OPERATOR_TOKEN),
      operatorEnv,
      createExecutionContext()
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      schema_version: "1.0",
      authorization_id: authorizationId,
      status: "issued",
      issued_at: body.issued_at,
      expires_at: body.expires_at
    });
  });

  it("persists immutable issuance evidence and makes exact replay idempotent", async () => {
    const mock = installDropboxMock();
    const operatorEnv = {
      ...testEnv,
      PROJECT_CREATE_OPERATOR_TOKEN: "project-create-operator-secret"
    } as Env & { PROJECT_CREATE_OPERATOR_TOKEN: string };

    const first = await worker.fetch(request(operatorEnv.PROJECT_CREATE_OPERATOR_TOKEN), operatorEnv, createExecutionContext());
    expect(first.status).toBe(200);
    const firstReceipt = await first.json();

    const replay = await worker.fetch(request(operatorEnv.PROJECT_CREATE_OPERATOR_TOKEN), operatorEnv, createExecutionContext());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstReceipt);
    expect(mock.files.has(machineProjectCreateAuthorizationIssuedPath(authorizationId))).toBe(true);
    expect(mock.files.has(machineProjectCreateAuthorizationReceiptPath(authorizationId))).toBe(true);

    const mismatch = await worker.fetch(request(operatorEnv.PROJECT_CREATE_OPERATOR_TOKEN, {
      ...body,
      objective: "Different payload using the same authorization id"
    }), operatorEnv, createExecutionContext());
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: "PROJECT_CREATE_AUTHORIZATION_IDEMPOTENCY_MISMATCH"
    });
  });

  it("does not grant generic transaction authority to the project-create operator token", async () => {
    const operatorEnv = {
      ...testEnv,
      PROJECT_CREATE_OPERATOR_TOKEN: "project-create-operator-secret"
    } as Env & { PROJECT_CREATE_OPERATOR_TOKEN: string };

    const transaction = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorEnv.PROJECT_CREATE_OPERATOR_TOKEN}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), operatorEnv, createExecutionContext());
    expect(transaction.status).toBe(401);
  });
});
