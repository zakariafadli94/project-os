import { expect, it } from "vitest";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../src/domain/artifact-write";
import { MAX_RETRYABLE_INBOX_ATTEMPTS, processArtifactInbox, type InboxProcessSummary } from "../src/inbox/processor";
import type { ObjectPersistence, ProviderEntry, ProviderObjectMetadata } from "../src/persistence/provider/contract";

class FakeObjects implements ObjectPersistence {
  files = new Map<string, string>();
  quarantineMoves = 0;

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
    if (to.includes("/quarantine/")) this.quarantineMoves += 1;
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

function committed(request: ArtifactWriteRequest): ArtifactWriteReceipt {
  return {
    request_id: request.request_id,
    project_id: request.project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status: "committed"
  };
}

it("skips exhausted artifacts without retrying cleanup and still admits one healthy work item within a bounded scan", async () => {
  const objects = new FakeObjects();
  const exhausted = artifact("ART-INGRESS-A-EXHAUSTED-0001");
  const healthy = artifact("ART-INGRESS-B-HEALTHY-0001");
  const outsideScan = artifact("ART-INGRESS-C-OUTSIDE-0001");
  for (const request of [exhausted, healthy, outsideScan]) {
    objects.files.set(incomingPath(request.request_id), JSON.stringify(request));
  }
  const exhaustedAt = "2026-09-03T09:45:55.413Z";
  objects.files.set(failurePath(exhausted.request_id), JSON.stringify({
    schema_version: "1.0",
    request_id: exhausted.request_id,
    project_id: exhausted.project_id,
    status: "retryable_failure",
    attempt_count: MAX_RETRYABLE_INBOX_ATTEMPTS,
    first_failed_at: exhaustedAt,
    last_failed_at: exhaustedAt,
    message: "Too many subrequests by single Worker invocation"
  }));
  let executions = 0;
  const boundedProcess = processArtifactInbox as unknown as (
    objects: ObjectPersistence,
    mode: "v2",
    execute: (request: ArtifactWriteRequest) => Promise<ArtifactWriteReceipt>,
    options: { maxScanEntries: number; maxWorkItems: number; respectRetryBackoff: boolean }
  ) => Promise<InboxProcessSummary>;

  const summary = await boundedProcess(objects, "v2", async (request) => {
    executions += 1;
    return committed(request);
  }, { maxScanEntries: 2, maxWorkItems: 1, respectRetryBackoff: true });

  expect(summary.scanned).toBe(3);
  expect(executions).toBe(1);
  expect(objects.quarantineMoves).toBe(0);
  expect(objects.files.has(incomingPath(exhausted.request_id))).toBe(true);
  expect(objects.files.has(incomingPath(healthy.request_id))).toBe(false);
  expect(objects.files.has(incomingPath(outsideScan.request_id))).toBe(true);
});
