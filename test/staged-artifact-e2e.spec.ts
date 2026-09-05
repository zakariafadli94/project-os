import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("staged artifact end-to-end", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;
  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("publishes one staged object through ProjectGuard and cleans staging after the receipt", async () => {
    const ctx = createExecutionContext();
    const enabledEnv = {
      ...testEnv,
      PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: "on" as const,
      PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES: "10485760"
    };
    const create = await worker.fetch(new Request("https://example.com/v1/transactions", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-BINARY-PROJECT-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-09-05T17:00:00.000Z",
        payload: { name: "Binary Project", slug: "binary-project", aliases: [], objective: "Test binary ingress" }
      })
    }), enabledEnv, ctx);
    const project = await create.json<{ project_id: string }>();
    const requestId = "ART-BINARY-E2E-0001";
    const sourcePath = `/PROJECT_OS/.project-os/artifacts/staging/${requestId}/example.pdf`;
    const metadata = (await dropbox.writeExternal(sourcePath, "opaque\u0000pdf\u0001bytes"))!;
    const request = {
      request_id: requestId,
      project_id: project.project_id,
      relative_path: "example.pdf",
      content_sha256: "c".repeat(64),
      source: {
        kind: "staged_provider_object",
        path: sourcePath,
        object_id: metadata.id,
        revision_token: metadata.rev,
        size: metadata.size,
        integrity: { algorithm: "dropbox-content-hash", value: metadata.content_hash }
      },
      mode: "create"
    };

    const response = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(request)
    }), enabledEnv, ctx);

    expect(await response.json()).toMatchObject({ status: "committed", request_id: requestId });
    const destination = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-binary-project/ARTIFACTS/example.pdf`;
    expect(dropbox.files.get(destination)).toBe("opaque\u0000pdf\u0001bytes");
    expect(dropbox.files.has(sourcePath)).toBe(false);
    expect(dropbox.conditionalDeleteCalls).toContainEqual({
      path: metadata.id,
      parent_rev: metadata.rev
    });

    const replay = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(request)
    }), enabledEnv, ctx);
    expect(await replay.json()).toMatchObject({ status: "committed", request_id: requestId });
    expect(dropbox.files.get(destination)).toBe("opaque\u0000pdf\u0001bytes");

    const mismatchId = "ART-BINARY-E2E-0002";
    const mismatchPath = `/PROJECT_OS/.project-os/artifacts/staging/${mismatchId}/mismatch.pdf`;
    const mismatchMetadata = (await dropbox.writeExternal(mismatchPath, "changed source"))!;
    const mismatchResponse = await worker.fetch(new Request("https://example.com/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        request_id: mismatchId,
        relative_path: "mismatch.pdf",
        source: {
          ...request.source,
          path: mismatchPath,
          object_id: mismatchMetadata.id,
          revision_token: `${mismatchMetadata.rev}-stale`,
          size: mismatchMetadata.size,
          integrity: { algorithm: "dropbox-content-hash", value: mismatchMetadata.content_hash }
        }
      })
    }), enabledEnv, ctx);
    expect(await mismatchResponse.json()).toMatchObject({
      status: "rejected",
      code: "ARTIFACT_EVIDENCE_MISMATCH"
    });
    expect(dropbox.files.has(mismatchPath)).toBe(true);
  });
});
