import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineStatePath } from "../src/persistence/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { encodeAdmission } from "../src/admission/transport";

const testEnv = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
async function setup(projectId: string) {
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
    PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }), MUTATION_CONTEXT_SIGNING_KEY: "exec-guard-context", RULE_ADMISSION_SIGNING_KEY: "exec-guard-admission"
  }));
  await bootstrapRuleAdmissionGovernance(testEnv, "exec-guard-admission", projectId);
  return { mock, guard };
}

describe("canonical execution boundary in ProjectGuard", () => {
  it("persists server admission before recovery and exposes incomplete execution independently of historical receipts", async () => {
    const { guard, mock } = await setup("PRJ-8291");
    const response = await guard.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    expect(response.status).toBe(200);
    const evidence = [...mock.files.entries()].find(([path]) => path.includes("/executions/") && path.endsWith("/admission.json"));
    expect(evidence).toBeDefined();
    expect(JSON.parse(evidence![1]).admission).toMatchObject({ project_id: "PRJ-8291", operation: "input.recover", actor: { authority: "durable_object" }, verdict: "allow" });
    const status = await guard.fetch("https://project-guard.internal/execution-status?kind=recovery&request_id=input-recovery%401");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "committed", terminal: false, code: "FINALIZATION_ADAPTER_UNAVAILABLE" });
  });

  it("fails closed when the canonical admission cannot commit; no discovery/effect runs", async () => {
    const { guard, mock } = await setup("PRJ-8292");
    await runInDurableObject(guard, (instance) => {
      const runtime = (instance as unknown as { persistence: ProjectOsPersistenceRuntime }).persistence;
      const original = runtime.objects.createText.bind(runtime.objects);
      vi.spyOn(runtime.objects, "createText").mockImplementation((path, text) => path.includes("/executions/") ? Promise.reject(new Error("execution_store_unavailable")) : original(path, text));
    });
    const baseline = mock.calls.length;
    const response = await guard.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    expect(response.status).toBe(503);
    expect(mock.calls.slice(baseline).filter((call) => /files\/list_folder/.test(call))).toEqual([]);
  });

  it("does not admit a broad implicit project repair without diagnosed drift", async () => {
    const { guard } = await setup("PRJ-8293");
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "REPAIR_INTENT_REQUIRED" });
  });

  it("a typed repair still requires the authenticated L3 mutation context", async () => {
    const { guard } = await setup("PRJ-8296");
    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST", body: JSON.stringify({ project_id: "PRJ-8296", operation: "project.repair", request_id: "REPAIR-8296", base_revision: 1, diagnosed_drift_refs: ["drift:1"], resources: [{ resource_id: "DOC-EXACT", resource_type: "document", zone: "WORKING", version: "V1" }], action: { kind: "resume_committed", original_kind: "document", original_request_id: "REQ-8296", effect_plan_hash: "a".repeat(64) } }) });
    expect(response.status).toBe(428);
  });

  it("links a committed transaction receipt without claiming its projections finalized", async () => {
    const { guard } = await setup("PRJ-8298");
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    const tx = { schema_version: "1.0", project_id: "PRJ-8298", transaction_id: "TXN-8298000001", base_revision: 1, operation: "task.create", created_at: "2026-09-12T00:00:00.000Z", payload: { task_id: "TASK-8298", title: "Exact receipt" } };
    const response = await guard.fetch("https://project-guard.internal/transaction", { method: "POST", body: JSON.stringify(encodeAdmission(tx, context)) });
    expect(await response.json()).toMatchObject({ status: "committed", new_revision: 2 });
    const status = await guard.fetch("https://project-guard.internal/execution-status?kind=transaction&request_id=TXN-8298000001");
    expect(await status.json()).toMatchObject({ status: "finalizing", terminal: false, receipt_ref: expect.any(String) });
  });
});
