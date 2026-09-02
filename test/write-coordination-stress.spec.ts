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
  }, 15_000);

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

  it("runs fifty managed-document writes across two projects without cross-project heads or duplicate replay versions", async () => {
    const [a, b] = await Promise.all([
      createProject("TXN-WRITE-STRESS-PROJECT-0004", "doc-stress-a"),
      createProject("TXN-WRITE-STRESS-PROJECT-0005", "doc-stress-b")
    ]);
    expect(a.status).toBe("committed");
    expect(b.status).toBe("committed");
    const guardA = testEnv.PROJECT_GUARD.getByName(a.project_id);
    const guardB = testEnv.PROJECT_GUARD.getByName(b.project_id);
    let firstA: any;
    let firstB: any;
    let firstBodyA: Record<string, unknown> | undefined;
    let firstBodyB: Record<string, unknown> | undefined;

    for (let index = 1; index <= 25; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const contentA = `# Project A document ${index}`;
      const contentB = `# Project B document ${index}`;
      const bodyA = {
        operation: "working.write",
        request_id: `DOCREQ-STRESS-A-${suffix}`,
        project_id: a.project_id,
        logical_path: `stress/doc-${suffix}.md`,
        content: contentA,
        content_sha256: await sha256(contentA),
        created_at: at
      };
      const bodyB = {
        operation: "working.write",
        request_id: `DOCREQ-STRESS-B-${suffix}`,
        project_id: b.project_id,
        logical_path: `stress/doc-${suffix}.md`,
        content: contentB,
        content_sha256: await sha256(contentB),
        created_at: at
      };
      const [responseA, responseB] = await Promise.all([
        guardA.fetch("https://project-guard.internal/document", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyA)
        }),
        guardB.fetch("https://project-guard.internal/document", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyB)
        })
      ]);
      const receiptA = await responseA.json<any>();
      const receiptB = await responseB.json<any>();
      expect(receiptA).toMatchObject({ status: "committed", project_id: a.project_id, stage: "working" });
      expect(receiptB).toMatchObject({ status: "committed", project_id: b.project_id, stage: "working" });
      if (index === 1) {
        firstA = receiptA;
        firstB = receiptB;
        firstBodyA = bodyA;
        firstBodyB = bodyB;
      }
    }

    const [replayA, replayB] = await Promise.all([
      guardA.fetch("https://project-guard.internal/document", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(firstBodyA)
      }),
      guardB.fetch("https://project-guard.internal/document", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(firstBodyB)
      })
    ]);
    expect(await replayA.json()).toMatchObject({ status: "committed", version_id: firstA.version_id });
    expect(await replayB.json()).toMatchObject({ status: "committed", version_id: firstB.version_id });

    const ownA = await guardA.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(firstA.document_id)}`,
      { method: "GET" }
    );
    const ownB = await guardB.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(firstB.document_id)}`,
      { method: "GET" }
    );
    expect(ownA.status).toBe(200);
    expect(ownB.status).toBe(200);

    const crossA = await guardB.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(firstA.document_id)}`,
      { method: "GET" }
    );
    const crossB = await guardA.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(firstB.document_id)}`,
      { method: "GET" }
    );
    expect(crossA.status).toBe(404);
    expect(crossB.status).toBe(404);
  }, 15_000);
});