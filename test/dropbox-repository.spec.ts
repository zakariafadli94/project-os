import { describe, expect, it } from "vitest";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { ProjectRepository } from "../src/dropbox/repository";
import type { DomainEvent } from "../src/domain/event";
import type { Receipt } from "../src/domain/receipt";
import { emptyProjectState } from "../src/domain/transitions";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: Array<{ path: string; mode: "add" | "overwrite" }> = [];
  failOnceOn?: string;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (this.failOnceOn && path.endsWith(this.failOnceOn)) {
      this.failOnceOn = undefined;
      throw new Error("transient write failure");
    }
    if (mode === "add" && this.files.has(path)) throw new DropboxConflictError("already exists", "req-test");
    this.files.set(path, content);
    this.uploads.push({ path, mode });
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
}

function fixture() {
  const state = emptyProjectState("PRJ-0001", "Agency", "agency", "Launch agency");
  state.revision = 1;
  state.last_event_id = "EVT-000001";
  state.created_at = "2026-08-20T18:00:00.000Z";
  state.updated_at = state.created_at;
  const event: DomainEvent = {
    schema_version: "1.0",
    event_id: "EVT-000001",
    project_id: state.project_id,
    revision: 1,
    transaction_id: "TXN-01J00000000000000000000999",
    type: "project.create",
    timestamp: state.updated_at,
    payload: { name: "Agency" }
  };
  const receipt: Receipt = {
    schema_version: "1.0",
    transaction_id: event.transaction_id,
    status: "committed",
    project_id: state.project_id,
    previous_revision: 0,
    new_revision: 1,
    event_id: event.event_id,
    committed_at: state.updated_at
  };
  return { state, event, receipt };
}

describe("ProjectRepository", () => {
  it("writes immutable event first, materialized views next, and receipt last", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport);
    const { state, event, receipt } = fixture();

    await repository.writeCommit(state, event, receipt);

    expect(transport.uploads[0]).toEqual(expect.objectContaining({ mode: "add" }));
    expect(transport.uploads.some((write) => write.path.endsWith("/STATE.md") && write.mode === "overwrite")).toBe(true);
    expect(transport.uploads.at(-1)?.path).toBe(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`);
  });

  it("retries without duplicating immutable events or producing a false receipt", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport);
    const { state, event, receipt } = fixture();
    transport.failOnceOn = "/STATE.md";

    await expect(repository.writeCommit(state, event, receipt)).rejects.toThrow("transient write failure");
    expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(false);

    await repository.writeCommit(state, event, receipt);

    const eventWrites = transport.uploads.filter((write) => write.path.endsWith(`/${event.event_id}.json`));
    expect(eventWrites).toHaveLength(1);
    expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(true);
  });
});
