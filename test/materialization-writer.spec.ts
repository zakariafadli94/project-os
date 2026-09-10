import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import { sha256Text } from "../src/materialization/hash";
import { createSliceBudget } from "../src/convergence/budget";
import type { PlannedProjectionOutput, ProjectionPlan } from "../src/materialization/planner";
import {
  MaterializationOutputConflictError,
  parseProjectionConcurrency,
  WorkspaceProjectionWriter
} from "../src/materialization/writer";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import { MANAGED_NOTICE } from "../src/render/shared";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

class InstrumentedObjects implements ObjectPersistence {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  downloads: string[] = [];
  uploadDelay = 0;
  readDelay = 0;
  inFlight = 0;
  maxInFlight = 0;
  readInFlight = 0;
  maxReadInFlight = 0;
  failPath: string | null = null;

  async readText(path: string): Promise<string | null> {
    this.downloads.push(path);
    this.readInFlight += 1;
    this.maxReadInFlight = Math.max(this.maxReadInFlight, this.readInFlight);
    try {
      if (this.readDelay) await new Promise((resolve) => setTimeout(resolve, this.readDelay));
      return this.files.get(path) ?? null;
    } finally {
      this.readInFlight -= 1;
    }
  }

  async createText(path: string, content: string): Promise<void> {
    await this.write(path, content, "add");
  }

  async upsertText(path: string, content: string): Promise<void> {
    await this.write(path, content, "overwrite");
  }

