import { expect, it } from "vitest";
import type { DocumentVersionRecord } from "../src/domain/managed-document";
import { machineDocumentHeadPath } from "../src/persistence/layout";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";

function runtimeWithFiles(): {
  runtime: ProjectOsPersistenceRuntime;
  files: Map<string, string>;
  forkRuntime: () => ProjectOsPersistenceRuntime;
  failNextHeadReadAfterUpsert: () => void;
  pauseNextCatalogCas: () => { entered: Promise<void>; release: () => void };
} {
  const files = new Map<string, string>();
  const revisions = new Map<string, number>();
  let failNextHeadReadAfterUpsert = false;
  let failingHeadPath: string | null = null;
  let nextCatalogGate: { entered(): void; enteredPromise: Promise<void>; wait: Promise<void>; release(): void } | null = null;
  const store = (path: string, content: string) => {
    files.set(path, content);
    revisions.set(path, (revisions.get(path) ?? 0) + 1);
  };
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "dropbox",
    objects: {
      readText: async (path) => {
        if (path === failingHeadPath) { failingHeadPath = null; throw new Error("injected_post_write_read_failure"); }
        return files.get(path) ?? null;
      },
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        store(path, content);
      },
      upsertText: async (path, content) => {
        store(path, content);
        if (failNextHeadReadAfterUpsert && path.includes("/documents/heads/")) {
          failNextHeadReadAfterUpsert = false;
          failingHeadPath = path;
        }
      },
      getMetadata: async (path) => files.has(path)
        ? { path, objectId: path, revisionToken: String(revisions.get(path)), size: files.get(path)!.length }
        : null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: {
      writeTextConditional: async (path, content, expectedRevisionToken) => {
        if (path.includes("/dirty/") && nextCatalogGate) {
          const gate = nextCatalogGate;
          nextCatalogGate = null;
          gate.entered();
          await gate.wait;
        }
        if (String(revisions.get(path)) !== expectedRevisionToken) throw new Error("conditional_write_conflict");
        store(path, content);
        return { path, objectId: path, revisionToken: String(revisions.get(path)), size: content.length };
      }
    },
    serverSideCopy: {
      copyObject: async (_from, to) => ({ path: to, size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "cursor" })
    },
    pagedListing: {
      listPage: async ({ path, cursor, limit }) => {
        const matching = [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)).sort();
        const start = cursor ? Math.max(0, matching.findIndex((candidate) => candidate > cursor)) : 0;
        const page = matching.slice(start, start + limit);
        return { entries: page.map((candidate) => ({ kind: "file" as const, path: candidate, name: candidate.slice(path.length + 1) })), cursor: start + page.length < matching.length ? page.at(-1) ?? null : null };
      }
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  return {
    runtime, files,
    forkRuntime: () => ({ ...runtime, objects: { ...runtime.objects }, conditionalWrite: { ...runtime.conditionalWrite } }) as ProjectOsPersistenceRuntime,
    failNextHeadReadAfterUpsert: () => { failNextHeadReadAfterUpsert = true; },
    pauseNextCatalogCas() {
      let enter!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { enter = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      nextCatalogGate = { entered: enter, enteredPromise, wait, release };
      return { entered: enteredPromise, release };
    }
  };
}

it("reads and writes schema-1.0 versions through neutral persistence", async () => {
  const { runtime } = runtimeWithFiles();
  const repository = new DocumentLedgerRepository(runtime);
  const record: DocumentVersionRecord = {
    schema_version: "1.0",
    project_id: "PRJ-0002",
    document_id: "DOC-0123456789ABCDEF01234567",
    version_id: "VER-REQ-111111111111111111111111",
    kind: "work_product",
    stage: "working",
    logical_path: "strategy/a.md",
    source: "project_os",
    created_at: "2026-08-26T12:45:00+01:00",
    immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    content_sha256: "a".repeat(64)
  };

  await repository.writeVersion(record);
  await expect(repository.readVersion(record.project_id, record.document_id, record.version_id))
    .resolves.toEqual(record);
});

it("recovers an in-flight navigation source write when the head upsert succeeded but its postcheck was interrupted", async () => {
  const { runtime, failNextHeadReadAfterUpsert } = runtimeWithFiles();
  const repository = new DocumentLedgerRepository(runtime);
  const projectId = "PRJ-0002";
  const documentId = "DOC-0123456789ABCDEF01234567";
  const first: DocumentVersionRecord = {
    schema_version: "1.0", project_id: projectId, document_id: documentId,
    version_id: "VER-REQ-111111111111111111111111", kind: "work_product", stage: "working",
    logical_path: "strategy/a.md", source: "project_os", created_at: "2026-08-26T12:45:00+01:00",
    immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    content_sha256: "a".repeat(64)
  };
  const second = { ...first, version_id: "VER-REQ-222222222222222222222222", created_at: "2026-08-27T12:45:00+01:00", content_sha256: "b".repeat(64) };
  await repository.writeVersion(first);
  await repository.writeVersion(second);
  const head = { schema_version: "1.0" as const, project_id: projectId, document_id: documentId, kind: "work_product" as const, logical_path: first.logical_path, working_version_id: first.version_id, reconciliation_status: "clean" as const };
  await repository.writeHead(head);
  const sources = new ZoneNavigationSources(runtime);
  await sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0);
  await sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0);

  failNextHeadReadAfterUpsert();
  await expect(repository.writeHead({ ...head, working_version_id: second.version_id })).rejects.toThrow("injected_post_write_read_failure");
  expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [`head:${documentId}`] });

  await repository.writeHead({ ...head, working_version_id: second.version_id });

  expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [] });
  expect(await runtime.objects.readText(machineDocumentHeadPath(projectId, documentId))).toContain(second.version_id);
});

