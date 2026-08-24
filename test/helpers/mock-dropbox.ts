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
  const calls: string[] = [];
  const uploadCalls: string[] = [];
  const downloadCalls: string[] = [];
  const matchedFaultOccurrences = new Map<number, number>();
  const consumedFaults = new Set<number>();
  let transientUploadFailures = options.transientUploadFailures ?? 0;
  let concurrentUploads = 0;
  let maxConcurrentUploadCount = 0;

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

        const arg = JSON.parse(request.headers.get("Dropbox-API-Arg") ?? "{}") as { path?: string; mode?: "add" | "overwrite" };
        if (!arg.path) return new Response("missing path", { status: 400 });
        const content = new TextDecoder().decode(await request.arrayBuffer());
        if (arg.mode === "add" && files.has(arg.path)) {
          return new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
            status: 409,
            headers: { "x-dropbox-request-id": "req-conflict" }
          });
        }
        files.set(arg.path, content);
        return Response.json({ name: arg.path.split("/").at(-1), path_display: arg.path });
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
        files.delete(body.from_path);
        files.set(body.to_path, directContent);
      } else {
        const destinationPrefix = `${body.to_path}/`;
        if ([...files.keys()].some((path) => path === body.to_path || path.startsWith(destinationPrefix))) {
          return new Response(JSON.stringify({ error_summary: "to/conflict/folder/" }), { status: 409 });
        }
        for (const [path, content] of descendants) {
          files.delete(path);
          files.set(`${body.to_path}${path.slice(body.from_path.length)}`, content);
        }
      }

      return Response.json({ metadata: { path_display: body.to_path } });
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
      for (const path of descendants) files.delete(path);
      return Response.json({ metadata: { path_display: body.path } });
    }

    if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/list_folder") {
      const body = JSON.parse(await request.text()) as { path: string };
      const prefix = `${body.path}/`;
      const entries = [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .sort()
        .map((path) => ({ ".tag": "file", name: path.slice(prefix.length), path_display: path, path_lower: path.toLowerCase() }));
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
