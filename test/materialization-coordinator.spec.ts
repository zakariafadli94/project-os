import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import {
  CURRENT_PROJECTION_VERSION,
  type CompletedMaterializationRecord,
  type MaterializationGenerationRef,
  type MaterializationHead,
  type ProjectionOutputEvidence
} from "../src/domain/materialization";
import type { ProjectState } from "../src/domain/project-state";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction, type Transaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { machineMaterializationRecordPath, workspaceProjectRoot } from "../src/dropbox/layout";
import {
  MaterializationCoordinator,
  rebuildProjectionBaseline,
  type MaterializationLedgerPort,
  type MaterializationRepositoryPort,
  type ProjectionWriterPort
} from "../src/materialization/coordinator";
import { projectionIndexRootHash } from "../src/materialization/hash";
import type { ProjectionPlan } from "../src/materialization/planner";

const at = "2026-08-24T17:20:00+01:00";
let seq = 0;

function committed(state: ProjectState, operation: Transaction["operation"], payload: Record<string, unknown>): CanonicalCommitRecord {
  seq += 1;
  const tx = parseTransaction({
    schema_version: "1.0",
    transaction_id: `TXN-COORD-${seq.toString().padStart(6, "0")}`,
    project_id: state.project_id,
    base_revision: state.revision,
    operation,
    created_at: at,
    payload
  });
  const result = applyTransaction(state, tx);
  if (result.kind !== "commit") throw new Error(`fixture failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: tx.transaction_id,
    status: "committed",
    project_id: state.project_id,
    previous_revision: state.revision,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: state.project_id,
    previous_revision: state.revision,
    new_revision: result.state.revision,
    transaction: tx,
    state: result.state,
    event: result.event,
    receipt
  };
}

function createFixture(projectId = "PRJ-3501"): CanonicalCommitRecord {
  seq = 1;
  const tx = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-COORD-000001",
    project_id: projectId,
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: "Coordinator Fixture",
      slug: "coordinator-fixture",
      aliases: [],
      objective: "Test coordinator"
    }
  });
  const result = applyTransaction(null, tx);
  if (result.kind !== "commit") throw new Error(`fixture failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: tx.transaction_id,
    status: "committed",
    project_id: projectId,
    previous_revision: 0,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: projectId,
    previous_revision: 0,
    new_revision: result.state.revision,
    transaction: tx,
    state: result.state,
    event: result.event,
    receipt
  };
}

class FakeRepository implements MaterializationRepositoryPort {
  commits = new Map<number, CanonicalCommitRecord>();
  records = new Map<string, CompletedMaterializationRecord>();
  head: MaterializationHead | null = null;
  writeOrder: string[] = [];
  derivativeCalls = 0;
  headWrites = 0;
  recordWrites = 0;
  failHeadOnce = false;

  async readCommitRecord(_projectId: string, revision: number) { return this.commits.get(revision) ?? null; }
  async readMaterializationHead() { return this.head; }
  async readMaterializationRecord(projectId: string, revision: number, pv: number) {
    return this.records.get(`${projectId}:${revision}:${pv}`) ?? null;
  }
  async listMaterializationRecordRefs(projectId: string): Promise<MaterializationGenerationRef[]> {
    return [...this.records.values()]
      .filter((record) => record.project_id === projectId)
      .map((record) => ({ target_revision: record.target_revision, projection_version: record.projection_version }))
      .sort((a, b) => a.projection_version - b.projection_version || a.target_revision - b.target_revision);
  }
  async writeCompletedMaterializationRecord(record: CompletedMaterializationRecord) {
    const key = `${record.project_id}:${record.target_revision}:${record.projection_version}`;
    const existing = this.records.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("immutable conflict");
    if (!existing) {
      this.records.set(key, record);
      this.recordWrites += 1;
      this.writeOrder.push("record");
    }
  }
  async writeMaterializationHead(head: MaterializationHead) {
    this.writeOrder.push("head");
    this.headWrites += 1;
    if (this.failHeadOnce) {
      this.failHeadOnce = false;
      throw new Error("injected head failure");
    }
    this.head = head;
  }
  async materializeCanonicalDerivatives() { this.derivativeCalls += 1; }
}

class FakeLedger implements MaterializationLedgerPort {
  head: { revision: number; projection_version: number } | null = null;
  requested: { revision: number; projection_version: number } | null = null;
  active: { revision: number; projection_version: number; coalesced_revisions: number[] } | null = null;
  baseline = new Map<string, ProjectionOutputEvidence>();
  attempts = new Map<string, ProjectionOutputEvidence>();
  lastError: string | null = null;
  nextCoalesced: number[] = [];

