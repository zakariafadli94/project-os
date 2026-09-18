import { expect, it } from "vitest";
import type { Receipt } from "../src/domain/receipt";
import type { Transaction } from "../src/domain/transaction";
import { MAX_RETRYABLE_INBOX_ATTEMPTS, processTransactionInbox } from "../src/inbox/processor";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import { AdmissionError } from "../src/admission/mutation-context";

class FakeObjects implements ObjectPersistence {
  files = new Map<string, string>();

  async readText(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async createText(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new ProviderConflictError("exists");
    this.files.set(path, content);
  }
  async upsertText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async getMetadata(path: string): Promise<ProviderObjectMetadata | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, size: content.length };
  }
  async listChildren(path: string): Promise<ProviderEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ kind: "file", name: candidate.slice(prefix.length), path: candidate }));
  }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new ProviderConflictError("missing source");
    if (this.files.has(to)) throw new ProviderConflictError("destination exists");
    this.files.delete(from);
    this.files.set(to, content);
  }
  async delete(path: string): Promise<void> { this.files.delete(path); }
}

function tx(id: string, baseRevision: number, createdAt: string): Transaction {
  return {
    schema_version: "1.0",
    transaction_id: id,
    project_id: "PRJ-0002",
    base_revision: baseRevision,
    operation: "task.start",
    created_at: createdAt,
    payload: { task_id: "TASK-IMPPERSIST001" }
  };
}

it("orders and archives transaction inbox entries through ObjectPersistence", async () => {
  const objects = new FakeObjects();
  const root = "/PROJECT_OS/.project-os/transactions/incoming";
  const newer = tx("TXN-INBOX-NEUTRAL-0002", 2, "2026-08-27T16:00:00+01:00");
  const older = tx("TXN-INBOX-NEUTRAL-0001", 1, "2026-08-27T16:01:00+01:00");
  objects.files.set(`${root}/${newer.transaction_id}.json`, JSON.stringify(newer));
  objects.files.set(`${root}/${older.transaction_id}.json`, JSON.stringify(older));
  const executed: string[] = [];

  const summary = await processTransactionInbox(objects, "v2", async (transaction) => {
    executed.push(transaction.transaction_id);
    const receipt: Receipt = {
      schema_version: "1.0",
      transaction_id: transaction.transaction_id,
      status: "committed",
      project_id: transaction.project_id,
      previous_revision: transaction.base_revision,
      new_revision: transaction.base_revision + 1,
      event_id: `EVT-${String(transaction.base_revision + 1).padStart(6, "0")}`,
      committed_at: transaction.created_at
    };
    return receipt;
  });

  expect(executed).toEqual([older.transaction_id, newer.transaction_id]);
  expect(summary).toEqual({ scanned: 2, processed: 2, failed: 0 });
  expect(objects.files.has(`${root}/${older.transaction_id}.json`)).toBe(false);
  expect(objects.files.has(`/PROJECT_OS/.project-os/transactions/committed/${older.transaction_id}.json`)).toBe(true);
  expect(objects.files.has(`/PROJECT_OS/.project-os/transactions/committed/${newer.transaction_id}.json`)).toBe(true);
});

it("preserves exact replay cleanup when committed terminal bytes already match", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-REPLAY-0001", 4, "2026-08-27T16:05:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const committed = `/PROJECT_OS/.project-os/transactions/committed/${transaction.transaction_id}.json`;
  const raw = JSON.stringify(transaction);
  objects.files.set(incoming, raw);
  objects.files.set(committed, raw);

  const summary = await processTransactionInbox(objects, "v2", async () => ({
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: 4,
    new_revision: 5,
    event_id: "EVT-000005",
    committed_at: transaction.created_at
  }));

  expect(summary).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.get(committed)).toBe(raw);
});

it("persists a retryable diagnostic when transaction execution throws", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-FAILURE-0001", 7, "2026-09-01T11:06:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const failure = `/PROJECT_OS/.project-os/transactions/failures/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));

  const summary = await processTransactionInbox(objects, "v2", async () => {
    throw new Error("ProjectGuard returned 500: canonical write failed");
  });

  expect(summary).toEqual({ scanned: 1, processed: 0, failed: 1 });
  expect(objects.files.has(incoming)).toBe(true);
  const diagnostic = JSON.parse(objects.files.get(failure) ?? "null") as Record<string, unknown>;
  expect(diagnostic).toMatchObject({
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    project_id: transaction.project_id,
    status: "retryable_failure",
    attempt_count: 1,
    message: "ProjectGuard returned 500: canonical write failed"
  });
  expect(typeof diagnostic.first_failed_at).toBe("string");
  expect(typeof diagnostic.last_failed_at).toBe("string");
});

it("terminally rejects an inbox transaction whose admission context cannot be refreshed", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-ADMISSION-0001", 7, "2026-09-01T11:06:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const rejected = `/PROJECT_OS/.project-os/transactions/rejected/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));

  const summary = await processTransactionInbox(objects, "v2", async () => {
    throw new AdmissionError("mutation_context_missing", 428);
  });

  expect(summary).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(objects.files.has(incoming)).toBe(false);
  expect(JSON.parse(objects.files.get(rejected) ?? "null")).toMatchObject({
    status: "rejected",
    code: "mutation_context_missing",
    transaction_id: transaction.transaction_id
  });
  expect(objects.files.has(rejected.replace(/\.json$/, ".source.json"))).toBe(true);
});

