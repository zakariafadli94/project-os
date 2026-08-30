import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-30T13:30:00.000Z";

async function createProject(): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: "TXN-INTAKE-SWEEP-INTEGRATION-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Intake Sweep Integration",
        slug: "intake-sweep-integration",
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
    const created = await createProject();
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const source = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-intake-sweep-integration/INPUTS/missed/report.pdf`;
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
      "intake-sweep-integration",
      "references",
      "UNCLASSIFIED/missed/report.pdf"
    ))).toBe("%PDF cursor-missed input");
  });
});