  requestTarget(target: { revision: number; projection_version: number }) {
    if (!this.requested || target.projection_version > this.requested.projection_version || (target.projection_version === this.requested.projection_version && target.revision > this.requested.revision)) {
      this.requested = target;
    }
  }
  beginNextTarget() {
    if (this.active) return this.active;
    if (!this.requested) return null;
    if (this.head?.revision === this.requested.revision && this.head.projection_version === this.requested.projection_version) return null;
    this.active = { ...this.requested, coalesced_revisions: [...this.nextCoalesced] };
    return this.active;
  }
  recordVerifiedOutput(key: string, evidence: ProjectionOutputEvidence) { this.attempts.set(key, evidence); }
  attemptOutputs() { return new Map(this.attempts); }
  baselineOutputs() { return new Map(this.baseline); }
  failActive(message: string) { this.lastError = message; }
  completeTarget(input: { revision: number; projection_version: number; outputs: ReadonlyMap<string, ProjectionOutputEvidence>; removed_outputs: readonly string[] }) {
    for (const key of input.removed_outputs) this.baseline.delete(key);
    for (const [key, evidence] of input.outputs) this.baseline.set(key, evidence);
    this.head = { revision: input.revision, projection_version: input.projection_version };
    if (this.requested?.projection_version === input.projection_version && this.requested.revision <= input.revision) this.requested = null;
    this.active = null;
    this.attempts.clear();
    this.lastError = null;
  }
  restoreExternalBaseline(head: { revision: number; projection_version: number }, outputs: ReadonlyMap<string, ProjectionOutputEvidence>) {
    this.head = head;
    this.baseline = new Map(outputs);
    if (this.requested?.projection_version === head.projection_version && this.requested.revision <= head.revision) this.requested = null;
    this.active = null;
    this.attempts.clear();
  }
  status() {
    return {
      head: this.head,
      requested: this.requested,
      active: this.active,
      active_status: this.active ? "running" : null,
      last_error: this.lastError,
      output_count: this.baseline.size,
      attempt_output_count: this.attempts.size
    };
  }
}

class FakeWriter implements ProjectionWriterPort {
  calls = 0;
  touched: string[][] = [];
  failAfter: number | null = null;

  async materialize(plan: ProjectionPlan, options: {
    workspaceRoot: string;
    alreadyVerified?: ReadonlyMap<string, ProjectionOutputEvidence>;
    onOutputVerified?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void>;
  }) {
    this.calls += 1;
    const keys: string[] = [];
    const verified = new Map<string, ProjectionOutputEvidence>();
    let newlyVerified = 0;
    for (const [key, output] of plan.changed_outputs) {
      const previous = options.alreadyVerified?.get(key);
      if (previous && previous.content_hash === output.content_hash && previous.input_hash === output.input_hash && previous.source_revision === output.source_revision) {
        verified.set(key, previous);
        continue;
      }
      if (this.failAfter !== null && newlyVerified >= this.failAfter) throw new Error("injected writer crash");
      const evidence: ProjectionOutputEvidence = {
        relative_path: output.relative_path,
        input_hash: output.input_hash,
        content_hash: output.content_hash,
        source_revision: output.source_revision
      };
      keys.push(key);
      newlyVerified += 1;
      verified.set(key, evidence);
      await options.onOutputVerified?.(key, evidence);
    }
    this.touched.push(keys);
    return verified;
  }
}

function coordinator(repo: FakeRepository, ledger = new FakeLedger(), writer = new FakeWriter(), projectionVersion = CURRENT_PROJECTION_VERSION) {
  return {
    ledger,
    writer,
    value: new MaterializationCoordinator({
      projectId: "PRJ-3501",
      repository: repo,
      ledger,
      writer,
      projectionVersion,
      workspaceRootFor: (state) => workspaceProjectRoot(state.project_id, state.slug),
      now: () => "2026-08-24T17:21:00+01:00"
    })
  };
}

