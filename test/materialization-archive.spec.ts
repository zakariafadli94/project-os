import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  archiveProjectRoot,
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
let sequence = 0;

async function createRegisteredProject(slug: string): Promise<Receipt> {
  sequence += 1;
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: `TXN-MATARCH-CREATE-${sequence.toString().padStart(6, "0")}`,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: "2026-08-24T18:00:00+01:00",
      payload: {
        name: `Materialization Archive ${sequence}`,
        slug,
        aliases: [],
        objective: "Prove archive-safe projection"
      }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function archiveProject(projectId: string, transactionId: string): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: projectId,
      base_revision: 1,
      operation: "project.archive",
      created_at: "2026-08-24T18:01:00+01:00",
      payload: { reason: "Archive projection proof" }
    })
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

function projectionStub(projectId: string) {
  return testEnv.MATERIALIZATION_GUARD.getByName(projectId);
}

describe("archive-safe materialization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves the verified active workspace once and publishes an archive generation with relative evidence", async () => {
    const mock = installDropboxMock();
    const slug = "materialization-archive-main";
    const created = await createRegisteredProject(slug);
    const projectId = created.project_id;
    const stub = projectionStub(projectId);
    const activeRoot = workspaceProjectRoot(projectId, slug);
    const archiveRoot = archiveProjectRoot(projectId, slug);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const activeHead = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}");
    expect(activeHead).toMatchObject({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION, workspace_location: "active" });
    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(true);

    const archived = await archiveProject(projectId, "TXN-MATARCH-ARCHIVE-000001");
    expect(archived).toMatchObject({ status: "committed", previous_revision: 1, new_revision: 2 });
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(false);
    expect(mock.files.has(`${archiveRoot}/PROJECT.md`)).toBe(true);

    const head = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}");
    expect(head).toMatchObject({ target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION, workspace_location: "archive" });
    const record = JSON.parse(mock.files.get(machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION)) ?? "{}");
    expect(record.workspace_location).toBe("archive");
    expect(record.outputs["global:STATE"].relative_path).toBe("STATE.md");
    expect(record.outputs["global:HANDOFF"].relative_path).toBe("HANDOFF.md");
    expect(JSON.stringify(record.outputs)).not.toContain("/PROJECT_OS/");
    expect(mock.files.get(`${archiveRoot}/STATE.md`)).toContain("Revision: 2");
    expect(mock.files.get(`${archiveRoot}/HANDOFF.md`)).toContain("Revision: 2");

    const replay = await archiveProject(projectId, "TXN-MATARCH-ARCHIVE-000001");
    expect(replay).toEqual(archived);
    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(false);
    expect(mock.files.has(`${archiveRoot}/PROJECT.md`)).toBe(true);
  });

  it("resumes after the workspace moved but generation evidence failed without recreating active workspace", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "materialization-archive-resume";
    const created = await createRegisteredProject(slug);
    const projectId = created.project_id;
    const stub = projectionStub(projectId);
    const activeRoot = workspaceProjectRoot(projectId, slug);
    const archiveRoot = archiveProjectRoot(projectId, slug);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    faults.push({
      endpoint: "/2/files/upload",
      method: "POST",
      path: machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION),
      occurrence: 1,
      status: 400,
      error_summary: "injected/archive_record_failure"
    });

    await archiveProject(projectId, "TXN-MATARCH-ARCHIVE-000002");
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow();

    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(false);
    expect(mock.files.has(`${archiveRoot}/PROJECT.md`)).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);
    expect(mock.files.has(machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION))).toBe(false);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(false);
    expect(mock.files.has(`${archiveRoot}/PROJECT.md`)).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}")).toMatchObject({
      target_revision: 2,
      workspace_location: "archive"
    });
  });

  it("fails closed when active and archive roots both exist and never advances the head", async () => {
    const mock = installDropboxMock();
    const slug = "materialization-archive-conflict";
    const created = await createRegisteredProject(slug);
    const projectId = created.project_id;
    const stub = projectionStub(projectId);
    const activeRoot = workspaceProjectRoot(projectId, slug);
    const archiveRoot = archiveProjectRoot(projectId, slug);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    mock.files.set(`${archiveRoot}/PROJECT.md`, mock.files.get(`${activeRoot}/PROJECT.md`) ?? "duplicate");

    await archiveProject(projectId, "TXN-MATARCH-ARCHIVE-000003");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(mock.files.has(`${activeRoot}/PROJECT.md`)).toBe(true);
    expect(mock.files.has(`${archiveRoot}/PROJECT.md`)).toBe(true);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "{}").target_revision).toBe(1);

    const statusResponse = await testEnv.PROJECT_GUARD.getByName(projectId).fetch(
      "https://project-guard.internal/materialization-status",
      { method: "GET" }
    );
    const status = await statusResponse.json<{ canonical_revision: number; blocked_error: string | null }>();
    expect(status.canonical_revision).toBe(2);
    expect(status.blocked_error).toMatch(/archive|workspace|inconsistent/i);
  });
});