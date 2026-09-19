import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { CompletedMaterializationRecord } from "../src/domain/materialization";
import { applyTransaction } from "../src/domain/transitions";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { ProjectState } from "../src/domain/project-state";
import {
  machineCommitRecordPath,
  machineMaterializationRecordPath,
  machineStatePath
} from "../src/persistence/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { encodeAdmission } from "../src/admission/transport";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { ExecutionJournal } from "../src/execution/journal";
import { sha256Text } from "../src/documents/hash";

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

function taskCompletionBaseline(projectId: string): CanonicalCommitRecord {
  let state: ProjectState | null = null;
  for (let revision = 1; revision <= 268; revision += 1) {
    const transaction = revision === 1
      ? {
          schema_version: "1.0" as const,
          transaction_id: `TXN-EXECUTION-${projectId}-CREATE`,
          project_id: projectId,
          base_revision: 0,
          operation: "project.create" as const,
          created_at: "2026-09-13T14:00:00.000Z",
          payload: { name: "Execution finalization", slug: "execution-finalization", aliases: [], objective: "Prove typed receipt finalization" }
        }
      : revision === 268
        ? {
            schema_version: "1.0" as const,
            transaction_id: "TXN-PRJ0003-TASK-A02S2DEV-RETIRE-20260913T140100Z-L4T7",
            project_id: projectId,
            base_revision: 267,
            operation: "task.create" as const,
            created_at: "2026-09-13T14:01:00.000Z",
            payload: { task_id: "TASK-A02S2DEV", title: "Retire obsolete execution" }
          }
        : {
            schema_version: "1.0" as const,
            transaction_id: `TXN-EXECUTION-${projectId}-RESEARCH-${String(revision).padStart(4, "0")}`,
            project_id: projectId,
            base_revision: revision - 1,
            operation: "research.add" as const,
            created_at: "2026-09-13T14:00:00.000Z",
            payload: { research_id: `RES-EXEC${String(revision).padStart(4, "0")}`, title: `Evidence ${revision}`, body: "Synthetic canonical history" }
          };
    const result = applyTransaction(state, transaction);
    if (result.kind !== "commit") throw new Error(`task_completion_baseline_${result.kind}`);
    state = result.state;
    if (revision === 268) {
      return {
        schema_version: "1.0", project_id: projectId, previous_revision: 267, new_revision: 268,
        transaction, state: result.state, event: result.event,
        receipt: {
          schema_version: "1.0", transaction_id: transaction.transaction_id, status: "committed",
          project_id: projectId, previous_revision: 267, new_revision: 268,
          event_id: result.event.event_id, committed_at: transaction.created_at
        }
      };
    }
  }
  throw new Error("task_completion_baseline_missing");
}

