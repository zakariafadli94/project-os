import { vi } from "vitest";

export interface DropboxMockFault {
  endpoint: string;
  occurrence: number;
  status: number;
  error_summary: string;
  method?: string;
  path?: string;
}

export interface DropboxMockOptions {
  transientUploadFailures?: number;
  faults?: DropboxMockFault[];
}

export function installDropboxMock(options: DropboxMockOptions = {}) {
  const files = new Map<string, string>();
  const fileIds = new Map<string, string>();
  const revisions = new Map<string, number>();
  const calls: string[] = [];
  const uploadCalls: string[] = [];
  const downloadCalls: string[] = [];
  const matchedFaultOccurrences = new Map<number, number>();
  const consumedFaults = new Set<number>();
  let transientUploadFailures = options.transientUploadFailures ?? 0;
  let concurrentUploads = 0;
  let maxConcurrentUploadCount = 0;
  let nextFileId = 1;

  const ensureIdentity = (path: string): string => {
    const existing = fileIds.get(path);
    if (existing) return existing;
    const id = `id:mock-${String(nextFileId++).padStart(6, "0")}`;
    fileIds.set(path, id);
    return id;
  };

  const bumpRevision = (path: string): number => {
    const revision = (revisions.get(path) ?? 0) + 1;
    revisions.set(path, revision);
    return revision;
  };

  const metadataFor = async (path: string) => {
    const content = files.get(path);
    if (content === undefined) return null;
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      ".tag": "file",
      id: ensureIdentity(path),
      name: path.split("/").at(-1) ?? path,
      path_display: path,
      path_lower: path.toLowerCase(),
      rev: `mock-rev-${revisions.get(path) ?? 1}`,
      content_hash: contentHash,
      size: bytes.byteLength,
      server_modified: "2026-08-24T22:00:00Z"
    };
  };

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);

    const requestPaths = new Set<string>();
    let apiPath: string | undefined;
    const apiArg = request.headers.get("Dropbox-API-Arg");
    if (apiArg) {
      try {
        const parsed = JSON.parse(apiArg) as { path?: unknown };
        if (typeof parsed.path === "string") {
          apiPath = parsed.path;
          requestPaths.add(parsed.path);
        }
      } catch {
        // Ignore malformed test-only metadata; the normal endpoint handler will surface it.
      }
    }

    if (!apiArg && request.method !== "GET" && request.method !== "HEAD") {
      try {
        const rawBody = await request.clone().text();
        if (rawBody) {
          const parsed = JSON.parse(rawBody) as { path?: unknown; from_path?: unknown; to_path?: unknown };
          for (const value of [parsed.path, parsed.from_path, parsed.to_path]) {
            if (typeof value === "string") requestPaths.add(value);
          }
        }
      } catch {
        // Non-JSON payloads are valid for Dropbox content endpoints and are ignored here.
      }
    }

    if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/upload" && apiPath) {
      uploadCalls.push(apiPath);
    }
    if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/download" && apiPath) {
      downloadCalls.push(apiPath);
    }

    const faults = options.faults ?? [];
    for (let index = 0; index < faults.length; index += 1) {
      if (consumedFaults.has(index)) continue;
      const fault = faults[index];
      const matches = fault.endpoint === url.pathname
        && (fault.method === undefined || fault.method === request.method)
        && (fault.path === undefined || requestPaths.has(fault.path));
      if (!matches) continue;

      const occurrence = (matchedFaultOccurrences.get(index) ?? 0) + 1;
      matchedFaultOccurrences.set(index, occurrence);
      if (occurrence !== fault.occurrence) continue;

      consumedFaults.add(index);
      return new Response(JSON.stringify({ error_summary: fault.error_summary }), {
        status: fault.status,
        headers: { "x-dropbox-request-id": `req-fault-${index}` }
      });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
      return Response.json({ access_token: "test-access-token", expires_in: 14400 });
    }

    if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/upload") {
      concurrentUploads += 1;
      maxConcurrentUploadCount = Math.max(maxConcurrentUploadCount, concurrentUploads);
      try {
        if (transientUploadFailures > 0) {
          transientUploadFailures -= 1;
          return new Response(JSON.stringify({ error_summary: "too_many_write_operations/..." }), {
            status: 409,
            headers: { "x-dropbox-request-id": `req-transient-${transientUploadFailures}` }
          });
        }

        const arg = JSON.parse(request.headers.get("Dropbox-API-Arg") ?? "{}") as {
          path?: string;
          mode?: "add" | "overwrite" | { ".tag": "update"; update: string };
        };
        if (!arg.path) return new Response("missing path", { status: 400 });
        const content = new TextDecoder().decode(await request.arrayBuffer());
        if (arg.mode === "add" && files.has(arg.path)) {
          return new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
            status: 409,
            headers: { "x-dropbox-request-id": "req-conflict" }
          });
        }
        if (typeof arg.mode === "object" && arg.mode?.[".tag"] === "update") {
          const current = await metadataFor(arg.path);
          if (!current || current.rev !== arg.mode.update) {
            return new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
              status: 409,
              headers: { "x-dropbox-request-id": "req-update-conflict" }
            });
          }
        }
        ensureIdentity(arg.path);
        files.set(arg.path, content);
        bumpRevision(arg.path);
        return Response.json(await metadataFor(arg.path));
      } finally {
        concurrentUploads -= 1;
      }
    }

    if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/download") {
      const arg = JSON.parse(request.headers.get("Dropbox-API-Arg") ?? "{}") as { path?: string };
      if (!arg.path || !files.has(arg.path)) {
        return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
      }
      return new Response(files.get(arg.path), { status: 200 });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/get_metadata") {
      const body = JSON.parse(await request.text()) as { path?: string };
      if (!body.path || !files.has(body.path)) {
        return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
      }
      return Response.json(await metadataFor(body.path));
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/move_v2") {
      const body = JSON.parse(await request.text()) as { from_path: string; to_path: string };
      const directContent = files.get(body.from_path);
      const sourcePrefix = `${body.from_path}/`;
      const descendants = [...files.entries()].filter(([path]) => path.startsWith(sourcePrefix));

      if (directContent === undefined && descendants.length === 0) {
        return new Response(JSON.stringify({ error_summary: "from_lookup/not_found/" }), { status: 409 });
      }

      if (directContent !== undefined) {
        if (files.has(body.to_path)) {
          return new Response(JSON.stringify({ error_summary: "to/conflict/file/" }), { status: 409 });
        }
        const id = ensureIdentity(body.from_path);
        const rev = revisions.get(body.from_path) ?? 1;
        files.delete(body.from_path);
        fileIds.delete(body.from_path);
        revisions.delete(body.from_path);
        files.set(body.to_path, directContent);
        fileIds.set(body.to_path, id);
        revisions.set(body.to_path, rev);
      } else {
        const destinationPrefix = `${body.to_path}/`;
        if ([...files.keys()].some((path) => path === body.to_path || path.startsWith(destinationPrefix))) {
          return new Response(JSON.stringify({ error_summary: "to/conflict/folder/" }), { status: 409 });
        }
        for (const [path, content] of descendants) {
          const destination = `${body.to_path}${path.slice(body.from_path.length)}`;
          const id = ensureIdentity(path);
          const rev = revisions.get(path) ?? 1;
          files.delete(path);
          fileIds.delete(path);
          revisions.delete(path);
          files.set(destination, content);
          fileIds.set(destination, id);
          revisions.set(destination, rev);
        }
      }

      return Response.json({ metadata: await metadataFor(body.to_path) ?? { path_display: body.to_path } });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/copy_v2") {
      const body = JSON.parse(await request.text()) as { from_path: string; to_path: string };
      const content = files.get(body.from_path);
      if (content === undefined) {
        return new Response(JSON.stringify({ error_summary: "from_lookup/not_found/" }), { status: 409 });
      }
      if (files.has(body.to_path)) {
        return new Response(JSON.stringify({ error_summary: "to/conflict/file/" }), { status: 409 });
      }
      files.set(body.to_path, content);
      ensureIdentity(body.to_path);
      bumpRevision(body.to_path);
      return Response.json({ metadata: await metadataFor(body.to_path) });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/delete_v2") {
      const body = JSON.parse(await request.text()) as { path: string };
      const directContent = files.get(body.path);
      const prefix = `${body.path}/`;
      const descendants = [...files.keys()].filter((path) => path.startsWith(prefix));
      if (directContent === undefined && descendants.length === 0) {
        return new Response(JSON.stringify({ error_summary: "path_lookup/not_found/" }), { status: 409 });
      }
      files.delete(body.path);
      fileIds.delete(body.path);
      revisions.delete(body.path);
      for (const path of descendants) {
        files.delete(path);
        fileIds.delete(path);
        revisions.delete(path);
      }
      return Response.json({ metadata: { path_display: body.path } });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder") {
      const body = JSON.parse(await request.text()) as { path: string; recursive?: boolean };
      const prefix = `${body.path}/`;
      const entries = (await Promise.all([...files.keys()]
        .filter((path) => path.startsWith(prefix) && (body.recursive || !path.slice(prefix.length).includes("/")))
        .sort()
        .map((path) => metadataFor(path))))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return Response.json({ entries, cursor: "done", has_more: false });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder/continue") {
      return Response.json({ entries: [], cursor: "done", has_more: false });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
      return Response.json({ metadata: { ".tag": "folder" } });
    }

    throw new Error(`Unhandled outbound request in Dropbox mock: ${request.method} ${request.url}`);
  });

  return {
    files,
    calls,
    spy,
    uploadCalls,
    downloadCalls,
    maxConcurrentUploads: () => maxConcurrentUploadCount
  };
}