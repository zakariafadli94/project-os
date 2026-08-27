import { describe, expect, it } from "vitest";
import {
  CURRENT_PROJECTION_VERSION,
  type CompletedMaterializationRecord,
  type MaterializationHead
} from "../src/domain/materialization";
import { DropboxConflictError, type DropboxEntry, type DropboxTransport } from "../src/dropbox/client";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath
} from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("already exists", "req-materialization-test");
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

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({
        tag: "file" as const,
        name: candidate.slice(prefix.length),
        path_display: candidate,
        path_lower: candidate.toLowerCase()
      }));
  }
}

const completed: CompletedMaterializationRecord = {
  schema_version: "1.0",
  project_id: "PRJ-3101",
  target_revision: 7,
  projection_version: CURRENT_PROJECTION_VERSION,
  record_kind: "snapshot",
  parent: null,
  chain_depth: 0,
  workspace_location: "active",
  outputs: {
    "global:STATE": {
      relative_path: "STATE.md",
      input_hash: "a".repeat(64),
      content_hash: "b".repeat(64),
      source_revision: 7
    },
    "global:HANDOFF": {
      relative_path: "HANDOFF.md",
      input_hash: "c".repeat(64),
      content_hash: "d".repeat(64),
      source_revision: 7
    }
  },
  removed_outputs: [],
  total_output_count: 2,
  result_root_hash: "e".repeat(64),
  coalesced_revisions: [],
  source_event_id: "EVT-000007",
  completed_at: "2026-08-24T16:40:00+01:00"
};

const head: MaterializationHead = {
  schema_version: "1.0",
  project_id: completed.project_id,
  target_revision: completed.target_revision,
  projection_version: completed.projection_version,
  workspace_location: completed.workspace_location,
  record_path: machineMaterializationRecordPath(
    completed.project_id,
    completed.target_revision,
    completed.projection_version
  ),
  result_root_hash: completed.result_root_hash,
  completed_at: completed.completed_at
};

describe("durable materialization evidence repository", () => {
  it("uses deterministic immutable generation and head paths", () => {
    expect(machineMaterializationRecordPath("PRJ-3101", 7, 1))
      .toBe("/PROJECT_OS/.project-os/projects/PRJ-3101/materializations/REV-000007-PV-0001.json");
    expect(machineMaterializationHeadPath("PRJ-3101"))
      .toBe("/PROJECT_OS/.project-os/projects/PRJ-3101/materialization-head.json");
  });

  it("replays identical completed evidence idempotently and rejects a different immutable reality", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const path = machineMaterializationRecordPath(completed.project_id, completed.target_revision, completed.projection_version);

    await repository.writeCompletedMaterializationRecord(completed);
    await repository.writeCompletedMaterializationRecord(completed);

    expect(transport.uploads.filter((write) => write.path === path)).toHaveLength(1);
    await expect(repository.readMaterializationRecord("PRJ-3101", 7, 1)).resolves.toEqual(completed);

    const conflicting: CompletedMaterializationRecord = {
      ...completed,
      result_root_hash: "f".repeat(64)
    };
    await expect(repository.writeCompletedMaterializationRecord(conflicting)).rejects.toThrow(/immutable.*conflict/i);
  });

  it("does not advance head implicitly and only publishes a head backed by matching immutable evidence", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");

    await repository.writeCompletedMaterializationRecord(completed);
    await expect(repository.readMaterializationHead("PRJ-3101")).resolves.toBeNull();

    await repository.writeMaterializationHead(head);
    await expect(repository.readMaterializationHead("PRJ-3101")).resolves.toEqual(head);

    await expect(repository.writeMaterializationHead({
      ...head,
      result_root_hash: "0".repeat(64)
    })).rejects.toThrow(/materialization head.*record/i);
  });

  it("validates record/head bindings and lists only valid generation filenames in deterministic order", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");

    await repository.writeCompletedMaterializationRecord(completed);
    const later: CompletedMaterializationRecord = {
      ...completed,
      target_revision: 8,
      projection_version: 2,
      result_root_hash: "1".repeat(64),
      source_event_id: "EVT-000008",
      completed_at: "2026-08-24T16:41:00+01:00"
    };
    await repository.writeCompletedMaterializationRecord(later);
    transport.files.set("/PROJECT_OS/.project-os/projects/PRJ-3101/materializations/README.txt", "ignore me");
    transport.files.set("/PROJECT_OS/.project-os/projects/PRJ-3101/materializations/REV-bad-PV-0001.json", "ignore me");

    await expect(repository.listMaterializationRecordRefs("PRJ-3101")).resolves.toEqual([
      { target_revision: 7, projection_version: 1 },
      { target_revision: 8, projection_version: 2 }
    ]);

    const recordPath = machineMaterializationRecordPath("PRJ-3101", 7, 1);
    transport.files.set(recordPath, JSON.stringify({ ...completed, project_id: "PRJ-9999" }));
    await expect(repository.readMaterializationRecord("PRJ-3101", 7, 1)).rejects.toThrow(/binding mismatch/i);
  });
});
