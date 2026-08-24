import { describe, expect, it } from "vitest";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { sha256Text } from "../src/materialization/hash";
import type { PlannedProjectionOutput, ProjectionPlan } from "../src/materialization/planner";
import {
  MaterializationOutputConflictError,
  parseProjectionConcurrency,
  WorkspaceProjectionWriter
} from "../src/materialization/writer";
import { MANAGED_NOTICE } from "../src/render/shared";

class InstrumentedTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  downloads: string[] = [];
  uploadDelay = 0;
  inFlight = 0;
  maxInFlight = 0;
  failPath: string | null = null;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.uploadDelay) await new Promise((resolve) => setTimeout(resolve, this.uploadDelay));
      if (path === this.failPath) throw new Error(`injected failure for ${path}`);
      if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("exists", "req-writer");
      this.files.set(path, content);
      this.uploads.push({ path, mode });
    } finally {
      this.inFlight -= 1;
    }
  }

  async download(path: string): Promise<string | null> {
    this.downloads.push(path);
    return this.files.get(path) ?? null;
  }

  async move(): Promise<void> {
    throw new Error("not used");
  }
}

async function output(
  key: string,
  relativePath: string,
  content: string,
  options: { critical?: boolean; baseline?: ProjectionOutputEvidence } = {}
): Promise<PlannedProjectionOutput> {
  return {
    key,
    relative_path: relativePath,
    input_hash: await sha256Text(`input:${key}:${content}`),
    content_hash: await sha256Text(content),
    source_revision: 4,
    content,
    critical: options.critical ?? false,
    ...(options.baseline ? { baseline: options.baseline } : {})
  };
}

function plan(outputs: PlannedProjectionOutput[]): ProjectionPlan {
  return {
    project_id: "PRJ-3301",
    target_revision: 4,
    projection_version: 1,
    source_transaction_id: "TXN-MATERIAL-WRITER-3301",
    source_event_id: "EVT-000004",
    changed_outputs: new Map(outputs.map((item) => [item.key, item])),
    carried_forward: new Map(),
    removed_outputs: [],
    expected_output_keys: outputs.map((item) => item.key)
  };
}

