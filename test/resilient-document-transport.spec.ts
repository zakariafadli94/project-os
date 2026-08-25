import { describe, expect, it, vi } from "vitest";
import {
  DropboxApiError,
  DropboxConflictError,
  type DropboxChangePage,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../src/dropbox/client";
import { ResilientDropboxTransport } from "../src/dropbox/resilient-transport";

function baseTransport(): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined
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
  entries: [{ tag: "file", name: "a.md", path: "/PROJECT_OS/WORKING/a.md", id: "id:abc", rev: "015abc", content_hash: "a".repeat(64), size: 4 }],
  cursor: "cursor-2"
};

describe("ResilientDropboxTransport managed-document methods", () => {
  it("retries transient metadata lookups", async () => {
    const getMetadata = vi.fn<NonNullable<DropboxTransport["getMetadata"]>>()
      .mockRejectedValueOnce(new DropboxApiError("temporary", 503, "req-meta", "internal_error"))
      .mockResolvedValueOnce(metadata);
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport({ ...baseTransport(), getMetadata }, {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(transport.getMetadata("/PROJECT_OS/WORKING/a.md")).resolves.toEqual(metadata);
    expect(getMetadata).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("does not retry a conditional-write semantic conflict", async () => {
    const uploadConditional = vi.fn<NonNullable<DropboxTransport["uploadConditional"]>>()
      .mockRejectedValue(new DropboxConflictError("stale rev", "req-cas", "path/conflict/file"));
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport({ ...baseTransport(), uploadConditional }, {
      sleep, random: () => 0
    });

    await expect(transport.uploadConditional("/PROJECT_OS/WORKING/a.md", "new", "015abc"))
      .rejects.toBeInstanceOf(DropboxConflictError);
    expect(uploadConditional).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient server-side copies", async () => {
    const copy = vi.fn<NonNullable<DropboxTransport["copy"]>>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-copy", "too_many_write_operations"))
      .mockResolvedValueOnce(metadata);
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport({ ...baseTransport(), copy }, {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(transport.copy("/from.pdf", "/to/payload")).resolves.toEqual(metadata);
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("retries transient change-feed calls", async () => {
    const listFolderChanges = vi.fn<NonNullable<DropboxTransport["listFolderChanges"]>>()
      .mockRejectedValueOnce(new DropboxApiError("temporary", 503, "req-changes", "internal_error"))
      .mockResolvedValueOnce(changes);
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport({ ...baseTransport(), listFolderChanges }, {
      sleep, random: () => 0, baseDelayMs: 100
    });

    await expect(transport.listFolderChanges(undefined, "cursor-1")).resolves.toEqual(changes);
    expect(listFolderChanges).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });
});
