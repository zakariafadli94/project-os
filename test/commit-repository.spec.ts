import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { machineCommitRecordPath, machineReceiptPath } from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("already exists", "req-test");
    this.files.set(path, content);
    this.uploads.push({ path, mode });
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("source missing");
    this.files.delete(from);
    this.files.set(to, value);
  }
}

function fixture(): CanonicalCommitRecord {
  const at = "2026-08-24T00:45:00.000Z";
  const baseline = emptyProjectState("PRJ-1201", "Commit Repo", "commit-repo", "Crash-safe commit repo");
  baseline.revision = 1;
  baseline.last_event_id = "EVT-000001";
  baseline.created_at = at;
  baseline.updated_at = at;

  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-COMMIT-REPO-1201",
    project_id: baseline.project_id,
    base_revision: 1,
    operation: "task.create",
    created_at: at,
    payload: { task_id: "TASK-COMMITR1201", title: "Materialize exactly once" }
  });
  const result = applyTransaction(baseline, transaction);
  if (result.kind !== "commit") throw new Error(`fixture transition failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: 1,
    new_revision: 2,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: transaction.project_id,
    previous_revision: 1,
    new_revision: 2,
    transaction,
    state: result.state,
    event: result.event,
    receipt
  };
}

describe("ProjectRepository canonical commit records", () => {
  it("publishes one immutable V2-layout commit record and replays identical content idempotently", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const record = fixture();
    const path = machineCommitRecordPath(record.project_id, record.new_revision);

    await repository.writeCommitRecord(record);
    await repository.writeCommitRecord(record);

    expect(transport.files.has(path)).toBe(true);
    expect(transport.uploads.filter((write) => write.path === path)).toHaveLength(1);
    await expect(repository.readCommitRecord(record.project_id, record.new_revision)).resolves.toEqual(record);
    await expect(repository.readCommitRecord(record.project_id, record.new_revision + 1)).resolves.toBeNull();
  });

  it("writes envelope 1.0 with nested ProjectState 2.0 at core_v2 and reads it back semantically", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2", "observe", "core_v2");
    const record = fixture();
    const path = machineCommitRecordPath(record.project_id, record.new_revision);

    await repository.writeCommitRecord(record);

    const durable = JSON.parse(transport.files.get(path)!);
    expect(durable.schema_version).toBe("1.0");
    expect(durable.state.schema_version).toBe("2.0");
    expect(durable.transaction.schema_version).toBe("1.0");
    expect(durable.event.schema_version).toBe("1.0");
    expect(durable.receipt.schema_version).toBe("1.0");

    const readBack = await repository.readCommitRecord(record.project_id, record.new_revision);
    expect(readBack?.schema_version).toBe("1.0");
    expect(readBack?.state.schema_version).toBe("2.0");
    expect({ ...readBack?.state, schema_version: "1.0" }).toEqual(record.state);
  });

  it("fails closed when a v1_only writer encounters an already-current ProjectState V2", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2", "observe", "v1_only");
    const record = fixture();
    record.state = { ...record.state, schema_version: "2.0" };

    await expect(repository.writeCommitRecord(record)).rejects.toThrow(/V2 writer regression|V1/i);
    expect(transport.files.has(machineCommitRecordPath(record.project_id, record.new_revision))).toBe(false);
  });

  it("keeps different content at the same project revision as a terminal immutable conflict", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const record = fixture();
    await repository.writeCommitRecord(record);

    const conflicting = fixture();
    conflicting.state.name = "Different committed reality";
    await expect(repository.writeCommitRecord(conflicting)).rejects.toThrow(/immutable.*conflict/i);
  });

  it("materializes event, V2 snapshots, human views and standalone receipt from a committed record", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const record = fixture();

    await repository.writeCommitRecord(record);
    await repository.materializeCommit(record);

    expect(transport.files.has(`/PROJECT_OS/.project-os/projects/${record.project_id}/events/${record.event.event_id}.json`)).toBe(true);
    expect(transport.files.has(`/PROJECT_OS/.project-os/projects/${record.project_id}/state.json`)).toBe(true);
    expect(transport.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${record.project_id}-${record.state.slug}/STATE.md`)).toBe(true);
    expect(transport.uploads.at(-1)?.path).toBe(machineReceiptPath(record.receipt.transaction_id));
  });
});