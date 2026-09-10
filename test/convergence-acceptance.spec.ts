import { describe, expect, it, vi } from "vitest";
import { runHumanSlice } from "../src/convergence/human";
import { ConvergenceEngine } from "../src/convergence/engine";
import { createSliceBudget } from "../src/convergence/budget";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { MaterializationCoordinator, type MaterializationLedgerPort } from "../src/materialization/coordinator";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import { ProjectRepository } from "../src/persistence/repository";
import {
  convergenceIncidentPath,
  machineCommitRecordPath,
  machineEventPath,
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  machineReceiptPath,
  workspaceProjectRoot
} from "../src/persistence/layout";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { commitFixture, seedCommits } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class AcceptanceLedger implements MaterializationLedgerPort {
  private requested: { revision: number; projection_version: number } | null = null;
  private active: { revision: number; projection_version: number; coalesced_revisions: number[] } | null = null;
  private head: { revision: number; projection_version: number } | null = null;
  private readonly outputs = new Map<string, ProjectionOutputEvidence>();

  requestTarget(target: { revision: number; projection_version: number }) { this.requested = target; }
  beginNextTarget() {
    if (!this.active && this.requested) {
      this.active = { ...this.requested, coalesced_revisions: [] };
    }
    return this.active;
  }
  recordVerifiedOutput(key: string, evidence: ProjectionOutputEvidence) { this.outputs.set(key, evidence); }
  attemptOutputs() { return new Map(this.outputs); }
  baselineOutputs() { return new Map(); }
  immutableDerivativesThrough() { return null; }
  markImmutableDerivativesThrough(_revision: number) {}
  failActive(_message: string) {}
  completeTarget(input: { revision: number; projection_version: number; outputs: ReadonlyMap<string, ProjectionOutputEvidence>; removed_outputs: readonly string[] }) {
    this.head = { revision: input.revision, projection_version: input.projection_version };
    this.active = null;
    this.requested = null;
  }
  restoreExternalBaseline(head: { revision: number; projection_version: number }, _outputs: ReadonlyMap<string, ProjectionOutputEvidence>) {
    this.head = head;
    this.active = null;
  }
  status() {
    return {
      head: this.head,
      requested: this.requested,
      active: this.active,
      active_status: this.active ? "running" as const : null,
      last_error: null,
      output_count: this.outputs.size,
      attempt_output_count: this.outputs.size
    };
  }
}

