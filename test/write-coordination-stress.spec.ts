import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-23T00:45:00.000Z";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const response = await registry.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: slug, slug, aliases: [], objective: "Stress write coordination" }
    })
  });
  return response.json<Receipt>();
}

describe("Project OS write coordination stress", () => {
  beforeEach(() => { installDropboxMock({ transientUploadFailures: 1 }); });
  afterEach(() => vi.restoreAllMocks());

  it("runs fifty mixed same-project mutations without duplicate business effects", async () => {
    const created = await createProject("TXN-WRITE-STRESS-PROJECT-0001", "write-stress-one");
    expect(created.status).toBe("committed");
    const project = testEnv.PROJECT_GUARD.getByName(created.project_id);
    let revision = 1;

    for (let index = 1; index <= 25; index += 1) {
      const txId = `TXN-WRITE-STRESS-TASK-${String(index).padStart(4, "0")}`;
      const txResponse = await project.fetch("https://project-guard.internal/transaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "1.0",
          transaction_id: txId,
          project_id: created.project_id,
          base_revision: revision,
          operation: "task.create",
          created_at: at,
          payload: { task_id: `TASK-STRESS${String(index).padStart(4, "0")}`, title: `Stress task ${index}` }
        })
      });
      const txReceipt = await txResponse.json<Receipt>();
      expect(txReceipt.status).toBe("committed");
      revision += 1;

      const content = `# Artifact ${index}`;
      const artifact = {
        request_id: `ART-STRESS-${String(index).padStart(6, "0")}`,
        project_id: created.project_id,
        relative_path: `stress/artifact-${String(index).padStart(2, "0")}.md`,
        content,
        content_sha256: await sha256(content),
        mode: "create"
      };
      const first = await project.fetch("https://project-guard.internal/artifact", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(artifact)
      });
      expect(await first.json()).toMatchObject({ status: "committed" });

      const replay = await project.fetch("https://project-guard.internal/artifact", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(artifact)
      });
      expect(await replay.json()).toMatchObject({ status: "committed", request_id: artifact.request_id });
    }

    expect(revision).toBe(26);
  });

  it("allows different project durable objects to progress independently", async () => {
    const [a, b] = await Promise.all([
      createProject("TXN-WRITE-STRESS-PROJECT-0002", "write-stress-two"),
      createProject("TXN-WRITE-STRESS-PROJECT-0003", "write-stress-three")
    ]);
    expect(a.status).toBe("committed");
    expect(b.status).toBe("committed");

    const contentA = "project a";
    const contentB = "project b";
    const [responseA, responseB] = await Promise.all([
      testEnv.PROJECT_GUARD.getByName(a.project_id).fetch("https://project-guard.internal/artifact", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          request_id: "ART-PARALLEL-000001", project_id: a.project_id, relative_path: "parallel/a.md", content: contentA,
          content_sha256: await sha256(contentA), mode: "create"
        })
      }),
      testEnv.PROJECT_GUARD.getByName(b.project_id).fetch("https://project-guard.internal/artifact", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          request_id: "ART-PARALLEL-000002", project_id: b.project_id, relative_path: "parallel/b.md", content: contentB,
          content_sha256: await sha256(contentB), mode: "create"
        })
      })
    ]);

    expect(await responseA.json()).toMatchObject({ status: "committed" });
    expect(await responseB.json()).toMatchObject({ status: "committed" });
  });
});
