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
  machineStatePath,
  machineTransactionRequestIntentPath
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
  it("does not call an admitted transaction committed before its canonical record exists", async () => {
    const projectId = "PRJ-8391";
    const { guard } = await setup(projectId);
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-EXECUTION-8391-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: "2026-09-20T08:00:00.000Z",
      payload: { task_id: "TASK-EXECUTION8391A", title: "Admission without a commit" }
    };
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "writeCommitRecord").mockRejectedValueOnce(new Error("commit_write_unavailable"));
      restore = () => spy.mockRestore();
    });
    await expect(guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
    })).rejects.toThrow("commit_write_unavailable");
    restore();
    const receiptRead = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(receiptRead.status).toBe(503);
    await expect(receiptRead.json()).resolves.toMatchObject({
      project_id: projectId, kind: "transaction", request_id: transaction.transaction_id, status: "unknown",
      observation: { status: "unknown", recovery: { action: "check_status" } }
    });
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await status.json()).toMatchObject({ status: "admitted_uncommitted", recovery: { durable_intent: true } });
    await runDurableObjectAlarm(guard);
    const committed = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await committed.json()).toMatchObject({ status: "committed", receipt: { new_revision: 2 } });
  });
  it("labels historical admission without exact request bytes as unrecoverable", async () => {
    const projectId = "PRJ-8392";
    const { guard, mock } = await setup(projectId);
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-EXECUTION-8392-TASK-A", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: "2026-09-20T08:00:00.000Z",
      payload: { task_id: "TASK-EXECUTION8392A", title: "Historical admission" }
    };
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    let restore!: () => void;
    await runInDurableObject(guard, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const spy = vi.spyOn(repository, "writeCommitRecord").mockRejectedValueOnce(new Error("commit_write_unavailable"));
      restore = () => spy.mockRestore();
    });
    await expect(guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
    })).rejects.toThrow("commit_write_unavailable");
    restore();
    mock.files.delete(machineTransactionRequestIntentPath(projectId, transaction.transaction_id));
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM request_recovery_payload WHERE kind = 'transaction' AND request_id = ?", transaction.transaction_id);
      state.storage.sql.exec("DELETE FROM request_recovery WHERE kind = 'transaction' AND request_id = ?", transaction.transaction_id);
    });
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await status.json()).toMatchObject({ status: "admitted_uncommitted", recovery: { durable_intent: false, recoverable: false, code: "recovery_unavailable" } });
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('transaction', ?)", transaction.transaction_id);
      state.storage.sql.exec(
        "INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message) VALUES ('transaction', ?, ?, 6, 1, 'unavailable')",
        transaction.transaction_id, "a".repeat(64)
      );
    });
    const blocked = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await blocked.json()).toMatchObject({ status: "recovery_blocked", recovery: { attempts: 6 } });
  });
  it("serves fresh canonical context while a separate serialized operation is waiting", async () => {
    const projectId = "PRJ-8310";
    const { guard } = await setup(projectId);
    await runInDurableObject(guard, (instance) => {
      vi.spyOn(instance as any, "serialize").mockRejectedValue(new Error("serialized_operation_busy"));
    });
    const response = await guard.fetch("https://project-guard.internal/mutation-context");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canonical_state: { project_id: projectId, revision: 1 } });
  });

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

  it("keeps artifact finalization recoverable when receipt persistence is interrupted", async () => {
    const projectId = "PRJ-8290";
    const { guard } = await setup(projectId);
    const content = "# Receipt recovery\n";
    const request = {
      request_id: "ART-EXECUTION-RECEIPT-0001",
      project_id: projectId,
      relative_path: "proofs/receipt-recovery.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    let restoreReceipt!: () => void;
    await runInDurableObject(guard, (instance) => {
      const repository = (instance as unknown as { repository: ProjectRepository }).repository;
      const writeReceipt = vi.spyOn(repository, "writeArtifactReceipt")
        .mockRejectedValueOnce(new Error("receipt_store_temporarily_unavailable"));
      restoreReceipt = () => writeReceipt.mockRestore();
    });
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const interrupted = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(interrupted.status).toBe(503);
    await expect(interrupted.json()).resolves.toMatchObject({
      status: "pending",
      code: "ARTIFACT_FINALIZATION_SCHEDULED",
      request_id: request.request_id
    });
    restoreReceipt();

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const finalized = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    await expect(finalized.json()).resolves.toMatchObject({ status: "finalized", terminal: true, code: null });
  });

  it("does not expose a global receipt through another project status view", async () => {
    const leftProjectId = "PRJ-8294";
    const rightProjectId = "PRJ-8295";
    const { guard: left } = await setup(leftProjectId);
    const record = commitFixture(rightProjectId, 1)[0]!;
    const runtime = createProductionPersistence(testEnv);
    await runtime.objects.upsertText(machineCommitRecordPath(rightProjectId, 1), JSON.stringify(record));
    await runtime.objects.upsertText(machineStatePath(rightProjectId), JSON.stringify(record.state));
    const right = testEnv.PROJECT_GUARD.getByName(rightProjectId);
    await runInDurableObject(right, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [rightProjectId]: "strict" }), MUTATION_CONTEXT_SIGNING_KEY: "exec-guard-context", RULE_ADMISSION_SIGNING_KEY: "exec-guard-admission"
    }));

    const { context } = await (await left.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const transactionId = "TXN-8294000001";
    const committed = await left.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      body: JSON.stringify(encodeAdmission({
        schema_version: "1.0", transaction_id: transactionId, project_id: leftProjectId, base_revision: 1,
        operation: "task.create", created_at: "2026-09-12T00:00:00.000Z", payload: { task_id: "TASK-8294", title: "Private receipt" }
      }, context))
    });
    expect(await committed.json()).toMatchObject({ status: "committed", project_id: leftProjectId });

    const hidden = await right.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transactionId}`);
    await expect(hidden.json()).resolves.toMatchObject({
      project_id: rightProjectId,
      status: "not_received"
    });

    const content = "private artifact receipt";
    const { context: artifactContext } = await (await left.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const artifact = {
      request_id: "ART-EXECUTION-PRIVATE-8294",
      project_id: leftProjectId,
      relative_path: "proofs/private-receipt.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create"
    };
    const artifactCommitted = await left.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(artifact, artifactContext))
    });
    await expect(artifactCommitted.json()).resolves.toMatchObject({ status: "committed", project_id: leftProjectId });
    const hiddenArtifact = await right.fetch(
      `https://project-guard.internal/request-status?kind=artifact&request_id=${artifact.request_id}`
    );
    await expect(hiddenArtifact.json()).resolves.toMatchObject({
      project_id: rightProjectId,
      status: "not_received"
    });
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
    expect(await status.json()).toMatchObject({ status: "admitted", terminal: false, code: null });
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

  it("certifies a committed revision covered by a verified historical projection jump", async () => {
    const projectId = "PRJ-8299";
    const { guard } = await setup(projectId);
    const requestIds: string[] = [];
    for (let revision = 2; revision <= 7; revision += 1) {
      const requestId = `TXN-EXECUTION-8299-${revision}`;
      requestIds.push(requestId);
      const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
      const { context } = await contextResponse.json<{ context: never }>();
      const transaction = {
        schema_version: "1.0", transaction_id: requestId, project_id: projectId,
        base_revision: revision - 1, operation: "research.add", created_at: "2026-09-20T18:00:00.000Z",
        payload: { research_id: `RES-HIST${revision}`, title: `Historical jump ${revision}`, body: "Canonical evidence" }
      };
      const committed = await guard.fetch("https://project-guard.internal/transaction", {
        method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
      });
      expect(await committed.json()).toMatchObject({ status: "committed", new_revision: revision });
    }

    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const baseline = await repository.readCommitRecord(projectId, 1);
    const record = await repository.readCommitRecord(projectId, 7);
    if (!baseline || !record) throw new Error("expected_historical_jump_record");
    await repository.writeCompletedMaterializationRecord({
      schema_version: "1.0", project_id: projectId, target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "c".repeat(64),
      coalesced_revisions: [], source_event_id: baseline.event.event_id, completed_at: "2026-09-20T17:59:00.000Z"
    });
    const materialization: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: projectId, target_revision: 7, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "d".repeat(64),
      // This is historical data from before gap coverage was recorded. The
      // complete canonical jump still physically reflects revision 2.
      coalesced_revisions: [3, 4, 5, 6], source_event_id: record.event.event_id,
      completed_at: "2026-09-20T18:01:00.000Z"
    };
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 7, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 7, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });
    // A callback may have completed its old scan before this coverage repair
    // is deployed. Its persisted cursor must be rebuilt, not trusted forever.
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-work", {
        head: {
          target_revision: 7,
          projection_version: CURRENT_PROJECTION_VERSION,
          result_root_hash: materialization.result_root_hash,
          completed_at: materialization.completed_at
        },
        next_generation: null,
        previous_child: null,
        scan_complete: true,
        candidates: []
      });
    });

    let finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 7, projection_version: CURRENT_PROJECTION_VERSION })
    });
    while (finalization.status === 202) {
      finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_revision: 7, projection_version: CURRENT_PROJECTION_VERSION })
      });
    }
    expect(finalization.status).toBe(200);
    const status = await guard.fetch(`https://project-guard.internal/execution-status?kind=transaction&request_id=${requestIds[0]}`);
    expect(await status.json()).toMatchObject({ status: "finalized", terminal: true, code: null, finalization_ref: expect.any(String) });
  });

  it("does not infer historical coverage from a generation without a partial coalescence record", async () => {
    const projectId = "PRJ-8300";
    const { guard } = await setup(projectId);
    const requestIds: string[] = [];
    for (let revision = 2; revision <= 4; revision += 1) {
      const requestId = `TXN-EXECUTION-8300-${revision}`;
      requestIds.push(requestId);
      const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context"))
        .json<{ context: never }>();
      const transaction = {
        schema_version: "1.0", transaction_id: requestId, project_id: projectId,
        base_revision: revision - 1, operation: "research.add", created_at: "2026-09-20T18:10:00.000Z",
        payload: { research_id: `RES-NOINFER${revision}`, title: `No inferred coverage ${revision}`, body: "Canonical evidence" }
      };
      const committed = await guard.fetch("https://project-guard.internal/transaction", {
        method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
      });
      expect(await committed.json()).toMatchObject({ status: "committed", new_revision: revision });
    }

    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const baseline = await repository.readCommitRecord(projectId, 1);
    const record = await repository.readCommitRecord(projectId, 4);
    if (!baseline || !record) throw new Error("expected_uncoalesced_jump_record");
    await repository.writeCompletedMaterializationRecord({
      schema_version: "1.0", project_id: projectId, target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "e".repeat(64),
      coalesced_revisions: [], source_event_id: baseline.event.event_id, completed_at: "2026-09-20T18:09:00.000Z"
    });
    const materialization: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "f".repeat(64),
      coalesced_revisions: [], source_event_id: record.event.event_id, completed_at: "2026-09-20T18:11:00.000Z"
    };
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 4, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });

    let finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION })
    });
    while (finalization.status === 202) {
      finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION })
      });
    }
    expect(finalization.status).toBe(200);
    const status = await guard.fetch(`https://project-guard.internal/execution-status?kind=transaction&request_id=${requestIds[0]}`);
    expect(await status.json()).toMatchObject({ status: "finalizing", terminal: false, code: "MATERIALIZATION_PENDING", finalization_ref: null });
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

    const context272Response = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context: context272 } = await context272Response.json<{ context: never }>();
    const transaction272 = {
      schema_version: "1.0", transaction_id: "TXN-PRJ0003-TASK-A03FOLLOWUP-CREATE-20260913T160600Z-W8K4",
      project_id: projectId, base_revision: 271, operation: "task.create", created_at: "2026-09-13T16:06:00.000Z",
      payload: { task_id: "TASK-A03FOLLOWUP", title: "Follow-up after coalescence" }
    };
    const committed272 = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction272, context272))
    });
    expect(await committed272.json()).toMatchObject({ status: "committed", new_revision: 272 });

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
    const record272 = await repository.readCommitRecord(projectId, 272);
    if (!record272) throw new Error("expected_descendant_record");
    const descendant: CompletedMaterializationRecord = {
      schema_version: "1.0", project_id: projectId, target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION },
      chain_depth: 2, workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "c".repeat(64), coalesced_revisions: [],
      source_event_id: record272.event.event_id, completed_at: "2026-09-13T16:06:30.000Z"
    };
    await repository.writeCompletedMaterializationRecord(descendant);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 272, CURRENT_PROJECTION_VERSION),
      result_root_hash: descendant.result_root_hash, completed_at: descendant.completed_at
    });

    mock.files.set(
      machineMaterializationRecordPath(projectId, 272, CURRENT_PROJECTION_VERSION),
      JSON.stringify({ ...descendant, chain_depth: 1 })
    );
    const malformedWake = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(malformedWake.status).toBe(409);
    await expect(malformedWake.json()).resolves.toEqual({ error: "materialization_chain_invalid" });
    mock.files.set(
      machineMaterializationRecordPath(projectId, 272, CURRENT_PROJECTION_VERSION),
      JSON.stringify(descendant)
    );
    mock.files.set(
      machineMaterializationRecordPath(projectId, 271, 4),
      JSON.stringify({ ...successor, projection_version: 4 })
    );
    mock.files.set(
      machineMaterializationRecordPath(projectId, 272, CURRENT_PROJECTION_VERSION),
      JSON.stringify({ ...descendant, parent: { target_revision: 271, projection_version: 4 } })
    );
    const crossVersionWake = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(crossVersionWake.status).toBe(409);
    await expect(crossVersionWake.json()).resolves.toEqual({ error: "materialization_chain_invalid" });
    mock.files.set(
      machineMaterializationRecordPath(projectId, 272, CURRENT_PROJECTION_VERSION),
      JSON.stringify(descendant)
    );

    // A published head can have a long, valid delta lineage. Finalization
    // must stay bounded: the MaterializationGuard will immediately call back
    // until the historical, coalesced work is fully certified.
    let longParent = { target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION };
    for (const revision of [273, 274, 275, 276]) {
      const longDescendant: CompletedMaterializationRecord = {
        schema_version: "1.0", project_id: projectId, target_revision: revision, projection_version: CURRENT_PROJECTION_VERSION,
        record_kind: "delta", parent: longParent, chain_depth: revision - 270, workspace_location: "active",
        outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: String(revision).repeat(64).slice(0, 64),
        coalesced_revisions: [], source_event_id: `EVT-${String(revision).padStart(6, "0")}`,
        completed_at: "2026-09-13T16:07:00.000Z"
      };
      await repository.writeCompletedMaterializationRecord(longDescendant);
      longParent = { target_revision: revision, projection_version: CURRENT_PROJECTION_VERSION };
    }
    const longHead = await repository.readMaterializationRecord(projectId, 276, CURRENT_PROJECTION_VERSION);
    if (!longHead) throw new Error("expected_long_materialization_head");
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 276, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 276, CURRENT_PROJECTION_VERSION),
      result_root_hash: longHead.result_root_hash, completed_at: longHead.completed_at
    });

    const firstWake = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 276, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(firstWake.status).toBe(202);
    expect(await firstWake.json()).toMatchObject({ finalization_pending: true });

    let wake = firstWake;
    for (let attempt = 0; attempt < 8 && wake.status === 202; attempt += 1) {
      wake = await guard.fetch("https://project-guard.internal/finalize-materialization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_revision: 276, projection_version: CURRENT_PROJECTION_VERSION })
      });
    }
    expect(wake.status).toBe(200);

    for (const requestId of [transaction270.transaction_id, transaction271.transaction_id, transaction272.transaction_id]) {
      const journal = new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "transaction", requestId);
      expect(await journal.status()).toMatchObject({ status: "finalized", terminal: true, code: null });
    }
  });

  it("bounds every examined finalization candidate, including missing commits", async () => {
    const projectId = "PRJ-8298";
    const { guard } = await setup(projectId);
    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const completed: CompletedMaterializationRecord = {
      schema_version: "1.0",
      project_id: projectId,
      target_revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot",
      parent: null,
      chain_depth: 0,
      workspace_location: "active",
      outputs: {},
      removed_outputs: [],
      total_output_count: 0,
      result_root_hash: "a".repeat(64),
      coalesced_revisions: [],
      source_event_id: "EVT-000001",
      completed_at: "2026-09-24T08:00:00.000Z"
    };
    await repository.writeCompletedMaterializationRecord(completed);
    await repository.writeMaterializationHead({
      schema_version: "1.0",
      project_id: projectId,
      target_revision: completed.target_revision,
      projection_version: completed.projection_version,
      workspace_location: completed.workspace_location,
      record_path: machineMaterializationRecordPath(projectId, completed.target_revision, completed.projection_version),
      result_root_hash: completed.result_root_hash,
      completed_at: completed.completed_at
    });
    const candidates = [9001, 9002, 9003, 9004, 9005].map((revision) => ({
      revision,
      coverage: "explicit" as const,
      materialization_revision: completed.target_revision,
      projection_version: completed.projection_version,
      result_root_hash: completed.result_root_hash,
      completed_at: completed.completed_at,
      source_event_id: completed.source_event_id
    }));
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-work", {
        coverage_version: 2,
        head: {
          target_revision: completed.target_revision,
          projection_version: completed.projection_version,
          result_root_hash: completed.result_root_hash,
          completed_at: completed.completed_at
        },
        next_generation: null,
        previous_child: null,
        scan_complete: true,
        candidates
      });
    });

    const response = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { finalizeCurrentMaterialization(request: Request): Promise<Response> })
        .finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
        }))
    );

    expect(response.status).toBe(202);
    await runInDurableObject(guard, async (_instance, state) => {
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      expect(work?.candidates).toEqual([expect.objectContaining({ revision: 9005 })]);
    });
  });
});
