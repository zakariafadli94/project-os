import { expect, it } from "vitest";
import type { DropboxTransport } from "../src/persistence/providers/dropbox/client";
import {
  DropboxApiError,
  DropboxConflictError,
  DropboxCursorResetError
} from "../src/persistence/providers/dropbox/client";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import {
  ProviderCursorResetError,
  ProviderOperationError,
  ProviderPreconditionFailedError
} from "../src/persistence/provider/errors";

const metadata = {
  id: "id:ABC_123",
  path: "/PROJECT_OS/x.txt",
  rev: "015abc",
  content_hash: "a".repeat(64),
  size: 42,
  server_modified: "2026-08-26T10:00:00Z"
};

function rawTransport(overrides: Partial<DropboxTransport> = {}): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined,
    getMetadata: async () => metadata,
    uploadConditional: async () => metadata,
    copy: async () => metadata,
    listFolder: async () => [],
    listFolderChanges: async () => ({ entries: [], cursor: "cursor" }),
    delete: async () => undefined,
    ...overrides
  };
}

it("maps Dropbox metadata into provider-neutral evidence", async () => {
  const runtime = createDropboxPersistence(rawTransport());
  await expect(runtime.objects.getMetadata(metadata.path)).resolves.toEqual({
    path: metadata.path,
    size: 42,
    modifiedAt: "2026-08-26T10:00:00Z",
    objectId: "id:ABC_123",
    revisionToken: "015abc",
    integrityHash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) }
  });
});

it("preserves create-only versus overwrite-upsert modes", async () => {
  const calls: Array<{ path: string; content: string; mode: "add" | "overwrite" }> = [];
  const runtime = createDropboxPersistence(rawTransport({
    upload: async (path, content, mode) => { calls.push({ path, content, mode }); }
  }));

  await runtime.objects.createText("/PROJECT_OS/create.txt", "new");
  await runtime.objects.upsertText("/PROJECT_OS/upsert.txt", "replacement");

  expect(calls).toEqual([
    { path: "/PROJECT_OS/create.txt", content: "new", mode: "add" },
    { path: "/PROJECT_OS/upsert.txt", content: "replacement", mode: "overwrite" }
  ]);
});

it("maps conditional-write conflicts to neutral precondition failures", async () => {
  const runtime = createDropboxPersistence(rawTransport({
    uploadConditional: async () => { throw new DropboxConflictError("race", "req-1"); }
  }));

  await expect(runtime.conditionalWrite!.writeTextConditional("/x", "new", "rev-old"))
    .rejects.toBeInstanceOf(ProviderPreconditionFailedError);
});

it("keeps provider-side copy as an explicit capability", async () => {
  const calls: Array<[string, string]> = [];
  const runtime = createDropboxPersistence(rawTransport({
    copy: async (from, to) => {
      calls.push([from, to]);
      return { ...metadata, path: to };
    }
  }));

  await expect(runtime.serverSideCopy!.copyObject("/from.bin", "/to.bin")).resolves.toMatchObject({
    path: "/to.bin",
    objectId: "id:ABC_123",
    revisionToken: "015abc"
  });
  expect(calls).toEqual([["/from.bin", "/to.bin"]]);
});

it("maps incremental changes and embedded file metadata", async () => {
  const runtime = createDropboxPersistence(rawTransport({
    listFolderChanges: async () => ({
      cursor: "next-cursor",
      entries: [
        {
          tag: "file",
          name: "x.txt",
          path: "/PROJECT_OS/x.txt",
          id: "id:ABC_123",
          rev: "015abc",
          content_hash: "a".repeat(64),
          size: 42,
          server_modified: "2026-08-26T10:00:00Z"
        },
        { tag: "deleted", name: "gone.txt", path: "/PROJECT_OS/gone.txt" }
      ]
    })
  }));

  await expect(runtime.changeFeed!.listChanges({ cursor: "old-cursor" })).resolves.toEqual({
    cursor: "next-cursor",
    entries: [
      {
        kind: "file",
        name: "x.txt",
        path: "/PROJECT_OS/x.txt",
        metadata: {
          path: "/PROJECT_OS/x.txt",
          size: 42,
          modifiedAt: "2026-08-26T10:00:00Z",
          objectId: "id:ABC_123",
          revisionToken: "015abc",
          integrityHash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) }
        }
      },
      { kind: "deleted", name: "gone.txt", path: "/PROJECT_OS/gone.txt" }
    ]
  });
});

it("maps cursor reset to the neutral cursor-reset condition", async () => {
  const runtime = createDropboxPersistence(rawTransport({
    listFolderChanges: async () => { throw new DropboxCursorResetError("reset", "req-2"); }
  }));

  await expect(runtime.changeFeed!.listChanges({ cursor: "old" }))
    .rejects.toBeInstanceOf(ProviderCursorResetError);
});

it("maps transient Dropbox API failures to retryable neutral failures", async () => {
  const runtime = createDropboxPersistence(rawTransport({
    download: async () => { throw new DropboxApiError("rate limited", 429, "req-3", "too many requests"); }
  }));

  try {
    await runtime.objects.readText("/x");
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderOperationError);
    expect((error as ProviderOperationError).retryable).toBe(true);
    expect((error as ProviderOperationError).diagnostics).toMatchObject({
      providerId: "dropbox",
      status: 429,
      requestId: "req-3"
    });
  }
});

it("maps terminal Dropbox API failures to non-retryable neutral failures", async () => {
  const runtime = createDropboxPersistence(rawTransport({
    download: async () => { throw new DropboxApiError("bad request", 400, "req-4", "bad request"); }
  }));

  try {
    await runtime.objects.readText("/x");
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderOperationError);
    expect((error as ProviderOperationError).retryable).toBe(false);
  }
});
