import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-09-12T12:00:00.000Z";

describe("SOP rule-admission rollout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a legacy project operational only before rule admission activation, then fails closed without global governance", async () => {
    installDropboxMock();
    const projectId = "PRJ-8199";
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    const create = { schema_version: "1.0", transaction_id: "TXN-8199000000", project_id: projectId, base_revision: 0, operation: "project.create", created_at: at, payload: { name: "Rollout", slug: "rollout", aliases: [], objective: "Rule admission" } };
    const first = await guard.fetch("https://project-guard.internal/transaction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) });
    expect(await first.json()).toMatchObject({ status: "committed", new_revision: 1 });

    await runInDurableObject(guard, instance => {
      const bindings = (instance as unknown as { env: Env }).env;
      bindings.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [projectId]: "strict" });
      bindings.MUTATION_CONTEXT_SIGNING_KEY = "synthetic-context-secret-for-vitest-only";
      bindings.RULE_ADMISSION_SIGNING_KEY = "synthetic-rule-admission-secret-for-vitest-only";
    });
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    expect(contextResponse.status).toBe(200);
    const { context } = await contextResponse.json<{ context: unknown }>();
    const task = { schema_version: "1.0", transaction_id: "TXN-8199000001", project_id: projectId, base_revision: 1, operation: "task.create", created_at: at, payload: { task_id: "TASK-8199", title: "Must be governed" } };
    const activated = await guard.fetch("https://project-guard.internal/transaction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(task, context as never)) });

    expect(activated.status).toBe(503);
    expect(await activated.json()).toMatchObject({ error: "GLOBAL_GOVERNANCE_UNAVAILABLE" });
  });
});
