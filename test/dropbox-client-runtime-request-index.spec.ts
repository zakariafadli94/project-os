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

  it("does not reset the outbound sequence on a later download", async () => {
    const transport = client();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response("first"))
      .mockRejectedValueOnce(new Error("Too many subrequests by single Worker invocation."));

    await expect(transport.download("/first.txt")).resolves.toBe("first");
    await expect(transport.download("/second.txt"))
      .rejects.toThrow(
        "Dropbox HTTP files/download request #3 for /second.txt failed: Too many subrequests by single Worker invocation."
      );
  });

  it("adds endpoint, path, and request index to metadata runtime failures", async () => {
    const transport = client();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
      .mockRejectedValueOnce(new Error("Too many subrequests by single Worker invocation."));

    await expect(transport.getMetadata("/PROJECT_OS/.project-os/projects/PRJ-0003/state.json"))
      .rejects.toThrow(
        "Dropbox HTTP files/get_metadata request #2 for /PROJECT_OS/.project-os/projects/PRJ-0003/state.json failed: Too many subrequests by single Worker invocation."
      );
  });

  it("resets exactly once at an explicit top-level operation boundary and names that operation", async () => {
    const transport = client();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response("warmup"))
      .mockRejectedValueOnce(new Error("Too many subrequests by single Worker invocation."));

    await expect(transport.download("/warmup.txt")).resolves.toBe("warmup");
    transport.beginRequestTrace("ProjectGuard POST /transaction");

    await expect(transport.download("/PROJECT_OS/.project-os/projects/PRJ-0003/state.json"))
      .rejects.toThrow(
        "Dropbox HTTP files/download request #1 for /PROJECT_OS/.project-os/projects/PRJ-0003/state.json during ProjectGuard POST /transaction failed: Too many subrequests by single Worker invocation."
      );
  });
});
