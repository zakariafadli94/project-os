import { describe, expect, it } from "vitest";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import type { DropboxTransport } from "../src/persistence/providers/dropbox/client";

function explodingTransport(): DropboxTransport {
  const explode = async (): Promise<never> => {
    throw new Error("Too many subrequests by single Worker invocation.");
  };
  return {
    upload: explode,
    download: explode,
    move: explode,
    delete: explode,
    listFolder: explode,
    getMetadata: explode
  };
}

describe("Dropbox adapter runtime error context", () => {
  it("preserves operation and path when a raw runtime error escapes Dropbox fetch", async () => {
    const runtime = createDropboxPersistence(explodingTransport());

    await expect(runtime.objects.readText("/PROJECT_OS/.project-os/projects/PRJ-0003/state.json"))
      .rejects.toThrow(
        "Dropbox read failed for /PROJECT_OS/.project-os/projects/PRJ-0003/state.json: Too many subrequests by single Worker invocation."
      );
  });
});
