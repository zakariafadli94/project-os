import { describe, expect, it } from "vitest";
import { DocumentLedgerRepository } from "../../src/documents/repository";
import {
  machineDocumentHeadPath,
  machineDocumentRoot,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath
} from "../../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../../src/persistence/provider/errors";
import {
  encodeDocumentVersionRecord,
  encodeManagedDocumentHead,
  readDocumentVersionRecord,
  readManagedDocumentHead
} from "../../src/schema/managed-document";

const projectId = "PRJ-9007";
const documentId = "DOC-0123456789ABCDEF01234567";
const vA = "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA";
const vB = "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB";
const vC = "VER-REQ-CCCCCCCCCCCCCCCCCCCCCCCC";
const at = "2026-08-28T17:00:00+01:00";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function provider(path: string, fileId: string, rev: string, hash: string, size: number) {
  return { path, file_id: fileId, rev, content_hash: hash, size };
}

function v1Head() {
  return {
    schema_version: "1.0" as const,
    project_id: projectId,
    document_id: documentId,
    kind: "work_product" as const,
    logical_path: "strategy/plan.md",
    published_version_id: vA,
    provider: {
      published: provider("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007/DELIVERABLES/strategy/plan.md", "id:published", "rev-a", hashA, 10)
    },
    reconciliation_status: "clean" as const
  };
}

function v1Version(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0" as const,
    project_id: projectId,
    document_id: documentId,
    version_id: vA,
    kind: "work_product" as const,
    stage: "published" as const,
    logical_path: "strategy/plan.md",
    source: "project_os" as const,
    created_at: at,
    immutable_payload_path: machineDocumentTextPayloadPath(projectId, hashA),
    content_sha256: hashA,
    provider_content_hash: hashA,
    provider_file_id: "id:published",
    provider_rev: "rev-a",
    provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007/DELIVERABLES/strategy/plan.md",
    size: 10,
    request_id: "DOCREQ-SCHEMA-9007-A",
    ...overrides
  };
}

function v2Observation(path: string, objectId: string, revisionToken: string, hash: string, size: number) {
  return {
    provider_id: "dropbox",
    path,
    object_id: objectId,
    revision_token: revisionToken,
    integrity_hash: { algorithm: "dropbox-content-hash", value: hash },
    size
  };
}

function memoryRuntime(): { runtime: ProjectOsPersistenceRuntime; files: Map<string, string> } {
  const files = new Map<string, string>();
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "dropbox",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async (_path): Promise<ProviderObjectMetadata | null> => null,
      listChildren: async (path): Promise<ProviderEntry[]> => {
        const prefix = `${path}/`;
        return [...files.keys()]
          .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
          .map((candidate) => ({ kind: "file", name: candidate.slice(prefix.length), path: candidate }));
      },
      move: async (from, to) => {
        const content = files.get(from);
        if (content === undefined) throw new ProviderConflictError("missing");
        if (files.has(to)) throw new ProviderConflictError("exists");
        files.delete(from);
        files.set(to, content);
      },
      delete: async (path) => { files.delete(path); }
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
  return { runtime, files };
}

