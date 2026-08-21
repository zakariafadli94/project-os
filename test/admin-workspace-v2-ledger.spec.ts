import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

describe("workspace v2 ledger migration admin route", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => {
    dropbox = installDropboxMock();
  });

  it("requires auth and mirrors legacy transactions and receipts", async () => {
    const txId = "TXN-LEDGER-ADMIN-0001";
    dropbox.files.set(`/PROJECT_OS/TRANSACTIONS/committed/${txId}.json`, '{"transaction_id":"TXN-LEDGER-ADMIN-0001"}\n');
    dropbox.files.set(`/PROJECT_OS/RECEIPTS/${txId}.json`, '{"transaction_id":"TXN-LEDGER-ADMIN-0001","status":"committed"}\n');

    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/workspace-v2/migrate-ledger", {
      method: "POST"
    }), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/workspace-v2/migrate-ledger", {
      method: "POST",
      headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ transactions: 1, receipts: 1 });
    expect(dropbox.files.get(`/PROJECT_OS/.project-os/transactions/committed/${txId}.json`)).toBe('{"transaction_id":"TXN-LEDGER-ADMIN-0001"}\n');
    expect(dropbox.files.get(`/PROJECT_OS/.project-os/receipts/${txId}.json`)).toBe('{"transaction_id":"TXN-LEDGER-ADMIN-0001","status":"committed"}\n');
  });
});
