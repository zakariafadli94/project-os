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
    const providerCalls = mock.calls.slice(baseline).filter((call) => call.includes("/2/files/"));
    expect(providerCalls).toEqual([]);
  });

  it("recovers only explicitly selected projects through their ProjectGuard", async () => {
    const mock = installDropboxMock();
    const selectedProject = await createProject("TXN-ADMIN-RECOVERY-0001", "admin-recovery-selected");
    const untouchedProject = await createProject("TXN-ADMIN-RECOVERY-0002", "admin-recovery-untouched");
    const selectedRelative = "legacy/selected.md";
    const untouchedRelative = "legacy/untouched.md";
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
    expect(await response.json()).toMatchObject({
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

    expect(mock.files.has(selectedInput)).toBe(false);
    expect(mock.files.get(workspaceManagedDocumentPath(
      selectedProject,
      "admin-recovery-selected",
      "references",
      `UNCLASSIFIED/${selectedRelative}`
    ))).toBe("selected historical source");
    expect(mock.files.get(untouchedInput)).toBe("untouched historical source");
  });
});
