import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DropboxClient bounded request scope", () => {
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
});