describe("managed-document family codecs", () => {
  it("upcasts a V1 head without changing lifecycle identity", () => {
    const result = readManagedDocumentHead(v1Head());
    expect(result.sourceVersion).toBe("1.0");
    expect(result.head).toMatchObject({
      project_id: projectId,
      document_id: documentId,
      kind: "work_product",
      logical_path: "strategy/plan.md",
      published_version_id: vA,
      reconciliation_status: "clean",
      provider: {
        published: {
          provider_id: "dropbox",
          object_id: "id:published",
          revision_token: "rev-a",
          integrity_hash: { algorithm: "dropbox-content-hash", value: hashA },
          size: 10
        }
      }
    });
  });

  it("reads strict V2 heads and rejects extra serialized fields", () => {
    const v2 = {
      schema_version: "2.0" as const,
      project_id: projectId,
      document_id: documentId,
      kind: "work_product" as const,
      logical_path: "strategy/plan.md",
      published_version_id: vA,
      provider: {
        published: v2Observation("/provider/published", "opaque-object", "opaque-rev", hashA, 10)
      },
      reconciliation_status: "clean" as const
    };
    expect(readManagedDocumentHead(v2).sourceVersion).toBe("2.0");
    expect(() => readManagedDocumentHead({ ...v2, unexpected: true })).toThrow();
  });

  it("upcasts flattened V1 version evidence while preserving immutable identity and request binding", () => {
    const result = readDocumentVersionRecord(v1Version());
    expect(result.sourceVersion).toBe("1.0");
    expect(result.record).toMatchObject({
      project_id: projectId,
      document_id: documentId,
      version_id: vA,
      stage: "published",
      logical_path: "strategy/plan.md",
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, hashA),
      request_id: "DOCREQ-SCHEMA-9007-A",
      provider_evidence: {
        provider_id: "dropbox",
        object_id: "id:published",
        revision_token: "rev-a",
        integrity_hash: { algorithm: "dropbox-content-hash", value: hashA }
      }
    });
  });

  it("writes provider-bearing V1 through core_v2 and V2 only through provider_v2", () => {
    const head = readManagedDocumentHead(v1Head()).head;
    const version = readDocumentVersionRecord(v1Version()).record;

    const coreHead = encodeManagedDocumentHead(head, "core_v2") as Record<string, unknown>;
    const coreVersion = encodeDocumentVersionRecord(version, "core_v2") as Record<string, unknown>;
    expect(coreHead.schema_version).toBe("1.0");
    expect(coreVersion.schema_version).toBe("1.0");
    expect(coreVersion).toHaveProperty("provider_file_id", "id:published");
    expect(coreVersion).not.toHaveProperty("provider_evidence");

    const v2Head = encodeManagedDocumentHead(head, "provider_v2") as Record<string, unknown>;
    const v2Version = encodeDocumentVersionRecord(version, "provider_v2") as Record<string, unknown>;
    expect(v2Head.schema_version).toBe("2.0");
    expect(v2Version.schema_version).toBe("2.0");
    expect(v2Version).toHaveProperty("provider_evidence.provider_id", "dropbox");
    expect(v2Version).not.toHaveProperty("provider_file_id");
    expect(v2Version).not.toHaveProperty("provider_content_hash");
  });

  it("reconstructs one deterministic head across VER-A V1 -> VER-B V1 -> VER-C V2", async () => {
    const { runtime, files } = memoryRuntime();
    const repository = new DocumentLedgerRepository(runtime, "provider_v2");
    const a = v1Version();
    const b = v1Version({
      version_id: vB,
      parent_version_id: vA,
      stage: "working",
      created_at: "2026-08-28T17:10:00+01:00",
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, hashB),
      content_sha256: hashB,
      provider_content_hash: hashB,
      provider_file_id: "id:working",
      provider_rev: "rev-b",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007/WORKING/strategy/plan.md",
      size: 11,
      request_id: "DOCREQ-SCHEMA-9007-B"
    });
    files.set(machineDocumentVersionPath(projectId, documentId, vA), `${JSON.stringify(a, null, 2)}\n`);
    files.set(machineDocumentVersionPath(projectId, documentId, vB), `${JSON.stringify(b, null, 2)}\n`);

    const semanticB = readDocumentVersionRecord(b).record;
    await repository.writeVersion({
      ...semanticB,
      schema_version: "2.0",
      version_id: vC,
      parent_version_id: vB,
      stage: "review",
      created_at: "2026-08-28T17:20:00+01:00",
      immutable_payload_path: machineDocumentTextPayloadPath(projectId, hashC),
      content_sha256: hashC,
      provider_content_hash: hashC,
      provider_file_id: "id:review",
      provider_rev: "rev-c",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007/REVIEW/strategy/plan.md",
      size: 12,
      provider_evidence: v2Observation(
        "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007/REVIEW/strategy/plan.md",
        "id:review",
        "rev-c",
        hashC,
        12
      ),
      request_id: "DOCREQ-SCHEMA-9007-C"
    });

    const serializedC = JSON.parse(files.get(machineDocumentVersionPath(projectId, documentId, vC)) ?? "null");
    expect(serializedC.schema_version).toBe("2.0");
    expect(serializedC.document_id).toBe(documentId);
    expect(serializedC.version_id).toBe(vC);
    expect(serializedC.parent_version_id).toBe(vB);
    expect(serializedC.request_id).toBe("DOCREQ-SCHEMA-9007-C");
    expect(serializedC.immutable_payload_path).toBe(machineDocumentTextPayloadPath(projectId, hashC));

    const restored = await repository.restoreHeadFromVersions(projectId, documentId);
    expect(restored).toMatchObject({
      document_id: documentId,
      published_version_id: vA,
      review_version_id: vC,
      reconciliation_status: "clean"
    });
    expect(restored?.working_version_id).toBeUndefined();

    const serializedHead = JSON.parse(files.get(machineDocumentHeadPath(projectId, documentId)) ?? "null");
    expect(serializedHead.schema_version).toBe("2.0");
    expect(serializedHead.published_version_id).toBe(vA);
    expect(serializedHead.review_version_id).toBe(vC);
    expect([...files.keys()].filter((path) => path.startsWith(`${machineDocumentRoot(projectId)}/versions/${documentId}/`))).toHaveLength(3);
  });
});
