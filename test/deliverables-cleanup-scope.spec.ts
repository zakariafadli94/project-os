import { describe, expect, it } from "vitest";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import type { ProjectionPlan } from "../src/materialization/planner";
import { WorkspaceProjectionWriter } from "../src/materialization/writer";
import { sha256Text } from "../src/materialization/hash";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";

class MemoryObjects implements ObjectPersistence {
  files = new Map<string, string>();
  deleted: string[] = [];
  async readText(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async createText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async upsertText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async getMetadata(path: string): Promise<ProviderObjectMetadata | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, size: content.length };
  }
  async listChildren(_path: string): Promise<ProviderEntry[]> { return []; }
  async move(): Promise<void> { throw new Error("not used"); }
  async delete(path: string): Promise<void> { this.deleted.push(path); this.files.delete(path); }
}

describe("deliverable projection cleanup scope", () => {
  it("does not physically remove unrelated obsolete projection families", async () => {
    const objects = new MemoryObjects();
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const path = "/workspace/TASKS/TASK-OLD3904.md";
    const content = "old generated task projection\n";
    const evidence: ProjectionOutputEvidence = {
      relative_path: "TASKS/TASK-OLD3904.md",
      input_hash: await sha256Text("task-input"),
      content_hash: await sha256Text(content),
      source_revision: 3
    };
    objects.files.set(path, content);
    const plan: ProjectionPlan = {
      project_id: "PRJ-3904",
      target_revision: 4,
      projection_version: 3,
      source_transaction_id: "TXN-DELIVVIEW-SCOPE",
      source_event_id: "EVT-000004",
      changed_outputs: new Map(),
      carried_forward: new Map(),
      removed_outputs: ["task:TASK-OLD3904"],
      removed_output_evidence: new Map([["task:TASK-OLD3904", evidence]]),
      expected_output_keys: []
    };

    await writer.materialize(plan, { workspaceRoot: "/workspace" });

    expect(objects.deleted).toEqual([]);
    expect(objects.files.get(path)).toBe(content);
  });
});
