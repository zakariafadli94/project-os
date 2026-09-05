import { expect, it } from "vitest";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../src/domain/artifact-write";
import {
  MAX_RETRYABLE_INBOX_ATTEMPTS,
  processArtifactInbox
} from "../src/inbox/processor";
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

function request(): ArtifactWriteRequest {
  return {
    request_id: "ART-INBOX-FAILURE-0001",
    project_id: "PRJ-0002",
    relative_path: "diagnostics/example.md",
    content: "# example",
    content_sha256: "a".repeat(64),
    mode: "create"
  };
}

function committed(artifact: ArtifactWriteRequest): ArtifactWriteReceipt {
  return {
    request_id: artifact.request_id,
    project_id: artifact.project_id,
    relative_path: artifact.relative_path,
    content_sha256: artifact.content_sha256,
    status: "committed"
  };
}

it("persists artifact retry diagnostics and removes them after recovery", async () => {
  const objects = new FakeObjects();
  const artifact = request();
  const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${artifact.request_id}.json`;
  const failure = `/PROJECT_OS/.project-os/artifacts/failures/${artifact.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(artifact));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const summary = await processArtifactInbox(objects, "v2", async () => {
      throw new Error(`ProjectGuard artifact route failed attempt ${attempt}`);
    });
    expect(summary).toEqual({ scanned: 1, processed: 0, failed: 1 });
  }

  const diagnostic = JSON.parse(objects.files.get(failure) ?? "null") as Record<string, unknown>;
  expect(diagnostic).toMatchObject({
    schema_version: "1.0",
    request_id: artifact.request_id,
    project_id: artifact.project_id,
    status: "retryable_failure",
    attempt_count: 2,
    message: "ProjectGuard artifact route failed attempt 2"
  });

  const recovered = await processArtifactInbox(objects, "v2", async (item) => committed(item));
  expect(recovered).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.has(failure)).toBe(false);
  expect(objects.files.has(`/PROJECT_OS/.project-os/artifacts/committed/${artifact.request_id}.json`)).toBe(true);
});

it("quarantines an artifact after the bounded retry limit", async () => {
  const objects = new FakeObjects();
  const artifact = request();
  const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${artifact.request_id}.json`;
  const failure = `/PROJECT_OS/.project-os/artifacts/failures/${artifact.request_id}.json`;
  const quarantine = `/PROJECT_OS/.project-os/artifacts/quarantine/${artifact.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(artifact));

  for (let attempt = 1; attempt <= MAX_RETRYABLE_INBOX_ATTEMPTS; attempt += 1) {
    await processArtifactInbox(objects, "v2", async () => {
      throw new Error("Too many subrequests by single Worker invocation");
    });
  }

  expect(objects.files.has(incoming)).toBe(false);
  expect(objects.files.has(quarantine)).toBe(true);
  expect(JSON.parse(objects.files.get(failure) ?? "null")).toMatchObject({
    request_id: artifact.request_id,
    attempt_count: MAX_RETRYABLE_INBOX_ATTEMPTS,
    status: "retryable_failure"
  });
});

it("persists a deterministic rejected artifact receipt before terminalizing the inbox manifest", async () => {
  const objects = new FakeObjects();
  const artifact = request();
  const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${artifact.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(artifact));

  const summary = await processArtifactInbox(objects, "v2", async (item) => ({
    request_id: item.request_id,
    project_id: item.project_id,
    relative_path: item.relative_path,
    content_sha256: item.content_sha256,
    status: "rejected",
    code: "BINARY_ARTIFACT_INGRESS_DISABLED",
    message: "Staged binary artifact ingress is disabled"
  }));

  expect(summary).toEqual({ scanned: 1, processed: 1, failed: 0 });
  expect(JSON.parse(objects.files.get(`/PROJECT_OS/.project-os/artifacts/receipts/${artifact.request_id}.json`) ?? "null"))
    .toMatchObject({ status: "rejected", code: "BINARY_ARTIFACT_INGRESS_DISABLED" });
  expect(objects.files.has(`/PROJECT_OS/.project-os/artifacts/rejected/${artifact.request_id}.json`)).toBe(true);
});

it("does not let an alternate-payload intent conflict occupy the original receipt path", async () => {
  const objects = new FakeObjects();
  const artifact = request();
  const incoming = `/PROJECT_OS/.project-os/artifacts/incoming/${artifact.request_id}.json`;
  objects.files.set(incoming, JSON.stringify(artifact));

  await processArtifactInbox(objects, "v2", async (item) => ({
    request_id: item.request_id,
    project_id: item.project_id,
    relative_path: item.relative_path,
    content_sha256: item.content_sha256,
    status: "conflict",
    code: "ARTIFACT_INTENT_CONFLICT",
    message: "request ID belongs to another frozen payload"
  }));

  expect(objects.files.has(`/PROJECT_OS/.project-os/artifacts/receipts/${artifact.request_id}.json`)).toBe(false);
  expect(objects.files.has(`/PROJECT_OS/.project-os/artifacts/conflicts/${artifact.request_id}.json`)).toBe(true);
});
