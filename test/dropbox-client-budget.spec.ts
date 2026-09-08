import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

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
});
