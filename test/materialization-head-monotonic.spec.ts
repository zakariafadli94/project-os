import { describe, expect, it } from "vitest";
import type { CompletedMaterializationRecord, MaterializationHead } from "../src/domain/materialization";
import { ProjectRepository } from "../src/persistence/repository";
import { machineMaterializationRecordPath } from "../src/persistence/layout";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

function completed(projectId: string, revision: number): CompletedMaterializationRecord {
  return {
    schema_version: "1.0",
    project_id: projectId,
    target_revision: revision,
    projection_version: 3,
    record_kind: "snapshot",
    parent: null,
    chain_depth: 0,
    workspace_location: "active",
    outputs: {},
    removed_outputs: [],
    total_output_count: 0,
    result_root_hash: revision.toString(16).padStart(64, "0"),
    coalesced_revisions: [],
    source_event_id: null,
    completed_at: `2026-09-10T00:00:0${revision}.000Z`
  };
}

function headFor(record: CompletedMaterializationRecord): MaterializationHead {
  return {
    schema_version: "1.0",
    project_id: record.project_id,
    target_revision: record.target_revision,
    projection_version: record.projection_version,
    workspace_location: record.workspace_location,
    record_path: machineMaterializationRecordPath(record.project_id, record.target_revision, record.projection_version),
    result_root_hash: record.result_root_hash,
    completed_at: record.completed_at
  };
}

describe("materialization head publication", () => {
  it("keeps a newer head when an older completed generation resumes", async () => {
    installDropboxMock();
    const projectId = "PRJ-9260";
    const repository = new ProjectRepository(
      persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" })),
      "v2"
    );
    const older = completed(projectId, 1);
    const newer = completed(projectId, 2);
    const newerHead = headFor(newer);

    await repository.writeCompletedMaterializationRecord(older);
    await repository.writeCompletedMaterializationRecord(newer);
    await repository.writeMaterializationHead(newerHead);
    await repository.writeMaterializationHead(headFor(older));

    await expect(repository.readMaterializationHead(projectId)).resolves.toEqual(newerHead);
  });
});
