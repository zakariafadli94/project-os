import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-30T13:30:00.000Z";

async function createProject(suffix: string): Promise<Receipt> {
  const slug = `intake-sweep-integration-${suffix.toLowerCase()}`;
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-INTAKE-SWEEP-INTEGRATION-${suffix}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: `Intake Sweep Integration ${suffix}`,
        slug,
        aliases: [],
        objective: "Prove direct INPUT sweep is part of document maintenance"
      }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("ProjectGuard direct INPUT sweep integration", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("ingests an INPUT that is present on the provider but absent from the change feed", async () => {
    const mock = installDropboxMock();
    const created = await createProject("A0001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const slug = "intake-sweep-integration-a0001";

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const source = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/INPUTS/missed/report.pdf`;
    // Deliberately bypass writeExternal(): the file exists for list/get_metadata,
    // but no provider change event is appended after the stored cursor.
    mock.files.set(source, "%PDF cursor-missed input");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sweep: { files_scanned: 1, ingested: 1, duplicates: 0, failed: 0 }
    });

    expect(mock.files.has(source)).toBe(false);
    expect(mock.files.get(workspaceManagedDocumentPath(
      created.project_id,
      slug,
      "references",
      "UNCLASSIFIED/missed/report.pdf"
    ))).toBe("%PDF cursor-missed input");
  });

  it("still sweeps INPUTS when the incremental change feed exhausts its retries", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const created = await createProject("B0001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const slug = "intake-sweep-integration-b0001";

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const source = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/INPUTS/missed/feed-down.pdf`;
    mock.files.set(source, "%PDF survives change feed outage");

    // Provider resilience retries change-feed operations five times. Each fault
    // is consumed once so the incremental path exhausts all retries while list /
    // metadata operations used by the direct sweep remain available.
    for (let index = 0; index < 5; index += 1) {
      faults.push({
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 503,
        error_summary: "internal_error/change_feed_unavailable"
      });
    }

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      change_feed_error: expect.stringContaining("change"),
      sweep: { files_scanned: 1, ingested: 1, duplicates: 0, failed: 0 }
    });
    expect(mock.files.has(source)).toBe(false);
  });
});
