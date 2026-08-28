import { afterEach, describe, expect, it, vi } from "vitest";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import {
  DropboxClient,
  DropboxConflictError,
  type DropboxTransport
} from "../src/persistence/providers/dropbox/client";

function rawTransport(overrides: Partial<DropboxTransport> = {}): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined,
    delete: async () => undefined,
    getMetadata: async () => null,
    listFolder: async () => [],
    uploadConditional: async () => ({
      id: "id:file",
      path: "/x",
      rev: "rev",
      content_hash: "a".repeat(64),
      size: 1
    }),
    copy: async (_from, to) => ({
      id: "id:file",
      path: to,
      rev: "rev",
      content_hash: "a".repeat(64),
      size: 1
    }),
    listFolderChanges: async () => ({ entries: [], cursor: "cursor" }),
    ...overrides
  };
}

describe("directory provisioning capability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes ensureDirectory through the provider-neutral runtime", async () => {
    const calls: string[] = [];
    const runtime = createDropboxPersistence(rawTransport({
      ensureDirectory: async (path) => { calls.push(path); }
    }));

    await runtime.directoryProvisioning!.ensureDirectory(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED"
    );

    expect(calls).toEqual([
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED"
    ]);
  });

  it("creates missing directory ancestors in order and succeeds idempotently when the folder already exists", async () => {
    const created: string[] = [];
    let idempotentPass = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        const body = JSON.parse(await request.text()) as { path: string };
        created.push(body.path);
        if (idempotentPass) {
          return new Response(JSON.stringify({ error_summary: "path/conflict/folder/" }), { status: 409 });
        }
        if (body.path.endsWith("/REFERENCES/UNCLASSIFIED")) {
          return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
        }
        if (body.path.endsWith("/REFERENCES")) {
          return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
        }
        throw new Error(`Unexpected create path: ${body.path}`);
      }
      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
    const target = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED";
    await client.ensureDirectory(target);
    expect(created).toEqual([target, target.replace(/\/UNCLASSIFIED$/, ""), target]);

    created.length = 0;
    idempotentPass = true;
    await client.ensureDirectory(target);
    expect(created).toEqual([target]);
  });

  it("fails closed when a file occupies the directory path", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        return new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
          status: 409,
          headers: { "x-dropbox-request-id": "req-file-collision" }
        });
      }
      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
    await expect(client.ensureDirectory("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/INPUTS"))
      .rejects.toBeInstanceOf(DropboxConflictError);
  });
});
