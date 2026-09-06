import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

async function createProject(transactionId: string, slug: string): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com/v1/transactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-31T16:10:00+01:00",
      payload: {
        name: `Admin recovery ${slug}`,
        slug,
        aliases: [],
        objective: "Admin recovery route test"
      }
    })
  }), testEnv, ctx);
  expect(response.status).toBe(200);
  const receipt = await response.json<{ status: string; project_id: string }>();
  expect(receipt.status).toBe("committed");
  return receipt.project_id;
}

function recoveryRequest(body: unknown, token = testEnv.INGRESS_TOKEN): Request {
  return new Request("https://example.com/v1/admin/recover-inputs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function recoveryStatusRequest(projectId: string, token = testEnv.INGRESS_TOKEN): Request {
  return new Request(`https://example.com/v1/admin/input-recovery-status?project_id=${encodeURIComponent(projectId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
}

function assertSummaryInvariant(summary: {
  scanned: number;
  completed: number;
  duplicate_cleaned: number;
  conflicts: number;
  withdrawn: number;
  failed: number;
}): void {
  expect(summary.scanned).toBe(
    summary.completed + summary.duplicate_cleaned + summary.conflicts + summary.withdrawn + summary.failed
  );
}

describe("POST /v1/admin/recover-inputs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires ingress authorization", async () => {
    installDropboxMock();
    const response = await worker.fetch(recoveryRequest({ project_ids: ["PRJ-0002"] }, "wrong-token"), testEnv, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it("requires an explicit non-empty project list", async () => {
    installDropboxMock();
    const empty = await worker.fetch(recoveryRequest({ project_ids: [] }), testEnv, createExecutionContext());
    const missing = await worker.fetch(recoveryRequest({}), testEnv, createExecutionContext());
    expect(empty.status).toBe(400);
    expect(missing.status).toBe(400);
  });

  it("rejects unknown projects before listing or mutating their provider roots", async () => {
    const mock = installDropboxMock();
    const baseline = mock.calls.length;
    const response = await worker.fetch(
      recoveryRequest({ project_ids: ["PRJ-9999"] }),
      testEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(404);
    const forbiddenProviderCalls = mock.calls.slice(baseline).filter((call) =>
      call.includes("/2/files/list_folder")
      || call.includes("/2/files/upload")
      || call.includes("/2/files/delete_v2")
      || call.includes("/2/files/move_v2")
      || call.includes("/2/files/copy_v2")
      || call.includes("/2/files/create_folder_v2")
    );
    expect(forbiddenProviderCalls).toEqual([]);
  });

  it("recovers only explicitly selected projects through their ProjectGuard", async () => {
    const mock = installDropboxMock();
    const selectedProject = await createProject("TXN-ADMIN-RECOVERY-0001", "admin-recovery-selected");
    const untouchedProject = await createProject("TXN-ADMIN-RECOVERY-0002", "admin-recovery-untouched");
    const selectedRelative = "selected.md";
    const untouchedRelative = "untouched.md";
    const selectedInput = workspaceManagedDocumentPath(
      selectedProject,
      "admin-recovery-selected",
      "inputs",
      selectedRelative
    );
    const untouchedInput = workspaceManagedDocumentPath(
      untouchedProject,
      "admin-recovery-untouched",
      "inputs",
      untouchedRelative
    );
    await mock.writeExternal(selectedInput, "selected historical source");
    await mock.writeExternal(untouchedInput, "untouched historical source");

    const response = await worker.fetch(
      recoveryRequest({ project_ids: [selectedProject] }),
      testEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ results: Array<{
      project_id: string;
      scanned: number;
      completed: number;
      duplicate_cleaned: number;
      conflicts: number;
      withdrawn: number;
      failed: number;
    }> }>();
    expect(body).toMatchObject({
      results: [{
        project_id: selectedProject,
        scanned: 1,
        completed: 1,
        duplicate_cleaned: 0,
        conflicts: 0,
        withdrawn: 0,
        failed: 0
      }]
    });
    assertSummaryInvariant(body.results[0]);

    expect(mock.files.has(selectedInput)).toBe(false);
    expect(mock.files.get(workspaceManagedDocumentPath(
      selectedProject,
      "admin-recovery-selected",
      "references",
      `UNCLASSIFIED/${selectedRelative}`
    ))).toBe("selected historical source");
    expect(mock.files.get(untouchedInput)).toBe("untouched historical source");

    const status = await worker.fetch(recoveryStatusRequest(selectedProject), testEnv, createExecutionContext());
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ project_id: selectedProject, remaining: 0 });
  });
});

describe("GET /v1/admin/input-recovery-status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires authorization and an exact four-digit project ID", async () => {
    installDropboxMock();
    const unauthorized = await worker.fetch(recoveryStatusRequest("PRJ-0002", "wrong-token"), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    for (const invalid of ["PRJ-000", "PRJ-00000", "PRJ-AUTO", "prj-0002", "PRJ-12A4"]) {
      const response = await worker.fetch(recoveryStatusRequest(invalid), testEnv, createExecutionContext());
      expect(response.status, invalid).toBe(400);
    }
  });

  it("counts remaining INPUTS without provider mutation", async () => {
    const mock = installDropboxMock();
    const projectId = await createProject("TXN-ADMIN-RECOVERY-STATUS-0001", "admin-recovery-status");
    const relative = "pending.md";
    const input = workspaceManagedDocumentPath(projectId, "admin-recovery-status", "inputs", relative);
    const reference = workspaceManagedDocumentPath(projectId, "admin-recovery-status", "references", `UNCLASSIFIED/${relative}`);
    await mock.writeExternal(input, "pending source");
    const baseline = mock.calls.length;

    const response = await worker.fetch(recoveryStatusRequest(projectId), testEnv, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project_id: projectId, remaining: 1 });
    expect(mock.files.get(input)).toBe("pending source");
    expect(mock.files.has(reference)).toBe(false);

    const mutationCalls = mock.calls.slice(baseline).filter((call) =>
      call.includes("/2/files/upload")
      || call.includes("/2/files/delete_v2")
      || call.includes("/2/files/move_v2")
      || call.includes("/2/files/copy_v2")
      || call.includes("/2/files/create_folder_v2")
    );
    expect(mutationCalls).toEqual([]);
  });
});
