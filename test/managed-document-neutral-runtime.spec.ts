import { expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { ManagedDocumentBootstrapper } from "../src/documents/bootstrap";
import { sha256Text } from "../src/documents/hash";
import { LegacyArtifactDocumentWriter } from "../src/documents/legacy-artifact";
import { ManagedDocumentReconciler } from "../src/documents/reconciler";
import { ManagedDocumentRequestLedger } from "../src/documents/request-ledger";
import { ManagedDocumentService } from "../src/documents/service";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";

function neutralRuntime(): {
  runtime: ProjectOsPersistenceRuntime;
  seed: (path: string, content: string, objectId?: string) => ProviderObjectMetadata;
} {
  const files = new Map<string, { content: string; objectId: string; revisionToken: string; integrityHash: string }>();
  let revision = 0;

  const metadata = (path: string): ProviderObjectMetadata | null => {
    const file = files.get(path);
    return file
      ? {
          path,
          size: file.content.length,
          objectId: file.objectId,
          revisionToken: file.revisionToken,
          integrityHash: { algorithm: "dropbox-content-hash", value: file.integrityHash }
        }
      : null;
  };

  const put = (path: string, content: string, objectId?: string): ProviderObjectMetadata => {
    revision += 1;
    files.set(path, {
      content,
      objectId: objectId ?? `id:neutral-${revision}`,
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
      upsertText: async (path, content) => {
        put(path, content, files.get(path)?.objectId);
      },
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
        if (!current || current.revisionToken !== expectedRevisionToken) {
          throw new ProviderPreconditionFailedError("stale");
        }
        return put(path, content, current.objectId);
      }
    },
    serverSideCopy: {
      copyObject: async (from, to) => {
        const source = files.get(from);
        if (!source) throw new Error(`missing ${from}`);
        if (files.has(to)) throw new ProviderConflictError("exists");
        return put(to, source.content);
      }
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

  return { runtime, seed: put };
}

function contentHash(content: string): string {
  let acc = 0;
  for (const char of content) acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

it("writes a managed working document through the neutral runtime contract", async () => {
  const { runtime } = neutralRuntime();
  const service = new ManagedDocumentService(runtime);
  const content = "# Strategy\n\nNeutral runtime";

  const receipt = await service.writeWorking({
    request_id: "DOCREQ-NEUTRAL-000001",
    project_id: "PRJ-0002",
    logical_path: "strategy/commercial.md",
    content,
    content_sha256: await sha256Text(content),
    created_at: "2026-08-27T15:40:00+01:00"
  }, emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs"));

  expect(receipt).toMatchObject({
    request_id: "DOCREQ-NEUTRAL-000001",
    project_id: "PRJ-0002",
    stage: "working",
    status: "committed"
  });
});

it("bootstraps an existing managed file through neutral metadata and copy capabilities", async () => {
  const { runtime, seed } = neutralRuntime();
  const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
  const visiblePath = workspaceManagedDocumentPath(
    state.project_id,
    state.slug,
    "working",
    "strategy/existing.md"
  );
  const metadata = seed(visiblePath, "# Existing managed file", "id:neutral-existing");
  const bootstrapper = new ManagedDocumentBootstrapper(runtime);

  const result = await bootstrapper.bootstrapExistingManagedPath(
    state,
    visiblePath,
    metadata,
    "working"
  );

  expect(result.adopted).toBe(true);
  expect(result.version).toMatchObject({
    schema_version: "1.0",
    stage: "working",
    provider_file_id: "id:neutral-existing",
    provider_rev: metadata.revisionToken,
    provider_content_hash: metadata.integrityHash?.value
  });
});

it("reconciles neutral provider change entries without Dropbox runtime types", async () => {
  const { runtime } = neutralRuntime();
  const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Managed docs");
  const path = workspaceManagedDocumentPath(
    state.project_id,
    state.slug,
    "working",
    "strategy/missing.md"
  );
  const change: ProviderChangeEntry = {
    kind: "deleted",
    name: "missing.md",
    path
  };

  const summary = await new ManagedDocumentReconciler(runtime).reconcileChanges(state, [change]);

  expect(summary).toMatchObject({ scanned: 1, ignored: 1, restored: 0, conflicts: 0 });
});

it("persists managed request intents and receipts through object persistence", async () => {
  const { runtime } = neutralRuntime();
  const ledger = new ManagedDocumentRequestLedger(runtime.objects);
  const requestId = "DOCREQ-NEUTRAL-LEDGER-0001";
  const requestJson = JSON.stringify({ request_id: requestId, project_id: "PRJ-0002" });
  const receiptJson = JSON.stringify({ status: "committed" });

  const intent = await ledger.ensureIntent("PRJ-0002", requestId, requestJson);
  expect(await ledger.readIntent("PRJ-0002", requestId)).toEqual(intent);

  const receipt = await ledger.writeReceipt("PRJ-0002", requestId, requestJson, receiptJson);
  expect(await ledger.readReceipt("PRJ-0002", requestId)).toEqual(receipt);
});

it("constructs the legacy managed artifact writer from the neutral runtime", () => {
  const { runtime } = neutralRuntime();
  expect(new LegacyArtifactDocumentWriter(runtime)).toBeInstanceOf(LegacyArtifactDocumentWriter);
});
