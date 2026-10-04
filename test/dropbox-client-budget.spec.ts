import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { installDropboxMock } from "./helpers/mock-dropbox";
import type { Env } from "../src/env";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DropboxClient bounded request scope", () => {
  it("opts only document slices into one transport attempt while preserving other scoped defaults", async () => {
    const attempts = async (singleAttempt: boolean) => {
      let metadataCalls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/oauth2/token") return Response.json({ access_token: "test-access-token", expires_in: 14_400 });
        metadataCalls += 1;
        return Response.json({ error_summary: "server_error" }, { status: 500 });
      });
      const scope = { deadlineMs: Date.now() + 60_000, signal: new AbortController().signal, beforeHttp: () => undefined };
      const runtime = createProductionPersistence({
        DROPBOX_APP_KEY: "test-key", DROPBOX_APP_SECRET: "test-secret", DROPBOX_REFRESH_TOKEN: "test-refresh"
      } as unknown as Env, "PRJ-0001", scope, singleAttempt ? { singleAttempt: true } : {});
      await expect(runtime.objects.getMetadata("/retry-test")).rejects.toBeDefined();
      vi.restoreAllMocks();
      return metadataCalls;
    };

    await expect(attempts(false)).resolves.toBeGreaterThan(1);
    await expect(attempts(true)).resolves.toBe(1);
  }, 15_000);

  it("charges the token refresh and metadata request to the same slice", async () => {
    installDropboxMock();
    let calls = 0;
    const client = new DropboxClient(
      { appKey: "key", appSecret: "secret", refreshToken: "refresh" },
      {
        requestScope: {
          deadlineMs: Date.now() + 1_000,
          signal: new AbortController().signal,
          beforeHttp: () => { calls += 1; }
        }
      }
    );

    await expect(client.getMetadata("/missing.txt")).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it("reads an exact Dropbox file or folder kind and treats only provider not-found as absence", async () => {
    const requestedPaths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-access-token", expires_in: 14_400 });
      }
      const body = await request.json() as { path?: string };
      const path = body.path ?? "";
      requestedPaths.push(path);
      if (path === "/missing-target") {
        return Response.json({ error_summary: "path/not_found/" }, { status: 409 });
      }
      if (path === "/folder-target") {
        return Response.json({ ".tag": "folder", id: "id:folder", name: "folder-target",
          path_display: path, path_lower: path.toLowerCase() });
      }
      return Response.json({ ".tag": "file", id: "id:file", name: "file-target",
        path_display: path,
        path_lower: path.toLowerCase(), rev: "rev-file", content_hash: "a".repeat(64), size: 7 });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" });
    await expect(client.getEntryKind("/file-target")).resolves.toBe("file");
    await expect(client.getEntryKind("/folder-target")).resolves.toBe("folder");
    await expect(client.getEntryKind("/missing-target")).resolves.toBeNull();
    await expect(client.getMetadata("/folder-target")).rejects.toThrow("Dropbox file metadata incomplete");
    expect(requestedPaths).toEqual(["/file-target", "/folder-target", "/missing-target", "/folder-target"]);
  });

  it("fails closed on malformed, unsupported, or mismatched metadata kinds", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-access-token", expires_in: 14_400 });
      }
      const body = await request.json() as { path?: string };
      if (body.path === "/unsupported") return Response.json({ ".tag": "deleted", id: "id:deleted", name: "unsupported",
        path_display: body.path, path_lower: body.path?.toLowerCase() });
      if (body.path === "/missing-tag") return Response.json({ id: "id:untagged", name: "missing-tag",
        path_display: body.path, path_lower: body.path?.toLowerCase() });
      if (body.path === "/wrong-path") return Response.json({ ".tag": "folder", id: "id:wrong", name: "wrong-path",
        path_display: "/elsewhere", path_lower: "/elsewhere" });
      if (body.path === "/missing-identity") return Response.json({ ".tag": "folder", name: "missing-identity", path_display: body.path });
      if (body.path === "/numeric-identity") return Response.json({ ".tag": "folder", id: 42, name: "numeric-identity", path_display: body.path });
      return Response.json({ path_display: body.path, path_lower: body.path?.toLowerCase() });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" });
    await expect(client.getEntryKind("/missing-tag")).rejects.toBeDefined();
    await expect(client.getEntryKind("/unsupported")).rejects.toBeDefined();
    await expect(client.getEntryKind("/wrong-path")).rejects.toBeDefined();
    await expect(client.getEntryKind("/missing-identity")).rejects.toBeDefined();
    await expect(client.getEntryKind("/numeric-identity")).rejects.toBeDefined();
  });

  it("preserves retryable Dropbox metadata failures for exact-kind lookup", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-access-token", expires_in: 14_400 });
      }
      if ((await request.clone().json() as { path?: string }).path === "/misleading-not-found") {
        return Response.json({ error_summary: "path/no_permission/not_found/" }, { status: 409 });
      }
      return Response.json({ error_summary: "temporarily_unavailable/" }, {
        status: 503,
        headers: { "Retry-After": "60" }
      });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" });
    await expect(client.getEntryKind("/temporary-failure"))
      .rejects.toMatchObject({ name: "DropboxApiError", status: 503, retryAfterMs: 60_000 });
    await expect(client.getEntryKind("/misleading-not-found"))
      .rejects.toMatchObject({ name: "DropboxApiError", status: 409 });
  });

  it("returns one bounded listing page instead of draining a folder", async () => {
    installDropboxMock();
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });

    await expect(client.listFolderPage("/empty", null, 10)).resolves.toEqual({ entries: [], cursor: null });
  });

  it("rejects a change page without an explicit provider completion flag", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return Promise.resolve(url.pathname === "/oauth2/token"
        ? Response.json({ access_token: "test-access-token", expires_in: 14_400 })
        : Response.json({ entries: [], cursor: "incomplete-change-page" }));
    });
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
    await expect(client.listFolderChanges("/PROJECT_OS")).rejects.toThrow("Invalid Dropbox change page");
  });

  it("aborts an in-flight provider request at the scope deadline and clears its timer", async () => {
    vi.useFakeTimers();
    let metadataRequestStarted!: () => void;
    const metadataRequest = new Promise<void>((resolve) => { metadataRequestStarted = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(Response.json({ access_token: "test-access-token", expires_in: 14_400 }));
      }
      metadataRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = new DropboxClient(
      { appKey: "key", appSecret: "secret", refreshToken: "refresh" },
      {
        requestScope: {
          deadlineMs: 10,
          now: () => 0,
          signal: new AbortController().signal,
          beforeHttp: () => undefined
        }
      }
    );

    const pending = client.getMetadata("/slow.txt");
    const rejection = expect(pending).rejects.toThrow("slice_budget_exhausted");
    await metadataRequest;
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unscoped Dropbox request so one stalled call cannot hold ProjectGuard forever", async () => {
    vi.useFakeTimers();
    let metadataRequestStarted!: () => void;
    const metadataRequest = new Promise<void>((resolve) => { metadataRequestStarted = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(Response.json({ access_token: "test-access-token", expires_in: 14_400 }));
      }
      metadataRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });

    const pending = client.getMetadata("/slow.txt");
    const rejection = expect(pending).rejects.toThrow("dropbox_request_timeout");
    await metadataRequest;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a stalled response body after Dropbox sends headers", async () => {
    vi.useFakeTimers();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(Response.json({ access_token: "test-access-token", expires_in: 14_400 }));
      }
      const stream = new ReadableStream<Uint8Array>({ start() { bodyStarted(); } });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });

    const pending = client.download("/slow-body.txt");
    const rejection = expect(pending).rejects.toThrow("dropbox_request_timeout");
    await started;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled binary stream without prebuffering it", async () => {
    vi.useFakeTimers();
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(Response.json({ access_token: "test-access-token", expires_in: 14_400 }));
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() { streamStarted(); } })));
    });
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });

    const pending = client.downloadBytes("/slow-binary.bin", 1024);
    const rejection = expect(pending).rejects.toThrow("dropbox_request_timeout");
    await started;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one cold refresh across concurrent public operations in the same scope", async () => {
    let releaseRefresh!: () => void;
    const refreshResponse = new Promise<void>(resolve => { releaseRefresh = resolve; });
    let refreshRequests = 0;
    let metadataRequests = 0;
    let budgetCalls = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(String(input));
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        refreshRequests += 1;
        await refreshResponse;
        return Response.json({ access_token: "cold-token", expires_in: 14_400 });
      }
      metadataRequests += 1;
      return Response.json({ id: `id:${metadataRequests}`, path: `/cold-${metadataRequests}.txt`, rev: "rev-1",
        content_hash: "hash", size: 1 });
    });

    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" }, {
      requestScope: {
        deadlineMs: Date.now() + 5_000,
        signal: new AbortController().signal,
        beforeHttp: () => { budgetCalls += 1; }
      }
    });

    const first = client.getMetadata("/cold-first.txt");
    const second = client.getMetadata("/cold-second.txt");
    releaseRefresh();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect({ refreshRequests, metadataRequests, budgetCalls }).toEqual({ refreshRequests: 1, metadataRequests: 2, budgetCalls: 3 });
  });

  it("shares a failed cold refresh and allows a later public operation to retry", async () => {
    let releaseRefresh!: () => void;
    const refreshResponse = new Promise<void>(resolve => { releaseRefresh = resolve; });
    let refreshRequests = 0;
    let metadataRequests = 0;
    let budgetCalls = 0;
    let refreshIsUnavailable = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(String(input));
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        refreshRequests += 1;
        await refreshResponse;
        if (refreshIsUnavailable) {
          return Response.json({ error_summary: "temporarily_unavailable" }, { status: 503 });
        }
        return Response.json({ access_token: "retried-token", expires_in: 14_400 });
      }
      metadataRequests += 1;
      return Response.json({ id: "id:retried", path: "/retry.txt", rev: "rev-1", content_hash: "hash", size: 1 });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" }, {
      requestScope: {
        deadlineMs: Date.now() + 5_000,
        signal: new AbortController().signal,
        beforeHttp: () => { budgetCalls += 1; }
      }
    });

    const failedCalls = [client.getMetadata("/first.txt"), client.getMetadata("/second.txt")];
    releaseRefresh();
    const firstResults = await Promise.allSettled(failedCalls);
    const refreshesBeforeRetry = refreshRequests;
    refreshIsUnavailable = false;
    const retried = await client.getMetadata("/retry.txt");

    expect(firstResults.every(result => result.status === "rejected")).toBe(true);
    expect(retried?.path).toBe("/retry.txt");
    expect({ refreshesBeforeRetry, refreshRequests, metadataRequests, budgetCalls }).toEqual({
      refreshesBeforeRetry: 1, refreshRequests: 2, metadataRequests: 1, budgetCalls: 3
    });
  });

  it("reuses a valid cached token but refreshes after its safety margin expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    let refreshRequests = 0;
    let metadataRequests = 0;
    let budgetCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(String(input));
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/token") {
        refreshRequests += 1;
        return Response.json({ access_token: `token-${refreshRequests}`, expires_in: 120 });
      }
      metadataRequests += 1;
      return Response.json({ id: `id:${metadataRequests}`, path: `/cache-${metadataRequests}.txt`, rev: "rev-1",
        content_hash: "hash", size: 1 });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" }, {
      requestScope: {
        deadlineMs: Date.now() + 120_000,
        signal: new AbortController().signal,
        beforeHttp: () => { budgetCalls += 1; }
      }
    });

    await client.getMetadata("/cache-first.txt");
    await client.getMetadata("/cache-second.txt");
    vi.setSystemTime(new Date("2026-10-04T12:01:01.000Z"));
    await client.getMetadata("/cache-third.txt");

    expect({ refreshRequests, metadataRequests, budgetCalls }).toEqual({ refreshRequests: 2, metadataRequests: 3, budgetCalls: 5 });
  });

  it("shares an OAuth request's scope abort and clears the shared bounded timer", async () => {
    vi.useFakeTimers();
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve; });
    const scopeController = new AbortController();
    let refreshRequests = 0;
    let metadataRequests = 0;
    let budgetCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname !== "/oauth2/token") {
        metadataRequests += 1;
        return Promise.resolve(Response.json({ id: "id:file", path: "/file.txt", rev: "rev-1", content_hash: "hash", size: 1 }));
      }
      refreshRequests += 1;
      signalRefreshStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = request.signal;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const client = new DropboxClient({ appKey: "test-key", appSecret: "test-secret", refreshToken: "test-refresh" }, {
      requestScope: {
        deadlineMs: Date.now() + 30_000,
        signal: scopeController.signal,
        beforeHttp: () => { budgetCalls += 1; }
      }
    });

    const calls = [client.getMetadata("/abort-first.txt"), client.getMetadata("/abort-second.txt")];
    await refreshStarted;
    scopeController.abort(new Error("slice cancelled"));
    const results = await Promise.allSettled(calls);

    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect({ refreshRequests, metadataRequests, budgetCalls, remainingTimers: vi.getTimerCount() }).toEqual({
      refreshRequests: 1, metadataRequests: 0, budgetCalls: 1, remainingTimers: 0
    });
  });
});
