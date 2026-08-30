import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import {
  machineProjectGovernanceProfilePath,
  machineRegistryJsonPath,
  machineRegistryMarkdownPath
} from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-30T08:15:00+01:00";

describe("RegistryGuard governance-aware human index", () => {
  beforeEach(() => installDropboxMock());
  afterEach(() => vi.restoreAllMocks());

  it("loads durable project governance for PROJECT_INDEX without changing canonical registry JSON", async () => {
    const mock = installDropboxMock();
    const registry = testEnv.REGISTRY_GUARD.getByName("global");
    const create = await registry.fetch("https://registry-guard.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-REG-GOV-RENDER-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: at,
        payload: {
          name: "Governance render probe",
          slug: "governance-render-probe",
          aliases: [],
          objective: "Verify human registry kind rendering"
        }
      })
    });
    const receipt = await create.json<Receipt>();
    expect(receipt.status).toBe("committed");

    mock.files.set(
      machineProjectGovernanceProfilePath(receipt.project_id),
      `${JSON.stringify({
        schema_version: "1.0",
        project_id: receipt.project_id,
        project_kind: "synthetic_probe",
        authorization_id: "PCAUTH-EEEEEEEEEEEEEEEEEEEEEEEE",
        improvement_package_id: "IMP-GOV001",
        created_at: at
      }, null, 2)}\n`
    );

    const sync = await registry.fetch("https://registry-guard.internal/sync-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: receipt.project_id, status: "paused", updated_at: at })
    });
    expect(sync.status).toBe(200);

    const humanIndex = mock.files.get(machineRegistryMarkdownPath()) ?? "";
    expect(humanIndex).toContain(`**${receipt.project_id}** [synthetic]`);

    const canonical = JSON.parse(mock.files.get(machineRegistryJsonPath()) ?? "{}") as {
      projects?: Array<Record<string, unknown>>;
    };
    const entry = canonical.projects?.find((project) => project.project_id === receipt.project_id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("project_kind");
  });
});
