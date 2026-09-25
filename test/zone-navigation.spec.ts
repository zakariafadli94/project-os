import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import {
  navigationReconcileSchema,
  type NavigationReconcileRequest,
  type NavigationInventoryEntry,
  type NavigationInventoryPort,
  type NavigationIndexIdentity
} from "../src/domain/zone-navigation";
import { ZoneNavigationEngine } from "../src/documents/zone-navigation";
import { executionHash } from "../src/execution/journal";
import type { ExecutionAdmission } from "../src/execution/contract";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";
import { workspaceProjectRoot } from "../src/persistence/layout";
import { sha256Text } from "../src/documents/hash";
import type { SliceBudget } from "../src/convergence/contract";

const state = () => emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
const at = "2026-09-25T09:00:00.000Z";

function request(zone: "WORKING" | "REVIEW" | "DELIVERABLES" = "WORKING", expected_index: NavigationReconcileRequest["expected_index"] = null): NavigationReconcileRequest {
  return navigationReconcileSchema.parse({
    operation: "navigation.reconcile",
    request_id: `DOCREQ-NAVIGATION-${zone}-0001`,
    project_id: "PRJ-0002",
    zone,
    expected_project_revision: 0,
    expected_generation: 0,
    expected_index,
    created_at: at
  });
}

function admissionFor(input: NavigationReconcileRequest): Promise<ExecutionAdmission> {
  const zonePath = `${workspaceProjectRoot(input.project_id, "project-os")}/${input.zone}/${input.expected_index?.basename ?? "00-CURRENT.md"}`;
  const archivePath = input.expected_index
    ? `${workspaceProjectRoot(input.project_id, "project-os")}/ARCHIVES/NAVIGATION/${input.zone}/${input.expected_generation + 1}-${input.expected_index.content_sha256}.md`
    : null;
  return executionHash(input).then((request_hash) => ({
    project_id: input.project_id,
    request_id: input.request_id,
    kind: "document",
    operation: "navigation.reconcile",
    request_hash,
    actor: { actor_id: "operator:test", authority: "project_guard" },
    resources: [{ resource_id: `navigation:${input.zone}`, resource_type: "navigation", zone: input.zone, version: String(input.expected_generation) }],
    resource_effect_scopes: [{
      resource_id: `navigation:${input.zone}`, resource_version: String(input.expected_generation), provider_id: "test-provider",
      sources: input.expected_index ? [{ path: zonePath, logical_path: `${input.zone}/${input.expected_index.basename}` }] : [],
      destinations: [{ path: zonePath, logical_path: `${input.zone}/${input.expected_index?.basename ?? "00-CURRENT.md"}` }],
      preservation_copies: archivePath ? [{ path: archivePath, logical_path: archivePath.slice(`${workspaceProjectRoot(input.project_id, "project-os")}/`.length) }] : []
    }],
    global_revision: 0,
    project_revision: input.expected_project_revision,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: input.expected_project_revision },
    verdict: "allow",
    results: [],
    gaps: [],
    deferred_rules: []
  } as unknown as ExecutionAdmission));
}

