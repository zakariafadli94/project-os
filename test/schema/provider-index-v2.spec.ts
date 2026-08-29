import { describe, expect, it } from "vitest";
import { documentIdForProviderFile } from "../../src/domain/managed-document";
import {
  DocumentLedgerRepository,
  providerFileBindingV2Path,
  referenceFingerprintV2Path
} from "../../src/documents/repository";
import {
  machineDocumentHeadPath,
  machineDocumentRoot,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath
} from "../../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import type { ProviderEntry, ProviderObjectMetadata } from "../../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../../src/persistence/provider/errors";

const projectId = "PRJ-9008";
const documentId = "DOC-0123456789ABCDEF01234567";
const otherDocumentId = "DOC-89ABCDEF0123456701234567";
const versionId = "VER-REQ-AAAAAAAAAAAAAAAAAAAAAAAA";
const secondVersionId = "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB";
const providerFileId = "id:AbC_123-x";
const providerHash = "a".repeat(64);
const providerPath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9008/REFERENCES/UNCLASSIFIED/reference.md";
const expectedBindingKey = "218101917a7ce5a6687925f932169d8b10e2314f759164109caae5659300e721";
const expectedFingerprintKey = "92dd2571d90fd32d979bd013913c81f2d76ca538517ce73b2e94fda3cd005d5d";

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
    serverSideCopy: { copyObject: async (_from, to) => ({ path: to, size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  return { runtime, files };
}

function rawV1Head(activeVersionId = versionId, rev = "rev-a") {
  return {
    schema_version: "1.0",
    project_id: projectId,
    document_id: documentId,
    kind: "reference",
    logical_path: "reference.md",
    collection_path: "UNCLASSIFIED",
    reference_version_id: activeVersionId,
    provider: {
      reference: {
        path: providerPath,
        file_id: providerFileId,
        rev,
        content_hash: providerHash,
        size: 10
      }
    },
    reconciliation_status: "clean"
  };
}

function rawV1Version(activeVersionId = versionId, rev = "rev-a") {
  return {
    schema_version: "1.0",
    project_id: projectId,
    document_id: documentId,
    version_id: activeVersionId,
    kind: "reference",
    stage: "reference",
    logical_path: "reference.md",
    source: "input_ingest",
    created_at: "2026-08-28T17:00:00+01:00",
    immutable_payload_path: machineDocumentTextPayloadPath(projectId, providerHash),
    content_sha256: providerHash,
    provider_content_hash: providerHash,
    provider_file_id: providerFileId,
    provider_rev: rev,
    provider_path: providerPath,
    size: 10
  };
}

async function legacyBindingPath(): Promise<string> {
  return `${machineDocumentRoot(projectId)}/provider-file-bindings/${await documentIdForProviderFile(projectId, providerFileId)}.json`;
}

function legacyFingerprintPath(): string {
  return `${machineDocumentRoot(projectId)}/reference-fingerprints/${providerHash}.json`;
}

describe("provider-qualified document indexes", () => {
  it("uses exact full SHA-256 V2 namespaces", async () => {
    expect(await providerFileBindingV2Path(projectId, "dropbox", providerFileId)).toBe(
      `${machineDocumentRoot(projectId)}/provider-file-bindings/v2/${expectedBindingKey}.json`
    );
    expect(await referenceFingerprintV2Path(projectId, "dropbox", "dropbox-content-hash", providerHash)).toBe(
      `${machineDocumentRoot(projectId)}/reference-fingerprints/v2/${expectedFingerprintKey}.json`
    );
  });

  it("writes provider-qualified V2 bindings and fingerprints only at provider_v2", async () => {
    const { runtime, files } = memoryRuntime();
    files.set(machineDocumentHeadPath(projectId, documentId), `${JSON.stringify(rawV1Head(), null, 2)}\n`);
    files.set(machineDocumentVersionPath(projectId, documentId, versionId), `${JSON.stringify(rawV1Version(), null, 2)}\n`);
    const repository = new DocumentLedgerRepository(runtime, "provider_v2");

    await repository.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: projectId,
      provider_file_id: providerFileId,
      document_id: documentId
    });
    await repository.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: projectId,
      provider_content_hash: providerHash,
      document_id: documentId,
      version_id: versionId
    });

    const bindingPath = await providerFileBindingV2Path(projectId, "dropbox", providerFileId);
    const fingerprintPath = await referenceFingerprintV2Path(projectId, "dropbox", "dropbox-content-hash", providerHash);
    expect(JSON.parse(files.get(bindingPath) ?? "null")).toEqual({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      object_id: providerFileId,
      document_id: documentId
    });
    expect(JSON.parse(files.get(fingerprintPath) ?? "null")).toEqual({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
      document_id: documentId,
      version_id: versionId
    });
    expect(files.has(await legacyBindingPath())).toBe(false);
    expect(files.has(legacyFingerprintPath())).toBe(false);
  });

  it("prefers V2, falls back to V1 without write-on-read, and accepts matching duplicate evidence", async () => {
    const { runtime, files } = memoryRuntime();
    const repository = new DocumentLedgerRepository(runtime, "provider_v2");
    const legacyBinding = {
      schema_version: "1.0",
      project_id: projectId,
      provider_file_id: providerFileId,
      document_id: documentId
    };
    const legacyFingerprint = {
      schema_version: "1.0",
      project_id: projectId,
      provider_content_hash: providerHash,
      document_id: documentId,
      version_id: versionId
    };
    files.set(await legacyBindingPath(), `${JSON.stringify(legacyBinding, null, 2)}\n`);
    files.set(legacyFingerprintPath(), `${JSON.stringify(legacyFingerprint, null, 2)}\n`);
    const before = new Map(files);

    expect(await repository.readProviderFileBinding(projectId, providerFileId)).toEqual(legacyBinding);
    expect(await repository.readReferenceFingerprint(projectId, providerHash)).toEqual(legacyFingerprint);
    expect(files).toEqual(before);
    expect(files.has(await providerFileBindingV2Path(projectId, "dropbox", providerFileId))).toBe(false);
    expect(files.has(await referenceFingerprintV2Path(projectId, "dropbox", "dropbox-content-hash", providerHash))).toBe(false);

    files.set(await providerFileBindingV2Path(projectId, "dropbox", providerFileId), `${JSON.stringify({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      object_id: providerFileId,
      document_id: documentId
    }, null, 2)}\n`);
    files.set(await referenceFingerprintV2Path(projectId, "dropbox", "dropbox-content-hash", providerHash), `${JSON.stringify({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
      document_id: documentId,
      version_id: versionId
    }, null, 2)}\n`);
    expect(await repository.readProviderFileBinding(projectId, providerFileId)).toEqual(legacyBinding);
    expect(await repository.readReferenceFingerprint(projectId, providerHash)).toEqual(legacyFingerprint);
  });

  it("rebinds stale V1 reference evidence into synchronized V1/V2 current indexes", async () => {
    const { runtime, files } = memoryRuntime();
    const legacyRepository = new DocumentLedgerRepository(runtime, "v1_only");
    const v2Repository = new DocumentLedgerRepository(runtime, "provider_v2");

    files.set(machineDocumentHeadPath(projectId, documentId), `${JSON.stringify(rawV1Head(), null, 2)}\n`);
    files.set(machineDocumentVersionPath(projectId, documentId, versionId), `${JSON.stringify(rawV1Version(), null, 2)}\n`);
    await legacyRepository.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: projectId,
      provider_content_hash: providerHash,
      document_id: documentId,
      version_id: versionId
    });

    files.set(machineDocumentVersionPath(projectId, documentId, secondVersionId), `${JSON.stringify(rawV1Version(secondVersionId, "rev-b"), null, 2)}\n`);
    files.set(machineDocumentHeadPath(projectId, documentId), `${JSON.stringify(rawV1Head(secondVersionId, "rev-b"), null, 2)}\n`);

    await v2Repository.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: projectId,
      provider_content_hash: providerHash,
      document_id: documentId,
      version_id: secondVersionId
    });

    const expectedCurrent = {
      schema_version: "1.0",
      project_id: projectId,
      provider_content_hash: providerHash,
      document_id: documentId,
      version_id: secondVersionId
    };
    expect(JSON.parse(files.get(legacyFingerprintPath()) ?? "null")).toEqual(expectedCurrent);
    expect(JSON.parse(files.get(await referenceFingerprintV2Path(projectId, "dropbox", "dropbox-content-hash", providerHash)) ?? "null")).toEqual({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
      document_id: documentId,
      version_id: secondVersionId
    });
    expect(await v2Repository.readReferenceFingerprint(projectId, providerHash)).toEqual(expectedCurrent);
  });

  it("fails closed when V1 and V2 evidence contradict each other", async () => {
    const { runtime, files } = memoryRuntime();
    const repository = new DocumentLedgerRepository(runtime, "provider_v2");
    files.set(await legacyBindingPath(), `${JSON.stringify({
      schema_version: "1.0",
      project_id: projectId,
      provider_file_id: providerFileId,
      document_id: documentId
    }, null, 2)}\n`);
    files.set(await providerFileBindingV2Path(projectId, "dropbox", providerFileId), `${JSON.stringify({
      schema_version: "2.0",
      project_id: projectId,
      provider_id: "dropbox",
      object_id: providerFileId,
      document_id: otherDocumentId
    }, null, 2)}\n`);

    await expect(repository.readProviderFileBinding(projectId, providerFileId)).rejects.toThrow(/contradict|conflict/i);
  });
});
