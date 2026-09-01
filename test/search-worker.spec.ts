import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

interface SearchResponse {
  hits: Array<{
    project_id: string;
    record_id: string;
    title: string;
  }>;
  freshness: Array<{
    project_id: string;
    state: "current" | "lagging" | "rebuilding" | "unknown" | "failed";
    canonical_revision_requested: number;
    canonical_revision_indexed: number;
    document_generation_requested: number;
    document_generation_indexed: number;
    active_generation: number | null;
  }>;
}

async function createProject(name: string, slug: string, objective: string): Promise<string> {
  const response = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-SEARCH-WORKER-${slug.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-09-01T15:00:00+01:00",
      payload: { name, slug, aliases: [], objective }
    })
  }), testEnv, createExecutionContext());
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

async function drainSearch(projectId: string): Promise<void> {
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!await runDurableObjectAlarm(guard)) break;
  }
}

async function search(body: unknown, authenticated = true): Promise<Response> {
  return worker.fetch(new Request("https://project-os.test/v1/search", {
    method: "POST",
    headers: authenticated ? authHeaders : { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), testEnv, createExecutionContext());
}

async function adminSearchRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  authenticated = true
): Promise<Response> {
  const headers = authenticated
    ? { ...authHeaders }
    : { "content-type": "application/json" };
  return worker.fetch(new Request(`https://project-os.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), testEnv, createExecutionContext());
}

describe("Project OS search worker API", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("requires authentication and explicit bounded project scope", async () => {
    expect((await search({ project_ids: ["PRJ-0002"], text: "pricing" }, false)).status).toBe(401);

    const missingScope = await search({ text: "pricing" });
    expect(missingScope.status).toBe(400);
    await expect(missingScope.json()).resolves.toMatchObject({ error: "invalid_search_query" });

    const emptyScope = await search({ project_ids: [], text: "pricing" });
    expect(emptyScope.status).toBe(400);

    const tooLarge = await search({ project_ids: ["PRJ-0002"], text: "pricing", limit: 101 });
    expect(tooLarge.status).toBe(400);
  });

  it("rejects an explicitly scoped project that is not in the registry", async () => {
    const response = await search({ project_ids: ["PRJ-9999"], text: "missing" });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "project_not_found", project_id: "PRJ-9999" });
  });

  it("searches one project without leaking a stronger match from another project", async () => {
    const alpha = await createProject(
      "Worker Search Alpha",
      "worker-search-alpha",
      "shared-worker-needle exact alpha authority"
    );
    const beta = await createProject(
      "Worker Search Beta",
      "worker-search-beta",
      "shared-worker-needle shared-worker-needle shared-worker-needle beta authority"
    );
    await drainSearch(alpha);
    await drainSearch(beta);

    const response = await search({ project_ids: [alpha], text: "shared-worker-needle", limit: 20 });
    expect(response.status).toBe(200);
    const body = await response.json<SearchResponse>();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(new Set(body.hits.map((hit) => hit.project_id))).toEqual(new Set([alpha]));
    expect(body.hits.some((hit) => hit.project_id === beta)).toBe(false);
    expect(body.freshness).toEqual([
      expect.objectContaining({
        project_id: alpha,
        state: "current",
        canonical_revision_requested: 1,
        canonical_revision_indexed: 1,
        document_generation_requested: 1,
        document_generation_indexed: 1,
        active_generation: 1
      })
    ]);
  });

  it("searches an explicit two-project portfolio and never treats omitted scope as all projects", async () => {
    const left = await createProject(
      "Worker Portfolio Left",
      "worker-portfolio-left",
      "portfolio-worker-needle left authority"
    );
    const right = await createProject(
      "Worker Portfolio Right",
      "worker-portfolio-right",
      "portfolio-worker-needle right authority"
    );
    await drainSearch(left);
    await drainSearch(right);

    const response = await search({ project_ids: [left, right], text: "portfolio-worker-needle" });
    expect(response.status).toBe(200);
    const body = await response.json<SearchResponse>();
    expect(new Set(body.hits.map((hit) => hit.project_id))).toEqual(new Set([left, right]));
    expect(new Set(body.freshness.map((item) => item.project_id))).toEqual(new Set([left, right]));
    expect(body.freshness.every((item) => item.state === "current")).toBe(true);

    const implicitAll = await search({ text: "portfolio-worker-needle" });
    expect(implicitAll.status).toBe(400);
  });

  it("requires auth and a unique non-empty scope for search rebuild administration", async () => {
    const unauthorized = await adminSearchRequest(
      "/v1/admin/search/rebuild",
      "POST",
      { project_ids: ["PRJ-0002"] },
      false
    );
    expect(unauthorized.status).toBe(401);

    const empty = await adminSearchRequest("/v1/admin/search/rebuild", "POST", { project_ids: [] });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ error: "invalid_request" });

    const duplicate = await adminSearchRequest(
      "/v1/admin/search/rebuild",
      "POST",
      { project_ids: ["PRJ-0002", "PRJ-0002"] }
    );
    expect(duplicate.status).toBe(400);
  });

  it("starts rebuilds only for registered projects and exposes source plus index status", async () => {
    const projectId = await createProject(
      "Worker Admin Search",
      "worker-admin-search",
      "worker admin search rebuild authority"
    );
    await drainSearch(projectId);

    const missing = await adminSearchRequest(
      "/v1/admin/search/rebuild",
      "POST",
      { project_ids: ["PRJ-9999"] }
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "project_not_found", project_id: "PRJ-9999" });

    const rebuild = await adminSearchRequest(
      "/v1/admin/search/rebuild",
      "POST",
      { project_ids: [projectId] }
    );
    if (rebuild.status !== 202) {
      console.error("Search rebuild diagnostic", {
        project_id: projectId,
        status: rebuild.status,
        body: await rebuild.clone().text()
      });
    }
    expect(rebuild.status).toBe(202);
    await expect(rebuild.json()).resolves.toMatchObject({
      projects: [expect.objectContaining({ project_id: projectId })]
    });

    const unauthorizedStatus = await adminSearchRequest(
      `/v1/admin/search/status?project_id=${encodeURIComponent(projectId)}`,
      "GET",
      undefined,
      false
    );
    expect(unauthorizedStatus.status).toBe(401);

    const status = await adminSearchRequest(
      `/v1/admin/search/status?project_id=${encodeURIComponent(projectId)}`,
      "GET"
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      project_id: projectId,
      source: {
        project_id: projectId,
        canonical_revision_requested: 1,
        document_generation_requested: 1
      },
      index: {
        project_id: projectId,
        active_generation: 1
      },
      rebuild: {
        project_id: projectId,
        staging_generation: 2
      }
    });
  });
});