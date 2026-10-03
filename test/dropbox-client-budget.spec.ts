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
});
