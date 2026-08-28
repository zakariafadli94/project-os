import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receipt } from "../src/domain/receipt";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { DropboxApiError } from "../src/persistence/providers/dropbox/client";
import { mapDropboxError } from "../src/persistence/providers/dropbox/error-mapping";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-28T14:00:00+01:00";

afterEach(() => vi.restoreAllMocks());

describe("MutationGate provider diagnostics", () => {
  it("normalizes Dropbox code and operation without exposing the provider response body", () => {
    const error = mapDropboxError(
      new DropboxApiError(
        "rate limited",
        429,
        "req-safe",
        JSON.stringify({ error_summary: "too_many_requests/...", sensitive: "DO_NOT_EXPOSE" })
      ),
      "list"
    );

    expect(error).toBeInstanceOf(ProviderOperationError);
    const providerError = error as ProviderOperationError;
    expect(providerError.diagnostics).toEqual({
      providerId: "dropbox",
      status: 429,
      requestId: "req-safe",
      code: "too_many_requests",
      operation: "list"
    });
    expect(JSON.stringify(providerError.diagnostics)).not.toContain("DO_NOT_EXPOSE");
  });

  it("returns safe retry-exhaustion diagnostics from governed candidate resolution ingress", async () => {
    const faults: DropboxMockFault[] = [];
    const dropbox = installDropboxMock({ faults });
    const project = await createProject("TXN-CANDDIAG-PROJECT-0001", "candidate-diagnostics");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const candidate = await captureCandidate(
      dropbox,
      guard,
      `/PROJECT_OS/WORKSPACE/PROJECTS/${project.projectId}-${project.slug}/ARTIFACTS/diagnostics.md`,
      "# diagnostics candidate"
    );
    const resolutionId = "MUTRES-FAFAFAFAFAFAFAFAFAFAFAFA";
    const terminalPath = `/PROJECT_OS/.project-os/projects/${project.projectId}/mutation-gate/resolutions/${candidate.candidate_id}/terminal.json`;

    for (let index = 0; index < 5; index += 1) {
      faults.push({
        endpoint: "/2/files/upload",
        occurrence: 1,
        status: 429,
        error_summary: "too_many_requests/DO_NOT_EXPOSE",
        path: terminalPath
      });
    }

    const response = await worker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        operation: "candidate.reject",
        resolution_id: resolutionId,
        project_id: project.projectId,
        candidate_id: candidate.candidate_id
      })
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(503);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      error: "persistence_provider_unavailable",
      provider_id: "dropbox",
      provider_operation: "create",
      provider_status: 429,
      provider_code: "too_many_requests",
      provider_request_id: "req-fault-4"
    });
    expect(JSON.stringify(body)).not.toContain("DO_NOT_EXPOSE");
  });
});

async function createProject(transactionId: string, slug: string): Promise<{ projectId: string; slug: string }> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: slug, slug, aliases: [], objective: "Mutation candidate provider diagnostics" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return { projectId: receipt.project_id, slug };
}

async function captureCandidate(
  dropbox: ReturnType<typeof installDropboxMock>,
  guard: DurableObjectStub,
  path: string,
  content: string
): Promise<{ candidate_id: string; provider_path: string }> {
  await dropbox.writeExternal(path, content);
  const reconcile = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
  expect(reconcile.status).toBe(200);
  const list = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
  const body = await list.json<{ candidates: Array<{ candidate_id: string; provider_path: string }> }>();
  const candidate = body.candidates.find((item) => item.provider_path === path);
  expect(candidate).toBeDefined();
  return candidate!;
}
