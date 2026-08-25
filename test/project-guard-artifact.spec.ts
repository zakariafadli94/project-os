import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-23T00:30:00.000Z";

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createProject(transactionId: string): Promise<Receipt> {
  const suffix = transactionId.slice(-4).toLowerCase();
  const stub = testEnv.REGISTRY_GUARD.getByName("global");
  const response = await stub.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Artifact Project ${suffix}`, slug: `artifact-${suffix}`, aliases: [], objective: "Test artifacts" }
    })
  });
  expect(response.status).toBe(200);
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  expect(receipt.project_id).toMatch(/^PRJ-[0-9]{4,}$/);
  return receipt;
}

function artifactBody(projectId: string, requestId: string, content: string, hash: string) {
  return {
    request_id: requestId,
    project_id: projectId,
    relative_path: "playbooks/acquisition.md",
    content,
    content_sha256: hash,
    mode: "create"
  };
}

describe("ProjectGuard artifact writes", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;
  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("commits an artifact and returns the same receipt on exact replay", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0001");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Acquisition";
    const body = artifactBody(created.project_id, "ART-GROWTH-000001", content, await sha256(content));

    const first = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const firstReceipt = await first.json<{ status: string }>();
    expect(firstReceipt.status).toBe("committed");

    const second = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect(await second.json()).toEqual(expect.objectContaining({ status: "committed", request_id: body.request_id }));

    const artifactPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-artifact-0001/ARTIFACTS/playbooks/acquisition.md`;
    expect(dropbox.files.get(artifactPath)).toBe(content);
  });

  it("persists durable mutation intent before the first visible artifact write", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0006");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# intent first";
    const requestId = "ART-GROWTH-INTENT-0001";
    const body = artifactBody(created.project_id, requestId, content, await sha256(content));

    const response = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect(await response.json()).toMatchObject({ status: "committed" });

    const intentPath = `/PROJECT_OS/.project-os/projects/${created.project_id}/mutation-gate/intents/artifacts/${requestId}.json`;
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-artifact-0006/ARTIFACTS/playbooks/acquisition.md`;
    const intentIndex = dropbox.uploadCalls.findIndex((path) => path === intentPath);
    const visibleIndex = dropbox.uploadCalls.findIndex((path) => path === visiblePath);
    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(visibleIndex).toBeGreaterThan(intentIndex);
  });

  it("rejects request-id reuse with different content", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0002");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "one";
    const body = artifactBody(created.project_id, "ART-GROWTH-000002", content, await sha256(content));

    await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const changed = { ...body, content: "two", content_sha256: await sha256("two") };
    const response = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });

    expect(await response.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("rejects a mismatched declared content hash", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0003");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const body = artifactBody(created.project_id, "ART-GROWTH-000003", "content", "a".repeat(64));
    const response = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });

    expect(await response.json()).toMatchObject({ status: "rejected", code: "CONTENT_HASH_MISMATCH" });
  });

  it("keeps a real create-content conflict visible", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0004");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const firstContent = "first";
    const first = artifactBody(created.project_id, "ART-GROWTH-000004", firstContent, await sha256(firstContent));
    await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(first)
    });

    const secondContent = "second";
    const second = { ...artifactBody(created.project_id, "ART-GROWTH-000005", secondContent, await sha256(secondContent)), relative_path: first.relative_path };
    const response = await project.fetch("https://project-guard.internal/artifact", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(second)
    });
    expect(await response.json()).toMatchObject({ status: "conflict", code: "ARTIFACT_CONTENT_CONFLICT" });
  });

  it("serializes a transaction and artifact request through the same project guard", async () => {
    const created = await createProject("TXN-ARTIFACT-PROJECT-0005");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "serialized";
    const artifact = artifactBody(created.project_id, "ART-GROWTH-000006", content, await sha256(content));
    const transaction = {
      schema_version: "1.0",
      transaction_id: "TXN-ARTIFACT-TASK-000001",
      project_id: created.project_id,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: { task_id: "TASK-ARTI0001", title: "Artifact task" }
    };

    const [txResponse, artifactResponse] = await Promise.all([
      project.fetch("https://project-guard.internal/transaction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transaction) }),
      project.fetch("https://project-guard.internal/artifact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(artifact) })
    ]);

    expect((await txResponse.json<Receipt>()).status).toBe("committed");
    expect(await artifactResponse.json()).toMatchObject({ status: "committed" });
  });
});