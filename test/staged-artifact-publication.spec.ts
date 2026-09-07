import { describe, expect, it } from "vitest";
import {
  matchesStagedArtifactRollbackBackup,
  stagedArtifactRollbackEvidence,
  StagedArtifactPublisher
} from "../src/artifacts/staged-publication";
import type { StagedArtifactWriteRequest } from "../src/domain/artifact-write";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError } from "../src/persistence/provider/errors";

const sourcePath = "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf";
const destinationPath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-example/ARTIFACTS/example.pdf";
const sourceMetadata: ProviderObjectMetadata = {
  path: sourcePath,
  size: 123,
  objectId: "id:source",
  revisionToken: "rev-1",
  integrityHash: { algorithm: "dropbox-content-hash", value: "provider-hash" }
};
const request: StagedArtifactWriteRequest = {
  request_id: "ART-BINARY-000001",
  project_id: "PRJ-0003",
  relative_path: "example.pdf",
  content_sha256: "a".repeat(64),
  source: {
    kind: "staged_provider_object",
    path: sourcePath,
    object_id: "id:source",
    revision_token: "rev-1",
    size: 123,
    integrity: { algorithm: "dropbox-content-hash", value: "provider-hash" }
  },
  mode: "create"
};

function fixture(source: ProviderObjectMetadata | null = sourceMetadata) {
  const metadata = new Map<string, ProviderObjectMetadata>();
  const textFiles = new Map<string, string>();
  if (source) metadata.set(sourcePath, source);
  let textReads = 0;
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "dropbox",
    objects: {
      readText: async (path) => { textReads += 1; return textFiles.get(path) ?? null; },
      createText: async (path, content) => {
        if (textFiles.has(path)) throw new ProviderConflictError("exists");
        textFiles.set(path, content);
      },
      upsertText: async (path, content) => { textFiles.set(path, content); },
      getMetadata: async (path) => metadata.get(path) ?? null,
      listChildren: async () => [],
      move: async (from, to) => {
        const sourceEntry = metadata.has(from)
          ? [from, metadata.get(from)!] as const
          : [...metadata.entries()].find(([, value]) => value.objectId === from);
        const current = sourceEntry?.[1];
        if (!current) throw new Error("missing source");
        metadata.delete(sourceEntry![0]);
        metadata.set(to, { ...current, path: to });
      },
      delete: async (path) => { metadata.delete(path); },
      deleteIfUnchanged: async (path, expected) => {
        const current = metadata.get(path);
        if (!current) return "missing";
        if (current.objectId !== expected.objectId || current.revisionToken !== expected.revisionToken) return "changed";
        metadata.delete(path);
        return "deleted";
      }
    },
    conditionalWrite: { writeTextConditional: async () => { throw new Error("unused"); } },
    serverSideCopy: {
      copyObject: async (from, to) => {
        const current = metadata.get(from);
        if (!current) throw new Error("missing source");
        const copied = { ...current, path: to, objectId: "id:destination", revisionToken: "rev-destination" };
        metadata.set(to, copied);
        return copied;
      }
    },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  return { runtime, metadata, textFiles, get textReads() { return textReads; } };
}

