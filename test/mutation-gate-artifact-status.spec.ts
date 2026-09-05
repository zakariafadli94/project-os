import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/dropbox/client";
import { machineArtifactReceiptPath } from "../src/dropbox/layout";
import { sha256Text } from "../src/documents/hash";
import { ArtifactMutationIntentService } from "../src/mutation-gate/artifact-intent";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { MutationGateService } from "../src/mutation-gate/service";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class FakeStatusTransport implements DropboxTransport {
  readonly files = new Map<string, string>();

  async upload(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(): Promise<void> {
    throw new Error("unused");
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    const content = this.files.get(path);
    if (content === undefined) return null;
    return {
      id: "id:artifact-status",
      path,
      rev: "artifact-status-rev-1",
      content_hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T19:10:00+01:00"
    };
  }

  async listFolder(): Promise<DropboxEntry[]> {
    return [];
  }
}

async function fixture() {
  const transport = new FakeStatusTransport();
  const runtime = persistenceFromDropbox(transport);
  const state = emptyProjectState("PRJ-9902", "Artifact Status", "artifact-status", "Verify artifact status");
  const content = "# verified artifact";
  const request: ArtifactWriteRequest = {
    request_id: "ART-STATUS-VERIFY-0001",
    project_id: state.project_id,
    relative_path: "status/verified.md",
    content,
    content_sha256: await sha256Text(content),
    mode: "create"
  };
  const repository = new MutationGateRepository(runtime);
  const prepared = await new ArtifactMutationIntentService(repository, runtime).prepare(state, request);
  const service = new MutationGateService(runtime, "observe");
  const receipt = {
    request_id: request.request_id,
    project_id: request.project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status: "committed" as const
  };
  return { transport, request, prepared, service, receipt };
}

describe("MutationGate artifact verification state", () => {
  it("reports COMMITTED when receipt exists but the final provider effect cannot be verified", async () => {
    const { transport, request, service, receipt } = await fixture();
    await transport.upload(machineArtifactReceiptPath(request.request_id), JSON.stringify(receipt));

    expect(await service.artifactStatus(request.project_id, request.request_id)).toMatchObject({
      verification_state: "committed",
      receipt_status: "committed"
    });
  });

  it("reports CANONICAL VERIFIED only when committed receipt and final bytes match durable intent", async () => {
    const { transport, request, prepared, service, receipt } = await fixture();
    await transport.upload(prepared.destination.path, request.content);
    await transport.upload(machineArtifactReceiptPath(request.request_id), JSON.stringify(receipt));

    expect(await service.artifactStatus(request.project_id, request.request_id)).toMatchObject({
      verification_state: "canonical_verified",
      receipt_status: "committed"
    });
  });

  it("fails closed when a committed receipt relative_path does not match the request frozen in the durable intent", async () => {
    const { transport, request, prepared, service, receipt } = await fixture();
    await transport.upload(prepared.destination.path, request.content);
    await transport.upload(machineArtifactReceiptPath(request.request_id), JSON.stringify({
      ...receipt,
      relative_path: "status/forged.md"
    }));

    await expect(service.artifactStatus(request.project_id, request.request_id))
      .rejects.toThrow(`Artifact receipt does not match durable mutation intent: ${request.request_id}`);
  });

  it("verifies staged artifacts from provider evidence without decoding final bytes as text", async () => {
    const transport = new FakeStatusTransport();
    const sourcePath = "/PROJECT_OS/.project-os/artifacts/staging/ART-STATUS-BINARY-0001/example.pdf";
    await transport.upload(sourcePath, "opaque-binary-fixture");
    const source = (await transport.getMetadata(sourcePath))!;
    const runtime = persistenceFromDropbox(transport);
    const state = emptyProjectState("PRJ-9902", "Artifact Status", "artifact-status", "Verify artifact status");
    const request: ArtifactWriteRequest = {
      request_id: "ART-STATUS-BINARY-0001",
      project_id: state.project_id,
      relative_path: "status/example.pdf",
      content_sha256: "b".repeat(64),
      source: {
        kind: "staged_provider_object",
        path: sourcePath,
        object_id: source.id,
        revision_token: source.rev,
        size: source.size,
        integrity: { algorithm: "dropbox-content-hash", value: source.content_hash }
      },
      mode: "create"
    };
    const prepared = await new ArtifactMutationIntentService(new MutationGateRepository(runtime), runtime).prepare(state, request);
    await transport.upload(prepared.destination.path, "opaque-binary-fixture");
    await transport.upload(machineArtifactReceiptPath(request.request_id), JSON.stringify({
      request_id: request.request_id,
      project_id: request.project_id,
      relative_path: request.relative_path,
      content_sha256: request.content_sha256,
      status: "committed"
    }));

    expect(await new MutationGateService(runtime, "observe").artifactStatus(request.project_id, request.request_id))
      .toMatchObject({ verification_state: "canonical_verified" });
  });
});
