import { describe, expect, it, vi } from "vitest";
import { DropboxApiError, DropboxConflictError, type DropboxEntry, type DropboxTransport } from "../src/dropbox/client";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import { withProviderResilience } from "../src/persistence/provider/resilience";

function fakeTransport(overrides: Partial<DropboxTransport> = {}): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined,
    getMetadata: async () => null,
    listFolder: async () => [],
    delete: async () => undefined,
    ...overrides
  };
}

describe("Dropbox adapter with provider resilience", () => {
  it("retries transient Dropbox API failures with neutral retry diagnostics", async () => {
    const upload = vi.fn<DropboxTransport["upload"]>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-1", "too_many_write_operations"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);
    const logs: Record<string, unknown>[] = [];
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ upload })), {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      log: (entry) => logs.push(entry)
    });

    await runtime.objects.createText("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-x/ARTIFACTS/a.md", "a");

    expect(upload).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(logs[0]).toMatchObject({
      operation: "create",
      project_id: "PRJ-0003",
      provider_id: "dropbox",
      attempt: 1,
      provider_status: 409,
      provider_request_id: "req-1"
    });
  });

  it("retries transient downloads and returns the successful read", async () => {
    const download = vi.fn<DropboxTransport["download"]>()
      .mockRejectedValueOnce(new DropboxApiError("temporarily unavailable", 503, "req-read", "internal_error"))
      .mockResolvedValueOnce("canonical-state");
    const sleep = vi.fn(async () => undefined);
    const logs: Record<string, unknown>[] = [];
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ download })), {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      log: (entry) => logs.push(entry)
    });

    await expect(runtime.objects.readText("/PROJECT_OS/.project-os/projects/PRJ-0002/state.json"))
      .resolves.toBe("canonical-state");

    expect(download).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(logs[0]).toMatchObject({
      operation: "read",
      project_id: "PRJ-0002",
      provider_status: 503,
      provider_request_id: "req-read"
    });
  });

  it("retries transient folder listings and returns the successful neutral listing", async () => {
    const entries: DropboxEntry[] = [{ tag: "file", name: "TXN-TEST.json", path_display: "/PROJECT_OS/incoming/TXN-TEST.json" }];
    const listFolder = vi.fn<(path: string) => Promise<DropboxEntry[]>>()
      .mockRejectedValueOnce(new DropboxApiError("rate limited", 429, "req-list", "too_many_requests"))
      .mockResolvedValueOnce(entries);
    const sleep = vi.fn(async () => undefined);
    const logs: Record<string, unknown>[] = [];
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ listFolder })), {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      log: (entry) => logs.push(entry)
    });

    await expect(runtime.objects.listChildren("/PROJECT_OS/.project-os/transactions/incoming"))
      .resolves.toEqual([{ kind: "file", name: "TXN-TEST.json", path: "/PROJECT_OS/incoming/TXN-TEST.json" }]);

    expect(listFolder).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(logs[0]).toMatchObject({
      operation: "list",
      attempt: 1,
      provider_status: 429,
      provider_request_id: "req-list"
    });
  });

  it("does not retry semantic conflicts", async () => {
    const upload = vi.fn<DropboxTransport["upload"]>()
      .mockRejectedValue(new DropboxConflictError("conflict", "req-2", "path/conflict/file"));
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ upload })), { sleep, random: () => 0 });

    await expect(runtime.objects.createText("/PROJECT_OS/x", "x")).rejects.toBeInstanceOf(ProviderConflictError);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient cleanup deletes", async () => {
    const remove = vi.fn<NonNullable<DropboxTransport["delete"]>>()
      .mockRejectedValueOnce(new DropboxApiError("busy", 409, "req-delete", "too_many_write_operations"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ delete: remove })), {
      sleep,
      random: () => 0,
      baseDelayMs: 100
    });

    await runtime.objects.delete("/PROJECT_OS/.project-os/artifacts/incoming/ART-TEST-000001.json");

    expect(remove).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("publishes and removes a file source when move conflicts before the destination exists", async () => {
    const from = "/PROJECT_OS/.project-os/transactions/incoming/TXN-FALLBACK-000001.json";
    const to = "/PROJECT_OS/.project-os/transactions/committed/TXN-FALLBACK-000001.json";
    const content = "{\"transaction_id\":\"TXN-FALLBACK-000001\"}";
    const move = vi.fn<DropboxTransport["move"]>()
      .mockRejectedValue(new DropboxConflictError("move conflict", "req-move", "to/conflict/file"));
    const upload = vi.fn<DropboxTransport["upload"]>().mockResolvedValue(undefined);
    const remove = vi.fn<NonNullable<DropboxTransport["delete"]>>().mockResolvedValue(undefined);
    const download = vi.fn<DropboxTransport["download"]>(async (path) => path === from ? content : null);
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ upload, download, move, delete: remove })), { random: () => 0 });

    await runtime.objects.move(from, to);

    expect(upload).toHaveBeenCalledWith(to, content, "add");
    expect(remove).toHaveBeenCalledWith(from);
  });

  it("keeps a move conflict terminal when the destination contains different content", async () => {
    const from = "/PROJECT_OS/.project-os/transactions/incoming/TXN-FALLBACK-000002.json";
    const to = "/PROJECT_OS/.project-os/transactions/committed/TXN-FALLBACK-000002.json";
    const conflict = new DropboxConflictError("move conflict", "req-move", "to/conflict/file");
    const move = vi.fn<DropboxTransport["move"]>().mockRejectedValue(conflict);
    const upload = vi.fn<DropboxTransport["upload"]>().mockResolvedValue(undefined);
    const remove = vi.fn<NonNullable<DropboxTransport["delete"]>>().mockResolvedValue(undefined);
    const download = vi.fn<DropboxTransport["download"]>(async (path) => path === from ? "source" : "different");
    const runtime = withProviderResilience(createDropboxPersistence(fakeTransport({ upload, download, move, delete: remove })), { random: () => 0 });

    await expect(runtime.objects.move(from, to)).rejects.toBeInstanceOf(ProviderConflictError);
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