describe("staged artifact publication", () => {
  it("copies opaque provider bytes and verifies final integrity without reading text", async () => {
    const f = fixture();
    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath })).resolves.toBe("written");
    expect(f.metadata.get(destinationPath)).toMatchObject({
      size: 123,
      integrityHash: { algorithm: "dropbox-content-hash", value: "provider-hash" }
    });
    expect(f.textReads).toBe(0);
  });

  it.each([
    ["missing", null],
    ["path", { ...sourceMetadata, path: `${sourcePath}.other` }],
    ["object id", { ...sourceMetadata, objectId: "id:different" }],
    ["revision", { ...sourceMetadata, revisionToken: "rev-different" }],
    ["size", { ...sourceMetadata, size: 124 }],
    ["algorithm", { ...sourceMetadata, integrityHash: { algorithm: "sha256", value: "provider-hash" } }],
    ["integrity", { ...sourceMetadata, integrityHash: { algorithm: "dropbox-content-hash", value: "different" } }]
  ])("rejects a %s source mismatch before publication", async (_label, source) => {
    const f = fixture(source as ProviderObjectMetadata | null);
    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath })).rejects.toThrow();
    expect(f.metadata.has(destinationPath)).toBe(false);
  });

  it("is idempotent when the destination already has the staged bytes", async () => {
    const f = fixture();
    f.metadata.set(destinationPath, { ...sourceMetadata, path: destinationPath, objectId: "id:dest", revisionToken: "rev-dest" });
    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath })).resolves.toBe("idempotent");
  });

  it("does not accept matching destination bytes without the claimed staging source", async () => {
    const f = fixture(null);
    f.metadata.set(destinationPath, { ...sourceMetadata, path: destinationPath, objectId: "id:dest", revisionToken: "rev-dest" });
    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath })).rejects.toThrow(/source does not exist/i);
  });

  it("keeps a different create destination as a conflict", async () => {
    const f = fixture();
    f.metadata.set(destinationPath, {
      ...sourceMetadata,
      path: destinationPath,
      integrityHash: { algorithm: "dropbox-content-hash", value: "different" }
    });
    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath })).rejects.toThrow(/conflict/i);
  });

  it("archives a different destination before a replace copy", async () => {
    const f = fixture();
    const archivePath = `${destinationPath}.archive`;
    f.metadata.set(destinationPath, {
      ...sourceMetadata,
      path: destinationPath,
      objectId: "id:old",
      integrityHash: { algorithm: "dropbox-content-hash", value: "old" }
    });
    await expect(new StagedArtifactPublisher(f.runtime).publish(
      { ...request, mode: "replace" },
      { path: destinationPath, archive_path: archivePath }
    )).resolves.toBe("written");
    const archived = [...f.metadata.entries()].find(([path]) => path.startsWith(`${destinationPath}.previous-`));
    expect(archived?.[1].integrityHash?.value).toBe("old");
    expect(f.metadata.get(destinationPath)?.integrityHash?.value).toBe("provider-hash");
  });

  it("restores the old destination when a replace copy fails without an archive route", async () => {
    const f = fixture();
    f.metadata.set(destinationPath, {
      ...sourceMetadata,
      path: destinationPath,
      objectId: "id:old",
      integrityHash: { algorithm: "dropbox-content-hash", value: "old" }
    });
    const copy = f.runtime.serverSideCopy.copyObject.bind(f.runtime.serverSideCopy);
    f.runtime.serverSideCopy.copyObject = async (from, to) => {
      if (from === sourcePath && to === destinationPath) throw new Error("injected publication failure");
      return copy(from, to);
    };

    await expect(new StagedArtifactPublisher(f.runtime).publish(
      { ...request, mode: "replace" },
      { path: destinationPath }
    )).rejects.toThrow(/injected publication failure/);
    expect(f.metadata.get(destinationPath)?.integrityHash?.value).toBe("old");
    expect(f.metadata.get(destinationPath)?.objectId).toBe("id:destination");
  });

  it("removes an unverified create result when the source changes during path-based copy", async () => {
    const f = fixture();
    const copy = f.runtime.serverSideCopy.copyObject.bind(f.runtime.serverSideCopy);
    f.runtime.serverSideCopy.copyObject = async (from, to) => {
      if (from === sourcePath && to === destinationPath) {
        f.metadata.set(sourcePath, {
          ...sourceMetadata,
          revisionToken: "rev-raced",
          integrityHash: { algorithm: "dropbox-content-hash", value: "raced" }
        });
      }
      return copy(from, to);
    };

    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath }))
      .rejects.toThrow(/source mismatch/i);
    expect(f.metadata.has(destinationPath)).toBe(false);
    expect(f.metadata.has(sourcePath)).toBe(true);
  });

  it("restores an archived destination when replacement publication fails", async () => {
    const f = fixture();
    f.metadata.set(destinationPath, {
      ...sourceMetadata,
      path: destinationPath,
      objectId: "id:old",
      integrityHash: { algorithm: "dropbox-content-hash", value: "old" }
    });
    const copy = f.runtime.serverSideCopy.copyObject.bind(f.runtime.serverSideCopy);
    f.runtime.serverSideCopy.copyObject = async (from, to) => {
      if (from === sourcePath && to === destinationPath) throw new Error("injected publication failure");
      return copy(from, to);
    };

    await expect(new StagedArtifactPublisher(f.runtime).publish(
      { ...request, mode: "replace" },
      { path: destinationPath, archive_path: `${destinationPath}.archive` }
    )).rejects.toThrow(/injected publication failure/);
    expect(f.metadata.get(destinationPath)?.integrityHash?.value).toBe("old");
    expect(f.metadata.get(destinationPath)?.objectId).toBe("id:destination");
    expect([...f.metadata.keys()].some((path) => path.startsWith(`${destinationPath}.previous-`))).toBe(true);

    f.runtime.serverSideCopy.copyObject = copy;
    await expect(new StagedArtifactPublisher(f.runtime).publish(
      { ...request, mode: "replace" },
      { path: destinationPath, archive_path: `${destinationPath}.archive` }
    )).resolves.toBe("written");
    expect(f.metadata.get(destinationPath)?.integrityHash?.value).toBe("provider-hash");
  });

  it("keeps the destination after an ambiguous archive copy", async () => {
    const f = fixture();
    f.metadata.set(destinationPath, {
      ...sourceMetadata,
      path: destinationPath,
      objectId: "id:old",
      integrityHash: { algorithm: "dropbox-content-hash", value: "old" }
    });
    const copy = f.runtime.serverSideCopy.copyObject.bind(f.runtime.serverSideCopy);
    f.runtime.serverSideCopy.copyObject = async (from, to) => {
      const result = await copy(from, to);
      if (from === destinationPath) throw new Error("ambiguous archive copy");
      return result;
    };

    await expect(new StagedArtifactPublisher(f.runtime).publish(
      { ...request, mode: "replace" },
      { path: destinationPath, archive_path: `${destinationPath}.archive` }
    )).rejects.toThrow(/ambiguous archive copy/);
    expect(f.metadata.get(destinationPath)?.integrityHash?.value).toBe("old");
    expect(f.metadata.get(destinationPath)?.objectId).toBe("id:old");
  });

  it("preserves a concurrently changed destination when conditional cleanup loses the race", async () => {
    const f = fixture();
    const copy = f.runtime.serverSideCopy.copyObject.bind(f.runtime.serverSideCopy);
    f.runtime.serverSideCopy.copyObject = async (from, to) => {
      const result = await copy(from, to);
      if (from === sourcePath && to === destinationPath) {
        f.metadata.set(sourcePath, { ...sourceMetadata, revisionToken: "rev-raced" });
      }
      return result;
    };
    const conditionalDelete = f.runtime.objects.deleteIfUnchanged!;
    f.runtime.objects.deleteIfUnchanged = async (path, expected) => {
      if (path === destinationPath) {
        f.metadata.set(destinationPath, {
          ...sourceMetadata,
          path: destinationPath,
          objectId: "id:external",
          revisionToken: "rev-external",
          integrityHash: { algorithm: "dropbox-content-hash", value: "external" }
        });
        return "changed";
      }
      return conditionalDelete(path, expected);
    };

    await expect(new StagedArtifactPublisher(f.runtime).publish(request, { path: destinationPath }))
      .rejects.toThrow(/changed provider object/i);
    expect(f.metadata.get(destinationPath)?.objectId).toBe("id:external");
  });

  it("rejects replacement backup cleanup evidence after any provider observation changes", () => {
    const backup: ProviderObjectMetadata = {
      path: "/PROJECT_OS/.project-os/artifacts/replacements/ART-BINARY-000001/previous",
      size: 123,
      objectId: "id:backup",
      revisionToken: "rev-backup",
      integrityHash: { algorithm: "dropbox-content-hash", value: "old-provider-hash" }
    };
    const evidence = stagedArtifactRollbackEvidence(request, destinationPath, backup, "dropbox");
    expect(matchesStagedArtifactRollbackBackup(evidence, backup)).toBe(true);
    expect(matchesStagedArtifactRollbackBackup(evidence, { ...backup, objectId: "id:external" })).toBe(false);
    expect(matchesStagedArtifactRollbackBackup(evidence, { ...backup, revisionToken: "rev-external" })).toBe(false);
    expect(matchesStagedArtifactRollbackBackup(evidence, {
      ...backup,
      integrityHash: { algorithm: "dropbox-content-hash", value: "external-hash" }
    })).toBe(false);
  });
});

