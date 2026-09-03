import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

function envWithSearchReadMode(mode?: string): Env {
  const overrides = mode === undefined ? {} : { PROJECT_OS_SEARCH_READ_MODE: mode };
  return { ...testEnv, ...overrides } as Env;
}

async function requestSearch(mode: string | undefined, authenticated = true): Promise<Response> {
  return worker.fetch(new Request("https://project-os.test/v1/search?probe=1", {
    method: "POST",
    headers: authenticated ? authHeaders : { "content-type": "application/json" },
    body: JSON.stringify({ project_ids: ["PRJ-0002"], text: "probe" })
  }), envWithSearchReadMode(mode), createExecutionContext());
}

describe("PROJECT_OS_SEARCH_READ_MODE ingress gate", () => {
  it("fails closed when the mode is absent", async () => {
    const response = await requestSearch(undefined);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("keeps POST /v1/search inaccessible when explicitly off, even without authentication", async () => {
    const authenticated = await requestSearch("off", true);
    const unauthenticated = await requestSearch("off", false);
    expect(authenticated.status).toBe(404);
    expect(unauthenticated.status).toBe(404);
  });

  it.each(["ON", "true", "1", " on", "on ", "enabled", ""]) (
    "does not accept bypass value %j",
    async (mode) => {
      expect((await requestSearch(mode)).status).toBe(404);
    }
  );

  it("enables the route only for the exact explicit value on", async () => {
    const unauthenticated = await requestSearch("on", false);
    expect(unauthenticated.status).toBe(401);

    const malformed = await worker.fetch(new Request("https://project-os.test/v1/search", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "missing explicit project scope" })
    }), envWithSearchReadMode("on"), createExecutionContext());
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_search_query" });
  });

  it("does not expose an alternate-method bypass", async () => {
    const response = await worker.fetch(new Request("https://project-os.test/v1/search", {
      method: "GET",
      headers: authHeaders
    }), envWithSearchReadMode("on"), createExecutionContext());
    expect(response.status).toBe(404);
  });
});
