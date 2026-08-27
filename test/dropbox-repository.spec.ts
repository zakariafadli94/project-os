import { describe, expect, it } from "vitest";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { machineReceiptPath } from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import type { DomainEvent } from "../src/domain/event";
import type { Receipt } from "../src/domain/receipt";
import { emptyProjectState } from "../src/domain/transitions";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

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
    const repository = new ProjectRepository(persistenceFromDropbox(transport));
    const { state, event, receipt } = fixture();

    await repository.writeCommit(state, event, receipt);

    expect(transport.uploads[0]).toEqual(expect.objectContaining({ mode: "add" }));
    expect(transport.uploads.some((write) => write.path.endsWith("/STATE.md") && write.mode === "overwrite")).toBe(true);
    expect(transport.uploads.at(-1)?.path).toBe(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`);
  });

  it("retries without duplicating immutable events or producing a false receipt", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport));
    const { state, event, receipt } = fixture();
    transport.failOnceOn = "/STATE.md";

    await expect(repository.writeCommit(state, event, receipt)).rejects.toThrow("transient write failure");
    expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(false);

    await repository.writeCommit(state, event, receipt);

    const eventWrites = transport.uploads.filter((write) => write.path.endsWith(`/${event.event_id}.json`));
    expect(eventWrites).toHaveLength(1);
    expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(true);
  });

  it("shadow mode keeps legacy canonical writes and also materializes V2 workspace", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "shadow");
    const { state, event, receipt } = fixture();
    state.research["RES-CODE0001"] = {
      research_id: "RES-CODE0001",
      title: "Code map",
      body: "Responsibilities",
      created_at: state.updated_at
    };

    await repository.writeCommit(state, event, receipt);

    expect(transport.files.has("/PROJECT_OS/PROJECTS/PRJ-0001-agency/STATE.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/STATE.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/BRIEF.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/DISCOVERY.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/ROADMAP.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/RESEARCH/RES-CODE0001.md")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/.project-os/projects/PRJ-0001/state.json")).toBe(true);
    expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(true);
    expect(transport.uploads.at(-1)?.path).toBe(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`);
  });

  it("shadow registry writes legacy and V2 machine registry plus human portfolio dashboard", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "shadow");
    const registry = { schema_version: "1.0", projects: [] };

    await repository.writeRegistry(registry, "# Project Index\n");

    expect(transport.files.has("/PROJECT_OS/SYSTEM/PROJECT_REGISTRY.json")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/.project-os/registry/PROJECT_REGISTRY.json")).toBe(true);
    expect(transport.files.has("/PROJECT_OS/WORKSPACE/PORTFOLIO/DASHBOARD.md")).toBe(true);
  });

  it("v2 writes its receipt last and never publishes it after an earlier view failure", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const { state, event, receipt } = fixture();
    transport.failOnceOn = "/STATE.md";

    await expect(repository.writeCommit(state, event, receipt)).rejects.toThrow("transient write failure");
    expect(transport.files.has(machineReceiptPath(receipt.transaction_id))).toBe(false);

    await repository.writeCommit(state, event, receipt);
    expect(transport.uploads.at(-1)?.path).toBe(machineReceiptPath(receipt.transaction_id));
  });

  it("never publishes a committed receipt when a human brief write fails", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(persistenceFromDropbox(transport), "v2");
    const { state, event, receipt } = fixture();
    transport.failOnceOn = "/BRIEF.md";

    await expect(repository.writeCommit(state, event, receipt)).rejects.toThrow("transient write failure");
    expect(transport.files.has(machineReceiptPath(receipt.transaction_id))).toBe(false);
  });
});
