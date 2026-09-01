import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import {
  machineMaterializationHeadPath,
  workspaceManagedZoneRoot
} from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-28T22:15:00+01:00";

async function submit(projectId: string, transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
    "https://project-guard.internal/transaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    }
  );
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

async function createProject(slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch(
    "https://registry-guard.internal/create",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-ACTIVATION-BOOTSTRAP-CREATE",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: "Managed Zone Bootstrap",
          slug,
          aliases: [],
          objective: "Prove managed workspace activation"
        }
      })
    }
  );
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

function expectedManagedDirectories(projectId: string, slug: string): string[] {
  const references = workspaceManagedZoneRoot(projectId, slug, "references");
  return [
    workspaceManagedZoneRoot(projectId, slug, "inputs"),
    references,
    `${references}/UNCLASSIFIED`,
    workspaceManagedZoneRoot(projectId, slug, "working"),
    workspaceManagedZoneRoot(projectId, slug, "review"),
    workspaceManagedZoneRoot(projectId, slug, "deliverables")
  ];
}

describe("projection-v2 managed-zone bootstrap", () => {
  afterEach(() => vi.restoreAllMocks());

  it("provisions active managed zones before projection and does not reprovision during archive materialization", async () => {
    const mock = installDropboxMock();
    const baseImplementation = mock.spy.getMockImplementation();
    if (!baseImplementation) throw new Error("Dropbox mock implementation missing");
    const directoryCalls: string[] = [];

    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        const body = JSON.parse(await request.clone().text()) as { path?: string };
        if (body.path) directoryCalls.push(body.path);
      }
      return baseImplementation(input, init);
    });

    const slug = "managed-zone-bootstrap";
    const created = await createProject(slug);
    expect(created).toMatchObject({ status: "committed", previous_revision: 0, new_revision: 1 });
    const projectId = created.project_id;
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(directoryCalls).toEqual(expectedManagedDirectories(projectId, slug));
    const activeHead = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}");
    expect(activeHead).toMatchObject({
      target_revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active"
    });

    directoryCalls.length = 0;
    const reconcile = await stub.fetch("https://project-guard.internal/reconcile-materialization", { method: "POST" });
    expect(reconcile.status).toBe(200);
    // INDEX001 can legitimately leave a derived search-index alarm pending after
    // the first canonical/materialization cycle. Running it must still preserve
    // this test's actual invariant: managed zones are not provisioned again.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(directoryCalls).toEqual([]);

    const archived = await submit(projectId, {
      schema_version: "1.0",
      transaction_id: "TXN-ACTIVATION-BOOTSTRAP-ARCHIVE",
      project_id: projectId,
      base_revision: 1,
      operation: "project.archive",
      created_at: at,
      payload: { reason: "Verify archived projection does not provision active zones" }
    });
    expect(archived).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(directoryCalls).toEqual([]);
  });
});