function runtimeHarness() {
  const files = new Map<string, { content: string; objectId: string; revisionToken: string }>();
  const binaryFiles = new Map<string, { bytes: Uint8Array; objectId: string; revisionToken: string }>();
  let sequence = 0;
  const metadata = (path: string): ProviderObjectMetadata | null => {
    const file = files.get(path);
    const binary = binaryFiles.get(path);
    return file ? {
      path,
      size: new TextEncoder().encode(file.content).byteLength,
      objectId: file.objectId,
      revisionToken: file.revisionToken,
    } : binary ? { path, size: binary.bytes.length, objectId: binary.objectId, revisionToken: binary.revisionToken } : null;
  };
  const put = (path: string, content: string, objectId?: string): ProviderObjectMetadata => {
    sequence += 1;
    files.set(path, { content, objectId: objectId ?? `id:${sequence}`, revisionToken: `rev-${sequence}` });
    return metadata(path)!;
  };
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test-provider",
    objects: {
      readText: async (path) => files.get(path)?.content ?? null,
      readBytes: async (path, maxBytes) => {
        const binary = binaryFiles.get(path);
        if (!binary) return null;
        if (binary.bytes.length > maxBytes) throw new Error("byte_limit");
        return binary.bytes.slice();
      },
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        put(path, content);
      },
      upsertText: async (path, content) => { put(path, content, files.get(path)?.objectId); },
      getMetadata: async (path) => metadata(path),
      listChildren: async () => [],
      move: async (from, to) => {
        const source = files.get(from);
        if (!source || files.has(to)) throw new ProviderConflictError("move_conflict");
        files.delete(from);
        put(to, source.content, source.objectId);
      },
      delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: {
      writeTextConditional: async (path, content, expectedRevisionToken) => {
        const current = files.get(path);
        if (!current || current.revisionToken !== expectedRevisionToken) throw new ProviderPreconditionFailedError("stale");
        return put(path, content, current.objectId);
      }
    },
    serverSideCopy: { copyObject: async () => { throw new Error("unused"); } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "test" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  const putBytes = (path: string, bytes: Uint8Array, objectId?: string): ProviderObjectMetadata => {
    sequence += 1;
    binaryFiles.set(path, { bytes: bytes.slice(), objectId: objectId ?? `id:${sequence}`, revisionToken: `rev-${sequence}` });
    return metadata(path)!;
  };
  return { runtime, files, binaryFiles, put, putBytes };
}

async function inventoryHarness(inputState = state(), zone: "WORKING" | "REVIEW" | "DELIVERABLES" = "WORKING", options: { missing?: boolean; snapshotChanged?: boolean; pages?: NavigationInventoryEntry[][] } = {}) {
  const projectRoot = workspaceProjectRoot(inputState.project_id, inputState.slug);
  const logical_path = "plans/roadmap.md";
  const targetPath = `${projectRoot}/${zone}/${logical_path}`;
  const targetContent = "Canonical content\n";
  const entry: NavigationInventoryEntry = {
    project_id: inputState.project_id,
    zone,
    resource_id: "DOC-0123456789ABCDEF01234567",
    version: "VER-REQ-0123456789ABCDEF01234567",
    logical_path,
    path: targetPath,
    expected: { object_id: "id:target", revision_token: "rev-target", content_sha256: await sha256Text(targetContent), size: new TextEncoder().encode(targetContent).byteLength }
  };
  const pages = options.pages ?? [[entry]];
  const port: NavigationInventoryPort = {
    listPage: async ({ cursor, budget: slice }) => {
      const pageNumber = cursor === null ? 0 : Number(cursor);
      slice.beforeHttp();
      return { entries: pages[pageNumber] ?? [], gaps: [], snapshot_id: "snapshot-1", next_cursor: pageNumber + 1 < pages.length ? String(pageNumber + 1) : null };
    },
    verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return !options.snapshotChanged; },
    verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return !options.missing; }
  };
  return { port, entry, targetPath, targetContent };
}

function budget(calls = 32): SliceBudget {
  return {
    deadline_ms: Number.MAX_SAFE_INTEGER,
    calls_left: calls,
    now: () => 0,
    signal: new AbortController().signal,
    beforeHttp() { this.calls_left -= 1; if (this.calls_left < 0) throw new Error("slice_budget_exhausted"); },
    canStartEffect(required) { return this.calls_left >= required; }
  };
}

async function seedIndex(runtimeHarnessValue: ReturnType<typeof runtimeHarness>, path: string, content: string) {
  const metadata = runtimeHarnessValue.put(path, content, "id:index");
  return {
    basename: path.split("/").at(-1)! as NavigationIndexIdentity["basename"],
    object_id: metadata.objectId!,
    revision_token: metadata.revisionToken!,
    content_sha256: await sha256Text(content)
  } satisfies NavigationIndexIdentity;
}

