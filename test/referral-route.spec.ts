import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const body = {
  schema_version: "1.0",
  referral_id: "REF-GOV-ROUTE-00000001",
  source_project_id: "PRJ-0003",
  target_project_id: "PRJ-9999",
  referral_type: "information",
  title: "Route contract",
  created_at: "2026-08-30T10:10:00.000Z",
  source_refs: [],
  body: "Routing evidence"
};

function request(token?: string, payload: unknown = body): Request {
  return new Request("https://example.com/v1/referrals", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

describe("referral route", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("requires normal ingress authentication", async () => {
    const response = await worker.fetch(request(), testEnv, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it("validates the standard referral envelope and returns transport rejection for an unknown target", async () => {
    const response = await worker.fetch(request(testEnv.INGRESS_TOKEN), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: "1.0",
      referral_id: body.referral_id,
      status: "rejected",
      code: "REFERRAL_TARGET_NOT_FOUND"
    });

    const malformed = await worker.fetch(request(testEnv.INGRESS_TOKEN, { ...body, referral_type: "task" }), testEnv, createExecutionContext());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_referral_request" });
  });
});