  async getMetadata(path: string): Promise<ProviderObjectMetadata | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, size: new TextEncoder().encode(content).byteLength };
  }

  async listChildren(_path: string): Promise<ProviderEntry[]> { return []; }
  async move(): Promise<void> { throw new Error("not used"); }
  async delete(path: string): Promise<void> { this.files.delete(path); }

  private async write(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.uploadDelay) await new Promise((resolve) => setTimeout(resolve, this.uploadDelay));
      if (path === this.failPath) throw new Error(`injected failure for ${path}`);
      if (mode === "add" && this.files.has(path)) throw new ProviderConflictError("exists");
      this.files.set(path, content);
      this.uploads.push({ path, mode });
    } finally {
      this.inFlight -= 1;
    }
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
  it("uses create for a missing destination", async () => {
    const objects = new InstrumentedObjects();
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const item = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nbrief`);

    await writer.materialize(plan([item]), { workspaceRoot: "/workspace" });

    expect(objects.uploads).toEqual([{ path: "/workspace/BRIEF.md", mode: "add" }]);
  });

  it("skips upload when destination already has desired bytes", async () => {
    const objects = new InstrumentedObjects();
    const content = `${MANAGED_NOTICE}\nalready current`;
    objects.files.set("/workspace/BRIEF.md", content);
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const item = await output("global:BRIEF", "BRIEF.md", content);

    await writer.materialize(plan([item]), { workspaceRoot: "/workspace" });

    expect(objects.uploads).toHaveLength(0);
  });

  it("rechecks a reused output and preserves an external edit instead of trusting stale attempt evidence", async () => {
    const objects = new InstrumentedObjects();
    const expected = `${MANAGED_NOTICE}\nfirst generated bytes`;
    const external = `${MANAGED_NOTICE}\nexternal edit between slices`;
    const item = await output("global:BRIEF", "BRIEF.md", expected);
    const priorAttempt: ProjectionOutputEvidence = {
      relative_path: item.relative_path,
      input_hash: item.input_hash,
      content_hash: item.content_hash,
      source_revision: item.source_revision
    };
    objects.files.set("/workspace/BRIEF.md", external);
    const writer = new WorkspaceProjectionWriter(objects, 1);

    await expect(writer.materialize(plan([item]), {
      workspaceRoot: "/workspace",
      alreadyVerified: new Map([[item.key, priorAttempt]])
    })).rejects.toBeInstanceOf(MaterializationOutputConflictError);

    expect(objects.files.get("/workspace/BRIEF.md")).toBe(external);
    const externalHash = await sha256Text(external);
    expect(objects.files.get(
      `/PROJECT_OS/.project-os/projects/PRJ-3301/recovery/projections/payloads/sha256/${externalHash}.md`
    )).toBe(external);
  });

  it("fails closed and durably quarantines current bytes when they match neither baseline nor desired", async () => {
    const objects = new InstrumentedObjects();
    const baselineContent = `${MANAGED_NOTICE}\nbaseline`;
    const baseline: ProjectionOutputEvidence = {
      relative_path: "BRIEF.md",
      input_hash: await sha256Text("baseline-input"),
      content_hash: await sha256Text(baselineContent),
      source_revision: 3
    };
    const humanEdit = `${MANAGED_NOTICE}\nunexpected edit`;
    objects.files.set("/workspace/BRIEF.md", humanEdit);
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const item = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\ndesired`, { baseline });

    await expect(writer.materialize(plan([item]), { workspaceRoot: "/workspace" }))
      .rejects.toBeInstanceOf(MaterializationOutputConflictError);
    expect(objects.uploads.filter(({ path }) => path.startsWith("/workspace/"))).toHaveLength(0);
    const hash = await sha256Text(humanEdit);
    expect(objects.files.get(`/PROJECT_OS/.project-os/projects/PRJ-3301/recovery/projections/payloads/sha256/${hash}.md`))
      .toBe(humanEdit);
    expect([...objects.files.keys()].some((path) =>
      path.startsWith("/PROJECT_OS/.project-os/projects/PRJ-3301/recovery/projections/records/")
    )).toBe(true);
  });

  it("offers already-preserved unexpected human bytes to a recovery hook before failing closed", async () => {
    const objects = new InstrumentedObjects();
    const baselineContent = `${MANAGED_NOTICE}\nbaseline`;
    const baseline: ProjectionOutputEvidence = {
      relative_path: "STATE.md",
      input_hash: await sha256Text("baseline-state"),
      content_hash: await sha256Text(baselineContent),
      source_revision: 3
    };
    const humanEdit = `${MANAGED_NOTICE}\nhuman changed this in Obsidian`;
    objects.files.set("/workspace/STATE.md", humanEdit);
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const item = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\ncanonical state`, { baseline, critical: true });
    const preserved: Array<{ key: string; path: string; currentContent: string; currentHash: string }> = [];

    await expect(writer.materialize(plan([item]), {
      workspaceRoot: "/workspace",
      onUnexpectedContent: (entry) => { preserved.push(entry); }
    })).rejects.toBeInstanceOf(MaterializationOutputConflictError);

    expect(preserved).toEqual([{
      key: "global:STATE",
      path: "/workspace/STATE.md",
      currentContent: humanEdit,
      currentHash: await sha256Text(humanEdit)
    }]);
    expect(objects.uploads.filter(({ path }) => path.startsWith("/workspace/"))).toHaveLength(0);
  });

  it("does not overwrite a managed projection that changes after observation", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const path = "/workspace/STATE.md";
    const baselineContent = `${MANAGED_NOTICE}\nbaseline`;
    const humanEdit = `${MANAGED_NOTICE}\nexternal edit after observation`;
    await mock.writeExternal(path, baselineContent);
    const baseline: ProjectionOutputEvidence = {
      relative_path: "STATE.md",
      input_hash: await sha256Text("baseline-state"),
      content_hash: await sha256Text(baselineContent),
      source_revision: 3
    };
    const originalWrite = runtime.conditionalWrite.writeTextConditional.bind(runtime.conditionalWrite);
    runtime.conditionalWrite.writeTextConditional = async (writePath, content, token) => {
      await mock.writeExternal(writePath, humanEdit);
      return originalWrite(writePath, content, token);
    };
    const writer = new WorkspaceProjectionWriter(runtime, 1);
    const item = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\ncanonical state`, {
      baseline, critical: true
    });

    await expect(writer.materialize(plan([item]), { workspaceRoot: "/workspace" })).rejects.toBeTruthy();
    expect(mock.files.get(path)).toBe(humanEdit);
  });

  it("does not delete a removed deliverable that changes after its stable observation", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const path = "/workspace/DELIVERABLES/DEL-3301.md";
    const generated = `${MANAGED_NOTICE}\nold deliverable`;
    const external = `${MANAGED_NOTICE}\nexternal edit after observation`;
    await mock.writeExternal(path, generated);
    const evidence: ProjectionOutputEvidence = {
      relative_path: "DELIVERABLES/DEL-3301.md",
      input_hash: await sha256Text("legacy-input"),
      content_hash: await sha256Text(generated),
      source_revision: 3
    };
    let deleteCalled = false;
    runtime.objects.deleteIfUnchanged = async (deletePath, expected) => {
      deleteCalled = true;
      expect(expected.revisionToken).toMatch(/^mock-rev-/);
      await mock.writeExternal(deletePath, external);
      return "changed";
    };
    const writer = new WorkspaceProjectionWriter(runtime, 1);
    const removalPlan: ProjectionPlan = {
      ...plan([]),
      removed_outputs: ["deliverable:DEL-3301"],
      removed_output_evidence: new Map([["deliverable:DEL-3301", evidence]])
    };

    await expect(writer.materialize(removalPlan, { workspaceRoot: "/workspace" }))
      .rejects.toBeInstanceOf(MaterializationOutputConflictError);
    expect(deleteCalled).toBe(true);
    expect(mock.files.get(path)).toBe(external);
  });

  it("bootstrap may overwrite a known machine-managed note but quarantines and refuses an untracked human file", async () => {
    const managedObjects = new InstrumentedObjects();
    managedObjects.files.set("/workspace/BRIEF.md", `${MANAGED_NOTICE}\nold generated`);
    const managedWriter = new WorkspaceProjectionWriter(managedObjects, 1);
    const desired = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nnew generated`);

    await managedWriter.materialize(plan([desired]), { workspaceRoot: "/workspace" });
    expect(managedObjects.uploads).toEqual([{ path: "/workspace/BRIEF.md", mode: "overwrite" }]);

    const humanObjects = new InstrumentedObjects();
    humanObjects.files.set("/workspace/BRIEF.md", "human-owned content");
    const humanWriter = new WorkspaceProjectionWriter(humanObjects, 1);
    await expect(humanWriter.materialize(plan([desired]), { workspaceRoot: "/workspace" }))
      .rejects.toBeInstanceOf(MaterializationOutputConflictError);
    expect(humanObjects.uploads.filter(({ path }) => path.startsWith("/workspace/"))).toHaveLength(0);
    expect([...humanObjects.files.keys()].some((path) =>
      path.startsWith("/PROJECT_OS/.project-os/projects/PRJ-3301/recovery/projections/payloads/")
    )).toBe(true);
  });

  it("does not read back non-critical success but verifies critical output after upload", async () => {
    const nonCriticalObjects = new InstrumentedObjects();
    const nonCriticalWriter = new WorkspaceProjectionWriter(nonCriticalObjects, 1);
    const brief = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nbrief`);
    await nonCriticalWriter.materialize(plan([brief]), { workspaceRoot: "/workspace" });
    expect(nonCriticalObjects.downloads.filter((path) => path === "/workspace/BRIEF.md")).toHaveLength(1);

    const criticalObjects = new InstrumentedObjects();
    const criticalWriter = new WorkspaceProjectionWriter(criticalObjects, 1);
    const state = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\nstate`, { critical: true });
    await criticalWriter.materialize(plan([state]), { workspaceRoot: "/workspace" });
    expect(criticalObjects.downloads.filter((path) => path === "/workspace/STATE.md")).toHaveLength(2);
  });

  it("keeps verified callbacks from earlier outputs when a later output fails", async () => {
    const objects = new InstrumentedObjects();
    objects.files.set("/workspace/SECOND.md", "human edit");
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const first = await output("one", "FIRST.md", `${MANAGED_NOTICE}\nfirst`);
    const second = await output("two", "SECOND.md", `${MANAGED_NOTICE}\nsecond`);
    const verified: string[] = [];

    await expect(writer.materialize(plan([first, second]), {
      workspaceRoot: "/workspace",
      onOutputVerified: (key) => { verified.push(key); }
    })).rejects.toBeInstanceOf(MaterializationOutputConflictError);

    expect(verified).toContain("one");
  });

  it("writes the critical STATE and HANDOFF pair before a non-critical output can fail", async () => {
    const objects = new InstrumentedObjects();
    objects.failPath = "/workspace/BRIEF.md";
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const state = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\nstate`, { critical: true });
    const handoff = await output("global:HANDOFF", "HANDOFF.md", `${MANAGED_NOTICE}\nhandoff`, { critical: true });
    const brief = await output("global:BRIEF", "BRIEF.md", `${MANAGED_NOTICE}\nbrief`);

    await expect(writer.materialize(plan([brief, handoff, state]), { workspaceRoot: "/workspace" }))
      .rejects.toThrow("injected failure");

    expect(objects.files.get("/workspace/STATE.md")).toBe(`${MANAGED_NOTICE}\nstate`);
    expect(objects.files.get("/workspace/HANDOFF.md")).toBe(`${MANAGED_NOTICE}\nhandoff`);
  });

  it("stops a materialization slice before exhausting its checkpoint reserve", async () => {
    const budget = createSliceBudget(() => 0, new AbortController().signal);
    class ScopedObjects extends InstrumentedObjects {
      override async readText(path: string) { budget.beforeHttp(); return super.readText(path); }
      override async createText(path: string, content: string) { budget.beforeHttp(); return super.createText(path, content); }
      override async upsertText(path: string, content: string) { budget.beforeHttp(); return super.upsertText(path, content); }
    }
    const objects = new ScopedObjects();
    const writer = new WorkspaceProjectionWriter(objects, 1);
    const outputs = await Promise.all(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"].map((key) =>
        output(`global:${key}`, `${key}.md`, `${MANAGED_NOTICE}\n${key}`)
      )
    );
    const result = await writer.materializeSlice(plan(outputs), { workspaceRoot: "/workspace" }, budget);

    expect(result.nextKey).not.toBeNull();
    expect(result.verified.size).toBeLessThan(outputs.length);
    expect(budget.calls_left).toBeGreaterThanOrEqual(4);
  });

  it("never exceeds configured concurrent writes", async () => {
    const objects = new InstrumentedObjects();
    objects.uploadDelay = 10;
    const writer = new WorkspaceProjectionWriter(objects, 2);
    const outputs = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((index) => output(`key-${index}`, `F-${index}.md`, `${MANAGED_NOTICE}\n${index}`))
    );

    await writer.materialize(plan(outputs), { workspaceRoot: "/workspace" });

    expect(objects.maxInFlight).toBeLessThanOrEqual(2);
    expect(objects.maxInFlight).toBeGreaterThan(1);
  });

  it("verifies completed outputs with bounded parallel reads", async () => {
    const objects = new InstrumentedObjects();
    objects.readDelay = 10;
    const writer = new WorkspaceProjectionWriter(objects, 2);
    const outputs = await Promise.all(
      [1, 2, 3, 4].map((index) => output(`key-${index}`, `F-${index}.md`, `${MANAGED_NOTICE}\n${index}`))
    );
    for (const item of outputs) objects.files.set(`/workspace/${item.relative_path}`, item.content);

    await writer.verifyOutputs(
      new Map(outputs.map((item) => [item.key, {
        relative_path: item.relative_path,
        input_hash: item.input_hash,
        content_hash: item.content_hash,
        source_revision: item.source_revision
      }])),
      "/workspace"
    );

    expect(objects.maxReadInFlight).toBeLessThanOrEqual(2);
    expect(objects.maxReadInFlight).toBeGreaterThan(1);
  });

  it("verifies the critical STATE/HANDOFF pair with configured concurrent reads", async () => {
    const objects = new InstrumentedObjects();
    objects.readDelay = 10;
    const writer = new WorkspaceProjectionWriter(objects, 2);
    const state = await output("global:STATE", "STATE.md", `${MANAGED_NOTICE}\nstate`, { critical: true });
    const handoff = await output("global:HANDOFF", "HANDOFF.md", `${MANAGED_NOTICE}\nhandoff`, { critical: true });
    objects.files.set("/workspace/STATE.md", state.content);
    objects.files.set("/workspace/HANDOFF.md", handoff.content);

    await writer.verifyCritical(plan([state, handoff]), "/workspace");

    expect(objects.maxReadInFlight).toBeLessThanOrEqual(2);
    expect(objects.maxReadInFlight).toBeGreaterThan(1);
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
