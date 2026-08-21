import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/dropbox/client";

describe("DropboxClient parent folder recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates missing parent folders and retries an upload after path/not_found", async () => {
    const createdFolders: string[] = [];
    let uploadAttempts = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }

      if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/upload") {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return new Response(JSON.stringify({ error_summary: "path/not_found/" }), {
            status: 409,
            headers: { "x-dropbox-request-id": "req-missing-parent" }
          });
        }
        return Response.json({ name: "STATE.md" });
      }

      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        const body = JSON.parse(await request.text()) as { path: string };
        createdFolders.push(body.path);
        return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
      }

      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({
      appKey: "key",
      appSecret: "secret",
      refreshToken: "refresh"
    });

    await client.upload(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/STATE.md",
      "state",
      "overwrite"
    );

    expect(uploadAttempts).toBe(2);
    expect(createdFolders).toEqual([
      "/PROJECT_OS",
      "/PROJECT_OS/WORKSPACE",
      "/PROJECT_OS/WORKSPACE/PROJECTS",
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os"
    ]);
  });

  it("creates missing destination parent folders and retries a move after to/not_found", async () => {
    const createdFolders: string[] = [];
    let moveAttempts = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }

      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/move_v2") {
        moveAttempts += 1;
        if (moveAttempts === 1) {
          return new Response(JSON.stringify({ error_summary: "to/not_found/" }), {
            status: 409,
            headers: { "x-dropbox-request-id": "req-missing-move-parent" }
          });
        }
        return Response.json({ metadata: { path_display: "/PROJECT_OS/ARCHIVE/PROJECTS/PRJ-0002-project-os" } });
      }

      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        const body = JSON.parse(await request.text()) as { path: string };
        createdFolders.push(body.path);
        return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
      }

      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({
      appKey: "key",
      appSecret: "secret",
      refreshToken: "refresh"
    });

    await client.move(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os",
      "/PROJECT_OS/ARCHIVE/PROJECTS/PRJ-0002-project-os"
    );

    expect(moveAttempts).toBe(2);
    expect(createdFolders).toEqual([
      "/PROJECT_OS",
      "/PROJECT_OS/ARCHIVE",
      "/PROJECT_OS/ARCHIVE/PROJECTS"
    ]);
  });
});
