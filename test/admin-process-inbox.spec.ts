import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("admin inbox processing", () => {
  beforeEach(() => installDropboxMock());

  it("requires auth and returns the immediate inbox processing summary", async () => {
    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
      method: "POST"
    }), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "v2",
      inbox: "/PROJECT_OS/.project-os/transactions/incoming",
      artifact_inbox: "/PROJECT_OS/.project-os/artifacts/incoming",
      scanned: 0,
      processed: 0,
      failed: 0
    });
  });
});

it("runs the project transaction before a bounded batch of four artifacts", async () => {
  const mock = installDropboxMock();
  const { sha256Text } = await import("../src/documents/hash");
  mock.files.set("/PROJECT_OS/.project-os/transactions/incoming/TXN-BATCH-CREATE-0001.json", JSON.stringify({
    schema_version:"1.0", transaction_id:"TXN-BATCH-CREATE-0001", project_id:"PRJ-AUTO", base_revision:0,
    operation:"project.create", created_at:"2026-09-07T10:00:00Z", payload:{name:"Batch",slug:"batch",aliases:[],objective:"Test"}
  }));
  for (let i = 1; i <= 5; i++) {
    const request_id = `ART-BATCH-REVIEW-000${i}`;
    mock.files.set(`/PROJECT_OS/.project-os/artifacts/incoming/${request_id}.json`, JSON.stringify({request_id,project_id:"PRJ-0001",relative_path:`file-${i}.md`,content:"batch",content_sha256:await sha256Text("batch"),mode:"create"}));
  }
  const response = await worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {method:"POST",headers:{authorization:`Bearer ${testEnv.INGRESS_TOKEN}`}}),testEnv,createExecutionContext());
  expect(await response.json()).toMatchObject({processed:5,failed:0});
  for(let i=1;i<=4;i++) expect(mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-batch/ARTIFACTS/file-${i}.md`)).toBe("batch");
  expect(mock.files.has("/PROJECT_OS/.project-os/artifacts/incoming/ART-BATCH-REVIEW-0005.json")).toBe(true);
});
