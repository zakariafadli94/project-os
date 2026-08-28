import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";

describe("DropboxClient efficient parent folder recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates only the immediate missing parent when its ancestors already exist", async () => {
    const target = "/PROJECT_OS/.project-os/projects/PRJ-0003/mutation-gate/resolutions/MUTCAND-AAAAAAAAAAAAAAAAAAAAAAAA/terminal.json";
    const parent = target.slice(0, target.lastIndexOf("/"));
    const knownFolders = ancestors(parent).slice(0, -1);
    const harness = installFolderRecoveryMock(knownFolders);

    await client().upload(target, "terminal", "add");

    expect(harness.createdFolders).toEqual([parent]);
    expect(harness.uploadAttempts()).toBe(2);
  });

  it("walks upward only until an existing ancestor then creates the missing suffix", async () => {
    const resolutionRoot = "/PROJECT_OS/.project-os/projects/PRJ-0003/mutation-gate/resolutions";
    const candidateRoot = `${resolutionRoot}/MUTCAND-BBBBBBBBBBBBBBBBBBBBBBBB`;
    const target = `${candidateRoot}/terminal.json`;
    const knownFolders = ancestors(resolutionRoot).slice(0, -1);
    const harness = installFolderRecoveryMock(knownFolders);

    await client().upload(target, "terminal", "add");

    expect(harness.createdFolders).toEqual([
      candidateRoot,
      resolutionRoot,
      candidateRoot
    ]);
    expect(harness.uploadAttempts()).toBe(2);
  });
});

function client(): DropboxClient {
  return new DropboxClient({
    appKey: "key",
    appSecret: "secret",
    refreshToken: "refresh"
  });
}

function installFolderRecoveryMock(initialFolders: string[]) {
  const folders = new Set(initialFolders);
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
      return Response.json({ name: "terminal.json" });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
      const body = JSON.parse(await request.text()) as { path: string };
      createdFolders.push(body.path);

      if (folders.has(body.path)) {
        return new Response(JSON.stringify({ error_summary: "path/conflict/folder/" }), {
          status: 409,
          headers: { "x-dropbox-request-id": "req-existing-folder" }
        });
      }

      const parent = body.path.slice(0, body.path.lastIndexOf("/")) || "/";
      if (parent !== "/" && !folders.has(parent)) {
        return new Response(JSON.stringify({ error_summary: "path/not_found/" }), {
          status: 409,
          headers: { "x-dropbox-request-id": "req-missing-folder-parent" }
        });
      }

      folders.add(body.path);
      return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
    }

    throw new Error(`Unhandled request: ${request.method} ${request.url}`);
  });

  return {
    createdFolders,
    uploadAttempts: () => uploadAttempts
  };
}

function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push(current);
  }
  return result;
}
