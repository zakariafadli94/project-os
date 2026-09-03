import { expect, it } from "vitest";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../src/domain/artifact-write";
import {
  MAX_RETRYABLE_INBOX_ATTEMPTS,
  processArtifactInbox,
  type InboxProcessSummary
} from "../src/inbox/processor";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";

class FakeObjects implements ObjectPersistence {
  files = new Map<string, string>();
  failQuarantineMove = false;

  async readText(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async createText(path: string, content: string): Promise<void> { this.files.set(path, content); }
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
    if (this.failQuarantineMove && to.includes("/quarantine/")) {
      throw new Error("Too many subrequests by single Worker invocation");
    }
    const content = this.files.get(from);
    if (content === undefined) throw new Error("missing source");
    this.files.delete(from);
    this.files.set(to, content);
  }
  async delete(path: string): Promise<void> { this.files.delete(path); }
}

function artifact(requestId: string): ArtifactWriteRequest {
  return {
    request_id: requestId,
    project_id: "PRJ-0002",
    relative_path: `diagnostics/${requestId}.md`,
    content: "# bounded ingress",
    content_sha256: "a".repeat(64),
    mode: "create"
  };
}

function incomingPath(requestId: string): string {
  return `/PROJECT_OS/.project-os/artifacts/incoming/${requestId}.json`;
}

function failurePath(requestId: string): string {
  return `/PROJECT_OS/.project-os/artifacts/failures/${requestId}.json`;
}

function failure(request: ArtifactWriteRequest, attemptCount: number, lastFailedAt: string): string {
  return JSON.stringify({
    schema_version: "1.0",
    request_id: request.request_id,
    project_id: request.project_id,
    status: "retryable_failure",
    attempt_count: attemptCount,
    first_failed_at: lastFailedAt,
    last_failed_at: lastFailedAt,
    message: "Too many subrequests by single Worker invocation"
  });
}

function committed(request: ArtifactWriteRequest): ArtifactWriteReceipt {
  return {
    request_id: request.request_id,
    project_id: request.project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status: "committed"
  };
}

it("never re-executes an artifact after the durable retry ceiling, even when quarantine cleanup is quota-blocked", async () => {
  const objects = new FakeObjects();
  const request = artifact("ART-INGRESS-HARDSTOP-0001");
  objects.files.set(incomingPath(request.request_id), JSON.stringify(request));
  objects.files.set(failurePath(request.request_id), failure(request, MAX_RETRYABLE_INBOX_ATTEMPTS, "2026-09-03T09:45:55.413Z"));
  objects.failQuarantineMove = true;
  let executions = 0;

  await processArtifactInbox(objects, "v2", async () => {
    executions += 1;
    throw new Error("ProjectGuard artifact route returned 500");
  });

  expect(executions).toBe(0);
  expect(JSON.parse(objects.files.get(failurePath(request.request_id)) ?? "null")).toMatchObject({
    attempt_count: MAX_RETRYABLE_INBOX_ATTEMPTS
  });
  expect(objects.files.has(incomingPath(request.request_id))).toBe(true);
});

it("defers retryable artifact execution until bounded backoff is due", async () => {
  const objects = new FakeObjects();
  const request = artifact("ART-INGRESS-BACKOFF-0001");
  const now = new Date().toISOString();
  objects.files.set(incomingPath(request.request_id), JSON.stringify(request));
  objects.files.set(failurePath(request.request_id), failure(request, 1, now));
  let executions = 0;

  await processArtifactInbox(objects, "v2", async (item) => {
    executions += 1;
    return committed(item);
  });

  expect(executions).toBe(0);
  expect(objects.files.has(incomingPath(request.request_id))).toBe(true);
});

it("honors an explicit per-call work-item budget before draining the artifact inbox", async () => {
  const objects = new FakeObjects();
  for (const requestId of ["ART-INGRESS-BUDGET-0001", "ART-INGRESS-BUDGET-0002", "ART-INGRESS-BUDGET-0003"]) {
    const request = artifact(requestId);
    objects.files.set(incomingPath(requestId), JSON.stringify(request));
  }
  let executions = 0;
  const boundedProcess = processArtifactInbox as unknown as (
    objects: ObjectPersistence,
    mode: "v2",
    execute: (request: ArtifactWriteRequest) => Promise<ArtifactWriteReceipt>,
    options: { maxEntries: number }
  ) => Promise<InboxProcessSummary>;

  const summary = await boundedProcess(objects, "v2", async (item) => {
    executions += 1;
    return committed(item);
  }, { maxEntries: 1 });

  expect(summary.scanned).toBe(3);
  expect(executions).toBe(1);
  expect([...objects.files.keys()].filter((path) => path.includes("/artifacts/incoming/")).length).toBe(2);
});
