import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { testEnv } from "./support/runtime-env";
import { mock, resetMock, createProject, submit, at } from "./support/dropbox-mock";
import { machineMaterializationHeadPath } from "../src/persistence/layout";
import { CURRENT_PROJECTION_VERSION } from "../src/materialization/version";

function expectedManagedDirectories(projectId: string, slug: string): string[] {
  const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-${slug}`;
  return [
    `${root}/INPUTS`,
    `${root}/REFERENCES`,
    `${root}/WORKING`,
    `${root}/REVIEW`,
    `${root}/DELIVERABLES`
  ];
}

describe("projection-v2 managed-zone bootstrap", () => {
  beforeEach(() => {
    resetMock();
  });

  it("provisions active managed zones before projection and does not reprovision during archive materialization", async () => {
    const directoryCalls: string[] = [];
    const baseImplementation = mock.fetch.getMockImplementation();
    if (!baseImplementation) throw new Error("Dropbox mock is not initialized");
    mock.fetch.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/files/create_folder_v2")) {
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