describe("MaterializationCoordinator", () => {
  it("publishes the first generation as a full snapshot and writes record before head", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    const { value } = coordinator(repo);

    value.requestTarget(record.new_revision);
    await value.runNext();

    const completed = repo.records.get(`PRJ-3501:${record.new_revision}:${CURRENT_PROJECTION_VERSION}`)!;
    expect(completed.record_kind).toBe("snapshot");
    expect(completed.parent).toBeNull();
    expect(completed.chain_depth).toBe(0);
    expect(Object.keys(completed.outputs).length).toBe(completed.total_output_count);
    expect(repo.writeOrder).toEqual(["record", "head"]);
    expect(repo.head?.target_revision).toBe(record.new_revision);
  });

  it("publishes same-version task-only follow-up as a compact delta with a valid full root", async () => {
    const first = createFixture();
    const second = committed(first.state, "task.create", { task_id: "TASK-COORD3501", title: "Only this task" });
    const repo = new FakeRepository();
    repo.commits.set(first.new_revision, first);
    repo.commits.set(second.new_revision, second);
    const { value } = coordinator(repo);

    value.requestTarget(first.new_revision);
    await value.runNext();
    value.requestTarget(second.new_revision);
    await value.runNext();

    const delta = repo.records.get(`PRJ-3501:${second.new_revision}:${CURRENT_PROJECTION_VERSION}`)!;
    expect(delta.record_kind).toBe("delta");
    expect(delta.parent).toEqual({ target_revision: first.new_revision, projection_version: CURRENT_PROJECTION_VERSION });
    expect(delta.outputs["global:BRIEF"]).toBeUndefined();
    expect(delta.outputs["task:TASK-COORD3501"]).toBeDefined();
    expect(delta.outputs["global:STATE"]).toBeDefined();
    expect(delta.outputs["global:HANDOFF"]).toBeDefined();

    const baseline = await rebuildProjectionBaseline(repo, repo.head!);
    expect(await projectionIndexRootHash(baseline.outputs)).toBe(delta.result_root_hash);
  });

  it("starts a fresh snapshot when the previous chain depth reached 127", async () => {
    seq = 127;
    const targetState = emptyProjectState("PRJ-3501", "Coordinator Fixture", "coordinator-fixture", "Test coordinator");
    targetState.revision = 127;
    targetState.last_event_id = "EVT-000127";
    targetState.created_at = at;
    targetState.updated_at = at;
    const target = committed(targetState, "task.create", {
      task_id: "TASK-SNAPSHOT3501",
      title: "Force snapshot rollover"
    });
    expect(target.new_revision).toBe(128);

    const repo = new FakeRepository();
    repo.commits.set(target.new_revision, target);
    const seed: ProjectionOutputEvidence = {
      relative_path: "BRIEF.md",
      input_hash: "a".repeat(64),
      content_hash: "b".repeat(64),
      source_revision: 0
    };
    const root = await projectionIndexRootHash(new Map([["global:BRIEF", seed]]));
    repo.records.set(`PRJ-3501:0:${CURRENT_PROJECTION_VERSION}`, {
      schema_version: "1.0", project_id: "PRJ-3501", target_revision: 0, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: { "global:BRIEF": seed }, removed_outputs: [], total_output_count: 1, result_root_hash: root,
      coalesced_revisions: [], source_event_id: null, completed_at: at
    });
    for (let revision = 1; revision <= 127; revision += 1) {
      repo.records.set(`PRJ-3501:${revision}:${CURRENT_PROJECTION_VERSION}`, {
        schema_version: "1.0", project_id: "PRJ-3501", target_revision: revision, projection_version: CURRENT_PROJECTION_VERSION,
        record_kind: "delta", parent: { target_revision: revision - 1, projection_version: CURRENT_PROJECTION_VERSION }, chain_depth: revision,
        workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 1, result_root_hash: root,
        coalesced_revisions: [], source_event_id: null, completed_at: at
      });
    }
    repo.head = {
      schema_version: "1.0", project_id: "PRJ-3501", target_revision: 127, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath("PRJ-3501", 127, CURRENT_PROJECTION_VERSION),
      result_root_hash: root, completed_at: at
    };
    const ledger = new FakeLedger();
    ledger.restoreExternalBaseline({ revision: 127, projection_version: CURRENT_PROJECTION_VERSION }, new Map([["global:BRIEF", seed]]));
    const { value } = coordinator(repo, ledger);

    value.requestTarget(target.new_revision);
    await value.runNext();

    const completed = repo.records.get(`PRJ-3501:${target.new_revision}:${CURRENT_PROJECTION_VERSION}`)!;
    expect(completed.record_kind).toBe("snapshot");
    expect(completed.chain_depth).toBe(0);
  });

  it("repairs a failed head write from immutable evidence without rewriting workspace", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    repo.failHeadOnce = true;
    const { value, writer } = coordinator(repo);
    value.requestTarget(record.new_revision);

    await expect(value.runNext()).rejects.toThrow(/head failure/);
    expect(repo.recordWrites).toBe(1);
    expect(repo.head).toBeNull();
    const callsAfterFailure = writer.calls;

    await value.runNext();
    expect(repo.head?.target_revision).toBe(record.new_revision);
    expect(writer.calls).toBe(callsAfterFailure);
    expect(repo.recordWrites).toBe(1);
  });

  it("rebuilds lost hot state from external completed evidence", async () => {
    const first = createFixture();
    const second = committed(first.state, "task.create", { task_id: "TASK-RECOVER3501", title: "Recover projection" });
    const repo = new FakeRepository();
    repo.commits.set(first.new_revision, first);
    repo.commits.set(second.new_revision, second);
    const initial = coordinator(repo);
    initial.value.requestTarget(first.new_revision);
    await initial.value.runNext();

    const freshLedger = new FakeLedger();
    const next = coordinator(repo, freshLedger);
    next.value.requestTarget(second.new_revision);
    await next.value.runNext();

    expect(freshLedger.head).toEqual({ revision: second.new_revision, projection_version: CURRENT_PROJECTION_VERSION });
    expect(freshLedger.baseline.size).toBeGreaterThan(0);
  });

  it("fails closed on a missing parent or result-root mismatch", async () => {
    const repo = new FakeRepository();
    const bad: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: "PRJ-3501", target_revision: 2, projection_version: 1,
      record_kind: "delta", parent: { target_revision: 1, projection_version: 1 }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "f".repeat(64), coalesced_revisions: [], source_event_id: null, completed_at: at
    };
    repo.records.set("PRJ-3501:2:1", bad);
    const head: MaterializationHead = {
      schema_version: "1.0", project_id: "PRJ-3501", target_revision: 2, projection_version: 1,
      workspace_location: "active", record_path: machineMaterializationRecordPath("PRJ-3501", 2, 1),
      result_root_hash: bad.result_root_hash, completed_at: at
    };
    await expect(rebuildProjectionBaseline(repo, head)).rejects.toThrow(/parent|chain/i);
  });

  it("resumes per-output progress after a writer crash", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    const ledger = new FakeLedger();
    const writer = new FakeWriter();
    writer.failAfter = 2;
    const { value } = coordinator(repo, ledger, writer);
    value.requestTarget(record.new_revision);

    await expect(value.runNext()).rejects.toThrow(/writer crash/);
    expect(ledger.attempts.size).toBe(2);
    writer.failAfter = null;
    await value.runNext();
    expect(writer.touched.at(-1)?.length).toBeGreaterThan(0);
    expect(writer.touched.at(-1)?.length).toBeLessThan(repo.head ? repo.head.target_revision + 20 : 20);
    expect(repo.head?.target_revision).toBe(record.new_revision);
  });

  it("records supplied coalesced revisions in the completed generation", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    const ledger = new FakeLedger();
    ledger.nextCoalesced = [72, 73, 74];
    const { value } = coordinator(repo, ledger);
    value.requestTarget(record.new_revision);
    await value.runNext();
    expect(repo.records.get(`PRJ-3501:${record.new_revision}:${CURRENT_PROJECTION_VERSION}`)?.coalesced_revisions).toEqual([72, 73, 74]);
  });

  it("projection version bump rematerializes the same canonical revision as a new snapshot", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    const v1 = coordinator(repo, new FakeLedger(), new FakeWriter(), 1);
    v1.value.requestTarget(record.new_revision, 1);
    await v1.value.runNext();

    const ledgerV2 = new FakeLedger();
    const v2 = coordinator(repo, ledgerV2, new FakeWriter(), CURRENT_PROJECTION_VERSION);
    v2.value.requestTarget(record.new_revision, CURRENT_PROJECTION_VERSION);
    await v2.value.runNext();
    const recordV2 = repo.records.get(`PRJ-3501:${record.new_revision}:${CURRENT_PROJECTION_VERSION}`)!;
    expect(recordV2.record_kind).toBe("snapshot");
    expect(recordV2.projection_version).toBe(CURRENT_PROJECTION_VERSION);
    expect(repo.commits.size).toBe(1);
  });

  it("exact completed target replay performs no writer or new evidence writes", async () => {
    const record = createFixture();
    const repo = new FakeRepository();
    repo.commits.set(record.new_revision, record);
    const setup = coordinator(repo);
    setup.value.requestTarget(record.new_revision);
    await setup.value.runNext();
    const writes = repo.recordWrites;
    const writerCalls = setup.writer.calls;

    setup.value.requestTarget(record.new_revision);
    const result = await setup.value.runNext();
    expect(result.more_work).toBe(false);
    expect(repo.recordWrites).toBe(writes);
    expect(setup.writer.calls).toBe(writerCalls);
  });
});