it("keeps one inbox envelope pending when convergence capacity is temporarily exhausted", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-CAPACITY-0001", 7, "2026-09-01T11:06:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const failure = `/PROJECT_OS/.project-os/transactions/failures/${transaction.transaction_id}.json`;
  const rejected = `/PROJECT_OS/.project-os/transactions/rejected/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));

  const summary = await processTransactionInbox(objects, "v2", async () => {
    throw new AdmissionError("convergence_capacity_exceeded", 503);
  });

  expect(summary).toEqual({ scanned: 1, processed: 0, failed: 1 });
  expect(objects.files.get(incoming)).toBe(JSON.stringify(transaction));
  expect(objects.files.has(rejected)).toBe(false);
  expect(JSON.parse(objects.files.get(failure) ?? "null")).toMatchObject({
    transaction_id: transaction.transaction_id,
    project_id: transaction.project_id,
    status: "retryable_failure",
    attempt_count: 1,
    message: "convergence_capacity_exceeded"
  });
});

it("quarantines a capacity-blocked inbox envelope after the bounded retry limit", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-CAPACITY-0002", 8, "2026-09-01T11:07:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const failure = `/PROJECT_OS/.project-os/transactions/failures/${transaction.transaction_id}.json`;
  const quarantine = `/PROJECT_OS/.project-os/transactions/quarantine/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));

  for (let attempt = 1; attempt <= MAX_RETRYABLE_INBOX_ATTEMPTS; attempt += 1) {
    await processTransactionInbox(objects, "v2", async () => {
      throw new AdmissionError("convergence_capacity_exceeded", 503);
    });
  }

  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.get(quarantine)).toBe(JSON.stringify(transaction));
  expect(JSON.parse(objects.files.get(failure) ?? "null")).toMatchObject({
    status: "retryable_failure",
    attempt_count: MAX_RETRYABLE_INBOX_ATTEMPTS,
    message: "convergence_capacity_exceeded"
  });

  let executions = 0;
  const afterBound = await processTransactionInbox(objects, "v2", async () => {
    executions += 1;
    throw new Error("must not execute");
  });
  expect(afterBound).toEqual({ scanned: 0, processed: 0, failed: 0 });
  expect(executions).toBe(0);
});

it("does not hammer Project Guard again while a capacity retry backoff is active", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-CAPACITY-0003", 8, "2026-09-01T11:08:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const failure = `/PROJECT_OS/.project-os/transactions/failures/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));
  objects.files.set(failure, JSON.stringify({
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    project_id: transaction.project_id,
    status: "retryable_failure",
    attempt_count: 1,
    first_failed_at: new Date().toISOString(),
    last_failed_at: new Date().toISOString(),
    message: "convergence_capacity_exceeded"
  }));
  let executions = 0;

  const summary = await processTransactionInbox(objects, "v2", async () => {
    executions += 1;
    throw new Error("must not execute during backoff");
  }, { respectRetryBackoff: true });

  expect(summary).toEqual({ scanned: 1, processed: 0, failed: 0 });
  expect(executions).toBe(0);
  expect(objects.files.has(incoming)).toBe(true);
});

it("increments retry diagnostics and removes them after successful recovery", async () => {
  const objects = new FakeObjects();
  const transaction = tx("TXN-INBOX-NEUTRAL-RECOVERY-0001", 9, "2026-09-01T11:10:00+01:00");
  const incoming = `/PROJECT_OS/.project-os/transactions/incoming/${transaction.transaction_id}.json`;
  const failure = `/PROJECT_OS/.project-os/transactions/failures/${transaction.transaction_id}.json`;
  objects.files.set(incoming, JSON.stringify(transaction));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const summary = await processTransactionInbox(objects, "v2", async () => {
      throw new Error(`ProjectGuard returned 500 attempt ${attempt}`);
    });
    expect(summary).toEqual({ scanned: 1, processed: 0, failed: 1 });
  }

  const retried = JSON.parse(objects.files.get(failure) ?? "null") as Record<string, unknown>;
  expect(retried).toMatchObject({
    transaction_id: transaction.transaction_id,
    attempt_count: 2,
    message: "ProjectGuard returned 500 attempt 2"
  });
  const firstFailedAt = retried.first_failed_at;

  const recovered = await processTransactionInbox(objects, "v2", async () => ({
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: 9,
    new_revision: 10,
    event_id: "EVT-000010",
    committed_at: transaction.created_at
  }));

  expect(recovered).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.has(failure)).toBe(false);
  expect(typeof firstFailedAt).toBe("string");
});