it("transfers pending navigation invalidation to a later non-pointer head update", async () => {
  const { runtime, forkRuntime, pauseNextCatalogCas, files } = runtimeWithFiles();
  const olderRepository = new DocumentLedgerRepository(runtime);
  const newerRepository = new DocumentLedgerRepository(forkRuntime());
  const projectId = "PRJ-0002";
  const documentId = "DOC-0123456789ABCDEF01234567";
  const version = (version_id: string, created_at: string, hash: string): DocumentVersionRecord => ({
    schema_version: "1.0", project_id: projectId, document_id: documentId, version_id,
    kind: "work_product", stage: "working", logical_path: "strategy/a.md", source: "project_os", created_at,
    immutable_payload_path: `/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/sha256/${hash.repeat(64)}`,
    content_sha256: hash.repeat(64)
  });
  const first = version("VER-REQ-111111111111111111111111", "2026-08-26T12:45:00+01:00", "a");
  const older = version("VER-REQ-222222222222222222222222", "2026-08-27T12:45:00+01:00", "b");
  const newer = version("VER-REQ-333333333333333333333333", "2026-08-28T12:45:00+01:00", "c");
  for (const record of [first, older, newer]) await olderRepository.writeVersion(record);
  const head = { schema_version: "1.0" as const, project_id: projectId, document_id: documentId, kind: "work_product" as const, logical_path: first.logical_path, working_version_id: first.version_id, reconciliation_status: "clean" as const };
  await olderRepository.writeHead(head);
  const sources = new ZoneNavigationSources(runtime);
  await sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0);
  await sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-0001", 0);
  await sources.writeCatalogEntry({
    project_id: projectId, zone: "WORKING", resource_id: `head:${documentId}`, version: first.version_id,
    logical_path: first.logical_path, path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/strategy/a.md",
    expected: { object_id: "id:original", revision_token: "rev-original", content_sha256: first.content_sha256!, size: 1 }
  }, projectId, "WORKING", `head:${documentId}`);
  const seedTicket = await sources.beginHeadWrite(projectId, "WORKING", `head:${documentId}`);
  await sources.completeHeadWrite(seedTicket, {
    project_id: projectId, zone: "WORKING", resource_id: `head:${documentId}`, version: first.version_id,
    logical_path: first.logical_path, path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/strategy/a.md",
    expected: { object_id: "id:original", revision_token: "rev-original", content_sha256: first.content_sha256!, size: 1 }
  });

  const gate = pauseNextCatalogCas();
  const olderWrite = olderRepository.writeHead({ ...head, working_version_id: older.version_id });
  await gate.entered;
  // Same navigation pointer as A, but a different canonical head payload.
  // This must inherit the in-flight invalidation rather than skip the seam.
  await newerRepository.writeHead({ ...head, working_version_id: older.version_id, reconciliation_status: "conflict" });
  gate.release();

  await expect(olderWrite).rejects.toThrow("conditional_write_conflict");
  expect(await new DocumentLedgerRepository(forkRuntime()).readHead(projectId, documentId)).toMatchObject({ working_version_id: older.version_id, reconciliation_status: "conflict" });
  expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 3, in_flight_resource_ids: [] });
  expect(await sources.listDirtyPage(projectId, "WORKING", null, 1)).toMatchObject({ resource_ids: [`head:${documentId}`] });
  const dirtyMarker = [...files.entries()].find(([path]) => path.includes("/dirty/"));
  expect(dirtyMarker && JSON.parse(dirtyMarker[1])).toMatchObject({ resource_id: `head:${documentId}`, generation: 3 });
});