describe("review binary verification", () => {
  async function reviewFixture(bytes = new TextEncoder().encode("%PDF-1.7\nexample\n%%EOF")) {
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
    const blockHash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = await digest(bytes);
    const integrity = { algorithm: "dropbox-content-hash", value: await digest(blockHash) };
    const f = fixture({ ...sourceMetadata, size: bytes.length, integrityHash: integrity });
    const candidate = {
      ...request, operation: "REVIEW_CANDIDATE" as const, base_revision: 149,
      media_type: "application/pdf" as const, content_sha256: hash,
      source: { ...request.source, provider_id: "dropbox", size: bytes.length, integrity }
    };
    Object.assign(f.runtime.objects, { readBytes: async () => bytes });
    return { ...f, candidate, bytes };
  }
  it("reads bounded bytes before copying a review candidate", async () => {
    const f = await reviewFixture();
    let read = false;
    Object.assign(f.runtime.objects, { readBytes: async (_path: string, maxBytes: number) => { read = true; expect(maxBytes).toBe(f.bytes.length); return f.bytes; } });
    await new StagedArtifactPublisher(f.runtime).publish(f.candidate, { path: destinationPath });
    expect(read).toBe(true);
  });
  it.each(["sha", "type", "provider", "size", "integrity", "capability"])("rejects review %s mismatch before copy", async kind => {
    const f = await reviewFixture();
    if (kind === "sha") f.candidate.content_sha256 = "c".repeat(64);
    if (kind === "type") Object.assign(f.candidate, { media_type: "image/png" });
    if (kind === "provider") f.candidate.source.provider_id = "other";
    if (kind === "size") Object.assign(f.runtime.objects, { readBytes: async () => new Uint8Array(1000) });
    if (kind === "integrity") {
      f.candidate.source.integrity.value = "d".repeat(64);
      f.metadata.set(sourcePath, { ...f.metadata.get(sourcePath)!, integrityHash: f.candidate.source.integrity });
    }
    if (kind === "capability") delete (f.runtime.objects as unknown as { readBytes?: unknown }).readBytes;
    await expect(new StagedArtifactPublisher(f.runtime).publish(f.candidate, { path: destinationPath })).rejects.toThrow();
    expect(f.metadata.has(destinationPath)).toBe(false);
  });
});