describe("WorkspaceProjectionWriter", () => {
  it("uses add for a missing destination", async () => {
    const transport = new InstrumentedTransport();
    const writer = new WorkspaceProjectionWriter(transport, 1);
    const item = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nbrief`);

    await writer.materialize(plan([item]), { workspaceRoot: "/workspace" });

    expect(transport.uploads).toEqual([{ path: "/workspace/BRIEF.md", mode: "add" }]);
  });

  it("skips upload when destination already has desired bytes", async () => {
    const transport = new InstrumentedTransport();
    const content = `${MANAGED_NOTICE}\nalready current`;
    transport.files.set("/workspace/BRIEF.md", content);
    const writer = new WorkspaceProjectionWriter(transport, 1);
    const item = await output("global:BRIEF", "BRIEF.md", content);

    await writer.materialize(plan([item]), { workspaceRoot: "/workspace" });

    expect(transport.uploads).toHaveLength(0);
  });

  it("fails closed when current bytes match neither baseline nor desired", async () => {
    const transport = new InstrumentedTransport();
    const baselineContent = `${MANAGED_NOTICE}\nbaseline`;
    const baseline: ProjectionOutputEvidence = {
      relative_path: "BRIEF.md",
      input_hash: await sha256Text("baseline-input"),
      content_hash: await sha256Text(baselineContent),
      source_revision: 3
    };
    transport.files.set("/workspace/BRIEF.md", `${MANAGED_NOTICE}\nunexpected edit`);
    const writer = new WorkspaceProjectionWriter(transport, 1);
    const item = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\ndesired`, { baseline });

    await expect(writer.materialize(plan([item]), { workspaceRoot: "/workspace" }))
      .rejects.toBeInstanceOf(MaterializationOutputConflictError);
    expect(transport.uploads).toHaveLength(0);
  });

  it("bootstrap may overwrite a known machine-managed note but refuses an untracked human file", async () => {
    const managedTransport = new InstrumentedTransport();
    managedTransport.files.set("/workspace/BRIEF.md", `${MANAGED_NOTICE}\nold generated`);
    const managedWriter = new WorkspaceProjectionWriter(managedTransport, 1);
    const desired = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nnew generated`);

    await managedWriter.materialize(plan([desired]), { workspaceRoot: "/workspace" });
    expect(managedTransport.uploads).toEqual([{ path: "/workspace/BRIEF.md", mode: "overwrite" }]);

    const humanTransport = new InstrumentedTransport();
    humanTransport.files.set("/workspace/BRIEF.md", "human-owned content");
    const humanWriter = new WorkspaceProjectionWriter(humanTransport, 1);
    await expect(humanWriter.materialize(plan([desired]), { workspaceRoot: "/workspace" }))
      .rejects.toBeInstanceOf(MaterializationOutputConflictError);
    expect(humanTransport.uploads).toHaveLength(0);
  });

  it("does not read back non-critical success but verifies critical output after upload", async () => {
    const nonCriticalTransport = new InstrumentedTransport();
    const nonCriticalWriter = new WorkspaceProjectionWriter(nonCriticalTransport, 1);
    const brief = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nbrief`);
    await nonCriticalWriter.materialize(plan([brief]), { workspaceRoot: "/workspace" });
    expect(nonCriticalTransport.downloads.filter((path) => path === "/workspace/BRIEF.md")).toHaveLength(1);

    const criticalTransport = new InstrumentedTransport();
    const criticalWriter = new WorkspaceProjectionWriter(criticalTransport, 1);
    const state = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\nstate`, { critical: true });
    await criticalWriter.materialize(plan([state]), { workspaceRoot: "/workspace" });
    expect(criticalTransport.downloads.filter((path) => path === "/workspace/STATE.md")).toHaveLength(2);
  });

  it("keeps verified callbacks from earlier outputs when a later output fails", async () => {
    const transport = new InstrumentedTransport();
    transport.files.set("/workspace/SECOND.md", "human edit");
    const writer = new WorkspaceProjectionWriter(transport, 1);
    const first = await output("one", "FIRST.md", `${MANAGED_NOTICE}\nfirst`);
    const second = await output("two", "SECOND.md", `${MANAGED_NOTICE}\nsecond`);
    const verified: string[] = [];

    await expect(writer.materialize(plan([first, second]), {
      workspaceRoot: "/workspace",
      onOutputVerified: (key) => { verified.push(key); }
    })).rejects.toBeInstanceOf(MaterializationOutputConflictError);

    expect(verified).toContain("one");
  });

  it("never exceeds configured concurrent uploads", async () => {
    const transport = new InstrumentedTransport();
    transport.uploadDelay = 10;
    const writer = new WorkspaceProjectionWriter(transport, 2);
    const outputs = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((index) => output(`key-${index}`, `F-${index}.md`, `${MANAGED_NOTICE}\n${index}`))
    );

    await writer.materialize(plan(outputs), { workspaceRoot: "/workspace" });

    expect(transport.maxInFlight).toBeLessThanOrEqual(2);
    expect(transport.maxInFlight).toBeGreaterThan(1);
  });

  it("parses only conservative concurrency 1..4 and defaults to 4", () => {
    expect(parseProjectionConcurrency()).toBe(4);
    expect(parseProjectionConcurrency("1")).toBe(1);
    expect(parseProjectionConcurrency("4")).toBe(4);
    for (const invalid of ["0", "5", "1.5", "x"]) {
      expect(() => parseProjectionConcurrency(invalid)).toThrow(/PROJECT_OS_PROJECTION_CONCURRENCY/);
    }
  });
});
