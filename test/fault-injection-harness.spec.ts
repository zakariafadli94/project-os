import { afterEach, describe, expect, it, vi } from "vitest";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

async function upload(path: string, content: string): Promise<Response> {
  return fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite" })
    },
    body: content
  });
}

async function remove(path: string): Promise<Response> {
  return fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path })
  });
}

describe("deterministic Dropbox fault injection", () => {
  it("fails exactly the configured endpoint occurrence and then resumes normal behavior", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        occurrence: 2,
        status: 503,
        error_summary: "injected/write_failure"
      }]
    });

    expect((await upload("/a.txt", "a")).status).toBe(200);

    const failed = await upload("/b.txt", "b");
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error_summary: "injected/write_failure" });

    expect((await upload("/c.txt", "c")).status).toBe(200);
    expect(mock.files.get("/a.txt")).toBe("a");
    expect(mock.files.has("/b.txt")).toBe(false);
    expect(mock.files.get("/c.txt")).toBe("c");
  });

  it("can scope a failpoint to one Dropbox upload path without disturbing earlier writes", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/upload",
        path: "/target.txt",
        occurrence: 1,
        status: 500,
        error_summary: "injected/target_failure"
      }]
    });

    expect((await upload("/other.txt", "other")).status).toBe(200);

    const failed = await upload("/target.txt", "target");
    expect(failed.status).toBe(500);
    expect(mock.files.get("/other.txt")).toBe("other");
    expect(mock.files.has("/target.txt")).toBe(false);
  });

  it("can scope a failpoint to a Dropbox path carried in a JSON request body", async () => {
    const mock = installDropboxMock({
      faults: [{
        endpoint: "/2/files/delete_v2",
        path: "/target.txt",
        occurrence: 1,
        status: 500,
        error_summary: "injected/delete_failure"
      }]
    });

    expect((await upload("/target.txt", "target")).status).toBe(200);
    const failed = await remove("/target.txt");

    expect(failed.status).toBe(500);
    expect(mock.files.get("/target.txt")).toBe("target");
  });
});
