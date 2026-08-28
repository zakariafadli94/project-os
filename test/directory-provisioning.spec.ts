import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction } from "../src/domain/transitions";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import {
  DropboxClient,
  DropboxConflictError,
  type DropboxTransport
} from "../src/persistence/providers/dropbox/client";
import { ProjectRepository } from "../src/persistence/repository";

function rawTransport(overrides: Partial<DropboxTransport> = {}): DropboxTransport {
  return {
    upload: async () => undefined,
    download: async () => null,
    move: async () => undefined,
    delete: async () => undefined,
    getMetadata: async () => null,
    listFolder: async () => [],
    uploadConditional: async () => ({
      id: "id:file",
      path: "/x",
      rev: "rev",
      content_hash: "a".repeat(64),
      size: 1
    }),
    copy: async (_from, to) => ({
      id: "id:file",
      path: to,
      rev: "rev",
      content_hash: "a".repeat(64),
      size: 1
    }),
    listFolderChanges: async () => ({ entries: [], cursor: "cursor" }),
    ...overrides
  };
}

function projectRecord() {
  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-DIR-PV1-000001",
    project_id: "PRJ-7002",
    base_revision: 0,
    operation: "project.create",
    created_at: "2026-08-28T22:30:00+01:00",
    payload: {
      name: "PV1 Directory Fixture",
      slug: "pv1-directory-fixture",
      aliases: [],
      objective: "Prove PV1 does not activate PV2 folders"
    }
  });
  const result = applyTransaction(null, transaction);
  if (result.kind !== "commit") throw new Error(`fixture transition failed: ${result.kind}`);
  return {
    schema_version: "1.0" as const,
    project_id: transaction.project_id,
    previous_revision: 0,
    new_revision: result.state.revision,
    transaction,
    state: result.state,
    event: result.event,
    receipt: {
      schema_version: "1.0" as const,
      transaction_id: transaction.transaction_id,
      status: "committed" as const,
      project_id: transaction.project_id,
      previous_revision: 0,
      new_revision: result.state.revision,
      event_id: result.event.event_id,
      committed_at: "2026-08-28T22:30:00+01:00"
    }
  };
}

describe("directory provisioning capability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes ensureDirectory through the provider-neutral runtime", async () => {
    const calls: string[] = [];
    const runtime = createDropboxPersistence(rawTransport({
      ensureDirectory: async (path) => { calls.push(path); }
    }));

    await runtime.directoryProvisioning!.ensureDirectory(
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED"
    );

    expect(calls).toEqual([
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED"
    ]);
  });

  it("does not bootstrap managed zones for an explicitly requested projection v1 materialization", async () => {
    const calls: string[] = [];
    const runtime = createDropboxPersistence(rawTransport({
      ensureDirectory: async (path) => { calls.push(path); }
    }));
    const repository = new ProjectRepository(runtime, "v2");

    await repository.materializeCanonicalDerivatives(projectRecord(), {
      publishReceipt: false,
      projectionVersion: 1
    });

    expect(calls).toEqual([]);
  });

  it("creates missing directory ancestors in order and succeeds idempotently when the folder already exists", async () => {
    const created: string[] = [];
    let idempotentPass = false;
    let targetAttempts = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        const body = JSON.parse(await request.text()) as { path: string };
        created.push(body.path);
        if (idempotentPass) {
          return new Response(JSON.stringify({ error_summary: "path/conflict/folder/" }), { status: 409 });
        }
        if (body.path.endsWith("/REFERENCES/UNCLASSIFIED")) {
          targetAttempts += 1;
          if (targetAttempts === 1) {
            return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
          }
          return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
        }
        if (body.path.endsWith("/REFERENCES")) {
          return Response.json({ metadata: { ".tag": "folder", path_display: body.path } });
        }
        throw new Error(`Unexpected create path: ${body.path}`);
      }
      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
    const target = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/REFERENCES/UNCLASSIFIED";
    await client.ensureDirectory(target);
    expect(created).toEqual([target, target.replace(/\/UNCLASSIFIED$/, ""), target]);

    created.length = 0;
    idempotentPass = true;
    await client.ensureDirectory(target);
    expect(created).toEqual([target]);
  });

  it("fails closed when a file occupies the directory path", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/oauth2/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.hostname === "api.dropboxapi.com" && url.pathname === "/2/files/create_folder_v2") {
        return new Response(JSON.stringify({ error_summary: "path/conflict/file/" }), {
          status: 409,
          headers: { "x-dropbox-request-id": "req-file-collision" }
        });
      }
      throw new Error(`Unhandled request: ${request.method} ${request.url}`);
    });

    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
    await expect(client.ensureDirectory("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-7001-activation/INPUTS"))
      .rejects.toBeInstanceOf(DropboxConflictError);
  });
});
