import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { issueProjectCreateAuthorization } from "../src/governance/project-create-authorization";
import { GovernanceRepository } from "../src/governance/repository";
import {
  machineProjectCreateAuthorizationConsumptionPath,
  machineProjectGovernanceProfilePath
} from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const mutableEnv = testEnv as Env & {
  PROJECT_OS_PROJECT_CREATE_AUTH_MODE?: "observe" | "enforce";
  PROJECT_OS_PROJECT_CREATE_AUTH_FRONTIER?: string;
};
const createdAt = "2026-08-30T09:00:00.000Z";

function authorizationId(sequence: number): string {
  return `PCAUTH-REGISTRY-${sequence.toString().padStart(12, "0")}`;
}

function createRequest(
  sequence: number,
  options: {
    authorization_id?: string;
    name?: string;
    slug?: string;
    objective?: string;
  } = {}
) {
  return {
    schema_version: "1.0",
    transaction_id: `TXN-REGAUTH-${sequence.toString().padStart(6, "0")}`,
    project_id: "PRJ-AUTO",
    base_revision: 0,
    operation: "project.create",
    created_at: createdAt,
    payload: {
      name: options.name ?? `Authorized ${sequence}`,
      slug: options.slug ?? `authorized-${sequence}`,
      aliases: [`auth-${sequence}`],
      objective: options.objective ?? `Authorized objective ${sequence}`,
      ...(options.authorization_id ? { authorization_id: options.authorization_id } : {}),
      project_kind: "real" as const
    }
  };
}

async function issueMatchingAuthorization(
  sequence: number,
  tx: ReturnType<typeof createRequest>,
  timing: "live" | "expired" = "live"
): Promise<string> {
  const id = authorizationId(sequence);
  const now = Date.now();
  const issuedAt = timing === "live"
    ? new Date(now - 60_000).toISOString()
    : new Date(now - 31 * 60_000).toISOString();
  const expiresAt = timing === "live"
    ? new Date(now + 20 * 60_000).toISOString()
    : new Date(now - 60_000).toISOString();
  const repository = new GovernanceRepository(createProductionPersistence(testEnv));
  await issueProjectCreateAuthorization(repository, {
    schema_version: "1.0",
    authorization_id: id,
    name: tx.payload.name,
    slug: tx.payload.slug,
    aliases: [...tx.payload.aliases],
    objective: tx.payload.objective,
    project_kind: "real",
    issued_at: issuedAt,
    expires_at: expiresAt
  });
  return id;
}

async function createProjectResponse(transaction: unknown): Promise<Response> {
  return testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
}

async function createProject(transaction: unknown): Promise<Receipt> {
  const response = await createProjectResponse(transaction);
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("RegistryGuard project-create authorization", () => {
  let faults: DropboxMockFault[];
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => {
    faults = [];
    dropbox = installDropboxMock({ faults });
    mutableEnv.PROJECT_OS_PROJECT_CREATE_AUTH_MODE = "enforce";
    mutableEnv.PROJECT_OS_PROJECT_CREATE_AUTH_FRONTIER = "task4-test";
  });

  afterEach(() => {
    mutableEnv.PROJECT_OS_PROJECT_CREATE_AUTH_MODE = "observe";
    delete mutableEnv.PROJECT_OS_PROJECT_CREATE_AUTH_FRONTIER;
    vi.restoreAllMocks();
  });

  it("rejects a new project allocation without independent authorization", async () => {
    const receipt = await createProject(createRequest(1));
    expect(receipt.status).toBe("rejected");
    expect(receipt.code).toBe("PROJECT_CREATE_AUTHORIZATION_REQUIRED");
    expect(receipt.project_id).toBe("PRJ-AUTO");
  });

  it("rejects an authorization whose bound project payload does not match", async () => {
    const original = createRequest(2);
    const id = await issueMatchingAuthorization(2, original);
    const mismatched = createRequest(2, {
      authorization_id: id,
      objective: "Changed after approval"
    });

    const receipt = await createProject(mismatched);
    expect(receipt.status).toBe("rejected");
    expect(receipt.code).toBe("PROJECT_CREATE_AUTHORIZATION_MISMATCH");
  });

  it("rejects an expired authorization before allocating a project ID", async () => {
    const original = createRequest(3);
    const id = await issueMatchingAuthorization(3, original, "expired");
    const receipt = await createProject(createRequest(3, { authorization_id: id }));

    expect(receipt.status).toBe("rejected");
    expect(receipt.code).toBe("PROJECT_CREATE_AUTHORIZATION_EXPIRED");
    expect(receipt.project_id).toBe("PRJ-AUTO");
  });

  it("consumes authorization once and preserves exact committed replay", async () => {
    const firstRequest = createRequest(4);
    const id = await issueMatchingAuthorization(4, firstRequest);
    const authorized = createRequest(4, { authorization_id: id });

    const first = await createProject(authorized);
    expect(first.status).toBe("committed");

    const replay = await createProject(authorized);
    expect(replay).toEqual(first);

    const second = await createProject({
      ...createRequest(5, { authorization_id: id }),
      payload: {
        ...createRequest(5, { authorization_id: id }).payload,
        name: firstRequest.payload.name,
        slug: `${firstRequest.payload.slug}-second`,
        aliases: ["different-alias"],
        objective: firstRequest.payload.objective
      }
    });
    expect(second.status).toBe("rejected");
    expect(second.code).toBe("PROJECT_CREATE_AUTHORIZATION_CONSUMED");
  });

  it("recovers the same allocated project and governance profile after a post-allocation failure", async () => {
    const original = createRequest(20);
    const id = await issueMatchingAuthorization(20, original);
    const authorized = createRequest(20, { authorization_id: id });
    const reservedProjectId = "PRJ-0001";
    faults.push({
      endpoint: "/2/files/upload",
      path: machineProjectGovernanceProfilePath(reservedProjectId),
      occurrence: 1,
      status: 409,
      error_summary: "path/conflict/file/injected_profile_failure"
    });

    let failed = false;
    try {
      const response = await createProjectResponse(authorized);
      failed = !response.ok;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(dropbox.files.has(machineProjectCreateAuthorizationConsumptionPath(id))).toBe(true);
    expect(dropbox.files.has(machineProjectGovernanceProfilePath(reservedProjectId))).toBe(false);

    const competing = await createProject({
      ...authorized,
      transaction_id: "TXN-REGAUTH-000020-COMPETING"
    });
    expect(competing.status).toBe("rejected");
    expect(competing.code).toBe("PROJECT_CREATE_AUTHORIZATION_CONSUMED");

    const replay = await createProject(authorized);
    expect(replay.status).toBe("committed");
    expect(replay.project_id).toBe(reservedProjectId);
    expect(dropbox.files.has(machineProjectGovernanceProfilePath(reservedProjectId))).toBe(true);
  });
});
