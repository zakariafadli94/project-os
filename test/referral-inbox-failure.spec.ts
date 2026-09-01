import { expect, it } from "vitest";
import type { ReferralWriteReceipt, ReferralWriteRequest } from "../src/domain/referral-write";
import { MAX_RETRYABLE_INBOX_ATTEMPTS } from "../src/inbox/processor";
import { processReferralInboxEntries } from "../src/inbox/referral-processor";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError } from "../src/persistence/provider/errors";

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

function request(): ReferralWriteRequest {
  return {
    schema_version: "1.0",
    request_id: "REF-INBOX-FAILURE-0001",
    source_project_id: "PRJ-0002",
    target_project_id: "PRJ-0003",
    relative_path: "improvements/example.md",
    content: "# example",
    content_sha256: "b".repeat(64),
    created_at: "2026-09-01T13:00:00+01:00"
  };
}

function committed(referral: ReferralWriteRequest): ReferralWriteReceipt {
  return {
    request_id: referral.request_id,
    source_project_id: referral.source_project_id,
    target_project_id: referral.target_project_id,
    relative_path: referral.relative_path,
    content_sha256: referral.content_sha256,
    status: "committed"
  };
}

it("persists referral retry diagnostics and removes them after recovery", async () => {
  const objects = new FakeObjects();
  const referral = request();
  const incoming = `/PROJECT_OS/.project-os/referrals/incoming/${referral.request_id}.json`;
  const failure = `/PROJECT_OS/.project-os/referrals/failures/${referral.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(referral));

  const first = await processReferralInboxEntries(objects, async () => {
    throw new Error("ProjectGuard referral route returned 500");
  });
  expect(first).toEqual({ scanned: 1, processed: 0, failed: 1 });

  const diagnostic = JSON.parse(objects.files.get(failure) ?? "null") as Record<string, unknown>;
  expect(diagnostic).toMatchObject({
    schema_version: "1.0",
    request_id: referral.request_id,
    source_project_id: referral.source_project_id,
    target_project_id: referral.target_project_id,
    status: "retryable_failure",
    attempt_count: 1,
    message: "ProjectGuard referral route returned 500"
  });

  const recovered = await processReferralInboxEntries(objects, async (item) => committed(item));
  expect(recovered).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.has(failure)).toBe(false);
  expect(objects.files.has(`/PROJECT_OS/.project-os/referrals/receipts/${referral.request_id}.json`)).toBe(true);
  expect(objects.files.has(`/PROJECT_OS/.project-os/referrals/committed/${referral.request_id}.json`)).toBe(true);
});

it("quarantines a referral after the bounded retry limit", async () => {
  const objects = new FakeObjects();
  const referral = request();
  const incoming = `/PROJECT_OS/.project-os/referrals/incoming/${referral.request_id}.json`;
  const failure = `/PROJECT_OS/.project-os/referrals/failures/${referral.request_id}.json`;
  const quarantine = `/PROJECT_OS/.project-os/referrals/quarantine/${referral.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(referral));

  for (let attempt = 1; attempt <= MAX_RETRYABLE_INBOX_ATTEMPTS; attempt += 1) {
    await processReferralInboxEntries(objects, async () => {
      throw new Error("Too many subrequests by single Worker invocation");
    });
  }

  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.has(quarantine)).toBe(true);
  expect(JSON.parse(objects.files.get(failure) ?? "null")).toMatchObject({
    request_id: referral.request_id,
    attempt_count: MAX_RETRYABLE_INBOX_ATTEMPTS,
    status: "retryable_failure"
  });
});