it("keeps transient binary verification failures retryable", async () => {
  const { ProviderOperationError } = await import("../src/persistence/provider/errors");
  const f = fixture();
  const error = new ProviderOperationError("temporary", true);
  Object.assign(f.runtime.objects, {readBytes: async () => {throw error;}});
  await expect(new StagedArtifactPublisher(f.runtime).publish({...request, operation:"REVIEW_CANDIDATE",base_revision:149,media_type:"application/pdf",source:{...request.source,provider_id:"dropbox"}}, {path:destinationPath})).rejects.toBe(error);
});
it("freezes the verified provider observation and rejects a later same-byte identity replacement", async () => {
  const { ReviewCandidateJournal } = await import("../src/artifacts/review-journal");
  const f = fixture();
  const candidate = {...request,mode:"create" as const,operation:"REVIEW_CANDIDATE" as const,base_revision:149,media_type:"application/pdf" as const,source:{...request.source,provider_id:"dropbox"}};
  const first = {...sourceMetadata,path:destinationPath,objectId:"id:first",revisionToken:"rev-first"};
  f.metadata.set(destinationPath,first);
  const journal = new ReviewCandidateJournal(f.runtime);
  await journal.recordObservation(candidate,first);
  f.metadata.set(destinationPath,{...first,objectId:"id:external",revisionToken:"rev-external"});
  await expect(journal.observation(candidate)).rejects.toThrow(/changed/);
});
it("rechecks authorization immediately before copy after the byte read", async () => {
  const f = fixture();
  await expect(new StagedArtifactPublisher(f.runtime).publish(request,{path:destinationPath},undefined,()=>{throw new Error("expired capability");})).rejects.toThrow(/expired/);
  expect(f.metadata.has(destinationPath)).toBe(false);
});
it("retains a verified copy when journaling succeeds but its response is lost", async () => {
  const f = fixture();
  const observations: ProviderObjectMetadata[] = [];
  let copies = 0;
  const copy = f.runtime.serverSideCopy.copyObject;
  f.runtime.serverSideCopy.copyObject = async (from,to) => { copies++; return copy(from,to); };
  await expect(new StagedArtifactPublisher(f.runtime).publish(request,{path:destinationPath},async metadata => {
    observations.push(metadata);
    throw new Error("journal response lost");
  })).rejects.toThrow(/response lost/);
  expect(f.metadata.get(destinationPath)).toEqual(observations[0]);
  await expect(new StagedArtifactPublisher(f.runtime).publish(request,{path:destinationPath},async metadata => {
    expect(metadata).toEqual(observations[0]);
  })).resolves.toBe("idempotent");
  expect(copies).toBe(1);
});