describe("post-commit convergence acceptance", () => {
  it("materializes and verifies the revision-258 critical pair before publishing its head", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9258", 258)[257];
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);

    const result = await runHumanSlice({
      record,
      repository,
      runtime,
      ledger: new AcceptanceLedger(),
      now: () => "2026-09-09T00:00:00.000Z"
    });

    const root = workspaceProjectRoot(record.project_id, record.state.slug);
    expect(result.complete).toBe(true);
    expect(mock.files.get(`${root}/STATE.md`)).toContain("Revision: 258");
    expect(mock.files.get(`${root}/HANDOFF.md`)).toContain("Revision: 258");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record.project_id)) ?? "{}")).toMatchObject({
      target_revision: 258,
      projection_version: 3
    });
  });

  it("uses the reserved effect runtime for bounded human materialization", async () => {
    const mock = installDropboxMock();
    const effectRuntime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9275", 1)[0]!;
    const repository = new ProjectRepository(effectRuntime, "v2");
    await repository.writeCommitRecord(record);
    await repository.writeReceipt(record.receipt);
    const root = workspaceProjectRoot(record.project_id, record.state.slug);
    const requestRuntime = {
      ...effectRuntime,
      objects: {
        ...effectRuntime.objects,
        async createText(path: string, content: string) {
          if (path.startsWith(`${root}/`)) throw new Error("request_scope_must_not_write_human_output");
          return effectRuntime.objects.createText(path, content);
        }
      }
    };
    const journal = new ConvergenceJournal(effectRuntime, record.project_id);
    const engine = new ConvergenceEngine({
      projectId: record.project_id,
      repository,
      runtime: requestRuntime,
      effectRuntime,
      journal,
      ledger: new AcceptanceLedger() as never,
      now: () => 0,
      enableHuman: true
    });

    for (let slice = 0; slice < 8; slice += 1) {
      await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
      if (mock.files.has(machineMaterializationHeadPath(record.project_id))) break;
    }

    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record.project_id)) ?? "{}")).toMatchObject({
      target_revision: 1,
      projection_version: 3
    });
  });

  it("keeps a human projection pending when reconciliation reaches its slice boundary", async () => {
    installDropboxMock();
    const baseRuntime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9273", 1)[0];
    const baseRepository = new ProjectRepository(baseRuntime, "v2");
    await baseRepository.writeCommitRecord(record);
    const constrainedRuntime = {
      ...baseRuntime,
      objects: {
        ...baseRuntime.objects,
        async readText(path: string) {
          if (path === machineMaterializationHeadPath(record.project_id)) {
            throw new Error("Dropbox read failed: slice_budget_exhausted");
          }
          return baseRuntime.objects.readText(path);
        }
      }
    };

    await expect(runHumanSlice({
      record,
      repository: new ProjectRepository(constrainedRuntime, "v2"),
      runtime: constrainedRuntime,
      ledger: new AcceptanceLedger(),
      budget: createSliceBudget(() => 0, new AbortController().signal)
    })).resolves.toEqual({ complete: false, more_work: true });
  });

  it("does not repeat reconciliation for an already active human target", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9274", 1)[0];
    const repository = new ProjectRepository(runtime, "v2");
    const ledger = new AcceptanceLedger();
    ledger.requestTarget({ revision: record.new_revision, projection_version: 3 });
    ledger.beginNextTarget();
    const reconcile = vi.spyOn(MaterializationCoordinator.prototype, "reconcile");
    const runNext = vi.spyOn(MaterializationCoordinator.prototype, "runNext").mockResolvedValue({
      project_id: record.project_id, target_revision: record.new_revision, projection_version: 3,
      completed: false, repaired_head: false, more_work: true
    });

    try {
      await runHumanSlice({ record, repository, runtime, ledger });
      expect(reconcile).not.toHaveBeenCalled();
      expect(runNext).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("marks the human pair current only after revision-258 generation and head are verified", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const record = commitFixture("PRJ-9258", 258)[257];
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const progress = initialProgress(record.project_id, "2026-09-09T00:00:00.000Z", "writer-1");
    progress.canonical_observed_revision = 257;
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal,
      ledger: new AcceptanceLedger() as never,
      now: () => Date.parse("2026-09-09T00:00:00.000Z"),
      enableHuman: true
    });

    await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const result = await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const verified = await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));

    expect(result.health.layers.human_state.state).toBe("current");
    expect(result.health.layers.human_handoff.state).toBe("current");
    expect(result.health.layers.generation.state).toBe("current");
    expect(result.health.layers.head.state).toBe("current");
    expect(verified.health.converged).toBe(true);
    expect(mock.files.get(`${workspaceProjectRoot(record.project_id, record.state.slug)}/HANDOFF.md`)).toContain("Revision: 258");
  });

  it("does not let a PRJ-0003-shaped coalesced 264 generation hide a missing 263 event or receipt", async () => {
    const projectId = "PRJ-9263";
    const records = commitFixture(projectId, 264);
    const record263 = records[262]!;
    const record264 = records[263]!;
    const mock = installDropboxMock();
    seedCommits(mock, records);
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    const ledger = new AcceptanceLedger();
    await runHumanSlice({
      record: record264, repository, runtime, ledger,
      now: () => "2026-09-09T00:00:00.000Z"
    });
    const generationPath = machineMaterializationRecordPath(projectId, 264, 3);
    const generated = JSON.parse(mock.files.get(generationPath) ?? "{}");
    mock.files.set(generationPath, `${JSON.stringify({ ...generated, coalesced_revisions: [263] }, null, 2)}\n`);
    const coalescedGeneration = mock.files.get(generationPath)!;
    await repository.writeCanonicalEvent(record264);
    await repository.writeReceipt(record264.receipt);
    await repository.writeMachineSnapshot(record264.state);
    expect(mock.files.has(machineEventPath(projectId, record263.event.event_id))).toBe(false);
    expect(mock.files.has(machineReceiptPath(record263.receipt.transaction_id))).toBe(false);

    const journal = new ConvergenceJournal(runtime, projectId);
    const progress = initialProgress(projectId, "2026-09-09T00:00:00.000Z", "revision-263-regression");
    progress.canonical_observed_revision = 262;
    await journal.save(progress, null);
    const engine = new ConvergenceEngine({
      projectId, repository, runtime, journal, ledger: ledger as never,
      now: () => Date.parse("2026-09-09T00:00:00.000Z"), enableHuman: true
    });

    const before = await engine.observe(createSliceBudget(() => 0, new AbortController().signal));
    expect(before.converged).toBe(false);
    expect(before.layers.event.state).not.toBe("current");
    expect(before.layers.receipt.state).not.toBe("current");

    await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const repaired = await engine.runSlice(createSliceBudget(() => 0, new AbortController().signal));

    expect(repaired.health.converged).toBe(true);
    expect(mock.files.get(machineEventPath(projectId, record263.event.event_id)))
      .toBe(repository.canonicalDerivativeText("event", record263));
    expect(mock.files.get(machineReceiptPath(record263.receipt.transaction_id)))
      .toBe(repository.canonicalDerivativeText("receipt", record263));
    expect(mock.files.get(generationPath)).toBe(coalescedGeneration);
    expect(mock.files.has(machineCommitRecordPath(projectId, 265))).toBe(false);
  });

  it("keeps revision 258 pending when HANDOFF fails, then completes from its durable retry", async () => {
    const record = commitFixture("PRJ-9258", 258)[257];
    const root = workspaceProjectRoot(record.project_id, record.state.slug);
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload", path: `${root}/HANDOFF.md`, occurrence: 1,
        status: 400, error_summary: "injected/handoff_write_failed"
      }]
    });
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    await repository.writeCommitRecord(record);
    const journal = new ConvergenceJournal(runtime, record.project_id);
    const progress = initialProgress(record.project_id, "2026-09-09T00:00:00.000Z", "writer-1");
    progress.canonical_observed_revision = 257;
    await journal.save(progress, null);
    const ledger = new AcceptanceLedger();
    const first = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: ledger as never,
      now: () => 0, enableHuman: true
    });

    await first.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const pending = await first.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    expect(pending.health.layers.human_handoff.state).toBe("retry_wait");
    expect(mock.files.has(machineMaterializationHeadPath(record.project_id))).toBe(false);
    const saved = await journal.load();
    const retryAt = Date.parse(Object.values(saved?.progress.obligations ?? {})
      .find((obligation) => obligation.layer === "human_handoff")?.next_attempt_at ?? "");

    const recovered = new ConvergenceEngine({
      projectId: record.project_id, repository, runtime, journal, ledger: ledger as never,
      now: () => retryAt, enableHuman: true
    });
    const complete = await recovered.runSlice(createSliceBudget(() => retryAt, new AbortController().signal));

    expect(complete.health.layers.human_handoff.state).toBe("current");
    expect(mock.files.get(`${root}/HANDOFF.md`)).toContain("Revision: 258");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record.project_id)) ?? "{}")).toMatchObject({ target_revision: 258 });
  });

  it("repairs synthetic revision 258 after a 20-minute provider outage without creating revision 259", async () => {
    const records = commitFixture("PRJ-9258", 258);
    const record257 = records[256]!;
    const record258 = records[257]!;
    const root = workspaceProjectRoot(record258.project_id, record258.state.slug);
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload", path: `${root}/HANDOFF.md`, occurrence: 2,
        status: 400, error_summary: "injected/handoff_write_failed"
      }]
    });
    seedCommits(mock, records);
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    const ledger = new AcceptanceLedger();
    await runHumanSlice({
      record: record257, repository, runtime, ledger,
      now: () => "2026-09-09T00:00:00.000Z"
    });
    const journal = new ConvergenceJournal(runtime, record258.project_id);
    const progress = initialProgress(record258.project_id, "2026-09-09T00:00:00.000Z", "writer-1");
    progress.canonical_observed_revision = 257;
    await journal.save(progress, null);

    const failed = new ConvergenceEngine({
      projectId: record258.project_id, repository, runtime, journal, ledger: ledger as never,
      now: () => 0, enableHuman: true
    });
    await failed.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    const pending = await failed.runSlice(createSliceBudget(() => 0, new AbortController().signal));
    expect(pending.health.converged).toBe(false);
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record258.project_id)) ?? "{}")).toMatchObject({ target_revision: 257 });

    const recovered = new ConvergenceEngine({
      projectId: record258.project_id, repository, runtime, journal, ledger: ledger as never,
      now: () => 1_200_000, enableHuman: true
    });
    const complete = await recovered.runSlice(createSliceBudget(() => 1_200_000, new AbortController().signal));

    expect(complete.health.layers.human_handoff.state).toBe("current");
    expect(mock.files.get(`${root}/STATE.md`)).toContain("Revision: 258");
    expect(mock.files.get(`${root}/HANDOFF.md`)).toContain("Revision: 258");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record258.project_id)) ?? "{}")).toMatchObject({ target_revision: 258 });
    expect(mock.files.has(machineCommitRecordPath(record258.project_id, 259))).toBe(false);
  });

  it("exhausts six durable HANDOFF retries for synthetic revision 258, alerts, and recovers without a new commit", async () => {
    const records = commitFixture("PRJ-9258", 258);
    const record257 = records[256]!;
    const record258 = records[257]!;
    const root = workspaceProjectRoot(record258.project_id, record258.state.slug);
    const mock = installDropboxMock({
      // The initial revision-257 render is the first matching upload. Each
      // separate fault then rejects exactly one of the six revision-258
      // attempts, while preserving the prior human pair and its head.
      faults: Array.from({ length: 6 }, () => ({
        endpoint: "/2/files/upload",
        path: `${root}/HANDOFF.md`,
        occurrence: 2,
        status: 400,
        error_summary: "injected/handoff_provider_outage"
      }))
    });
    seedCommits(mock, records);
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const repository = new ProjectRepository(runtime, "v2");
    const ledger = new AcceptanceLedger();
    await runHumanSlice({
      record: record257,
      repository,
      runtime,
      ledger,
      now: () => "2026-09-09T00:00:00.000Z"
    });
    const journal = new ConvergenceJournal(runtime, record258.project_id);
    const progress = initialProgress(record258.project_id, "1970-01-01T00:00:00.000Z", "writer-1");
    progress.canonical_observed_revision = 257;
    await journal.save(progress, null);

    const runAt = async (now: number) => new ConvergenceEngine({
      projectId: record258.project_id,
      repository,
      runtime,
      journal,
      ledger: ledger as never,
      now: () => now,
      enableHuman: true
    }).runSlice(createSliceBudget(() => now, new AbortController().signal));

    // First slice restores all machine derivatives for 258; it has not yet
    // attempted the human pair. Its immutable receipt is the receipt that
    // must survive every failed human retry unchanged.
    await runAt(0);
    const originalReceipt = mock.files.get(machineReceiptPath(record258.receipt.transaction_id));
    expect(originalReceipt).toBe(repository.canonicalDerivativeText("receipt", record258));

    let now = 0;
    let exhaustedIncidentId: string | null = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await runAt(now);
      const saved = await journal.load();
      const obligation = Object.values(saved?.progress.obligations ?? {})
        .find((candidate) => candidate.layer === "human_handoff");
      expect(obligation).toMatchObject({
        failure_count: attempt,
        last_attempt_number: attempt,
        state: attempt === 6 ? "exhausted" : "retry_wait"
      });
      expect(result.health.converged).toBe(false);
      expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record258.project_id)) ?? "{}")).toMatchObject({
        target_revision: 257
      });
      expect(mock.files.get(`${root}/HANDOFF.md`)).toContain("Revision: 257");
      // The critical writer may stop before STATE or between STATE and
      // HANDOFF. Either retained pair or a mixed pair is valid while the old
      // head remains authoritative; publishing 258 is not.
      expect(mock.files.get(`${root}/STATE.md`)).toMatch(/Revision: 25[78]/);
      if (attempt < 6) now = Date.parse(obligation?.next_attempt_at ?? "");
      else exhaustedIncidentId = Object.keys(saved?.progress.alerts ?? {})[0] ?? null;
    }

    expect(exhaustedIncidentId).toMatch(/^inc-[a-f0-9]{64}$/);
    expect(mock.files.has(convergenceIncidentPath(record258.project_id, exhaustedIncidentId!))).toBe(true);
    expect(mock.files.get(machineReceiptPath(record258.receipt.transaction_id))).toBe(originalReceipt);

    // No input transaction and no handoff arrive during the outage. A later
    // scheduled slice alone must rebuild the critical pair, publish 258 and
    // resolve the same durable incident.
    await runAt(1_200_000);
    const verified = await runAt(1_200_000);
    const completed = await journal.load();

    expect(verified.health.converged).toBe(true);
    expect(mock.files.get(`${root}/STATE.md`)).toContain("Revision: 258");
    expect(mock.files.get(`${root}/HANDOFF.md`)).toContain("Revision: 258");
    expect(JSON.parse(mock.files.get(machineMaterializationHeadPath(record258.project_id)) ?? "{}")).toMatchObject({
      target_revision: 258,
      projection_version: 3
    });
    expect(mock.files.get(machineReceiptPath(record258.receipt.transaction_id))).toBe(originalReceipt);
    expect(completed?.progress.alerts[exhaustedIncidentId!]?.resolved_at).toBeTruthy();
    expect(mock.files.has(machineCommitRecordPath(record258.project_id, 259))).toBe(false);
  });
});
