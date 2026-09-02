import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { reconcileSearchIndexes } from "../src/index";

interface FakeProjectConfig {
  active_generation: number | null;
  freshness?: "current" | "lagging" | "rebuilding" | "unknown" | "failed";
  rebuild_state?: string;
  reconcile_status?: number;
  source?: {
    canonical_revision_requested: number;
    canonical_revision_indexed: number;
    document_generation_requested: number;
    document_generation_indexed: number;
    last_error?: string | null;
  };
}

function fakeEnv(config: Record<string, FakeProjectConfig>) {
  const projectIds = Object.keys(config);
  const reconcileBodies = new Map<string, unknown[]>();
  let activeStatusCalls = 0;
  let peakStatusCalls = 0;

  const env = {
    REGISTRY_GUARD: {
      getByName(name: string) {
        expect(name).toBe("global");
        return {
          async fetch() {
            return Response.json({ projects: projectIds.map((project_id) => ({ project_id, slug: project_id.toLowerCase() })) });
          }
        };
      }
    },
    SEARCH_INDEX_GUARD: {
      getByName(name: string) {
        expect(name).toBe("global");
        return {
          async fetch(input: RequestInfo | URL) {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const projectId = url.searchParams.get("project_id");
            if (!projectId || !(projectId in config)) return Response.json({ error: "missing" }, { status: 404 });
            activeStatusCalls += 1;
            peakStatusCalls = Math.max(peakStatusCalls, activeStatusCalls);
            await Promise.resolve();
            await Promise.resolve();
            activeStatusCalls -= 1;
            const project = config[projectId];
            return Response.json({
              project_id: projectId,
              freshness: project.freshness ?? (project.active_generation === null ? "unknown" : "current"),
              active_generation: project.active_generation,
              canonical_revision_indexed: project.source?.canonical_revision_indexed ?? 1,
              document_generation_indexed: project.source?.document_generation_indexed ?? 1,
              rebuild_state: project.rebuild_state ?? "idle"
            });
          }
        };
      }
    },
    PROJECT_GUARD: {
      getByName(projectId: string) {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const url = new URL(input instanceof Request ? input.url : String(input));
            expect(url.pathname).toBe("/reconcile-search");
            const bodies = reconcileBodies.get(projectId) ?? [];
            bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
            reconcileBodies.set(projectId, bodies);
            const project = config[projectId];
            if (project.reconcile_status && project.reconcile_status !== 200) {
              return Response.json({ error: "forced_failure" }, { status: project.reconcile_status });
            }
            const source = project.source ?? {
              canonical_revision_requested: 1,
              canonical_revision_indexed: 1,
              document_generation_requested: 1,
              document_generation_indexed: 1,
              last_error: null
            };
            return Response.json({ project_id: projectId, canonical_revision: source.canonical_revision_requested, ...source });
          }
        };
      }
    }
  } as unknown as Env;

  return {
    env,
    reconcileBodies,
    peakStatusCalls: () => peakStatusCalls
  };
}

describe("search fleet reconciliation", () => {
  it("processes at most four projects concurrently and forces full repair only for missing heads", async () => {
    const harness = fakeEnv({
      "PRJ-8001": { active_generation: null },
      "PRJ-8002": { active_generation: 1 },
      "PRJ-8003": { active_generation: 1 },
      "PRJ-8004": { active_generation: 1 },
      "PRJ-8005": { active_generation: 1 },
      "PRJ-8006": { active_generation: null }
    });

    const summary = await reconcileSearchIndexes(harness.env);

    expect(summary.scanned).toBe(6);
    expect(harness.peakStatusCalls()).toBeLessThanOrEqual(4);
    expect(harness.peakStatusCalls()).toBeGreaterThan(1);
    expect(harness.reconcileBodies.get("PRJ-8001")).toEqual([{ force_full: true }]);
    expect(harness.reconcileBodies.get("PRJ-8006")).toEqual([{ force_full: true }]);
    expect(harness.reconcileBodies.get("PRJ-8002")).toEqual([null]);
    expect(harness.reconcileBodies.get("PRJ-8005")).toEqual([null]);
  });

  it("isolates one project failure and reports current, scheduled, rebuilding, and failed counts", async () => {
    const harness = fakeEnv({
      "PRJ-8101": {
        active_generation: 1,
        source: {
          canonical_revision_requested: 1,
          canonical_revision_indexed: 1,
          document_generation_requested: 1,
          document_generation_indexed: 1,
          last_error: null
        }
      },
      "PRJ-8102": {
        active_generation: 1,
        source: {
          canonical_revision_requested: 2,
          canonical_revision_indexed: 1,
          document_generation_requested: 1,
          document_generation_indexed: 1,
          last_error: null
        }
      },
      "PRJ-8103": { active_generation: 1, freshness: "rebuilding", rebuild_state: "rebuilding" },
      "PRJ-8104": { active_generation: 1, reconcile_status: 503 },
      "PRJ-8105": { active_generation: null }
    });

    const summary = await reconcileSearchIndexes(harness.env);

    expect(summary).toEqual({
      scanned: 5,
      scheduled: 2,
      current: 1,
      rebuilding: 1,
      failed: 1
    });
    expect(harness.reconcileBodies.has("PRJ-8105")).toBe(true);
  });
});
