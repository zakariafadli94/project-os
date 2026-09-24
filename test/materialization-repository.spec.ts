import { describe, expect, it } from "vitest";
import type {
  CompletedMaterializationRecord,
  MaterializationHead
} from "../src/domain/materialization";
import { CURRENT_PROJECTION_VERSION, parseCompletedMaterializationRecord } from "../src/domain/materialization";
import { DropboxConflictError, type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath
} from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  revisions = new Map<string, number>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  pageCalls: Array<{ path: string; cursor: string | null; limit: number }> = [];
  pages: Array<{ entries: DropboxEntry[]; cursor: string | null }> = [];

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("already exists", "req-materialization-test");
    this.files.set(path, content);
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
    this.uploads.push({ path, mode });
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    if (!this.files.has(path)) return null;
    const revision = String(this.revisions.get(path) ?? 1);
    return { id: `id:${path}`, path, rev: revision, content_hash: "0".repeat(64), size: this.files.get(path)!.length };
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    const current = await this.getMetadata(path);
    if (!current || current.rev !== expectedRev) throw new DropboxConflictError("revision conflict", "req-materialization-test");
    await this.upload(path, content, "overwrite");
    return (await this.getMetadata(path))!;
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

  async listFolderPage(path: string, cursor: string | null, limit: number) {
    this.pageCalls.push({ path, cursor, limit });
    return this.pages.shift() ?? { entries: [], cursor: null };
  }
}

const completed: CompletedMaterializationRecord = {
  schema_version: "1.0",
  project_id: "PRJ-3101",
  target_revision: 7,
  projection_version: 1,
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
  it("keeps old generation records readable but requires a four-view proof for the current projection version", () => {
    expect(() => parseCompletedMaterializationRecord({
      ...completed,
      projection_version: CURRENT_PROJECTION_VERSION
    })).toThrow();

    expect(parseCompletedMaterializationRecord(completed).projection_version).toBe(1);
  });

  it("rejects a four-view proof whose PROJECT and PLAN evidence is absent from the completed generation", () => {
    const proofEntry = (relative_path: string, letter: string) => ({
      relative_path,
      input_hash: letter.repeat(64),
      content_hash: letter.repeat(64),
      source_revision: 7,
      provider_object_id: `object:${relative_path}`,
      provider_revision: `revision:${relative_path}`
    });
    expect(() => parseCompletedMaterializationRecord({
      ...completed,
      projection_version: CURRENT_PROJECTION_VERSION,
      current_views_proof: {
        target_revision: 7,
        projection_version: CURRENT_PROJECTION_VERSION,
        views: {
          "global:PROJECT": proofEntry("PROJECT.md", "a"),
          "global:PLAN": proofEntry("PLAN.md", "b"),
          "global:STATE": {
            ...proofEntry("STATE.md", "a"),
            content_hash: "b".repeat(64)
          },
          "global:HANDOFF": {
            ...proofEntry("HANDOFF.md", "c"),
            content_hash: "d".repeat(64)
          }
        }
      }
    })).toThrow();
  });

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

  it("lists materialization generations as bounded provider pages with an opaque continuation cursor", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    transport.pages.push({
      entries: [
        { tag: "file", name: "REV-000007-PV-0006.json" },
        { tag: "folder", name: "REV-000008-PV-0006.json" },
        { tag: "file", name: "README.txt" }
      ],
      cursor: "provider-cursor-2"
    });

    const page = await repository.listMaterializationRecordsPage("PRJ-3101", "provider-cursor-1", 50);

    expect(transport.pageCalls).toEqual([{
      path: "/PROJECT_OS/.project-os/projects/PRJ-3101/materializations",
      cursor: "provider-cursor-1", limit: 50
    }]);
    expect(page).toEqual({ records: [{ target_revision: 7, projection_version: 6 }], next_cursor: "provider-cursor-2" });
  });
});
