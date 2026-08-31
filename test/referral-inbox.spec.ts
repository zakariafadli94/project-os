import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-31T14:30:00+01:00";

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Referral ${slug}`, slug, aliases: [], objective: "Referral delivery test" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function processInbox() {
  return worker.fetch(new Request("https://example.com/v1/admin/process-inbox", {
    method: "POST",
    headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
  }), testEnv, createExecutionContext());
}

describe("governed referral inbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes durable target provenance before the visible INPUTS file without changing business state", async () => {
    const mock = installDropboxMock();
    const source = await createProject("TXN-REFERRAL-SOURCE-0001", "referral-source-one");
    const target = await createProject("TXN-REFERRAL-TARGET-0001", "referral-target-one");
    const requestId = "REF-GOVERNED-DELIVERY-0001";
    const relativePath = "improvements/input-lifecycle-anomaly.md";
    const content = "# Referral\n\nInvestigate the INPUTS lifecycle anomaly.";
    const contentSha256 = await sha256Text(content);
    const inputPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${target.project_id}-referral-target-one/INPUTS/${relativePath}`;
    const inputPathHash = await sha256Text(inputPath);
    const intentPath = `/PROJECT_OS/.project-os/projects/${target.project_id}/referrals/intents/${requestId}.json`;
    const bindingPath = `/PROJECT_OS/.project-os/projects/${target.project_id}/referrals/input-bindings/${inputPathHash}.json`;
    const receiptPath = `/PROJECT_OS/.project-os/referrals/receipts/${requestId}.json`;
    const incomingPath = `/PROJECT_OS/.project-os/referrals/incoming/${requestId}.json`;
    const targetStatePath = `/PROJECT_OS/.project-os/projects/${target.project_id}/state.json`;
    const stateBefore = mock.files.get(targetStatePath);

    const request = {
      schema_version: "1.0",
      request_id: requestId,
      source_project_id: source.project_id,
      target_project_id: target.project_id,
      relative_path: relativePath,
      content,
      content_sha256: contentSha256,
      created_at: at,
      referral_type: "project_os_improvement_anomaly",
      topic: "input_lifecycle"
    };
    await mock.writeExternal(incomingPath, `${JSON.stringify(request, null, 2)}\n`);

    const response = await processInbox();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanned: 1, processed: 1, failed: 0 });

    expect(mock.files.has(incomingPath)).toBe(false);
    expect(mock.files.get(inputPath)).toBe(content);
    expect(mock.files.has(intentPath)).toBe(true);
    expect(mock.files.has(bindingPath)).toBe(true);
    expect(mock.files.has(receiptPath)).toBe(true);
    expect(mock.files.get(targetStatePath)).toBe(stateBefore);

    const intentUpload = mock.uploadCalls.indexOf(intentPath);
    const bindingUpload = mock.uploadCalls.indexOf(bindingPath);
    const inputUpload = mock.uploadCalls.indexOf(inputPath);
    expect(intentUpload).toBeGreaterThanOrEqual(0);
    expect(bindingUpload).toBeGreaterThanOrEqual(0);
    expect(inputUpload).toBeGreaterThanOrEqual(0);
    expect(intentUpload).toBeLessThan(inputUpload);
    expect(bindingUpload).toBeLessThan(inputUpload);
  });

  it("rejects a referral whose source project is not registered and never creates target INPUTS", async () => {
    const mock = installDropboxMock();
    const target = await createProject("TXN-REFERRAL-TARGET-0002", "referral-target-two");
    const requestId = "REF-UNKNOWN-SOURCE-0002";
    const content = "# Untrusted referral";
    const relativePath = "unknown/source.md";
    const incomingPath = `/PROJECT_OS/.project-os/referrals/incoming/${requestId}.json`;
    const targetInput = `/PROJECT_OS/WORKSPACE/PROJECTS/${target.project_id}-referral-target-two/INPUTS/${relativePath}`;

    await mock.writeExternal(incomingPath, `${JSON.stringify({
      schema_version: "1.0",
      request_id: requestId,
      source_project_id: "PRJ-9999",
      target_project_id: target.project_id,
      relative_path: relativePath,
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    }, null, 2)}\n`);

    const response = await processInbox();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanned: 1, processed: 1, failed: 0 });
    expect(mock.files.has(targetInput)).toBe(false);
    expect(mock.files.has(`/PROJECT_OS/.project-os/referrals/rejected/${requestId}.json`)).toBe(true);
  });
});
