import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";

function client(): DropboxClient {
  return new DropboxClient({
    appKey: "key",
    appSecret: "secret",
    refreshToken: "refresh"
  });
}

describe("DropboxClient runtime request diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("identifies a runtime failure on the first outbound request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Too many subrequests by single Worker invocation.")
    );

    await expect(client().download("/PROJECT_OS/.project-os/projects/PRJ-0003/state.json"))
      .rejects.toThrow(
        "Dropbox HTTP oauth2/token request #1 failed: Too many subrequests by single Worker invocation."
      );
  });

  it("identifies the endpoint, path, and request index after token refresh", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
      .mockRejectedValueOnce(new Error("Too many subrequests by single Worker invocation."));

    await expect(client().download("/PROJECT_OS/.project-os/projects/PRJ-0003/state.json"))
      .rejects.toThrow(
        "Dropbox HTTP files/download request #2 for /PROJECT_OS/.project-os/projects/PRJ-0003/state.json failed: Too many subrequests by single Worker invocation."
      );
  });
});
