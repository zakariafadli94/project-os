import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-31T14:20:00+01:00";

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
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
      payload: { name: `Change jobs ${slug}`, slug, aliases: [], objective: "Durable change jobs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("durable managed-document change jobs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("advances the provider cursor after durable registration while isolating a failed job from a healthy sibling", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-isolation";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    // Establish the initial provider cursor before introducing the page under test.
    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const badInput = `${root}/INPUTS/bad.pdf`;
    const goodInput = `${root}/INPUTS/good.pdf`;
    faults.push({
      endpoint: "/2/files/copy_v2",
      occurrence: 1,
      status: 409,
      error_summary: "to/conflict/file/...",
      path: badInput
    });

    await mock.writeExternal(badInput, "%PDF poison job");
    await mock.writeExternal(goodInput, "%PDF healthy job");

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      cursor_advanced: true,
      jobs_registered: 2,
      jobs_completed: 1,
      jobs_pending: 1,
      job_failures: 1
    });

    expect(mock.files.has(badInput)).toBe(true);
    expect(mock.files.has(goodInput)).toBe(false);
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/good.pdf`)).toBe("%PDF healthy job");

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(second.status).toBe(200);
    const secondSummary = await second.json<{ jobs_completed: number; jobs_pending: number; job_failures: number }>();
    expect(secondSummary.jobs_completed).toBeGreaterThanOrEqual(1);
    expect(secondSummary).toMatchObject({
      jobs_pending: 0,
      job_failures: 0
    });
    expect(mock.files.has(badInput)).toBe(false);
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/bad.pdf`)).toBe("%PDF poison job");
    expect(mock.files.get(`${root}/REFERENCES/UNCLASSIFIED/good.pdf`)).toBe("%PDF healthy job");
  });

  it("keeps the old durable cursor when cursor-reset baseline fetch fails before atomic page registration", async () => {
    const faults: DropboxMockFault[] = [];
    const mock = installDropboxMock({ faults });
    const slug = "change-job-reset-atomic";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    const baseline = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(baseline.status).toBe(200);

    let cursorBefore: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorBefore = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(cursorBefore).not.toBeNull();

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    await mock.writeExternal(`${root}/ARTIFACTS/reset-proof.md`, "# reset proof");

    // The first continue reports reset, then rebuilding the baseline fails. The
    // second reset fault is reserved for the retry so we can prove the old cursor
    // survived rather than silently degrading the retry into an ordinary baseline.
    faults.push(
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      },
      {
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      },
      {
        endpoint: "/2/files/list_folder",
        occurrence: 1,
        status: 400,
        error_summary: "invalid_arg/..."
      }
    );

    let failed = false;
    try {
      const firstReset = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
      failed = !firstReset.ok;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    let cursorAfterFailure: string | null = null;
    await runInDurableObject(guard, async (_instance, state) => {
      cursorAfterFailure = state.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM managed_document_change_control WHERE singleton = 1"
      ).one().cursor;
    });
    expect(cursorAfterFailure).toBe(cursorBefore);

    const retry = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      cursor_reset: true,
      baseline: true,
      cursor_advanced: true
    });
  });
});
