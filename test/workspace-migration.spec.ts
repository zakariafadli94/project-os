import { describe, expect, it } from "vitest";
import { DropboxConflictError, type DropboxTransport } from "../src/dropbox/client";
import { machineEventPath, machineReceiptPath, machineTransactionPath } from "../src/dropbox/layout";
import { mirrorLegacyEvents, mirrorLegacyLedger } from "../src/migration/workspace-v2";

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

  it("mirrors legacy terminal transactions and receipts idempotently", async () => {
    const transport = new FakeTransport();
    const txId = "TXN-LEDGER-00000001";
    const txContent = '{"transaction_id":"TXN-LEDGER-00000001"}\n';
    const receiptContent = '{"transaction_id":"TXN-LEDGER-00000001","status":"committed"}\n';
    transport.files.set(`/PROJECT_OS/TRANSACTIONS/committed/${txId}.json`, txContent);
    transport.files.set(`/PROJECT_OS/RECEIPTS/${txId}.json`, receiptContent);

    const first = await mirrorLegacyLedger(transport);
    const second = await mirrorLegacyLedger(transport);

    expect(first).toEqual({ transactions: 1, receipts: 1 });
    expect(second).toEqual({ transactions: 1, receipts: 1 });
    expect(transport.files.get(machineTransactionPath("committed", txId))).toBe(txContent);
    expect(transport.files.get(machineReceiptPath(txId))).toBe(receiptContent);
  });

  it("resumes ledger migration after interruption without losing immutable history", async () => {
    const transport = new FakeTransport();
    const firstId = "TXN-LEDGER-00000002";
    const secondId = "TXN-LEDGER-00000003";
    transport.files.set(`/PROJECT_OS/TRANSACTIONS/committed/${firstId}.json`, '{"transaction_id":"TXN-LEDGER-00000002"}\n');
    transport.files.set(`/PROJECT_OS/TRANSACTIONS/committed/${secondId}.json`, '{"transaction_id":"TXN-LEDGER-00000003"}\n');
    transport.failOnceOnAdd = machineTransactionPath("committed", secondId);

    await expect(mirrorLegacyLedger(transport)).rejects.toThrow("simulated interruption");
    await mirrorLegacyLedger(transport);

    expect(transport.files.get(machineTransactionPath("committed", firstId))).toBe('{"transaction_id":"TXN-LEDGER-00000002"}\n');
    expect(transport.files.get(machineTransactionPath("committed", secondId))).toBe('{"transaction_id":"TXN-LEDGER-00000003"}\n');
  });

  it("fails closed when an existing v2 immutable ledger file has different content", async () => {
    const transport = new FakeTransport();
    const txId = "TXN-LEDGER-00000004";
    transport.files.set(`/PROJECT_OS/TRANSACTIONS/committed/${txId}.json`, '{"transaction_id":"TXN-LEDGER-00000004","value":1}\n');
    transport.files.set(machineTransactionPath("committed", txId), '{"transaction_id":"TXN-LEDGER-00000004","value":2}\n');

    await expect(mirrorLegacyLedger(transport)).rejects.toThrow("Migration conflict with different immutable content");
  });
});