describe("canonical execution boundary in ProjectGuard", () => {
  it("finalizes a committed artifact from its frozen intent and verified provider effect, including exact replay", async () => {
    const projectId = "PRJ-8288";
    const { guard, mock } = await setup(projectId);
    const content = "# Verified artifact\n";
    const request = {
      request_id: "ART-EXECUTION-FINAL-0001",
      project_id: projectId,
      relative_path: "proofs/verified.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    const first = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await first.json()).toMatchObject({ status: "committed", request_id: request.request_id });
    expect([...mock.files.keys()].some((path) => path.includes("/executions/") && path.includes("/finalizations/"))).toBe(true);

    const status = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    const finalized = await status.json<{ finalization_ref: string }>();
    expect(finalized).toMatchObject({ status: "finalized", terminal: true, code: null, finalization_ref: expect.any(String) });
    expect(JSON.parse(mock.files.get(finalized.finalization_ref) ?? "{}")).toMatchObject({
      request_id: request.request_id,
      content_sha256: request.content_sha256,
      receipt_ref: `/PROJECT_OS/.project-os/artifacts/receipts/${request.request_id}.json`,
      mutation_intent_ref: `/PROJECT_OS/.project-os/projects/${projectId}/mutation-gate/intents/artifacts/${request.request_id}.json`
    });

    const replay = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await replay.json()).toMatchObject({ status: "committed", request_id: request.request_id });
    const replayStatus = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    expect(await replayStatus.json()).toMatchObject({ status: "finalized", terminal: true, finalization_ref: finalized.finalization_ref });
  });

  it("keeps a committed artifact pending when a status read observes a newly restored effect", async () => {
    const projectId = "PRJ-8289";
    const { guard, mock } = await setup(projectId);
    const content = "# Recoverable proof\n";
    const request = {
      request_id: "ART-EXECUTION-PENDING-0001",
      project_id: projectId,
      relative_path: "proofs/pending.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    let restoreStatus!: () => void;
    await runInDurableObject(guard, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "artifactStatus").mockResolvedValue({
        request_id: request.request_id, project_id: projectId, intent_id: "intent:pending",
        destination_path: "/pending", gate_mode: "enforce", verification_state: "committed", receipt_status: "committed"
      });
      restoreStatus = () => spy.mockRestore();
    });
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    const response = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ status: "committed" });
    restoreStatus();
    const visiblePath = [...mock.files.keys()].find((path) => path.endsWith("/ARTIFACTS/proofs/pending.md"));
    expect(visiblePath).toBeDefined();
    mock.files.delete(visiblePath!);

    const pending = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    expect(await pending.json()).toMatchObject({ status: "finalizing", terminal: false, code: "MATERIALIZATION_PENDING", finalization_ref: null });
    mock.files.set(visiblePath!, content);
    const observed = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    expect(await observed.json()).toMatchObject({ status: "finalizing", terminal: false, code: "MATERIALIZATION_PENDING", finalization_ref: null });

    // Reading stays observational. The existing committed effect is certified
    // by the ProjectGuard alarm, without another artifact submission.
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const finalized = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    expect(await finalized.json()).toMatchObject({ status: "finalized", terminal: true, code: null, finalization_ref: expect.any(String) });
  });

  it("persists server admission before recovery and exposes incomplete execution independently of historical receipts", async () => {
    const { guard, mock } = await setup("PRJ-8291");
    const response = await guard.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    expect(response.status).toBe(200);
    const evidence = [...mock.files.entries()].find(([path]) => path.includes("/executions/") && path.endsWith("/admission.json"));
    expect(evidence).toBeDefined();
    expect(JSON.parse(evidence![1]).admission).toMatchObject({ project_id: "PRJ-8291", operation: "input.recover", actor: { authority: "durable_object" }, verdict: "allow" });
    const status = await guard.fetch("https://project-guard.internal/execution-status?kind=recovery&request_id=input-recovery%401");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "committed", terminal: false, code: "MATERIALIZATION_PENDING" });
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

  it("finalizes task.complete 268 to 269 only from its committed record and current materialization proof", async () => {
    const projectId = "PRJ-8301";
    const mock = installDropboxMock();
    const baseline = taskCompletionBaseline(projectId);
    mock.files.set(machineCommitRecordPath(projectId, 268), JSON.stringify(baseline));
    mock.files.set(machineStatePath(projectId), JSON.stringify(baseline.state));
    const guard = testEnv.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }), MUTATION_CONTEXT_SIGNING_KEY: "execution-finalization-context", RULE_ADMISSION_SIGNING_KEY: "execution-finalization-admission"
    }));
    await bootstrapRuleAdmissionGovernance(testEnv, "execution-finalization-admission", projectId);

    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-PRJ0003-TASK-A02S2DEV-RETIRE-20260913T140200Z-L4T7",
      project_id: projectId, base_revision: 268, operation: "task.complete", created_at: "2026-09-13T14:02:00.000Z",
      payload: { task_id: "TASK-A02S2DEV", result: "retired" }
    };
    const committed = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
    });
    expect(await committed.json()).toMatchObject({ status: "committed", previous_revision: 268, new_revision: 269 });

    const pending = await guard.fetch("https://project-guard.internal/execution-status?kind=transaction&request_id=TXN-PRJ0003-TASK-A02S2DEV-RETIRE-20260913T140200Z-L4T7");
    expect(await pending.json()).toMatchObject({ status: "finalizing", terminal: false, code: "MATERIALIZATION_PENDING" });

    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const record = await repository.readCommitRecord(projectId, 269);
    if (!record) throw new Error("expected_task_complete_record");
    const materialization: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: projectId, target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "a".repeat(64),
      coalesced_revisions: [], source_event_id: record.event.event_id, completed_at: "2026-09-13T14:03:00.000Z"
    };
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 269, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });
    const writesBeforeFinalization = mock.uploadCalls.length;

    const finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(finalization.status).toBe(200);
    const finalized = await guard.fetch("https://project-guard.internal/execution-status?kind=transaction&request_id=TXN-PRJ0003-TASK-A02S2DEV-RETIRE-20260913T140200Z-L4T7");
    const execution = await finalized.json<{ finalization_ref: string }>();
    expect(execution).toMatchObject({ status: "finalized", terminal: true, code: null, finalization_ref: expect.any(String) });
    expect(JSON.parse(mock.files.get(execution.finalization_ref) ?? "{}")).toMatchObject({
      canonical_commit_ref: machineCommitRecordPath(projectId, 269),
      receipt_ref: `${machineCommitRecordPath(projectId, 269)}#receipt`,
      materialization_record_ref: machineMaterializationRecordPath(projectId, 269, CURRENT_PROJECTION_VERSION),
      source_event_id: record.event.event_id,
      result_root_hash: materialization.result_root_hash
    });
    expect(mock.uploadCalls.slice(writesBeforeFinalization).every((path) => path.includes("/executions/"))).toBe(true);

    const context270Response = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context: context270 } = await context270Response.json<{ context: never }>();
    const transaction270 = {
      schema_version: "1.0", transaction_id: "TXN-PRJ0003-TASK-A03RESEARCHFINAL-CREATE-20260913T160300Z-Q7N5",
      project_id: projectId, base_revision: 269, operation: "task.create", created_at: "2026-09-13T16:03:00.000Z",
      payload: { task_id: "TASK-A03RESEARCHFINAL", title: "Finalize research" }
    };
    const committed270 = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction270, context270))
    });
    expect(await committed270.json()).toMatchObject({ status: "committed", new_revision: 270 });

    const context271Response = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context: context271 } = await context271Response.json<{ context: never }>();
    const transaction271 = {
      schema_version: "1.0", transaction_id: "TXN-PRJ0003-TASK-A03RESEARCHFINAL-START-20260913T160450Z-H9C2",
      project_id: projectId, base_revision: 270, operation: "task.start", created_at: "2026-09-13T16:04:50.000Z",
      payload: { task_id: "TASK-A03RESEARCHFINAL" }
    };
    const committed271 = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction271, context271))
    });
    expect(await committed271.json()).toMatchObject({ status: "committed", new_revision: 271 });

    const record271 = await repository.readCommitRecord(projectId, 271);
    if (!record271) throw new Error("expected_coalesced_successor_record");
    const successor: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: projectId, target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION },
      chain_depth: 1, workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "b".repeat(64), coalesced_revisions: [270],
      source_event_id: record271.event.event_id, completed_at: "2026-09-13T16:05:00.000Z"
    };
    await repository.writeCompletedMaterializationRecord(successor);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 271, CURRENT_PROJECTION_VERSION),
      result_root_hash: successor.result_root_hash, completed_at: successor.completed_at
    });

    const wake = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(wake.status).toBe(200);
    expect(await wake.json()).toMatchObject({ finalized_revisions: [270, 271] });

    for (const requestId of [transaction270.transaction_id, transaction271.transaction_id]) {
      const journal = new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "transaction", requestId);
      expect(await journal.status()).toMatchObject({ status: "finalized", terminal: true, code: null });
    }
  });
});