function seedTarget(runtimeHarnessValue: ReturnType<typeof runtimeHarness>, inventory: Awaited<ReturnType<typeof inventoryHarness>>) {
  const metadata = runtimeHarnessValue.put(inventory.targetPath, inventory.targetContent, "id:target");
  inventory.entry.expected.object_id = metadata.objectId!;
  inventory.entry.expected.revision_token = metadata.revisionToken!;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reconcileUntilTerminal(engine: ZoneNavigationEngine, input: NavigationReconcileRequest, project: ReturnType<typeof state>, admission: ExecutionAdmission, firstBudget = 32) {
  let result = await engine.reconcile(input, project, admission, budget(firstBudget));
  for (let attempt = 0; result.status === "pending" && attempt < 12; attempt++) result = await engine.reconcile(input, project, admission, budget());
  return result;
}

describe("zone navigation identity and resumable reconciliation", () => {
  it("rejects unknown public fields and non-exact index identities", () => {
    const input = { ...request(), renderer: "client-controlled" };
    expect(navigationReconcileSchema.safeParse(input).success).toBe(false);
    expect(navigationReconcileSchema.safeParse({ ...request(), expected_index: { basename: "../STATE.md", object_id: "id:x", revision_token: "rev", content_sha256: "a".repeat(64) } }).success).toBe(false);
  });

  it("preserves exact legacy index bytes before adopting the zone index", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT-INDEX.md`;
    const legacy = "# Human-maintained index\r\nKeep the original bytes.\r\n";
    const identity = await seedIndex(harness, indexPath, legacy);
    const input = request("WORKING", identity);
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    const archived = [...harness.files.entries()].find(([path]) => path.includes("/ARCHIVES/NAVIGATION/WORKING/") && path.endsWith(".md"));
    expect(archived?.[1].content).toBe(legacy);
    expect(harness.files.get(indexPath)?.content).not.toBe(legacy);
  });

  it("stores independent navigation identity and generation for each zone", async () => {
    const harness = runtimeHarness();
    const project = state();
    const paths: string[] = [];
    for (const zone of ["WORKING", "REVIEW", "DELIVERABLES"] as const) {
      const inv = await inventoryHarness(project, zone);
      seedTarget(harness, inv);
      const input = request(zone);
      const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
      const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
      expect(result.status, JSON.stringify(result)).toBe("finalized");
      if (result.status !== "finalized") throw new Error("expected finalized navigation");
      paths.push(result.receipt.head_ref);
    }
    expect(new Set(paths).size).toBe(3);
  });

  it("does not overwrite an index changed after its observed identity", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const identity = await seedIndex(harness, indexPath, "# Original\n");
    const input = request("WORKING", identity);
    const originalConditionalWrite = harness.runtime.conditionalWrite.writeTextConditional;
    harness.runtime.conditionalWrite.writeTextConditional = async () => {
      harness.put(indexPath, "# External edit\n", "id:index");
      return originalConditionalWrite(indexPath, "# Generated\n", identity.revision_token);
    };
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status).toBe("conflict");
    expect(harness.files.get(indexPath)?.content).toBe("# External edit\n");
  });

  it("refuses ambiguous legacy and current index names", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const root = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING`;
    const identity = await seedIndex(harness, `${root}/00-CURRENT-INDEX.md`, "# Legacy\n");
    harness.put(`${root}/00-CURRENT.md`, "# Current\n", "id:other-index");
    const input = request("WORKING", identity);
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const result = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(result.status).toBe("conflict");
    expect(harness.files.get(`${root}/00-CURRENT-INDEX.md`)?.content).toBe("# Legacy\n");
    expect(harness.files.get(`${root}/00-CURRENT.md`)?.content).toBe("# Current\n");
  });

  it("does not finalize when a canonical target is missing or snapshot changed", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project, "WORKING", { missing: true });
    const input = request();
    const result = await new ZoneNavigationEngine(harness.runtime, inv.port).reconcile(input, project, await admissionFor(input), budget());
    expect(result.status).toBe("conflict");
    const indexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    expect(harness.files.has(indexPath)).toBe(false);
  });

  it("verifies binary targets from bytes without decoding them as text", async () => {
    const harness = runtimeHarness();
    const project = state();
    const zone = "WORKING" as const;
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const targetPath = `${workspaceProjectRoot(project.project_id, project.slug)}/${zone}/assets/diagram.bin`;
    const metadata = harness.putBytes(targetPath, bytes, "id:binary");
    const entry: NavigationInventoryEntry = {
      project_id: project.project_id, zone, resource_id: "ART-BINARY-00000001", version: "a".repeat(64),
      logical_path: "assets/diagram.bin", path: targetPath,
      expected: { object_id: metadata.objectId!, revision_token: metadata.revisionToken!, content_sha256: await sha256Bytes(bytes), size: bytes.length }
    };
    const port: NavigationInventoryPort = {
      listPage: async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [entry], gaps: [], snapshot_id: "binary-snapshot", next_cursor: null }; },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_value, slice) => { slice.beforeHttp(); return true; }
    };
    const input = request(zone);
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, port), input, project, await admissionFor(input));
    expect(result.status).toBe("finalized");
    if (result.status === "finalized") expect(harness.files.get(`${workspaceProjectRoot(project.project_id, project.slug)}/${zone}/00-CURRENT.md`)?.content).toContain("assets/diagram.bin");
  });

  it("does not finalize deferred admission rules without their server postchecks", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const input = request();
    const admission = await admissionFor(input);
    admission.deferred_rules = [{ rule_id: "RULE-NAV-001", version: 1, scope: { kind: "project", project_id: project.project_id } }];
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, admission);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_postchecks_unavailable" });
    expect([...harness.files.keys()].some((path) => path.endsWith("/WORKING/00-CURRENT.md"))).toBe(false);
  });

  it("requires the admission to bind the observed index source and exact preservation target", async () => {
    const harness = runtimeHarness();
    const project = state();
    const inv = await inventoryHarness(project);
    seedTarget(harness, inv);
    const sourcePath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT-INDEX.md`;
    const expected = await seedIndex(harness, sourcePath, "old index\n");
    const input = request("WORKING", expected);
    const admission = await admissionFor(input);
    admission.resource_effect_scopes![0].preservation_copies = [];
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, inv.port), input, project, admission);
    expect(result).toMatchObject({ status: "conflict", code: "navigation_admission_binding_mismatch" });
    expect(harness.files.get(sourcePath)?.content).toBe("old index\n");
  });

  it("finishes inventory larger than one page across bounded slices without restarting cursors", async () => {
    const harness = runtimeHarness();
    const project = state();
    const entries: NavigationInventoryEntry[] = [];
    const content = "canonical\n";
    const hash = await sha256Text(content);
    for (let index = 0; index < 17; index++) {
      const logical_path = `records/item-${index}.md`;
      const path = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/${logical_path}`;
      const meta = harness.put(path, content, `id:source-${index}`);
      entries.push({ project_id: project.project_id, zone: "WORKING", resource_id: `DOC-${index.toString().padStart(24, "0")}`, version: `VER-${index}`, logical_path, path, expected: { object_id: meta.objectId!, revision_token: meta.revisionToken!, content_sha256: hash, size: new TextEncoder().encode(content).byteLength } });
    }
    const pages = [entries.slice(0, 8), entries.slice(8, 16), entries.slice(16)];
    const cursors: (string | null)[] = [];
    const port: NavigationInventoryPort = {
      listPage: async ({ cursor, budget: slice }) => {
        slice.beforeHttp();
        cursors.push(cursor);
        const page = cursor === null ? 0 : Number(cursor);
        return { entries: pages[page], gaps: [], snapshot_id: "large-snapshot", next_cursor: page < 2 ? String(page + 1) : null };
      },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return true; }
    };
    const input = request();
    const result = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, port), input, project, await admissionFor(input), 20);
    expect(result.status).toBe("finalized");
    expect(cursors).toEqual([null, "1", "2"]);
  });

  it("returns an old finalized receipt without restoring its index over a newer generation", async () => {
    const harness = runtimeHarness();
    const project = state();
    const originalInventory = await inventoryHarness(project);
    seedTarget(harness, originalInventory);
    const oldRequest = request();
    const oldEngine = new ZoneNavigationEngine(harness.runtime, originalInventory.port);
    const oldAdmission = await admissionFor(oldRequest);
    const original = await reconcileUntilTerminal(oldEngine, oldRequest, project, oldAdmission);
    expect(original.status).toBe("finalized");
    if (original.status !== "finalized") throw new Error("expected first generation to finalize");

    const newPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/plans/new-roadmap.md`;
    const newContent = "new canonical content\n";
    const newMeta = harness.put(newPath, newContent, "id:new-source");
    const newEntry: NavigationInventoryEntry = {
      ...originalInventory.entry,
      resource_id: "DOC-1123456789ABCDEF01234567",
      version: "VER-REQ-1123456789ABCDEF01234567",
      logical_path: "plans/new-roadmap.md",
      path: newPath,
      expected: { object_id: newMeta.objectId!, revision_token: newMeta.revisionToken!, content_sha256: await sha256Text(newContent), size: new TextEncoder().encode(newContent).byteLength }
    };
    const newPort: NavigationInventoryPort = {
      listPage: async ({ budget: slice }) => { slice.beforeHttp(); return { entries: [newEntry], gaps: [], snapshot_id: "snapshot-2", next_cursor: null }; },
      verifySnapshot: async ({ budget: slice }) => { slice.beforeHttp(); return true; },
      verifyEntry: async (_entry, slice) => { slice.beforeHttp(); return true; }
    };
    const nextRequest = navigationReconcileSchema.parse({ ...oldRequest, request_id: "DOCREQ-NAVIGATION-WORKING-0002", expected_generation: 1, expected_index: original.receipt.index });
    const next = await reconcileUntilTerminal(new ZoneNavigationEngine(harness.runtime, newPort), nextRequest, project, await admissionFor(nextRequest));
    expect(next.status).toBe("finalized");
    if (next.status !== "finalized") throw new Error("expected second generation to finalize");
    const currentIndexPath = `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/00-CURRENT.md`;
    const currentBeforeRetry = harness.files.get(currentIndexPath)!.content;
    expect(currentBeforeRetry).toContain("plans/new-roadmap.md");

    const replay = await oldEngine.reconcile(oldRequest, project, oldAdmission, budget());
    expect(replay).toEqual(original);
    expect(harness.files.get(currentIndexPath)?.content).toBe(currentBeforeRetry);
    expect(JSON.parse(harness.files.get(original.receipt.head_ref)!.content).generation).toBe(2);
  });

  it("resumes the frozen request after interruption and rejects changed payload under the same id", async () => {
    const harness = runtimeHarness();
    const project = state();
    const base = await inventoryHarness(project);
    const inv = await inventoryHarness(project, "WORKING", { pages: [[], [{
      project_id: project.project_id,
      zone: "WORKING",
      resource_id: "DOC-0123456789ABCDEF01234567",
      version: "VER-REQ-0123456789ABCDEF01234567",
      logical_path: "plans/roadmap.md",
      path: `${workspaceProjectRoot(project.project_id, project.slug)}/WORKING/plans/roadmap.md`,
      expected: base.entry.expected
    }]] });
    seedTarget(harness, base);
    inv.entry.expected = base.entry.expected;
    const input = request();
    const engine = new ZoneNavigationEngine(harness.runtime, inv.port);
    const first = await engine.reconcile(input, project, await admissionFor(input), budget(5));
    expect(first.status).toBe("pending");
    const resumed = await reconcileUntilTerminal(engine, input, project, await admissionFor(input));
    expect(resumed.status, JSON.stringify(resumed)).toBe("finalized");
    const altered = { ...input, expected_generation: 1 };
    const changedAdmission = await admissionFor(navigationReconcileSchema.parse(altered));
    const changed = await engine.reconcile(navigationReconcileSchema.parse(altered), project, changedAdmission, budget());
    expect(changed.status).toBe("conflict");
  });
});
