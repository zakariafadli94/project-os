import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-20T18:00:00.000Z";

function createRequest(sequence: number, slug = `project-${sequence}`) {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-REGISTRY-${sequence.toString().padStart(6, "0")}`,
    project_id: "PRJ-AUTO",
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: { name: `Project ${sequence}`, slug, aliases: [`p${sequence}`], objective: "Test registry allocation" }
  };
}

async function createProject(transaction: unknown): Promise<Receipt> {
  const stub = testEnv.REGISTRY_GUARD.getByName("global");
  const response = await stub.fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("RegistryGuard", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("allocates unique monotonic project IDs under concurrent creation", async () => {
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) => createProject(createRequest(index + 1))));
    const ids = receipts.map((receipt) => receipt.project_id);

    expect(receipts.every((receipt) => receipt.status === "committed")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice().sort()).toEqual([
      "PRJ-0001", "PRJ-0002", "PRJ-0003", "PRJ-0004",
      "PRJ-0005", "PRJ-0006", "PRJ-0007", "PRJ-0008"
    ]);
  }, 10_000);

  it("publishes the final Dropbox receipt only after registry creation completes", async () => {
    const tx = createRequest(90, "receipt-order");
    const receipt = await createProject(tx);

    expect(receipt.status).toBe("committed");
    expect(dropbox.files.has("/PROJECT_OS/.project-os/registry/PROJECT_REGISTRY.json")).toBe(true);
    expect(dropbox.files.has(`/PROJECT_OS/.project-os/receipts/${tx.transaction_id}.json`)).toBe(true);
  });

  it("replays project.create idempotently with the original allocated project ID", async () => {
    const tx = createRequest(101, "stable-project");
    const first = await createProject(tx);
    const replay = await createProject(tx);

    expect(replay).toEqual(first);
  });

  it("rejects duplicate canonical slugs before allocating another project", async () => {
    const first = await createProject(createRequest(201, "same-project"));
    const duplicate = await createProject(createRequest(202, "same-project"));

    expect(first.status).toBe("committed");
    expect(duplicate.status).toBe("rejected");
    expect(duplicate.code).toBe("DUPLICATE_PROJECT");
  });
});
