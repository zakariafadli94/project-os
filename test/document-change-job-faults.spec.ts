import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  initializeManagedDocumentChangeJobSchema,
  ManagedDocumentChangeJobStore,
  type ManagedDocumentChangeJobInput,
  type ManagedDocumentDriftFinding,
  type ManagedDocumentChangeQuarantine
} from "../src/documents/change-job-store";
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

  it("bounds a scheduled document slice and leaves durable work for the next cron", async () => {
    const mock = installDropboxMock();
    const slug = "scheduled-document-budget";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-SCHEDULED-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    for (let index = 0; index < 6; index += 1) {
      await mock.writeExternal(`${root}/INPUTS/scheduled-${index}.pdf`, `%PDF scheduled ${index}`);
    }

    const response = await guard.fetch(
      "https://project-guard.internal/reconcile-documents?scheduled=1",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduled: true,
      jobs_registered: 6,
      jobs_completed: 1,
      jobs_pending: 5
    });
  });

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
      job_failures: 1,
      ignored: 0
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

  it("routes a folder change without requesting file metadata", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-routing";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobs_registered: 1,
      jobs_completed: 1,
      jobs_pending: 0,
      job_failures: 0
    });
    expect(mock.providerCalls).not.toContainEqual({ endpoint: "POST /2/files/get_metadata", paths: [folder] });
  });

  it("terminally quarantines a legacy file job whose target is now a folder", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-folder-quarantine";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-FOLDER-0002", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const folder = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/REVENUE-OS`;
    mock.writeExternalFolder(folder);

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(),
        next_cursor: "legacy-folder-cursor",
        jobs: [{
          job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
          change: { kind: "file", name: "REVENUE-OS", path: folder },
          detection_source: "incremental",
          priority: 10
        }]
      });
    });

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 1, job_failures: 0 });

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
      path: folder,
      code: "directory_used_as_file_target",
      attempts: 1
    })]);
  });

  it("quarantines a proven-absent file target once and admits a new observation after it reappears", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-missing-metadata";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-MISSINGMETA-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/vanished.pdf`;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({
        expected_cursor: store.cursor(), next_cursor: "missing-metadata-retry-cursor",
        jobs: [{ job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", change: { kind: "file", name: "vanished.pdf", path: absentPath }, detection_source: "incremental", priority: 10 }]
      });
    });

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_completed: 0, job_failures: 0, jobs_quarantined: 1 });
    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual([expect.objectContaining({
      job_id: "CHGJOB-FFFFFFFFFFFFFFFFFFFFFFFF", path: absentPath, code: "file_target_missing", attempts: 1
    })]);

    const second = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(second.json()).resolves.toMatchObject({ jobs_pending: 0, jobs_quarantined: 0, job_failures: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines[0]?.attempts).toBe(1);

    await mock.writeExternal(absentPath, "%PDF target reappeared with a new provider revision");
    const reappeared = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await expect(reappeared.json()).resolves.toMatchObject({ jobs_registered: 1, jobs_completed: 1, jobs_pending: 0 });
    await runInDurableObject(guard, async (_instance, state) => {
      const jobs = state.storage.sql.exec<{ job_id: string; status: string; attempts: number }>(
        "SELECT job_id, status, attempts FROM managed_document_change_jobs ORDER BY ordinal"
      ).toArray();
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.job_id)).size).toBe(2);
      expect(jobs.map((job) => job.status)).toEqual(["completed", "completed"]);
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toHaveLength(1);
  });

  it("keeps a file-kind change retryable when the provider listing fails", async () => {
    const faults: DropboxMockFault[] = [];
    installDropboxMock({ faults });
    const slug = "change-job-list-failure";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-LISTFAIL-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const absentPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}/DELIVERABLES/unknown.pdf`;
    const parent = absentPath.slice(0, absentPath.lastIndexOf("/"));
    await runInDurableObject(guard, async (_instance, state) => {
      const store = new ManagedDocumentChangeJobStore(state.storage);
      store.registerPage({ expected_cursor: store.cursor(), next_cursor: "list-failure-cursor", jobs: [{
        job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE",
        change: { kind: "file", name: "unknown.pdf", path: absentPath }, detection_source: "incremental", priority: 10
      }] });
    });
    for (let occurrence = 1; occurrence <= 10; occurrence += 1) {
      faults.push({ endpoint: "/2/files/list_folder", occurrence: 1, status: 503, error_summary: "temporarily_unavailable", path: parent });
    }

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs_pending: 1, jobs_completed: 0, job_failures: expect.any(Number), jobs_quarantined: 0 });
    let pending: unknown[] = [];
    await runInDurableObject(guard, async (_instance, state) => {
      pending = new ManagedDocumentChangeJobStore(state.storage).pending();
    });
    expect(pending).toEqual([expect.objectContaining({
      job_id: "CHGJOB-EEEEEEEEEEEEEEEEEEEEEEEE", attempts: expect.any(Number), last_error: expect.stringContaining("Dropbox list_folder failed")
    })]);
  }, 15_000);

  it("terminally quarantines an external move that conflicts with immutable candidate evidence", async () => {
    const mock = installDropboxMock();
    const slug = "change-job-candidate-evidence-conflict";
    const created = await createProject("TXN-CHANGEJOB-PROJECT-CANDIDATE-0001", slug);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-${slug}`;
    const original = `${root}/DELIVERABLES/external.md`;
    const moved = `${root}/DELIVERABLES/external-moved.md`;
    await mock.writeExternal(original, "# externally moved");
    expect((await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })).status).toBe(200);

    const move = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_path: original, to_path: moved })
    });
    expect(move.ok).toBe(true);

    const first = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      jobs_quarantined: 1,
      jobs_pending: 0,
      job_failures: 0
    });

    let quarantines: ManagedDocumentChangeQuarantine[] = [];
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    await runInDurableObject(guard, async (_instance, state) => {
      quarantines = new ManagedDocumentChangeJobStore(state.storage).quarantines();
    });
    expect(quarantines).toEqual(expect.arrayContaining([expect.objectContaining({
      path: moved,
      code: "mutation_candidate_evidence_conflict",
      attempts: 1
    })]));
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

  it("deduplicates a replayed page and preserves global pending order across later pages", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0003", "change-job-store-order");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-store-order/INPUTS`;
      const firstPage: ManagedDocumentChangeJobInput[] = [
        {
          job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
          change: { kind: "deleted", name: "first.md", path: `${root}/first.md` },
          detection_source: "incremental",
          priority: 10
        },
        {
          job_id: "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB",
          change: { kind: "deleted", name: "second.md", path: `${root}/second.md` },
          detection_source: "incremental",
          priority: 10
        }
      ];

      const initialCursor = store.cursor();
      expect(store.registerPage({
        expected_cursor: initialCursor,
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-1",
        jobs: firstPage
      })).toEqual({ inserted: 0, cursor_advanced: false });
      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB"
      ]);

      store.markFailed("CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA", "retry me");
      store.markCompleted("CHGJOB-BBBBBBBBBBBBBBBBBBBBBBBB");
      expect(store.registerPage({
        expected_cursor: "store-cursor-1",
        next_cursor: "store-cursor-2",
        jobs: [
          {
            job_id: "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
            change: { kind: "deleted", name: "third.md", path: `${root}/third.md` },
            detection_source: "incremental",
            priority: 10
          },
          {
            job_id: "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD",
            change: { kind: "deleted", name: "fourth.md", path: `${root}/fourth.md` },
            detection_source: "incremental",
            priority: 10
          }
        ]
      })).toEqual({ inserted: 2, cursor_advanced: true });

      expect(store.pending().map((job) => job.job_id)).toEqual([
        "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        "CHGJOB-CCCCCCCCCCCCCCCCCCCCCCCC",
        "CHGJOB-DDDDDDDDDDDDDDDDDDDDDDDD"
      ]);
    });
  });

  it("persists an external drift conflict without replacing its first observation", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0004", "change-job-drift-finding");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let findings: ManagedDocumentDriftFinding[] = [];

    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      const finding = {
        finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
        job_id: "CHGJOB-AAAAAAAAAAAAAAAAAAAAAAAA",
        path: `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-change-job-drift-finding/WORKING/PACKAGES/PKG-${"A".repeat(64)}/1/a.md`,
        change_kind: "deleted" as const,
        status: "unexpected_conflict" as const,
        code: "PACKAGE_UNEXPECTED_DISAPPEARANCE",
        request_id: "DOCREQ-DRIFT-0001",
        resource: { resource_id: `PKG-${"A".repeat(64)}`, resource_type: "package", zone: "WORKING", version: `1:${"b".repeat(64)}` },
        observed_at: "2026-09-12T00:00:00.000Z"
      };
      store.recordDriftFinding(finding);
      store.recordDriftFinding({ ...finding, observed_at: "2026-09-12T01:00:00.000Z", code: "PACKAGE_EXPECTED_EFFECT_DIVERGED" });
      findings = store.driftFindings();
    });

    expect(findings).toEqual([expect.objectContaining({
      finding_id: "DRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
      status: "unexpected_conflict",
      code: "PACKAGE_EXPECTED_EFFECT_DIVERGED",
      opened_at: "2026-09-12T00:00:00.000Z",
      observed_at: "2026-09-12T01:00:00.000Z"
    })]);
  });

  it("persists daily verification lateness until a later successful verification", async () => {
    installDropboxMock();
    const created = await createProject("TXN-CHANGEJOB-PROJECT-0005", "change-job-lateness");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let first: unknown;
    let early: unknown;
    let late: unknown;
    let cleared: unknown;
    await runInDurableObject(guard, async (_instance, state) => {
      initializeManagedDocumentChangeJobSchema(state.storage);
      const store = new ManagedDocumentChangeJobStore(state.storage);
      first = store.scheduledVerification("2026-09-12T00:00:00.000Z");
      store.completeScheduledVerification("2026-09-12T00:00:00.000Z");
      early = store.scheduledVerification("2026-09-12T23:59:59.000Z");
      late = store.scheduledVerification("2026-09-13T00:00:01.000Z");
      store.completeScheduledVerification("2026-09-13T00:00:01.000Z");
      cleared = store.scheduledVerification("2026-09-13T00:00:02.000Z");
    });

    expect(first).toMatchObject({ due: true, late_since: null });
    expect(early).toMatchObject({ due: false, late_since: null });
    expect(late).toMatchObject({ due: true, late_since: "2026-09-13T00:00:00.000Z" });
    expect(cleared).toMatchObject({ due: false, late_since: null, last_verified_at: "2026-09-13T00:00:01.000Z" });
  });
});
