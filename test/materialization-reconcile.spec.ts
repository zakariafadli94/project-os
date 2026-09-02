import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker, {
  reconcileMaterializations,
  type MaterializationReconcileSummary
} from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

interface FakeProjectBehavior {
  status?: number;
  delayMs?: number;
  body?: Record<string, unknown>;
}

function fakeEnv(projects: string[], behavior: Record<string, FakeProjectBehavior> = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const registryStub = {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(url.pathname).toBe("/registry");
      return Response.json({
        schema_version: "1.0",
        projects: projects.map((project_id) => ({ project_id, slug: project_id.toLowerCase() }))
      });
    })
  };

  const materializationNamespace = {
    getByName(projectId: string) {
      return {
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          calls.push(`${projectId}:${url.pathname}`);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            const config = behavior[projectId] ?? {};
            if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
            const status = config.status ?? 200;
            const body = config.body ?? {
              project_id: projectId,
              canonical_revision: 3,
              projection_version: 1,
              materialized_head: { revision: 3, projection_version: 1 },
              requested: null,
              active: null,
              blocked_error: null,
              output_count: 5,
              attempt_output_count: 0
            };
            return Response.json(body, { status });
          } finally {
            inFlight -= 1;
          }
        })
      };
    }
  };

  const projectNamespace = {
    getByName() {
      return {
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          if (url.pathname === "/reconcile-documents") {
            return Response.json({
              scanned: 0,
              captured: 0,
              ingested: 0,
              duplicates: 0,
              restored: 0,
              conflicts: 0,
              cursor_reset: false
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        })
      };
    }
  };

  const env = {
    DROPBOX_APP_KEY: "test-app-key",
    DROPBOX_APP_SECRET: "test-app-secret",
    DROPBOX_REFRESH_TOKEN: "test-refresh-token",
    INGRESS_TOKEN: "test-ingress-token",
    PROJECT_OS_LAYOUT_MODE: "v2",
    PROJECT_OS_CONTINUITY_MODE: "stable",
    REGISTRY_GUARD: { getByName: () => registryStub },
    PROJECT_GUARD: projectNamespace,
    MATERIALIZATION_GUARD: materializationNamespace
  } as unknown as Env;

  return { env, calls, maxInFlight: () => maxInFlight };
}

describe("fleet materialization reconciliation", () => {
  it("checks every registered project and distinguishes current from scheduled work", async () => {
    const { env, calls } = fakeEnv(["PRJ-4101", "PRJ-4102", "PRJ-4103"], {
      "PRJ-4102": {
        body: {
          project_id: "PRJ-4102",
          canonical_revision: 4,
          projection_version: 1,
          materialized_head: { revision: 3, projection_version: 1 },
          requested: { revision: 4, projection_version: 1 },
          active: null,
          blocked_error: null,
          output_count: 5,
          attempt_output_count: 0
        }
      }
    });

    const summary = await reconcileMaterializations(env);

    expect(summary).toEqual<MaterializationReconcileSummary>({ scanned: 3, scheduled: 1, current: 2, failed: 0 });
    expect(calls.sort()).toEqual([
      "PRJ-4101:/reconcile",
      "PRJ-4102:/reconcile",
      "PRJ-4103:/reconcile"
    ]);
  });

  it("isolates one project failure and continues checking the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, calls } = fakeEnv(["PRJ-4111", "PRJ-4112", "PRJ-4113"], {
      "PRJ-4112": { status: 503, body: { error: "blocked" } }
    });

    await expect(reconcileMaterializations(env)).resolves.toEqual({ scanned: 3, scheduled: 0, current: 2, failed: 1 });
    expect(calls).toHaveLength(3);
    expect(error).toHaveBeenCalledWith("Project OS materialization reconcile failed", expect.objectContaining({ project_id: "PRJ-4112" }));
  });

  it("never exceeds four concurrent project reconciliations", async () => {
    const projects = Array.from({ length: 9 }, (_, index) => `PRJ-${(4120 + index).toString().padStart(4, "0")}`);
    const behavior = Object.fromEntries(projects.map((projectId) => [projectId, { delayMs: 10 }]));
    const { env, maxInFlight } = fakeEnv(projects, behavior);

    const summary = await reconcileMaterializations(env);

    expect(summary).toEqual({ scanned: 9, scheduled: 0, current: 9, failed: 0 });
    expect(maxInFlight()).toBe(4);
  });

  it("scheduled maintenance processes inbox work and fleet reconciliation in the same cron execution", async () => {
    const dropbox = installDropboxMock();
    const poisonId = "TXN-RECON-POISON-000001";
    const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${poisonId}.json`;
    const rejected = `/PROJECT_OS/.project-os/transactions/rejected/${poisonId}.json`;
    dropbox.files.set(incoming, "{broken-json");
    const { env, calls } = fakeEnv(["PRJ-4131"]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ctx = createExecutionContext();

    await worker.scheduled?.({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: () => undefined
    } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(dropbox.files.has(incoming)).toBe(false);
    expect(dropbox.files.has(rejected)).toBe(true);
    expect(calls).toContain("PRJ-4131:/reconcile");
    expect(info).toHaveBeenCalledWith("Project OS scheduled maintenance completed", expect.objectContaining({
      inbox: expect.any(Object),
      materialization: expect.any(Object)
    }));
  });
});
