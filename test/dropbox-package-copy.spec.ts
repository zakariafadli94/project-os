import { afterEach, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
const bytes = new Uint8Array([0, 255, 42, 128]);
afterEach(() => vi.restoreAllMocks());
it.each(["exact", "wrong_object", "wrong_revision", "wrong_hash", "oversized"])("copies only the admitted immutable revision: %s", async (scenario) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const uploads: Uint8Array[] = [], reads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.pathname === "/oauth2/token") return Response.json({ access_token: "test", expires_in: 3600 });
    if (url.pathname === "/2/files/get_metadata") {
      const { path }: any = await request.json(); reads.push(path);
      return Response.json({ ".tag": "file", id: path === "/dest" ? "id:dest" : scenario === "wrong_object" ? "id:wrong" : "id:source", rev: path === "/dest" ? "newrev" : scenario === "wrong_revision" ? "wrongrev" : "a123", path_display: path === "/dest" ? "/dest" : "/renamed-source", content_hash: "a".repeat(64), size: scenario === "oversized" ? 11 * 1024 * 1024 : bytes.length });
    }
    if (url.pathname === "/2/files/download") { const arg = JSON.parse(request.headers.get("Dropbox-API-Arg")!); reads.push(arg.path); return new Response(bytes); }
    if (url.pathname === "/2/files/upload") {
      expect(JSON.parse(request.headers.get("Dropbox-API-Arg")!)).toMatchObject({ path: "/dest", mode: "add", autorename: false, strict_conflict: true });
      uploads.push(new Uint8Array(await request.arrayBuffer()));
      return Response.json({ ".tag": "file", id: "id:created", rev: "createdrev", path_display: "/dest", content_hash: "b".repeat(64), size: bytes.length });
    }
    throw new Error(`Optimistic/unknown endpoint: ${url.pathname}`);
  });
  const runtime = createDropboxPersistence(new DropboxClient({ appKey: "test", appSecret: "test", refreshToken: "test" }));
  const action = () => (runtime.serverSideCopy as any).copyObjectVersion("/old-source-path", "/dest", { objectId: "id:source", revisionToken: "a123", contentSha256: scenario === "wrong_hash" ? "0".repeat(64) : sha });
  if (scenario === "exact") {
    expect(await action()).toMatchObject({ source: { objectId: "id:source", revisionToken: "a123", contentSha256: sha }, destination: { objectId: "id:created", revisionToken: "createdrev" } });
    expect(uploads).toEqual([bytes]); expect(reads.slice(0, 2)).toEqual(["rev:a123", "rev:a123"]);
  } else { await expect(action()).rejects.toThrow(); expect(uploads).toEqual([]); }
});
