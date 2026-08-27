import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient, DropboxConflictError, DropboxCursorResetError } from "../src/persistence/providers/dropbox/client";

const contentHash = "a".repeat(64);
const metadata = {
  ".tag": "file",
  id: "id:abc",
  name: "strategy.md",
  path_lower: "/project_os/working/strategy.md",
  path_display: "/PROJECT_OS/WORKING/strategy.md",
  client_modified: "2026-08-24T18:00:00Z",
  server_modified: "2026-08-24T18:00:01Z",
  rev: "015abc",
  size: 42,
  content_hash: contentHash
};

function client() {
  return new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
}

function mockTokenAnd(handler: (request: Request) => Promise<Response> | Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    return handler(request);
  });
}

describe("Dropbox managed-document concurrency primitives", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads file metadata without downloading content", async () => {
    mockTokenAnd(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/2/files/get_metadata");
      expect(JSON.parse(await request.text())).toEqual({ path: "/PROJECT_OS/WORKING/strategy.md" });
      return Response.json(metadata);
    });

    await expect(client().getMetadata("/PROJECT_OS/WORKING/strategy.md")).resolves.toEqual({
      id: "id:abc",
      path: "/PROJECT_OS/WORKING/strategy.md",
      rev: "015abc",
      content_hash: contentHash,
      size: 42,
      server_modified: "2026-08-24T18:00:01Z"
    });
  });

  it("performs a conditional update using the exact observed Dropbox rev", async () => {
    mockTokenAnd((request) => {
      const url = new URL(request.url);
      expect(url.hostname).toBe("content.dropboxapi.com");
      expect(url.pathname).toBe("/2/files/upload");
      const arg = JSON.parse(request.headers.get("Dropbox-API-Arg") ?? "{}") as Record<string, unknown>;
      expect(arg).toMatchObject({
        path: "/PROJECT_OS/WORKING/strategy.md",
        mode: { ".tag": "update", update: "015abc" },
        autorename: false,
        mute: true,
        strict_conflict: true
      });
      return Response.json({ ...metadata, rev: "015abd" });
    });

    const result = await client().uploadConditional(
      "/PROJECT_OS/WORKING/strategy.md",
      "new content",
      "015abc"
    );
    expect(result.rev).toBe("015abd");
  });

  it("fails closed on conditional revision mismatch", async () => {
    mockTokenAnd(() => new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
      status: 409,
      headers: { "x-dropbox-request-id": "req-cas" }
    }));

    await expect(client().uploadConditional(
      "/PROJECT_OS/WORKING/strategy.md",
      "new content",
      "015abc"
    )).rejects.toBeInstanceOf(DropboxConflictError);
  });

  it("copies an opaque provider file server-side and returns destination metadata", async () => {
    mockTokenAnd(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/2/files/copy_v2");
      expect(JSON.parse(await request.text())).toEqual({
        from_path: "/PROJECT_OS/INPUTS/report.pdf",
        to_path: "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/provider/DOC-0123456789ABCDEF01234567/VER-EXT-111111111111111111111111/payload",
        autorename: false,
        allow_shared_folder: false,
        allow_ownership_transfer: false
      });
      return Response.json({ metadata: { ...metadata, name: "payload", path_display: "/hidden/payload" } });
    });

    const result = await client().copy(
      "/PROJECT_OS/INPUTS/report.pdf",
      "/PROJECT_OS/.project-os/projects/PRJ-0002/documents/payloads/provider/DOC-0123456789ABCDEF01234567/VER-EXT-111111111111111111111111/payload"
    );
    expect(result.id).toBe("id:abc");
  });

  it("returns a recursive initial change page with provider metadata and cursor", async () => {
    mockTokenAnd(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/2/files/list_folder");
      expect(JSON.parse(await request.text())).toMatchObject({
        path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os",
        recursive: true,
        include_deleted: true
      });
      return Response.json({
        entries: [metadata, { ".tag": "deleted", name: "old.md", path_lower: "/project_os/old.md", path_display: "/PROJECT_OS/old.md" }],
        cursor: "cursor-1",
        has_more: false
      });
    });

    const page = await client().listFolderChanges("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os");
    expect(page.cursor).toBe("cursor-1");
    expect(page.entries).toEqual([
      expect.objectContaining({ tag: "file", rev: "015abc", content_hash: contentHash }),
      expect.objectContaining({ tag: "deleted", path: "/PROJECT_OS/old.md" })
    ]);
  });

  it("continues a change cursor without resupplying a root path", async () => {
    mockTokenAnd(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/2/files/list_folder/continue");
      expect(JSON.parse(await request.text())).toEqual({ cursor: "cursor-1" });
      return Response.json({ entries: [metadata], cursor: "cursor-2", has_more: false });
    });

    const page = await client().listFolderChanges(undefined, "cursor-1");
    expect(page.cursor).toBe("cursor-2");
    expect(page.entries).toHaveLength(1);
  });

  it("surfaces Dropbox cursor reset as a distinct rebuild signal", async () => {
    mockTokenAnd(() => new Response(JSON.stringify({ error_summary: "reset/" }), {
      status: 409,
      headers: { "x-dropbox-request-id": "req-reset" }
    }));

    await expect(client().listFolderChanges(undefined, "expired-cursor"))
      .rejects.toBeInstanceOf(DropboxCursorResetError);
  });
});
