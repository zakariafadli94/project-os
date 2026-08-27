import { describe, expect, it, vi } from "vitest";
import {
  DropboxApiError,
  DropboxConflictError,
  type DropboxChangePage,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import { ProviderPreconditionFailedError } from "../src/persistence/provider/errors";
import { withProviderResilience } from "../src/persistence/provider/resilience";

function baseTransport(): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined,
    getMetadata: async () => null,
    listFolder: async () => [],
    delete: async () => undefined
  };
}

const metadata: DropboxFileMetadata = {
  id: "id:abc",
  path: "/PROJECT_OS/WORKING/a.md",
  rev: "015abc",
  content_hash: "a".repeat(64),
  size: 4
};

const changes: DropboxChangePage = {
  entries: [{
    tag: "file",
    name: "a.md",
    path: "/PROJECT_OS/WORKING/a.md",
    id: "id:abc",
    rev: "015abc",
    content_hash: "a".repeat(64),
    size: 4
  }],
  cursor: "cursor-2"
};

describe("provider resilience for managed-document Dropbox capabilities", () => {
  it("retries transient metadata lookups", async () => {
    const getMetadata = vi.fn<NonNullable<DropboxTransport["getMetadata"]>>()
      .mockRejectedValueOnce(new DropboxApiError("temporary", 503, "req-meta", "internal_error"))
      .mockResolvedValueOnce(metadata);
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence({ ...baseTransport(), getMetadata }), {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(runtime.objects.getMetadata("/PROJECT_OS/WORKING/a.md")).resolves.toMatchObject({
      path: metadata.path,
      objectId: metadata.id,
      revisionToken: metadata.rev,
      integrityHash: { algorithm: "dropbox-content-hash", value: metadata.content_hash },
      size: metadata.size
    });
    expect(getMetadata).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("does not retry a conditional-write semantic conflict", async () => {
    const uploadConditional = vi.fn<NonNullable<DropboxTransport["uploadConditional"]>>()
      .mockRejectedValue(new DropboxConflictError("stale rev", "req-cas", "path/conflict/file"));
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence({ ...baseTransport(), uploadConditional }), {
      sleep, random: () => 0
    });

    await expect(runtime.conditionalWrite!.writeTextConditional("/PROJECT_OS/WORKING/a.md", "new", "015abc"))
      .rejects.toBeInstanceOf(ProviderPreconditionFailedError);
    expect(uploadConditional).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient server-side copies", async () => {
    const copy = vi.fn<NonNullable<DropboxTransport["copy"]>>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-copy", "too_many_write_operations"))
      .mockResolvedValueOnce(metadata);
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence({ ...baseTransport(), copy }), {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(runtime.serverSideCopy!.copyObject("/from.pdf", "/to/payload")).resolves.toMatchObject({
      objectId: metadata.id,
      revisionToken: metadata.rev,
      integrityHash: { value: metadata.content_hash }
    });
    expect(copy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("retries transient change-feed calls", async () => {
    const listFolderChanges = vi.fn<NonNullable<DropboxTransport["listFolderChanges"]>>()
      .mockRejectedValueOnce(new DropboxApiError("temporary", 503, "req-changes", "internal_error"))
      .mockResolvedValueOnce(changes);
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence({ ...baseTransport(), listFolderChanges }), {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(runtime.changeFeed!.listChanges({ cursor: "cursor-1" })).resolves.toMatchObject({
      cursor: "cursor-2",
      entries: [{
        kind: "file",
        name: "a.md",
        path: "/PROJECT_OS/WORKING/a.md",
        metadata: { objectId: "id:abc", revisionToken: "015abc", size: 4 }
      }]
    });
    expect(listFolderChanges).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });
});
