import { expect, it } from "vitest";
import type { DocumentVersionRecord } from "../src/domain/managed-document";
import { machineDocumentHeadPath } from "../src/persistence/layout";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";

function runtimeWithFiles(): { runtime: ProjectOsPersistenceRuntime; files: Map<string, string>; failNextHeadReadAfterUpsert: () => void } {
  const files = new Map<string, string>();
  const revisions = new Map<string, number>();
  let failNextHeadReadAfterUpsert = false;
  let failingHeadPath: string | null = null;
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
  return { runtime, files, failNextHeadReadAfterUpsert: () => { failNextHeadReadAfterUpsert = true; } };
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
