import { expect, it } from "vitest";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { emptyProjectState } from "../src/domain/transitions";
import { MutationCandidateResolutionService } from "../src/mutation-gate/resolution-service";
import { MutationGateService } from "../src/mutation-gate/service";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderChangeEntry } from "../src/persistence/provider/contract";
import { zoneNavigationHeadPath } from "../src/documents/zone-navigation";
import {
  ProviderConflictError,
  ProviderCursorResetError,
  ProviderPreconditionFailedError
} from "../src/persistence/provider/errors";

function neutralRuntime(files = new Map<string, string>()): ProjectOsPersistenceRuntime {
  return {
    providerId: "dropbox",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: {
      writeTextConditional: async () => { throw new ProviderPreconditionFailedError("unused"); }
    },
    serverSideCopy: {
      copyObject: async (_from, to) => ({ path: to, size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "cursor" })
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
}

function state() {
  return emptyProjectState("PRJ-0002", "Project OS", "project-os", "Mutation gate neutral runtime");
}

function cursorStore(initial?: string) {
  const values = new Map<string, unknown>();
  if (initial) values.set("managed-document-change-cursor-v1", initial);
  return {
    values,
    store: {
      get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    }
  };
}

it("processes neutral provider changes without Dropbox runtime types", async () => {
  const change: ProviderChangeEntry = {
    kind: "deleted",
    name: "removed.md",
    path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/removed.md"
  };

  await expect(new MutationGateService(neutralRuntime(), "observe").processChanges(
    state(),
    [change],
    "incremental"
  )).resolves.toEqual({
    candidates: 0,
    mutation_gate_mode: "observe",
    policy_violations: 0
  });
});

it("coordinates managed-document reconciliation through the neutral change feed", async () => {
  const runtime = neutralRuntime();
  runtime.changeFeed.listChanges = async () => ({ entries: [], cursor: "cursor-1" });
  const cursors = cursorStore();

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(summary).toMatchObject({
    baseline: true,
    cursor_reset: false,
    cursor_advanced: true,
    candidates: 0,
    mutation_gate_mode: "observe",
    policy_violations: 0,
    archived: false
  });
  expect(cursors.values.get("managed-document-change-cursor-v1")).toBe("cursor-1");
});

it("reserves both navigation index names during baseline reconciliation without false drift before adoption", async () => {
  const runtime = neutralRuntime();
  runtime.changeFeed.listChanges = async () => ({ entries: [
    { kind: "deleted", name: "00-CURRENT-INDEX.md", path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/00-CURRENT-INDEX.md" },
    { kind: "deleted", name: "00-CURRENT.md", path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/REVIEW/00-CURRENT.md" }
  ], cursor: "navigation-baseline" });
  const cursors = cursorStore();

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(summary).toMatchObject({ baseline: true, conflicts: 0, drift_findings: 0, bootstrapped: 0, restored: 0 });
  expect(summary.changed_document_ids).toEqual([]);
});

it("normalizes reserved navigation names regardless of Dropbox path casing", async () => {
  const runtime = neutralRuntime();
  runtime.changeFeed.listChanges = async () => ({ entries: [
    { kind: "deleted", name: "00-current-index.MD", path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/working/00-current-index.MD" }
  ], cursor: "navigation-case-alias" });
  const cursors = cursorStore();

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(summary).toMatchObject({ conflicts: 0, drift_findings: 0, bootstrapped: 0 });
});

it("ignores a reserved index change when it matches the adopted published identity", async () => {
  const files = new Map<string, string>();
  const runtime = neutralRuntime(files);
  const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/00-CURRENT-INDEX.md";
  const identity = { basename: "00-CURRENT-INDEX.md", object_id: "nav-index", revision_token: "rev-7", content_sha256: "a".repeat(64) };
  files.set(zoneNavigationHeadPath("PRJ-0002", "WORKING"), JSON.stringify({
    schema_version: "1.0", project_id: "PRJ-0002", zone: "WORKING", generation: 1,
    source_request_id: "DOCREQ-NAVIGATION-WORKING-0001", index: identity,
    finalization_ref: "/finalization", source_snapshot_id: "source:1", source_count: 1, coverage_gaps: []
  }));
  runtime.objects.getMetadata = async (candidate) => candidate === path
    ? { path, objectId: identity.object_id, revisionToken: identity.revision_token, size: 12 }
    : null;
  runtime.changeFeed.listChanges = async () => ({ entries: [{ kind: "file", name: "00-CURRENT-INDEX.md", path }], cursor: "navigation-expected" });
  const cursors = cursorStore();

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(summary).toMatchObject({ conflicts: 0, drift_findings: 0, bootstrapped: 0 });
});

it("reports drift when an adopted navigation index no longer matches the published identity", async () => {
  const files = new Map<string, string>();
  const runtime = neutralRuntime(files);
  const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/00-CURRENT-INDEX.md";
  files.set(zoneNavigationHeadPath("PRJ-0002", "WORKING"), JSON.stringify({
    schema_version: "1.0", project_id: "PRJ-0002", zone: "WORKING", generation: 1,
    source_request_id: "DOCREQ-NAVIGATION-WORKING-0001",
    index: { basename: "00-CURRENT-INDEX.md", object_id: "nav-index", revision_token: "rev-7", content_sha256: "a".repeat(64) },
    finalization_ref: "/finalization", source_snapshot_id: "source:1", source_count: 1, coverage_gaps: []
  }));
  runtime.changeFeed.listChanges = async () => ({ entries: [{ kind: "deleted", name: "00-CURRENT-INDEX.md", path }], cursor: "navigation-drift" });
  const cursors = cursorStore();

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(summary).toMatchObject({ conflicts: 1, drift_findings: 1, bootstrapped: 0 });
});

it("resets a stale neutral change-feed cursor before rebuilding the baseline", async () => {
  const runtime = neutralRuntime();
  let calls = 0;
  runtime.changeFeed.listChanges = async (input) => {
    calls += 1;
    if (input.cursor) throw new ProviderCursorResetError("reset");
    return { entries: [], cursor: "cursor-rebuilt" };
  };
  const cursors = cursorStore("cursor-stale");

  const summary = await new ManagedDocumentChangeCoordinator(runtime, cursors.store, "observe").reconcile(state());

  expect(calls).toBe(2);
  expect(summary).toMatchObject({
    baseline: true,
    cursor_reset: true,
    cursor_advanced: true,
    candidates: 0,
    mutation_gate_mode: "observe",
    policy_violations: 0
  });
  expect(cursors.values.get("managed-document-change-cursor-v1")).toBe("cursor-rebuilt");
});

it("resolves a missing candidate through neutral persistence without invoking downstream adoption", async () => {
  const service = new MutationCandidateResolutionService(neutralRuntime());
  const receipt = await service.resolve({
    operation: "candidate.reject",
    resolution_id: "MUTRES-111111111111111111111111",
    project_id: "PRJ-0002",
    candidate_id: "MUTCAND-111111111111111111111111"
  }, state(), {
    artifact: async () => { throw new Error("unused"); },
    working: async () => { throw new Error("unused"); }
  });

  expect(receipt).toMatchObject({
    status: "rejected",
    code: "CANDIDATE_NOT_FOUND",
    candidate_id: "MUTCAND-111111111111111111111111"
  });
});
