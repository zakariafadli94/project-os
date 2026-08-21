import { describe, expect, it } from "vitest";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { machineEventPath } from "../src/dropbox/layout";
import { mirrorLegacyEvents } from "../src/migration/workspace-v2";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  failOnceOnAdd?: string;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.failOnceOnAdd === path) {
      this.failOnceOnAdd = undefined;
      throw new Error("simulated interruption");
    }
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError("already exists", "req-test");
    }
    this.files.set(path, content);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("source missing");
    this.files.delete(from);
    this.files.set(to, value);
  }

  async listFolder(path: string): Promise<Array<{ tag: "file" | "folder" | "deleted"; name: string; path_display?: string }>> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"))
      .sort()
      .map((entry) => ({ tag: "file", name: entry.slice(prefix.length), path_display: entry }));
  }
}

describe("workspace v2 migration", () => {
  it("mirrors legacy immutable events idempotently", async () => {
    const transport = new FakeTransport();
    const legacy = "/PROJECT_OS/PROJECTS/PRJ-0001-agency/.system/events/EVT-000001.json";
    const content = '{"event_id":"EVT-000001"}\n';
    transport.files.set(legacy, content);

    await mirrorLegacyEvents(transport, "PRJ-0001", "agency");
    await mirrorLegacyEvents(transport, "PRJ-0001", "agency");

    expect(transport.files.get(machineEventPath("PRJ-0001", "EVT-000001"))).toBe(content);
  });

  it("resumes after an interrupted migration without duplicating or losing events", async () => {
    const transport = new FakeTransport();
    transport.files.set(
      "/PROJECT_OS/PROJECTS/PRJ-0001-agency/.system/events/EVT-000001.json",
      '{"event_id":"EVT-000001"}\n'
    );
    transport.files.set(
      "/PROJECT_OS/PROJECTS/PRJ-0001-agency/.system/events/EVT-000002.json",
      '{"event_id":"EVT-000002"}\n'
    );
    transport.failOnceOnAdd = machineEventPath("PRJ-0001", "EVT-000002");

    await expect(mirrorLegacyEvents(transport, "PRJ-0001", "agency")).rejects.toThrow("simulated interruption");
    await mirrorLegacyEvents(transport, "PRJ-0001", "agency");

    expect(transport.files.get(machineEventPath("PRJ-0001", "EVT-000001"))).toBe('{"event_id":"EVT-000001"}\n');
    expect(transport.files.get(machineEventPath("PRJ-0001", "EVT-000002"))).toBe('{"event_id":"EVT-000002"}\n');
  });
});
