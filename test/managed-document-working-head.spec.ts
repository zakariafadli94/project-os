import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { ManagedDocumentService } from "../src/documents/service";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";

function runtimeHarness() {
  const files = new Map<string, { content: string; objectId: string; revisionToken: string; integrityHash: string }>();
  let revision = 0;

  const metadata = (path: string): ProviderObjectMetadata | null => {
    const file = files.get(path);
    return file ? {
      path,
      size: file.content.length,
      objectId: file.objectId,
      revisionToken: file.revisionToken,
      integrityHash: { algorithm: "dropbox-content-hash", value: file.integrityHash }
    } : null;
  };

  const put = (path: string, content: string, objectId?: string): ProviderObjectMetadata => {
    revision += 1;
    files.set(path, {
      content,
      objectId: objectId ?? `id:working-head-${revision}`,
      revisionToken: `rev-${revision}`,
      integrityHash: contentHash(content)
    });
    return metadata(path)!;
  };

  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "dropbox",
    objects: {
      readText: async (path) => files.get(path)?.content ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        put(path, content);
      },
      upsertText: async (path, content) => { put(path, content, files.get(path)?.objectId); },
      getMetadata: async (path) => metadata(path),
      listChildren: async () => [],
      move: async (from, to) => {
        const source = files.get(from);
        if (!source) throw new ProviderConflictError("missing");
        if (files.has(to)) throw new ProviderConflictError("exists");
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
    serverSideCopy: {
      copyObject: async (from, to) => {
        const source = files.get(from);
        if (!source) throw new ProviderConflictError("missing");
        if (files.has(to)) throw new ProviderConflictError("exists");
        return put(to, source.content);
      }
    },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };

  return { runtime, files };
}

function contentHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function state() {
  return emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
}

const createdAt = "2026-09-01T15:05:00+01:00";

describe("one active working head", () => {
  it("supersedes a working document onto a new path while preserving document identity and archiving the prior head", async () => {
    const { runtime, files } = runtimeHarness();
    const service = new ManagedDocumentService(runtime);
    const v1LogicalPath = "strategy/commercial-v0.1.md";
    const v2LogicalPath = "strategy/commercial-v0.2.md";
    const v1Content = "# Commercial V0.1\n\nInitial";
    const v1 = await service.writeWorking({
      request_id: "DOCREQ-WORKHEAD-WRITE-0001",
      project_id: "PRJ-0002",
      logical_path: v1LogicalPath,
      content: v1Content,
      content_sha256: await sha256Text(v1Content),
      created_at: createdAt
    }, state());

    const v2Content = "# Commercial V0.2\n\nReplacement";
    const v2 = await service.supersedeWorking({
      request_id: "DOCREQ-WORKHEAD-SUPERSEDE-0001",
      project_id: "PRJ-0002",
      document_id: v1.document_id,
      expected_version_id: v1.version_id,
      new_logical_path: v2LogicalPath,
      content: v2Content,
      content_sha256: await sha256Text(v2Content),
      created_at: createdAt
    }, state());

    const oldVisible = workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", v1LogicalPath);
    const newVisible = workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", v2LogicalPath);
    const archive = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/ARCHIVES/MANAGED-DOCUMENTS/${v1.document_id}/${v1.version_id}/${v1LogicalPath}`;

    expect(v2.document_id).toBe(v1.document_id);
    expect(v2.logical_path).toBe(v2LogicalPath);
    expect(files.has(oldVisible)).toBe(false);
    expect(files.get(archive)?.content).toContain("Commercial V0.1");
    expect(files.get(newVisible)?.content).toContain(`document_id: ${v1.document_id}`);
    expect(files.get(newVisible)?.content).toContain("Commercial V0.2");

    const head = await service.status("PRJ-0002", v1.document_id);
    expect(head).toMatchObject({
      document_id: v1.document_id,
      logical_path: v2LogicalPath,
      working_version_id: v2.version_id,
      reconciliation_status: "clean"
    });
  });

  it("creates an explicit parallel fork as a distinct document without archiving the source head", async () => {
    const { runtime, files } = runtimeHarness();
    const service = new ManagedDocumentService(runtime);
    const sourceLogicalPath = "strategy/commercial.md";
    const sourceContent = "# Commercial\n\nBase";
    const source = await service.writeWorking({
      request_id: "DOCREQ-WORKHEAD-WRITE-0002",
      project_id: "PRJ-0002",
      logical_path: sourceLogicalPath,
      content: sourceContent,
      content_sha256: await sha256Text(sourceContent),
      created_at: createdAt
    }, state());

    const forkContent = "# Commercial Option B\n\nParallel";
    const fork = await service.forkWorking({
      request_id: "DOCREQ-WORKHEAD-FORK-0001",
      project_id: "PRJ-0002",
      source_document_id: source.document_id,
      expected_version_id: source.version_id,
      new_logical_path: "strategy/commercial-option-b.md",
      content: forkContent,
      content_sha256: await sha256Text(forkContent),
      created_at: createdAt
    }, state());

    expect(fork.document_id).not.toBe(source.document_id);
    expect(files.has(workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", sourceLogicalPath))).toBe(true);
    expect(files.has(workspaceManagedDocumentPath("PRJ-0002", "project-os", "working", "strategy/commercial-option-b.md"))).toBe(true);
    expect((await service.status("PRJ-0002", source.document_id))?.working_version_id).toBe(source.version_id);
  });
});
