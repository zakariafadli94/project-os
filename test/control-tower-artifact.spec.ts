import { describe, expect, it } from "vitest";
import { createControlTowerServer } from "../src/control-tower/mcp";

const artifact = {
  request_id: "ART-CONTROL-TOWER-0001",
  project_id: "PRJ-0007",
  relative_path: "DELIVERABLES/AMM-PROGRAMME-1/C2/canary.xlsx",
  content_sha256: "a".repeat(64),
  mode: "create" as const,
  source: {
    kind: "staged_provider_object" as const,
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-CONTROL-TOWER-0001/canary.xlsx",
    object_id: "id:canary",
    revision_token: "rev-canary",
    size: 123,
    integrity: { algorithm: "dropbox-content-hash", value: "provider-hash" }
  }
};

describe("Control Tower governed artifact submission", () => {
  it("sends a staged artifact with fresh signed admission to ProjectGuard", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const stub = {
      fetch: async (input: string, init?: RequestInit) => {
        calls.push({ path: new URL(input).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (new URL(input).pathname === "/mutation-context") {
          return Response.json({ context: { project_id: "PRJ-0007", token: "signed" } });
        }
        return Response.json({ status: "committed", request_id: artifact.request_id });
      }
    };
    const server = createControlTowerServer({
      PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
      REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
    }) as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> };

    const result = await server._registeredTools.project_os_submit_artifact.handler({
      project_id: "PRJ-0007",
      request: artifact
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(calls).toEqual([
      { path: "/mutation-context" },
      {
        path: "/artifact",
        body: {
          admission_version: "1.0",
          request: artifact,
          mutation_context: { project_id: "PRJ-0007", token: "signed" }
        }
      }
    ]);
  });
});
