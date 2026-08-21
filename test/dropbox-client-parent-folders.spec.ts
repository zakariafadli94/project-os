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
});
