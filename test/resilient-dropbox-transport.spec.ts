import { describe, expect, it, vi } from "vitest";
import { DropboxApiError, DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { ResilientDropboxTransport } from "../src/dropbox/resilient-transport";

function fakeTransport(upload: DropboxTransport["upload"]): DropboxTransport {
  return {
    upload,
    download: async () => null,
    move: async () => undefined
  };
}

describe("ResilientDropboxTransport", () => {
  it("retries transient Dropbox API failures", async () => {
    const upload = vi.fn<DropboxTransport["upload"]>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-1", "too_many_write_operations"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);
    const logs: Record<string, unknown>[] = [];
    const transport = new ResilientDropboxTransport(fakeTransport(upload), {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      log: (entry) => logs.push(entry)
    });

    await transport.upload("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-x/ARTIFACTS/a.md", "a", "add");

    expect(upload).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(logs[0]).toMatchObject({ project_id: "PRJ-0003", attempt: 1, dropbox_request_id: "req-1" });
  });

  it("does not retry semantic conflicts", async () => {
    const upload = vi.fn<DropboxTransport["upload"]>()
      .mockRejectedValue(new DropboxConflictError("conflict", "req-2", "path/conflict/file"));
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport(fakeTransport(upload), { sleep, random: () => 0 });

    await expect(transport.upload("/PROJECT_OS/x", "x", "add")).rejects.toBeInstanceOf(DropboxConflictError);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient cleanup deletes", async () => {
    const remove = vi.fn<NonNullable<DropboxTransport["delete"]>>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-delete", "too_many_write_operations"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);
    const base = fakeTransport(async () => undefined);
    const transport = new ResilientDropboxTransport({ ...base, delete: remove }, {
      sleep,
      random: () => 0,
      baseDelayMs: 100
    });

    await transport.delete("/PROJECT_OS/.project-os/artifacts/incoming/ART-TEST-000001.json");

    expect(remove).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });
});
