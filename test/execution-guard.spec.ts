import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import type { CompletedMaterializationRecord } from "../src/domain/materialization";
import { applyTransaction } from "../src/domain/transitions";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { ProjectState } from "../src/domain/project-state";
import { ProjectGuard } from "../src/durable/project-guard-neutral";
import {
  machineCommitRecordPath,
  machineDocumentRoot,
  machineMaterializationRecordPath,
  machineStatePath,
  machineTransactionRequestIntentPath
} from "../src/persistence/layout";
import { commitFixture, seedCommits } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { encodeAdmission } from "../src/admission/transport";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ProjectRepository } from "../src/persistence/repository";
import { ExecutionJournal } from "../src/execution/journal";
import { sha256Text } from "../src/documents/hash";
import { ZoneNavigationInventory } from "../src/documents/zone-navigation-inventory";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";
import { ProviderConflictError, ProviderOperationError } from "../src/persistence/provider/errors";

const testEnv = env as unknown as Env;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
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

function seedUnadoptedNavigationGeneration(mock: ReturnType<typeof installDropboxMock>, projectId: string, generation: number): void {
  const zone = { generation, adopted: false, adoption_request_id: null, adoption_generation: null, in_flight_writes: [] };
  mock.files.set(`${machineDocumentRoot(projectId)}/navigation-sources/state.json`, JSON.stringify({
    schema_version: "1.0", project_id: projectId, state_revision: 1,
    zones: { WORKING: zone, REVIEW: zone, DELIVERABLES: zone }
  }));
}

function failMaterializationHeadForProject(projectId: string, error: Error): void {
  const readHead = ProjectRepository.prototype.readMaterializationHead;
  vi.spyOn(ProjectRepository.prototype, "readMaterializationHead").mockImplementation(function (this: ProjectRepository, readProjectId) {
    if (readProjectId === projectId) return Promise.reject(error);
    return readHead.call(this, readProjectId);
  });
}

function addCurrentViewsProof(record: CompletedMaterializationRecord): CompletedMaterializationRecord {
  const paths = [
    ["global:PROJECT", "PROJECT.md"],
    ["global:PLAN", "PLAN.md"],
    ["global:STATE", "STATE.md"],
    ["global:HANDOFF", "HANDOFF.md"]
  ] as const;
  const outputs: CompletedMaterializationRecord["outputs"] = {};
  const views: NonNullable<CompletedMaterializationRecord["current_views_proof"]>["views"] = {} as any;
  for (const [key, relative_path] of paths) {
    const evidence = {
      relative_path,
      input_hash: "1".repeat(64),
      content_hash: "2".repeat(64),
      source_revision: record.target_revision
    };
    outputs[key] = evidence;
    views[key] = { ...evidence, provider_object_id: `fixture:${relative_path}`, provider_revision: `fixture-${record.target_revision}` };
  }
  return {
    ...record,
    outputs,
    current_views_proof: {
      target_revision: record.target_revision,
      projection_version: record.projection_version,
      views
    }
  };
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
  it("resumes the exact observed source ticket after interruption before completion", async () => {
    const projectId = "PRJ-8330";
    const { guard } = await setup(projectId);
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    await sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-8330", 0);
    await sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-8330", 0);
    const resourceId = "package:PKG-INTERRUPTED-SOURCE-0001";
    const complete = (ZoneNavigationSources.prototype as any).completeHeadWrites as (...args: any[]) => Promise<void>;
    let interrupt = true;
    vi.spyOn(ZoneNavigationSources.prototype as any, "completeHeadWrites").mockImplementation(async function (this: ZoneNavigationSources, ...args: any[]) {
      if (interrupt) { interrupt = false; throw new Error("injected before source completion"); }
      return complete.apply(this, args);
    });
    const record = () => runInDurableObject(guard, (instance) =>
      (instance as any).recordObservedNavigationSourceMutation(projectId, "WORKING", resourceId)
    );

    await expect(record()).rejects.toThrow("injected before source completion");
    expect((await sources.readState(projectId, "WORKING")).in_flight_resource_ids).toContain(resourceId);
    expect(await sources.hasDirtyMarker(projectId, "WORKING", resourceId)).toBe(false);
    await record();

    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [] });
    expect(await sources.hasDirtyMarker(projectId, "WORKING", resourceId)).toBe(true);
  });

  it("resumes marker-written source tickets without certifying an in-flight source", async () => {
    const projectId = "PRJ-8331";
    const { guard } = await setup(projectId);
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    await sources.beginAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-8331", 0);
    await sources.finishAdoption(projectId, "WORKING", "DOCREQ-NAVIGATION-WORKING-8331", 0);
    const resourceId = "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const writeState = (ZoneNavigationSources.prototype as any).writeProjectState as (...args: any[]) => Promise<void>;
    let stateWrites = 0;
    vi.spyOn(ZoneNavigationSources.prototype as any, "writeProjectState").mockImplementation(async function (this: ZoneNavigationSources, ...args: any[]) {
      stateWrites += 1;
      if (stateWrites === 2) throw new Error("injected after dirty marker before fence clear");
      return writeState.apply(this, args);
    });
    const record = () => runInDurableObject(guard, (instance) =>
      (instance as any).recordObservedNavigationSourceMutation(projectId, "WORKING", resourceId)
    );

    await expect(record()).rejects.toThrow("injected after dirty marker before fence clear");
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [resourceId] });
    expect(await sources.hasDirtyMarker(projectId, "WORKING", resourceId)).toBe(true);
    expect(await sources.verifySnapshot(projectId, "WORKING", "source:1")).toBe(false);
    await record();
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [] });

    await record();
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [] });
  });

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

  it("serves proven execution progress during a separate serialized effect", async () => {
    const projectId = "PRJ-8318";
    const { guard, mock } = await setup(projectId);
    const content = "# Busy status proof\n";
    const request = {
      request_id: "ART-EXECUTION-BUSY-0001", project_id: projectId,
      relative_path: "proofs/busy.md", content, content_sha256: await sha256Text(content), mode: "create"
    };
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const completed = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await completed.json()).toMatchObject({ status: "committed", request_id: request.request_id });
    const execution = await guard.fetch(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`);
    expect(execution.status).toBe(200);
    const executionBody = await execution.json<Record<string, unknown>>();
    expect(executionBody).toMatchObject({ status: "finalized", terminal: true, request_id: request.request_id, project_id: projectId });

    const busyRequest = { ...request, request_id: "ART-EXECUTION-BUSY-0002", relative_path: "proofs/busy-later.md" };
    const { context: busyContext } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const observed = await runInDurableObject(guard, async (instance) => {
      let release!: () => void;
      let entered!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const repository = (instance as any).repository;
      const original = repository.writeArtifact.bind(repository);
      const spy = vi.spyOn(repository, "writeArtifact").mockImplementation(async (...args: unknown[]) => {
        entered();
        await hold;
        return original(...args);
      });
      const submission = (instance as any).fetch(new Request("https://project-guard.internal/artifact", {
        method: "POST", body: JSON.stringify(encodeAdmission(busyRequest, busyContext))
      })) as Promise<Response>;
      try {
        await started;
        const durations: number[] = [];
        let observed: { status: number; body: unknown } | null = null;
        for (let index = 0; index < 5; index += 1) {
          const startedAt = performance.now();
          const response = await (instance as any).fetch(new Request(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`)) as Response;
          observed = { status: response.status, body: await response.json() };
          durations.push(performance.now() - startedAt);
        }
        if (typeof executionBody.finalization_ref !== "string") throw new Error("finalization_reference_missing");
        mock.files.delete(executionBody.finalization_ref);
        const corrupt = await (instance as any).fetch(new Request(`https://project-guard.internal/execution-status?kind=artifact&request_id=${request.request_id}`)) as Response;
        return { ...observed!, p95_ms: durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1]!,
          corrupt: { status: corrupt.status, body: await corrupt.json() } };
      } finally {
        release();
        await submission;
        spy.mockRestore();
      }
    });
    expect(observed).toMatchObject({ status: 200, body: { status: "finalized", terminal: true, request_id: request.request_id, project_id: projectId,
      finalization_ref: executionBody.finalization_ref } });
    expect(observed.p95_ms).toBeLessThanOrEqual(2_000);
    expect(observed.corrupt).toMatchObject({ status: 503, body: { status: "unknown", code: "PROJECT_OS_READ_BUSY" } });
    expect(observed.corrupt.body).not.toHaveProperty("finalization_ref");
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
    const legacyProjectionVersion = 5;
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
    await repository.writeCompletedMaterializationRecord(addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 1, projection_version: legacyProjectionVersion,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "c".repeat(64),
      coalesced_revisions: [], source_event_id: baseline.event.event_id, completed_at: "2026-09-20T17:59:00.000Z"
    }));
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 7, projection_version: legacyProjectionVersion,
      record_kind: "delta", parent: { target_revision: 1, projection_version: legacyProjectionVersion }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "d".repeat(64),
      // This is historical data from before gap coverage was recorded. The
      // complete canonical jump still physically reflects revision 2.
      coalesced_revisions: [3, 4, 5, 6], source_event_id: record.event.event_id,
      completed_at: "2026-09-20T18:01:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 7, projection_version: legacyProjectionVersion,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 7, legacyProjectionVersion),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });
    // A callback may have completed its old scan before this coverage repair
    // is deployed. Its persisted cursor must be rebuilt, not trusted forever.
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-work", {
        head: {
          target_revision: 7,
          projection_version: legacyProjectionVersion,
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
      body: JSON.stringify({ target_revision: 7, projection_version: legacyProjectionVersion })
    });
    while (finalization.status === 202) {
      finalization = await guard.fetch("https://project-guard.internal/finalize-materialization", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_revision: 7, projection_version: legacyProjectionVersion })
      });
    }
    expect(finalization.status).toBe(200);
    const status = await guard.fetch(`https://project-guard.internal/execution-status?kind=transaction&request_id=${requestIds[0]}`);
    expect(await status.json()).toMatchObject({ status: "finalized", terminal: true, code: null, finalization_ref: expect.any(String) });
  });

  it("does not infer historical coverage from a generation without a partial coalescence record", async () => {
    const projectId = "PRJ-8324";
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
    await repository.writeCompletedMaterializationRecord(addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "e".repeat(64),
      coalesced_revisions: [], source_event_id: baseline.event.event_id, completed_at: "2026-09-20T18:09:00.000Z"
    }));
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "f".repeat(64),
      coalesced_revisions: [], source_event_id: record.event.event_id, completed_at: "2026-09-20T18:11:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 4, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });

    const target = { target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, (_instance, state) =>
      state.storage.put("materialization-finalization-request", target)
    );
    await runInDurableObject(guard, (instance) =>
      (instance as any).resumePendingMaterializationFinalization()
    );
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestIds[0]}`);
    expect(await status.json()).toMatchObject({
      status: "committed",
      observation: { recovery: { state: "blocked" } },
      execution: { status: "finalizing", terminal: false, finalization_ref: null },
      recovery: { finalization: { target_revision: 4, blocked: true, code: "materialization_coalescence_gap" } }
    });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
      expect(await state.storage.get("materialization-finalization-work")).toMatchObject({
        uncovered_ranges: [{ from_revision: 2, to_revision: 3 }]
      });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("does not infer a missing revision from a partial current-generation coalescence list", async () => {
    const projectId = "PRJ-8325";
    const { guard } = await setup(projectId);
    const requestIds: string[] = [];
    for (let revision = 2; revision <= 4; revision += 1) {
      const requestId = `TXN-EXECUTION-8310-${revision}`;
      requestIds.push(requestId);
      const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context"))
        .json<{ context: never }>();
      const transaction = {
        schema_version: "1.0", transaction_id: requestId, project_id: projectId,
        base_revision: revision - 1, operation: "research.add", created_at: "2026-09-24T10:10:00.000Z",
        payload: { research_id: `RES-CURRENT${revision}`, title: `Current generation ${revision}`, body: "Canonical evidence" }
      };
      const committed = await guard.fetch("https://project-guard.internal/transaction", {
        method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
      });
      expect(await committed.json()).toMatchObject({ status: "committed", new_revision: revision });
    }

    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const baseline = await repository.readCommitRecord(projectId, 1);
    const record = await repository.readCommitRecord(projectId, 4);
    if (!baseline || !record) throw new Error("expected_current_generation_coalescence_fixture");
    await repository.writeCompletedMaterializationRecord(addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "a".repeat(64),
      coalesced_revisions: [], source_event_id: baseline.event.event_id, completed_at: "2026-09-24T10:09:00.000Z"
    }));
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "b".repeat(64), coalesced_revisions: [3],
      source_event_id: record.event.event_id, completed_at: "2026-09-24T10:11:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 4, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });

    const target = { target_revision: 4, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, (_instance, state) =>
      state.storage.put("materialization-finalization-request", target)
    );
    await runInDurableObject(guard, (instance) =>
      (instance as any).resumePendingMaterializationFinalization()
    );

    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestIds[0]}`);
    expect(await status.json()).toMatchObject({
      status: "committed",
      observation: { recovery: { state: "blocked" } },
      execution: { status: "finalizing", terminal: false, finalization_ref: null },
      recovery: { finalization: { target_revision: 4, blocked: true, code: "materialization_coalescence_gap", classification: "provider_blocked" } }
    });
    const coveredStatus = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestIds[1]}`);
    expect(await coveredStatus.json()).not.toHaveProperty("recovery.finalization");
    const missingCommit = await repository.readCommitRecord(projectId, 2);
    if (!missingCommit) throw new Error("expected_current_generation_missing_commit");
    const inferred = await runInDurableObject(guard, (instance) =>
      (instance as any).verifiedCandidateCoversTransaction({
        revision: 2,
        coverage: "canonical_range",
        materialization_revision: 4,
        projection_version: CURRENT_PROJECTION_VERSION,
        result_root_hash: materialization.result_root_hash,
        completed_at: materialization.completed_at,
        source_event_id: materialization.source_event_id
      }, materialization, 2, missingCommit.event.event_id)
    );
    expect(inferred).toBe(false);
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
      expect(await state.storage.get("materialization-finalization-work")).toMatchObject({
        uncovered_ranges: [{ from_revision: 2, to_revision: 2 }]
      });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("verifies a long legacy canonical range in bounded, resumable slices", async () => {
    const projectId = "PRJ-8320";
    const { guard, mock } = await setup(projectId);
    const records = commitFixture(projectId, 35);
    seedCommits(mock, records);
    const baseline = records[0]!;
    const latest = records.at(-1)!;
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 35, projection_version: 5,
      record_kind: "delta", parent: { target_revision: 1, projection_version: 5 }, chain_depth: 1,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "e".repeat(64), coalesced_revisions: Array.from({ length: 32 }, (_, i) => i + 3),
      source_event_id: latest.event.event_id, completed_at: "2026-09-24T10:30:00.000Z"
    });
    expect(baseline.new_revision).toBe(1);
    const candidate = {
      revision: 2, coverage: "canonical_range" as const, materialization_revision: 35, projection_version: 5,
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at,
      source_event_id: materialization.source_event_id
    };
    const work = {
      coverage_version: 2,
      head: { target_revision: 35, projection_version: 5, result_root_hash: materialization.result_root_hash,
        completed_at: materialization.completed_at },
      next_generation: null, previous_child: null, scan_complete: true, candidates: [candidate],
      legacy_range_cursor: null
    };
    const workKey = "materialization-finalization-work";
    await runInDurableObject(guard, (_instance, state) => state.storage.put(workKey, work));
    let verified = false;
    let slices = 0;
    const perSliceCalls: number[] = [];
    let lastStoredRevision = 1;
    for (; slices < 4 && !verified; slices += 1) {
      let calls = 0;
      const sliceResult = await runInDurableObject(guard, async (instance, state) => {
        const controller = new AbortController();
        const runtime = createProductionPersistence(testEnv, projectId, {
          deadlineMs: Date.now() + 15_000,
          signal: controller.signal,
          beforeHttp: () => {
            if (calls >= 32) throw new Error("slice_budget_exhausted");
            calls += 1;
          }
        });
        const repository = new ProjectRepository(runtime, "v2");
        const durableWork = await state.storage.get<typeof work>(workKey);
        if (!durableWork) throw new Error("legacy_range_work_not_persisted");
        const result = await (instance as any).verifiedCandidateCoversTransaction(
          candidate, materialization, 2, records[1]!.event.event_id, repository, durableWork, Date.now() + 15_000,
          controller.signal
        );
        const persisted = await state.storage.get<{ legacy_range_cursor?: { next_revision: number } }>(workKey);
        if (!persisted?.legacy_range_cursor) throw new Error("legacy_range_cursor_not_persisted");
        return { verified: result, nextRevision: persisted.legacy_range_cursor.next_revision };
      });
      verified = sliceResult.verified;
      expect(sliceResult.nextRevision).toBeGreaterThanOrEqual(lastStoredRevision);
      if (!verified) expect(sliceResult.nextRevision).toBeGreaterThan(lastStoredRevision);
      lastStoredRevision = sliceResult.nextRevision;
      // Only this repository runtime belongs to the bounded finalization
      // slice. The shared mock may also record asynchronous guard alarms.
      perSliceCalls.push(calls);
      expect(perSliceCalls.at(-1)).toBeLessThanOrEqual(32);
    }
    expect(verified).toBe(true);
    expect(slices).toBeGreaterThan(1);
    expect(perSliceCalls.length).toBeGreaterThan(1);

    const nextCandidate = { ...candidate, revision: 3 };
    let reuseCalls = 0;
    await runInDurableObject(guard, async (instance, state) => {
      const controller = new AbortController();
      const runtime = createProductionPersistence(testEnv, projectId, {
        deadlineMs: Date.now() + 15_000,
        signal: controller.signal,
        beforeHttp: () => { reuseCalls += 1; }
      });
      const repository = new ProjectRepository(runtime, "v2");
      const durableWork = await state.storage.get<typeof work>(workKey);
      if (!durableWork) throw new Error("legacy_range_work_not_persisted");
      await expect((instance as any).verifiedCandidateCoversTransaction(
        nextCandidate, materialization, 3, records[2]!.event.event_id, repository, durableWork,
        Date.now() + 15_000, controller.signal
      )).resolves.toBe(true);
    });
    expect(reuseCalls).toBe(0);
  });

  it("rearms an old callback against a newer canonically bound head instead of dropping its intent", async () => {
    const projectId = "PRJ-8311";
    const { guard } = await setup(projectId);
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context"))
      .json<{ context: never }>();
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-EXECUTION-8311-NEW-HEAD", project_id: projectId,
      base_revision: 1, operation: "research.add", created_at: "2026-09-24T10:12:00.000Z",
      payload: { research_id: "RES-NEWHEAD", title: "Newer head", body: "Canonical evidence" }
    };
    const committed = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
    });
    expect(await committed.json()).toMatchObject({ status: "committed", new_revision: 2 });
    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const commit = await repository.readCommitRecord(projectId, 2);
    if (!commit) throw new Error("expected_new_head_commit");
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "c".repeat(64),
      coalesced_revisions: [], source_event_id: commit.event.event_id, completed_at: "2026-09-24T10:13:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(materialization);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION,
      workspace_location: "active", record_path: machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION),
      result_root_hash: materialization.result_root_hash, completed_at: materialization.completed_at
    });
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", {
        target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION
      });
    });

    const response = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ target_revision: 2, finalization_pending: true });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual({
        target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
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
    const materialization = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "snapshot", parent: null, chain_depth: 0, workspace_location: "active",
      outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: "a".repeat(64),
      coalesced_revisions: [], source_event_id: record.event.event_id, completed_at: "2026-09-13T14:03:00.000Z"
    });
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
    const successor = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 269, projection_version: CURRENT_PROJECTION_VERSION },
      chain_depth: 1, workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "b".repeat(64), coalesced_revisions: [270],
      source_event_id: record271.event.event_id, completed_at: "2026-09-13T16:05:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(successor);
    const record272 = await repository.readCommitRecord(projectId, 272);
    if (!record272) throw new Error("expected_descendant_record");
    const descendant = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 272, projection_version: CURRENT_PROJECTION_VERSION,
      record_kind: "delta", parent: { target_revision: 271, projection_version: CURRENT_PROJECTION_VERSION },
      chain_depth: 2, workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "c".repeat(64), coalesced_revisions: [],
      source_event_id: record272.event.event_id, completed_at: "2026-09-13T16:06:30.000Z"
    });
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
    await runInDurableObject(guard, instance =>
      (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
        .resumePendingMaterializationFinalization()
    );
    await runInDurableObject(guard, async (_instance, state) => {
      const request = await state.storage.get<{ target_revision: number }>("materialization-finalization-request");
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      const failure = state.storage.sql.exec<{ request_id: string; stopped: number; message: string }>(
        "SELECT request_id, stopped, message FROM request_recovery_failures WHERE kind = 'materialization'"
      ).toArray();
      expect(request?.target_revision).toBe(272);
      expect(work?.candidates.map(({ revision }) => revision)).toContain(272);
      expect(failure).toHaveLength(1);
      expect(failure[0]?.stopped).toBe(1);
    });
    const malformedStatus = await guard.fetch(
      `https://project-guard.internal/request-status?kind=transaction&request_id=${transaction272.transaction_id}`
    );
    expect(await malformedStatus.json()).toMatchObject({
      recovery: { finalization: { target_revision: 272, blocked: true, code: "materialization_chain_invalid" } }
    });
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
      const longDescendant = addCurrentViewsProof({
        schema_version: "1.0", project_id: projectId, target_revision: revision, projection_version: CURRENT_PROJECTION_VERSION,
        record_kind: "delta", parent: longParent, chain_depth: revision - 270, workspace_location: "active",
        outputs: {}, removed_outputs: [], total_output_count: 0, result_root_hash: String(revision).repeat(64).slice(0, 64),
        coalesced_revisions: [], source_event_id: `EVT-${String(revision).padStart(6, "0")}`,
        completed_at: "2026-09-13T16:07:00.000Z"
      });
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
    const completed = addCurrentViewsProof({
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
    });
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
    const originalReadCommitRecord = ProjectRepository.prototype.readCommitRecord;
    const commitReads = vi.spyOn(ProjectRepository.prototype, "readCommitRecord");

    const response = await runInDurableObject(guard, (instance, state) => {
      const object = instance as any;
      return object.serialize(async () => {
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
        const response = await object.finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
        }));
        expect(response.status).toBe(202);
        expect(commitReads).toHaveBeenCalledWith(projectId, 9001);
        expect(commitReads).toHaveBeenCalledWith(projectId, 9004);
        const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
        expect(work?.candidates).toEqual([expect.objectContaining({ revision: 9005 })]);
        expect(await state.storage.getAlarm()).not.toBeNull();
        await state.storage.setAlarm(Date.now() + 60_000);
        return response;
      });
    });
    expect(response.status).toBe(202);
    await runInDurableObject(guard, async (instance, state) => {
      await (instance as unknown as { clearTransactionRecovery(requestId: string): Promise<void> })
        .clearTransactionRecovery("TXN-UNRELATED-CLEAR");
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    expect(commitReads).toHaveBeenCalledWith(projectId, 9005);
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-work")).toBeUndefined();
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
        candidates: [9101, 9102, 9103, 9104, 9105].map((revision) => ({
          revision, coverage: "explicit", materialization_revision: completed.target_revision,
          projection_version: completed.projection_version, result_root_hash: completed.result_root_hash,
          completed_at: completed.completed_at, source_event_id: completed.source_event_id
        }))
      });
    });

    // Keep the wall-clock abort timer out of this fixture; advance only Date
    // after the first candidate so runner load cannot expire the slice early.
    vi.useFakeTimers({ toFake: ["Date"] });
    const sliceBudget = await runInDurableObject(guard, instance =>
      vi.spyOn(instance as any, "materializationFinalizationSliceBudgetMs").mockReturnValue(60_000)
    );
    commitReads.mockClear();
    commitReads.mockImplementation(async function (this: ProjectRepository, candidateProjectId, revision) {
      if (candidateProjectId !== projectId || revision < 9101 || revision > 9105) {
        return originalReadCommitRecord.call(this, candidateProjectId, revision);
      }
      if (revision === 9101) vi.setSystemTime(Date.now() + 60_001);
      return null;
    });
    // The production route and alarm both use this serialized queue. This
    // fixture calls the slice directly, so remove an earlier alarm and avoid
    // installing a new one until the slice itself yields and rearms it.
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const { deadlineResponse, preinstalledAlarmAt } = await runInDurableObject(guard, (instance, state) => {
      const object = instance as any;
      return object.serialize(async () => {
        const deadlineResponse = await object.finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
        }), false);
        expect(deadlineResponse.status).toBe(202);
        // The persisted cursor below proves this invocation consumed exactly
        // one candidate. A prototype-wide spy can also see unrelated alarms.
        expect(commitReads).toHaveBeenCalledWith(projectId, 9101);
        const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
        expect(work?.candidates.map(({ revision }) => revision)).toEqual([9102, 9103, 9104, 9105]);
        expect(await state.storage.getAlarm()).not.toBeNull();
        await state.storage.put("materialization-finalization-work", {
          coverage_version: 2,
          head: {
            target_revision: completed.target_revision,
            projection_version: completed.projection_version,
            result_root_hash: completed.result_root_hash,
            completed_at: completed.completed_at
          },
          next_generation: null, previous_child: null, scan_complete: true,
          candidates: [{
            revision: 9201, coverage: "explicit", materialization_revision: completed.target_revision,
            projection_version: completed.projection_version, result_root_hash: completed.result_root_hash,
            completed_at: completed.completed_at, source_event_id: completed.source_event_id
          }]
        });
        // The previous phase advanced fake Date past its alarm. Keep that alarm
        // from racing this explicitly invoked provider-budget slice.
        const alarmAt = Date.now() + 60_000;
        await state.storage.setAlarm(alarmAt);
        return { deadlineResponse, preinstalledAlarmAt: alarmAt };
      });
    });

    sliceBudget.mockRestore();
    commitReads.mockRestore();
    const { providerBudgetResponse, scopedProviderCalls } = await runInDurableObject(guard, async (instance) => {
      const object = instance as any;
      const budgetSpy = vi.spyOn(object, "materializationFinalizationProviderCallBudget").mockReturnValue(2);
      const originalSlice = object.finalizeCurrentMaterializationSlice.bind(object);
      let scopedProviderCalls = -1;
      const sliceSpy = vi.spyOn(object, "finalizeCurrentMaterializationSlice")
        .mockImplementation(async (...args: any[]) => {
          const budget = args[4] as { calls: number };
          try { return await originalSlice(...args); }
          finally { scopedProviderCalls = budget.calls; }
        });
      try {
        const providerBudgetResponse = await object.finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
        }), false);
        return { providerBudgetResponse, scopedProviderCalls };
      } finally {
        sliceSpy.mockRestore();
        budgetSpy.mockRestore();
      }
    });
    expect(providerBudgetResponse.status).toBe(202);
    // The budget object belongs to this one finalization slice, unlike the
    // shared Dropbox mock which also records other projects' alarm traffic.
    expect(scopedProviderCalls).toBe(2);
    await runInDurableObject(guard, async (_instance, state) => {
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      expect(work?.candidates.map(({ revision }) => revision)).toEqual([9201]);
      // Budget exhaustion must re-arm a near wake, not merely leave the
      // preinstalled distant alarm in place.
      expect(await state.storage.getAlarm()).toBeLessThan(preinstalledAlarmAt);
      expect(state.storage.sql.exec(
        "SELECT count FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
        `1:${CURRENT_PROJECTION_VERSION}`
      ).toArray()).toEqual([]);
    });
  });

  it("counts terminal and unadmitted candidates in a mixed finalization batch", async () => {
    const projectId = "PRJ-8299";
    const { guard } = await setup(projectId);
    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const completed = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION, record_kind: "snapshot", parent: null, chain_depth: 0,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "b".repeat(64), coalesced_revisions: [], source_event_id: "EVT-000001",
      completed_at: "2026-09-24T08:00:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(completed);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION, workspace_location: "active",
      record_path: machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION),
      result_root_hash: completed.result_root_hash, completed_at: completed.completed_at
    });
    const candidate = (revision: number) => ({
      revision, coverage: "explicit" as const, materialization_revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION, result_root_hash: completed.result_root_hash,
      completed_at: completed.completed_at, source_event_id: completed.source_event_id
    });
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-work", {
        coverage_version: 2,
        head: { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION,
          result_root_hash: completed.result_root_hash, completed_at: completed.completed_at },
        next_generation: null, previous_child: null, scan_complete: true,
        candidates: [9301, 9302, 9303, 9304, 9305].map(candidate)
      });
    });
    const fixtureCommit = commitFixture(projectId, 1)[0]!;
    const terminalCommit = {
      ...fixtureCommit,
      transaction: { ...fixtureCommit.transaction, transaction_id: "TXN-TERMINAL-9302" },
      receipt: { ...fixtureCommit.receipt, transaction_id: "TXN-TERMINAL-9302" }
    };
    const unadmittedCommit = {
      ...fixtureCommit,
      transaction: { ...fixtureCommit.transaction, transaction_id: "TXN-UNADMITTED-9304" },
      receipt: { ...fixtureCommit.receipt, transaction_id: "TXN-UNADMITTED-9304" }
    };
    const originalReadCommitRecord = ProjectRepository.prototype.readCommitRecord;
    const readCommit = vi.spyOn(ProjectRepository.prototype, "readCommitRecord").mockImplementation(async function (this: ProjectRepository, candidateProjectId, revision) {
      if (candidateProjectId !== projectId || revision < 9301 || revision > 9305) {
        return originalReadCommitRecord.call(this, candidateProjectId, revision);
      }
      if (revision === 9302) return terminalCommit;
      if (revision === 9304) return unadmittedCommit;
      return null;
    });
    const originalStatus = ExecutionJournal.prototype.status;
    vi.spyOn(ExecutionJournal.prototype, "status").mockImplementation(async function (this: ExecutionJournal) {
      if (this.projectId !== projectId || ![
        terminalCommit.transaction.transaction_id, unadmittedCommit.transaction.transaction_id
      ].includes(this.requestId)) return originalStatus.call(this);
      return this.requestId === terminalCommit.transaction.transaction_id
        ? { status: "finalized", terminal: true } as any
        : null;
    });

    const response = await runInDurableObject(guard, (instance) =>
      (instance as unknown as { finalizeCurrentMaterialization(request: Request): Promise<Response> })
        .finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION })
        }))
    );

    expect(response.status).toBe(202);
    expect(readCommit).toHaveBeenCalledWith(projectId, 9302);
    expect(readCommit).toHaveBeenCalledWith(projectId, 9304);
    await runInDurableObject(guard, async (_instance, state) => {
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      expect(work?.candidates.map(({ revision }) => revision)).toEqual([9305]);
    });
  });

  it("finalizes a committed transaction from the ProjectGuard alarm without a status read", async () => {
    const projectId = "PRJ-8302";
    const { guard } = await setup(projectId);
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const transaction = {
      schema_version: "1.0", transaction_id: "TXN-8302-AUTONOMOUS", project_id: projectId,
      base_revision: 1, operation: "task.create", created_at: "2026-09-24T10:00:00.000Z",
      payload: { task_id: "TASK-8302AUTONOMOUS", title: "Alarm finalization" }
    };
    const committed = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
    });
    expect(await committed.json()).toMatchObject({ status: "committed", new_revision: 2 });

    const repository = new ProjectRepository(createProductionPersistence(testEnv, projectId), "v2");
    const commit = await repository.readCommitRecord(projectId, 2);
    if (!commit) throw new Error("expected_alarm_finalization_commit");
    const completed = addCurrentViewsProof({
      schema_version: "1.0", project_id: projectId, target_revision: 2,
      projection_version: CURRENT_PROJECTION_VERSION, record_kind: "snapshot", parent: null, chain_depth: 0,
      workspace_location: "active", outputs: {}, removed_outputs: [], total_output_count: 0,
      result_root_hash: "d".repeat(64), coalesced_revisions: [], source_event_id: commit.event.event_id,
      completed_at: "2026-09-24T10:01:00.000Z"
    });
    await repository.writeCompletedMaterializationRecord(completed);
    await repository.writeMaterializationHead({
      schema_version: "1.0", project_id: projectId, target_revision: 2,
      projection_version: CURRENT_PROJECTION_VERSION, workspace_location: "active",
      record_path: machineMaterializationRecordPath(projectId, 2, CURRENT_PROJECTION_VERSION),
      result_root_hash: completed.result_root_hash, completed_at: completed.completed_at
    });
    const candidate = (revision: number) => ({
      revision, coverage: "explicit" as const, materialization_revision: 2,
      projection_version: CURRENT_PROJECTION_VERSION, result_root_hash: completed.result_root_hash,
      completed_at: completed.completed_at, source_event_id: completed.source_event_id
    });
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-work", {
        coverage_version: 2,
        head: { target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION,
          result_root_hash: completed.result_root_hash, completed_at: completed.completed_at },
        next_generation: null, previous_child: null, scan_complete: true,
        candidates: [9401, 9402, 9403, 9404, 2].map(candidate)
      });
    });

    const first = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(first.status).toBe(202);
    await runInDurableObject(guard, async (_instance, state) => {
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      expect(work?.candidates.map(({ revision }) => revision)).toEqual([2]);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const finalizeCertificate = ExecutionJournal.prototype.finalizeMaterializedTransaction;
    const readExecutionStatus = ExecutionJournal.prototype.status;
    let certificateWritten = false;
    const writeCertificate = vi.spyOn(ExecutionJournal.prototype, "finalizeMaterializedTransaction").mockImplementationOnce(async function (
      this: ExecutionJournal,
      input: Parameters<ExecutionJournal["finalizeMaterializedTransaction"]>[0]
    ) {
      const progress = await finalizeCertificate.call(this, input);
      certificateWritten = true;
      return progress;
    });
    const statusBeforeCursorCheckpoint = vi.spyOn(ExecutionJournal.prototype, "status").mockImplementation(async function (
      this: ExecutionJournal
    ) {
      const actual = await readExecutionStatus.call(this);
      if (certificateWritten && this.requestId === transaction.transaction_id) {
        certificateWritten = false;
        return { ...actual!, status: "finalizing", terminal: false };
      }
      return actual;
    });
    const interrupted = await guard.fetch("https://project-guard.internal/finalize-materialization", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_revision: 2, projection_version: CURRENT_PROJECTION_VERSION })
    });
    expect(interrupted.status).toBe(202);
    writeCertificate.mockRestore();
    statusBeforeCursorCheckpoint.mockRestore();
    await runInDurableObject(guard, async (_instance, state) => {
      const work = await state.storage.get<{ candidates: Array<{ revision: number }> }>("materialization-finalization-work");
      expect(work?.candidates.map(({ revision }) => revision)).toEqual([2]);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const journal = new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "transaction", transaction.transaction_id);
    expect(await journal.status()).toMatchObject({ status: "finalized", terminal: true, code: null });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-work")).toBeUndefined();
      expect(await state.storage.get("materialization-finalization-request")).toBeUndefined();
    });
  });

  it("backs off a temporary provider failure while retaining the same finalization intent", async () => {
    const projectId = "PRJ-8303";
    const { guard } = await setup(projectId);
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
    });
    failMaterializationHeadForProject(projectId,
      new ProviderOperationError("provider_unavailable", true, { providerId: "dropbox", status: 503 }));
    const startedAt = Date.now();

    await expect(runInDurableObject(guard, (instance) =>
      (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
        .resumePendingMaterializationFinalization()
    )).resolves.toBeUndefined();

    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
      const failure = state.storage.sql.exec<{ count: number; stopped: number }>(
        "SELECT count, stopped FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
        `${target.target_revision}:${target.projection_version}`
      ).toArray()[0];
      expect(failure).toMatchObject({ count: 1, stopped: 0 });
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      expect(alarmAt! - startedAt).toBeGreaterThanOrEqual(5_000);
      expect(alarmAt! - startedAt).toBeLessThan(6_000);
    });
  });

  it("honors provider Retry-After when it exceeds the local backoff ceiling", async () => {
    const projectId = "PRJ-8307";
    const { guard } = await setup(projectId);
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
    });
    failMaterializationHeadForProject(projectId,
      new ProviderOperationError("provider_unavailable", true, {
        providerId: "dropbox", status: 503, retryAfterMs: 180_000
      }));
    const startedAt = Date.now();

    await runInDurableObject(guard, (instance) =>
      (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
        .resumePendingMaterializationFinalization()
    );

    await runInDurableObject(guard, async (_instance, state) => {
      const failure = state.storage.sql.exec<{ message: string }>(
        "SELECT message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
        `${target.target_revision}:${target.projection_version}`
      ).toArray()[0];
      expect(failure).toBeDefined();
      const nextAttemptAt = Date.parse(JSON.parse(failure!.message).next_attempt_at);
      expect(nextAttemptAt).toBeGreaterThanOrEqual(startedAt + 180_000);
      expect(nextAttemptAt).toBeLessThanOrEqual(startedAt + 181_000);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("backs off and visibly stops a pending materialization callback that makes no durable progress", async () => {
    const projectId = "PRJ-8322";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    const work = {
      coverage_version: 2,
      head: { ...target, result_root_hash: "f".repeat(64), completed_at: "2026-09-24T10:30:00.000Z" },
      next_generation: target, previous_child: null, scan_complete: false, candidates: [], legacy_range_cursor: null
    };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
      await state.storage.put("materialization-finalization-work", work);
    });
    const callback = await runInDurableObject(guard, instance => {
      const isolated = vi.spyOn(instance as any, "finalizeCurrentMaterialization")
        .mockResolvedValue(Response.json({ finalization_pending: true }, { status: 202 }));
      vi.spyOn(instance as any, "armRequestRecoveryAlarm").mockResolvedValue(undefined);
      return isolated;
    });

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as any).resumePendingMaterializationFinalization()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; message: string;
      }>("SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
      `${target.target_revision}:${target.projection_version}`).toArray()[0]);
      expect(failure).toMatchObject({ count: attempt, stopped: attempt === 6 ? 1 : 0 });
      const diagnostic = JSON.parse(failure!.message);
      expect(diagnostic).toMatchObject({
        classification: "internal",
        code: attempt === 6 ? "identical_internal_failure_limit" : "materialization_evidence_no_progress"
      });
      if (attempt < 6) {
        const dueAt = Date.parse(diagnostic.next_attempt_at);
        expect(dueAt - Date.now()).toBeGreaterThanOrEqual(4_999);
        vi.setSystemTime(dueAt + 1);
      }
    }

    expect(callback).toHaveBeenCalledTimes(6);
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
      expect(await state.storage.get("materialization-finalization-work")).toEqual(work);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("backs off a recognizable network timeout as a dependency failure", async () => {
    const projectId = "PRJ-8308";
    const { guard } = await setup(projectId);
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
    });
    failMaterializationHeadForProject(projectId, new TypeError("fetch failed"));
    const startedAt = Date.now();

    await runInDurableObject(guard, (instance) =>
      (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
        .resumePendingMaterializationFinalization()
    );

    await runInDurableObject(guard, async (_instance, state) => {
      const failure = state.storage.sql.exec<{ count: number; stopped: number; message: string }>(
        "SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
        `${target.target_revision}:${target.projection_version}`
      ).toArray()[0];
      expect(failure).toMatchObject({ count: 1, stopped: 0 });
      expect(JSON.parse(failure!.message)).toMatchObject({ classification: "provider_temporary" });
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(startedAt + 5_000);
    });
  });

  it("stops immediately for provider access and conflict failures without discarding intent", async () => {
    const cases = [
      { projectId: "PRJ-8305", error: new ProviderOperationError("provider_scope_insufficient", false, { providerId: "dropbox", status: 403 }), code: "provider_http_403" },
      { projectId: "PRJ-8306", error: new ProviderConflictError("materialization_precondition_diverged", { providerId: "dropbox", status: 409 }), code: "provider_conflict" }
    ];
    for (const { projectId, error, code } of cases) {
      const { guard } = await setup(projectId);
      const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
      await runInDurableObject(guard, async (_instance, state) => {
        await state.storage.put("materialization-finalization-request", target);
      });
      failMaterializationHeadForProject(projectId, error);

      await expect(runInDurableObject(guard, (instance) =>
        (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
          .resumePendingMaterializationFinalization()
      )).resolves.toBeUndefined();

      await runInDurableObject(guard, async (_instance, state) => {
        expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
        const failure = state.storage.sql.exec<{ count: number; stopped: number; message: string }>(
          "SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
          `${target.target_revision}:${target.projection_version}`
        ).toArray()[0];
        expect(failure).toMatchObject({ count: 1, stopped: 1 });
        expect(JSON.parse(failure!.message)).toMatchObject({ code, classification: "provider_blocked" });
        expect(await state.storage.getAlarm()).toBeNull();
      });
      vi.restoreAllMocks();
    }
  });

  it("stops and exposes six identical internal failures without progress", async () => {
    const projectId = "PRJ-8304";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
    });
    vi.spyOn(ProjectRepository.prototype, "readMaterializationHead").mockRejectedValue(
      new Error("materialization_internal_invariant")
    );
    const incident = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await runInDurableObject(guard, async (_instance, state) => state.storage.deleteAlarm());
      await expect(runInDurableObject(guard, (instance) =>
        (instance as unknown as { resumePendingMaterializationFinalization(): Promise<void> })
          .resumePendingMaterializationFinalization()
      )).resolves.toBeUndefined();
      if (attempt < 5) vi.setSystemTime(Date.now() + 30_001);
    }

    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toEqual(target);
      const failure = state.storage.sql.exec<{ fingerprint: string; count: number; stopped: number; message: string }>(
        "SELECT fingerprint, count, stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
        `${target.target_revision}:${target.projection_version}`
      ).toArray()[0];
      expect(failure).toMatchObject({ count: 6, stopped: 1 });
      expect(JSON.parse(failure!.message)).toMatchObject({ code: "identical_internal_failure_limit", classification: "internal" });
      expect(failure?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(incident).toHaveBeenCalledWith("Project OS materialization finalization blocked", expect.objectContaining({
      project_id: projectId,
      target_revision: 1,
      attempts: 6,
      code: "identical_internal_failure_limit"
    }));
    vi.useRealTimers();
  });

  it("exposes a persisted finalization incident only for the transaction in its durable work cursor", async () => {
    const projectId = "PRJ-8309";
    const { guard } = await setup(projectId);
    const requestIds: string[] = [];
    for (const revision of [2, 3]) {
      const transactionId = `TXN-8309-STATUS-${revision}`;
      requestIds.push(transactionId);
      const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
      const transaction = {
        schema_version: "1.0", transaction_id: transactionId, project_id: projectId,
        base_revision: revision - 1, operation: "task.create", created_at: `2026-09-24T10:0${revision}:00.000Z`,
        payload: { task_id: `TASK-8309STATUS${revision}`, title: `Status ${revision}` }
      };
      const committed = await guard.fetch("https://project-guard.internal/transaction", {
        method: "POST", body: JSON.stringify(encodeAdmission(transaction, context))
      });
      expect(await committed.json()).toMatchObject({ status: "committed", new_revision: revision });
    }
    const target = { target_revision: 3, projection_version: CURRENT_PROJECTION_VERSION };
    const progressHash = "e".repeat(64);
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.put("materialization-finalization-request", target);
      await state.storage.put("materialization-finalization-work", {
        coverage_version: 2,
        head: { ...target, result_root_hash: "f".repeat(64), completed_at: "2026-09-24T10:10:00.000Z" },
        next_generation: null, previous_child: null, scan_complete: true,
        candidates: [{ revision: 2, coverage: "explicit", materialization_revision: 3,
          projection_version: CURRENT_PROJECTION_VERSION, result_root_hash: "f".repeat(64),
          completed_at: "2026-09-24T10:10:00.000Z", source_event_id: null }]
      });
      state.storage.sql.exec(
        `INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message)
         VALUES ('materialization', ?, ?, 6, 1, ?)`,
        `3:${CURRENT_PROJECTION_VERSION}`, "d".repeat(64), JSON.stringify({
          code: "identical_internal_failure_limit", classification: "internal", error_name: "Error",
          progress_sha256: progressHash, next_attempt_at: null
        })
      );
    });

    const affectedResponse = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestIds[0]}`);
    const affected = await affectedResponse.json<any>();
    expect(affected).toMatchObject({ status: "committed", recovery: {
      finalization: { target_revision: 3, projection_version: CURRENT_PROJECTION_VERSION,
        blocked: true, code: "identical_internal_failure_limit", progress_sha256: progressHash,
        next_attempt_at: null, next_action: "wait_for_dependency" }
    }, observation: { recovery: { state: "blocked", action: "wait_for_dependency" } } });

    const unrelatedResponse = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestIds[1]}`);
    const unrelated = await unrelatedResponse.json<any>();
    expect(unrelated).not.toHaveProperty("recovery.finalization");
  });

  it("arms a safe wake before publishing a materialization continuation", async () => {
    const projectId = "PRJ-8326";
    const { guard } = await setup(projectId);
    const target = { target_revision: 1, projection_version: CURRENT_PROJECTION_VERSION };
    await runInDurableObject(guard, async (_instance, state) => {
      await state.storage.deleteAlarm();
      const put = state.storage.put.bind(state.storage);
      vi.spyOn(state.storage, "put").mockImplementationOnce((async (...args: any[]) => {
        if (args[0] === "materialization-finalization-request"
          || (typeof args[0] === "object" && args[0] !== null && "materialization-finalization-request" in args[0])) {
          throw new Error("continuation_write_interrupted");
        }
        await (put as any)(...args);
      }) as any);
    });

    await expect(runInDurableObject(guard, (instance) =>
      (instance as unknown as { persistMaterializationFinalizationRequest(requestTarget: { target_revision: number; projection_version: number }): Promise<void> })
        .persistMaterializationFinalizationRequest(target)
    )).rejects.toThrow("continuation_write_interrupted");
    await runInDurableObject(guard, async (_instance, state) => {
      expect(await state.storage.get("materialization-finalization-request")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("keeps request recovery alive through seven retryable provider failures and honors Retry-After", async () => {
    const projectId = "PRJ-8312";
    const requestId = "DOC-8312-RETRY";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    const progressProbe = vi.spyOn(ExecutionJournal.prototype, "status").mockResolvedValue(null);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
    });
    vi.spyOn(ProjectGuard.prototype as any, "resumeManagedDocument").mockRejectedValue(
      new ProviderOperationError("provider_unavailable", true, {
        providerId: "dropbox", status: 503, retryAfterMs: 60_000
      })
    );

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; message: string;
      }>("SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId).toArray()[0]);
      const diagnostic = JSON.parse(failure!.message);
      expect(failure).toMatchObject({ count: attempt, stopped: 0 });
      expect(diagnostic).toMatchObject({ classification: "provider_temporary", code: "provider_http_503" });
      expect(Date.parse(diagnostic.next_attempt_at)).toBeGreaterThanOrEqual(Date.now() + 59_000);
      if (attempt < 7) vi.setSystemTime(Date.parse(diagnostic.next_attempt_at) + 1);
    }
    await runInDurableObject(guard, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM request_recovery WHERE kind = 'document' AND request_id = ?", requestId).toArray()).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(progressProbe).not.toHaveBeenCalled();
  });

  it("keeps transaction recovery alive through seven retryable 503 responses", async () => {
    const projectId = "PRJ-8317";
    const requestId = "TXN-8317-RETRY";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    const transaction = {
      schema_version: "1.0", transaction_id: requestId, project_id: projectId,
      base_revision: 1, operation: "research.add", created_at: "2026-09-20T08:00:00.000Z",
      payload: { research_id: "RES-8317", title: "Recover transaction retry" }
    };
    const intent = { project_id: projectId, transaction_id: requestId, request_sha256: "a".repeat(64), request_json: JSON.stringify(transaction), actor: { actor_id: "actor-8317", authority: "founder" } };
    await runInDurableObject(guard, (instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('transaction', ?)", requestId);
      vi.spyOn((instance as any).transactionRequests, "readRecoverableTransaction").mockResolvedValue(transaction);
      vi.spyOn((instance as any).transactionRequests, "readIntent").mockResolvedValue(intent);
      vi.spyOn(instance as any, "fetch").mockImplementation(async () => new Response("temporarily unavailable", {
        status: 503, headers: { "Retry-After": "60" }
      }));
    });

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as unknown as { resumePendingTransactionRecovery(): Promise<void> }).resumePendingTransactionRecovery()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; message: string;
      }>("SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'transaction' AND request_id = ?", requestId).toArray()[0]);
      const diagnostic = JSON.parse(failure!.message);
      expect(failure).toMatchObject({ count: attempt, stopped: 0 });
      expect(diagnostic).toMatchObject({ classification: "provider_temporary", code: "provider_http_503" });
      expect(Date.parse(diagnostic.next_attempt_at)).toBeGreaterThanOrEqual(Date.now() + 59_000);
      if (attempt < 7) vi.setSystemTime(Date.parse(diagnostic.next_attempt_at) + 1);
    }
  });

  it("schedules bounded-slice exhaustion as useful continuation rather than provider backoff", async () => {
    const projectId = "PRJ-8315";
    const requestId = "DOC-8315-CONTINUE";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
    });
    vi.spyOn(ProjectGuard.prototype as any, "resumeManagedDocument").mockRejectedValue(
      new Error("materialization_finalization_slice_budget_exhausted")
    );

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; message: string;
      }>("SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId).toArray()[0]);
      const diagnostic = JSON.parse(failure!.message);
      expect(failure).toMatchObject({ count: attempt, stopped: 0 });
      expect(diagnostic).toMatchObject({ classification: "continuation", code: "slice_budget_exhausted" });
      expect(Date.parse(diagnostic.next_attempt_at)).toBeGreaterThanOrEqual(Date.now() + 999);
      expect(Date.parse(diagnostic.next_attempt_at)).toBeLessThanOrEqual(Date.now() + 1_001);
      if (attempt < 7) vi.setSystemTime(Date.parse(diagnostic.next_attempt_at) + 1);
    }
  });

  it("keeps Dropbox request timeouts transient across seven document recovery attempts", async () => {
    const projectId = "PRJ-8321";
    const requestId = "DOC-8321-DROPBOX-TIMEOUT";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
    });
    vi.spyOn(ProjectGuard.prototype as any, "resumeManagedDocument").mockRejectedValue(
      new Error("dropbox_request_timeout")
    );

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; message: string;
      }>("SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId).toArray()[0]);
      expect(failure).toMatchObject({ count: attempt, stopped: 0 });
      expect(JSON.parse(failure!.message)).toMatchObject({ classification: "provider_temporary", code: "network_transport_unavailable" });
      const dueAt = Date.parse(JSON.parse(failure!.message).next_attempt_at);
      expect(dueAt).toBeGreaterThan(Date.now());
      if (attempt < 7) vi.setSystemTime(dueAt + 1);
    }
  });

  it("blocks permanent request-recovery failures immediately with a visible diagnostic", async () => {
    const projectId = "PRJ-8313";
    const requestId = "DOC-8313-BLOCKED";
    const { guard } = await setup(projectId);
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
    });
    vi.spyOn(ProjectGuard.prototype as any, "resumeManagedDocument").mockRejectedValue(
      new ProviderConflictError("provider_conflict", { providerId: "dropbox", code: "permanent_conflict" })
    );
    await runInDurableObject(guard, instance =>
      (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
    );

    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    expect(await status.json()).toMatchObject({
      status: "recovery_blocked",
      recovery: { code: "permanent_conflict", classification: "provider_blocked" },
      observation: { recovery: { state: "blocked" } }
    });
    await runInDurableObject(guard, async (_instance, state) => {
      const failure = state.storage.sql.exec<{ count: number; stopped: number }>(
        "SELECT count, stopped FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId
      ).toArray()[0];
      expect(failure).toEqual({ count: 1, stopped: 1 });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("stops six identical no-progress request-recovery failures", async () => {
    const projectId = "PRJ-8314";
    const requestId = "DOC-8314-INTERNAL";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    await runInDurableObject(guard, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
    });
    vi.spyOn(ProjectGuard.prototype as any, "resumeManagedDocument").mockRejectedValue(
      new Error("persistent_internal_defect")
    );

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await runInDurableObject(guard, instance =>
        (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
      );
      const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{
        count: number; stopped: number; fingerprint: string; message: string;
      }>("SELECT count, stopped, fingerprint, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId).toArray()[0]);
      expect(failure).toMatchObject({ count: attempt, stopped: attempt === 6 ? 1 : 0 });
      if (attempt < 6) vi.setSystemTime(Date.now() + 30_001);
    }
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    expect(await status.json()).toMatchObject({
      status: "recovery_blocked",
      recovery: { code: "identical_internal_failure_limit", classification: "internal" },
      observation: { recovery: { state: "blocked" } }
    });
  });

  it("resets the internal streak when the execution journal has durable step progress", async () => {
    const projectId = "PRJ-8316";
    const requestId = "DOC-8316-PROGRESS";
    const { guard } = await setup(projectId);
    const originalStatus = ExecutionJournal.prototype.status;
    let targetProgressReads = 0;
    vi.spyOn(ExecutionJournal.prototype, "status").mockImplementation(async function(this: ExecutionJournal) {
      if (this.projectId !== projectId || this.requestId !== requestId) return originalStatus.call(this);
      targetProgressReads += 1;
      const completed = targetProgressReads >= 2;
      return {
        status: "admitted", terminal: false,
        completed_steps: completed ? [{ step_id: "copy-1", evidence_refs: ["evidence:copy-1"] }] : [],
        postchecks: [], receipt_ref: null, finalization_ref: null
      } as any;
    });

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const failure = await runInDurableObject(guard, instance =>
        (instance as any).recordRecoveryFailure("document", requestId, new Error("persistent_internal_defect"), "a".repeat(64))
      );
      if (attempt === 6) expect(failure).toMatchObject({ count: 1, stopped: false });
      if (attempt === 11) expect(failure).toMatchObject({ count: 6, stopped: true, code: "identical_internal_failure_limit" });
    }
    expect(targetProgressReads).toBe(3);
  });

  it("preserves document recovery when reading its canonical intent has a retryable provider failure", async () => {
    const projectId = "PRJ-8318";
    const requestId = "DOC-8318-READ-RETRY";
    const { guard } = await setup(projectId);
    vi.useFakeTimers({ toFake: ["Date"] });
    await runInDurableObject(guard, (instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
      vi.spyOn((instance as any).managedDocumentRequests, "readRecoverableIntent").mockRejectedValue(
        new ProviderOperationError("provider_unavailable", true, { providerId: "dropbox", status: 503, retryAfterMs: 60_000 })
      );
    });

    await runInDurableObject(guard, instance =>
      (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
    );

    await runInDurableObject(guard, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM request_recovery WHERE kind = 'document' AND request_id = ?", requestId).toArray()).toHaveLength(1);
      const failure = state.storage.sql.exec<{ count: number; stopped: number; message: string }>(
        "SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId
      ).toArray()[0];
      expect(failure).toMatchObject({ count: 1, stopped: 0 });
      expect(JSON.parse(failure!.message)).toMatchObject({ classification: "provider_temporary", code: "provider_http_503" });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("automatically resumes an admitted navigation request by alarm without status polling", async () => {
    const projectId = "PRJ-8320";
    const request = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAVIGATION-WORKING-8320",
      project_id: projectId,
      zone: "WORKING" as const,
      expected_project_revision: 1,
      expected_generation: 0,
      expected_index: null,
      created_at: "2026-09-25T10:00:00.000Z"
    };
    const { guard, mock } = await setup(projectId);
    const inventoryPages: Array<{ cursor: string | null; calls_left: number }> = [];
    const originalListPage = ZoneNavigationInventory.prototype.listPage;
    vi.spyOn(ZoneNavigationInventory.prototype, "listPage").mockImplementation(async function (
      this: ZoneNavigationInventory,
      input: Parameters<ZoneNavigationInventory["listPage"]>[0]
    ) {
      inventoryPages.push({ cursor: input.cursor, calls_left: input.budget.calls_left });
      return originalListPage.call(this, input);
    });
    const contextResponse = await guard.fetch("https://project-guard.internal/mutation-context");
    const { context } = await contextResponse.json<{ context: never }>();
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context))
    });
    const initial = await response.json<{ status: string; code?: string }>();
    expect(["pending", "committed"]).toContain(initial.status);
    expect(inventoryPages).toHaveLength(0);

    // Do not call execution-status or request-status to wake navigation.
    for (let attempt = 0; attempt < 16; attempt++) {
      const headPath = [...mock.files.keys()].find((path) => path.endsWith("/navigation/WORKING/head.json"));
      const sourcePath = [...mock.files.keys()].find((path) => path.endsWith("/navigation-sources/state.json"));
      const adopted = sourcePath ? JSON.parse(mock.files.get(sourcePath)!).zones.WORKING.adopted : false;
      const progressPath = [...mock.files.keys()].find((path) => path.includes("/executions/") && path.endsWith("/progress.json"));
      const progress = progressPath ? JSON.parse(mock.files.get(progressPath)!) : null;
      if (headPath && JSON.parse(mock.files.get(headPath)!).generation === 1 && adopted && progress?.status === "finalized" && progress?.terminal === true) break;
      await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), (instance) => instance.alarm());
      await runInDurableObject(guard, (instance) => instance.alarm());
    }
    const headPath = [...mock.files.keys()].find((path) => path.endsWith("/navigation/WORKING/head.json"));
    expect(headPath).toBeDefined();
    expect(inventoryPages.some(({ cursor }) => cursor?.startsWith("packages:"))).toBe(true);
    expect(inventoryPages.every(({ calls_left }) => calls_left > 0 && calls_left <= 32)).toBe(true);
    expect(JSON.parse(mock.files.get(headPath!)!)).toMatchObject({ project_id: projectId, zone: "WORKING", generation: 1, source_request_id: request.request_id });
    const executionProgressPath = [...mock.files.keys()].find((path) => path.includes("/executions/") && path.endsWith("/progress.json"));
    expect(executionProgressPath).toBeDefined();
    expect(JSON.parse(mock.files.get(executionProgressPath!)!)).toMatchObject({ status: "finalized", terminal: true });
    expect([...mock.files.keys()].some((path) => path.includes("/WORKING/00-CURRENT.md"))).toBe(true);
  });

  it("fences a prepared navigation after a source-generation interleave and replays duplicate workrefs safely", async () => {
    const projectId = "PRJ-8400";
    const request = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAVIGATION-WORKING-8400001",
      project_id: projectId,
      zone: "WORKING" as const,
      expected_project_revision: 1,
      expected_generation: 0,
      expected_index: null,
      created_at: "2026-09-25T10:00:00.000Z"
    };
    const { guard, mock } = await setup(projectId);
    const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const ingress = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context.context))
    });
    expect(ingress.status).toBe(202);

    const materialization = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    const runPreparationSlice = () => runInDurableObject(materialization, (instance) =>
      (instance as any).serialize(() => (instance as any).runNavigationWorkSlice())
    );
    let first: any;
    for (let attempt = 0; attempt < 16; attempt++) {
      first = await runPreparationSlice();
      if (first?.publish) break;
    }
    const replay = await runPreparationSlice();
    expect(first).toMatchObject({ publish: true, ref: { request_id: request.request_id, request_hash: expect.any(String) } });
    expect(replay).toEqual(first);

    await runInDurableObject(guard, (instance) => (instance as any).serialize(() =>
      (instance as any).recordObservedNavigationSourceMutation(projectId, "WORKING", "package:PKG-NAV-INTERLEAVE-8400")
    ));
    const publish = await guard.fetch("https://project-guard.internal/navigation-publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(first.ref)
    });
    expect(publish.status).toBe(409);
    expect(await publish.json()).toMatchObject({ status: "conflict", code: "navigation_snapshot_changed" });
    expect([...mock.files.keys()].some((path) => path.endsWith("/navigation/WORKING/head.json"))).toBe(false);
    expect([...mock.files.keys()].some((path) => path.endsWith("/WORKING/00-CURRENT.md"))).toBe(false);
  });

  it("releases only the matching unadopted owner after terminal navigation conflict", async () => {
    const projectId = "PRJ-8401";
    const request = {
      operation: "navigation.reconcile" as const, request_id: "DOCREQ-NAV-CONFLICT-8401",
      project_id: projectId, zone: "WORKING" as const, expected_project_revision: 1,
      expected_generation: 0, expected_index: null, created_at: "2026-09-25T10:00:00.000Z"
    };
    const { guard, mock } = await setup(projectId);
    seedUnadoptedNavigationGeneration(mock, projectId, 1);
    const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context.context))
    })).status).toBe(202);
    const materialization = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
    let prepared: any;
    for (let attempt = 0; attempt < 16; attempt++) {
      prepared = await runInDurableObject(materialization, (instance) =>
        (instance as any).serialize(() => (instance as any).runNavigationWorkSlice())
      );
      if (prepared?.publish) break;
    }
    expect(prepared?.publish).toBe(true);
    const progressPath = `${prepared.ref.authority_ref.replace(/\/admission\.json$/, "")}/navigation-progress.json`;
    mock.files.delete(progressPath);
    const terminal = await guard.fetch("https://project-guard.internal/navigation-publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepared.ref)
    });
    expect(terminal.status).toBe(409);
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({
      generation: 1, adopted: false, adoption_request_id: null
    });
    const successor = { ...request, request_id: "DOCREQ-NAV-CONFLICT-SUCCESSOR-8401" };
    const successorContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(successor, successorContext.context))
    })).status).toBe(202);
    expect(await sources.beginAdoption(projectId, "WORKING", successor.request_id, 1)).toBe(true);
    expect(await sources.abortAdoption(projectId, "WORKING", request.request_id, 1)).toBe(false);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ adoption_request_id: successor.request_id });
  });

  it("releases a historical terminal-conflict navigation owner only after a fresh authorized successor admission", async () => {
    const projectId = "PRJ-8463";
    const prior = {
      operation: "navigation.reconcile" as const, request_id: "DOCREQ-NAV-CONFLICT-HISTORICAL-8463",
      project_id: projectId, zone: "WORKING" as const, expected_project_revision: 1,
      expected_generation: 0, expected_index: null, created_at: "2026-09-25T10:00:00.000Z"
    };
    const { guard } = await setup(projectId);
    const abortAdoption = vi.spyOn(ZoneNavigationSources.prototype, "abortAdoption");
    const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(prior, context.context))
    })).status).toBe(202);

    const terminalReceipt = {
      operation: prior.operation, request_id: prior.request_id, project_id: projectId,
      status: "conflict" as const, execution_status: "conflict" as const, code: "navigation_snapshot_changed"
    };
    await runInDurableObject(guard, async (instance) => {
      const ledger = (instance as any).managedDocumentRequests;
      await ledger.writeReceipt(projectId, prior.request_id, JSON.stringify(prior), JSON.stringify(terminalReceipt));
      await (instance as any).settleNavigationReceipt(prior, terminalReceipt);
    });
    const journal = new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", prior.request_id);
    expect(await journal.status()).toMatchObject({ status: "conflict", terminal: true });
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    expect(await sources.beginAdoption(projectId, "WORKING", prior.request_id, 0)).toBe(true);

    const successor = { ...prior, request_id: "DOCREQ-NAV-CONFLICT-SUCCESSOR-8463" };
    const successorContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const successorBody = JSON.stringify(encodeAdmission(successor, successorContext.context));
    abortAdoption.mockResolvedValueOnce(false);
    await guard.fetch("https://project-guard.internal/document", { method: "POST", body: successorBody });
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ adoption_request_id: prior.request_id });
    expect(await runInDurableObject(guard, (instance) => (instance as any).managedDocumentRequests.readReceipt(projectId, successor.request_id))).toBeNull();

    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: successorBody
    })).status).toBe(202);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({
      generation: 0, adopted: false, adoption_request_id: null, in_flight_resource_ids: []
    });
    expect(abortAdoption).toHaveBeenCalledWith(projectId, "WORKING", prior.request_id, 0, expect.anything());

    expect(await sources.beginAdoption(projectId, "WORKING", successor.request_id, 0)).toBe(true);
    const activeSuccessor = { ...successor, request_id: "DOCREQ-NAV-CONFLICT-ACTIVE-8463" };
    const activeContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(activeSuccessor, activeContext.context))
    })).status).toBe(202);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({
      generation: 0, adopted: false, adoption_request_id: successor.request_id, in_flight_resource_ids: []
    });

    const inFlight = await sources.beginHeadWrite(projectId, "WORKING", "head:DOC-NAV-IN-FLIGHT-8463");
    expect(inFlight).toMatchObject({ generation: 1, resource_id: "head:DOC-NAV-IN-FLIGHT-8463" });
    const inFlightSuccessor = { ...activeSuccessor, request_id: "DOCREQ-NAV-CONFLICT-INFLIGHT-8463" };
    const inFlightContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    expect((await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(inFlightSuccessor, inFlightContext.context))
    })).status).toBe(202);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({
      generation: 1, adopted: false, adoption_request_id: successor.request_id,
      in_flight_resource_ids: ["head:DOC-NAV-IN-FLIGHT-8463"]
    });
  });

  it("stops six identical no-progress navigation failures using the durable recovery ledger", async () => {
    const projectId = "PRJ-8344";
    const request = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAV-FAILURE-STREAK-8344",
      project_id: projectId,
      zone: "WORKING" as const,
      expected_project_revision: 1,
      expected_generation: 0,
      expected_index: null,
      created_at: "2026-09-25T10:00:00.000Z"
    };
    const { guard, mock } = await setup(projectId);
    seedUnadoptedNavigationGeneration(mock, projectId, 1);
    const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const ingress = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(request, context.context))
    });
    expect(ingress.status).toBe(202);
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    expect(await sources.beginAdoption(projectId, "WORKING", request.request_id, 1)).toBe(true);
    const work = await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), (_instance, state) =>
      state.storage.list<string>({ prefix: "navigation-work" })
    );
    const rawRef = [...work.values()][0];
    expect(rawRef).toBeDefined();
    const ref = JSON.parse(rawRef!) as Record<string, unknown>;

    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await guard.fetch("https://project-guard.internal/navigation-publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ref, failure_code: "navigation_work_internal_failure" })
      });
    }
    expect(await response!.json()).toMatchObject({ status: "stopped", failure_code: "identical_internal_failure_limit" });
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, adoption_request_id: null });
    const successorId = "DOCREQ-NAV-FAILURE-SUCCESSOR-8344";
    expect(await sources.beginAdoption(projectId, "WORKING", successorId, 1)).toBe(true);
    expect(await sources.abortAdoption(projectId, "WORKING", request.request_id, 1)).toBe(false);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ adoption_request_id: successorId });
    const failure = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{ count: number; stopped: number }>(
      "SELECT count, stopped FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", request.request_id
    ).toArray()[0]);
    expect(failure).toMatchObject({ count: 6, stopped: 1 });
    const pending = await runInDurableObject(guard, (instance) => (instance as any).pendingRequestRecovery() as Array<{ kind: string; request_id: string }>);
    expect(pending).not.toContainEqual({ kind: "document", request_id: request.request_id });
    const frozenPath = `${machineDocumentRoot(projectId)}/requests/${request.request_id}/navigation-admitted-state.json`;
    const frozen = JSON.parse(mock.files.get(frozenPath)!);
    const admission = (await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", request.request_id).readAdmission())!.admission;
    const replay = await runInDurableObject(guard, (instance) => (instance as any).executeNavigationSlice(request, frozen.state, admission) as Promise<Response>);
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ status: "pending", code: "identical_internal_failure_limit" });
  });

  it("releases the ProjectGuard queue between recovery jobs so an enqueued request runs before the next job", async () => {
    const { guard } = await setup("PRJ-8343");
    await runInDurableObject(guard, async (instance) => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      let signalFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
      const internal = instance as unknown as Record<string, any>;
      vi.spyOn(internal, "pendingRequestRecovery").mockReturnValue([
        { kind: "document", request_id: "job-1" },
        { kind: "document", request_id: "job-2" }
      ]);
      vi.spyOn(internal, "resumeManagedDocument").mockImplementation(async (...args: unknown[]) => {
        const requestId = args[0] as string;
        order.push(`start:${requestId}`);
        if (requestId === "job-1") {
          signalFirst();
          await firstBlocked;
        }
        order.push(`end:${requestId}`);
      });
      for (const method of ["scheduleNextRequestRecoveryWake", "resumePendingNavigationRefreshes", "resumePendingMaterializationFinalization", "resumePendingTransactionRecovery"]) {
        vi.spyOn(internal, method).mockResolvedValue(undefined);
      }
      const alarm = instance.alarm();
      await firstStarted;
      const queuedRequest = internal.serialize(async () => { order.push("client-request"); });
      order.push("client-enqueued");
      releaseFirst();
      await Promise.all([alarm, queuedRequest]);
      expect(order).toEqual([
        "start:job-1", "client-enqueued", "end:job-1", "client-request", "start:job-2", "end:job-2"
      ]);
    });
  });

  it("recovers an interrupted dirty-to-outbox write and refreshes without status polling", async () => {
    const projectId = "PRJ-8321";
    const { guard, mock } = await setup(projectId);
    const navigation = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAVIGATION-WORKING-8321",
      project_id: projectId,
      zone: "WORKING" as const,
      expected_project_revision: 1,
      expected_generation: 0,
      expected_index: null,
      created_at: "2026-09-25T10:00:00.000Z"
    };
    const initialContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const initialResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(navigation, initialContext.context))
    });
    expect([200, 202, 503]).toContain(initialResponse.status);
    for (let attempt = 0; attempt < 16; attempt++) {
      const headPath = [...mock.files.keys()].find((path) => path.endsWith("/navigation/WORKING/head.json"));
      const sourcePath = [...mock.files.keys()].find((path) => path.endsWith("/navigation-sources/state.json"));
      const adopted = sourcePath ? JSON.parse(mock.files.get(sourcePath)!).zones.WORKING.adopted : false;
      if (headPath && JSON.parse(mock.files.get(headPath)!).generation === 1 && adopted) break;
      await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), (instance) => instance.alarm());
      await runInDurableObject(guard, (instance) => instance.alarm());
    }
    const navHeadPath = [...mock.files.keys()].find((path) => path.endsWith("/navigation/WORKING/head.json"));
    expect(navHeadPath).toBeDefined();
    expect(JSON.parse(mock.files.get(navHeadPath!)!).generation).toBe(1);

    let interruptOutboxOnce = true;
    const enqueueDirtyZones = (ProjectGuard.prototype as any).enqueueNavigationRefreshForDirtyZones;
    vi.spyOn(ProjectGuard.prototype as any, "enqueueNavigationRefreshForDirtyZones").mockImplementation(async function (
      this: ProjectGuard,
      ...args: unknown[]
    ) {
      if (interruptOutboxOnce) {
        interruptOutboxOnce = false;
        throw new Error("injected dirty-to-outbox interruption");
      }
      return enqueueDirtyZones.call(this, args[0]);
    });

    const content = "# Automatically refreshed\n";
    const workingWrite = {
      operation: "working.write" as const,
      request_id: "DOCREQ-NAV-AUTO-SOURCE-8321",
      project_id: projectId,
      logical_path: "notes/automatic.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: "2026-09-25T10:01:00.000Z"
    };
    const workingContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const workingResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(workingWrite, workingContext.context))
    });
    expect(workingResponse.status).toBe(503);
    expect(await workingResponse.json()).toMatchObject({ status: "pending", request_id: workingWrite.request_id });
    expect([...mock.files.keys()].some((path) => path.includes("navigation-sources/WORKING/dirty/"))).toBe(true);
    expect(await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec("SELECT * FROM navigation_refresh_outbox").toArray())).toHaveLength(0);

    for (let attempt = 0; attempt < 12; attempt++) {
      const navHead = JSON.parse(mock.files.get(navHeadPath!)!);
      if (navHead.generation === 2) break;
      await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), (instance) => instance.alarm());
      await runInDurableObject(guard, (instance) => instance.alarm());
    }
    expect(JSON.parse(mock.files.get(navHeadPath!)!)).toMatchObject({ generation: 2, zone: "WORKING" });
    const currentIndex = [...mock.files.entries()].find(([path]) => path.endsWith("/WORKING/00-CURRENT.md"))?.[1];
    expect(currentIndex).toContain("](./notes/automatic.md)");
  });

  it("uses a new automatic request identity when a frozen pre-admission snapshot goes stale", async () => {
    const projectId = "PRJ-8322";
    const { guard, mock } = await setup(projectId);
    const navigation = {
      operation: "navigation.reconcile" as const,
      request_id: "DOCREQ-NAVIGATION-WORKING-8322",
      project_id: projectId,
      zone: "WORKING" as const,
      expected_project_revision: 1,
      expected_generation: 0,
      expected_index: null,
      created_at: "2026-09-25T10:00:00.000Z"
    };
    const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(navigation, context.context))
    });
    let navHeadPath: string | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      navHeadPath = [...mock.files.keys()].find((path) => path.endsWith("/navigation/WORKING/head.json"));
      const sourcePath = [...mock.files.keys()].find((path) => path.endsWith("/navigation-sources/state.json"));
      const progressPath = [...mock.files.keys()].find((path) => path.includes("/executions/") && path.endsWith("/progress.json"));
      const progress = progressPath ? JSON.parse(mock.files.get(progressPath)!) : null;
      if (navHeadPath && JSON.parse(mock.files.get(navHeadPath)!).generation === 1
        && sourcePath && JSON.parse(mock.files.get(sourcePath)!).zones.WORKING.adopted
        && progress?.status === "finalized" && progress?.terminal === true) break;
      await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), (instance) => instance.alarm());
      await runInDurableObject(guard, (instance) => instance.alarm());
    }
    expect(navHeadPath).toBeDefined();

    const content = "# Snapshot recovered\n";
    const workingWrite = {
      operation: "working.write" as const,
      request_id: "DOCREQ-NAV-AUTO-SOURCE-8322",
      project_id: projectId,
      logical_path: "notes/frozen-revision.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: "2026-09-25T10:02:00.000Z"
    };
    const workingContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const workingResponse = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", body: JSON.stringify(encodeAdmission(workingWrite, workingContext.context))
    });
    expect(await workingResponse.json()).toMatchObject({ status: "committed" });

    let interruptBeforeAdmission = true;
    const persistAdmission = (ProjectGuard.prototype as any).persistAdmissionProof;
    vi.spyOn(ProjectGuard.prototype as any, "persistAdmissionProof").mockImplementation(async function (
      this: ProjectGuard,
      ...args: unknown[]
    ) {
      const requestId = args[1];
      if (interruptBeforeAdmission && typeof requestId === "string" && requestId.startsWith("DOCREQ-NAV-AUTO-")) {
        interruptBeforeAdmission = false;
        throw new Error("injected after frozen state, before journal admission");
      }
      return persistAdmission.call(this, ...args);
    });
    await runInDurableObject(guard, (instance) => instance.alarm());

    const outboxBefore = await runInDurableObject(guard, (_instance, state) =>
      state.storage.sql.exec<{ request_json: string; source_generation: number }>("SELECT request_json, source_generation FROM navigation_refresh_outbox WHERE zone = 'WORKING'").toArray()[0]
    );
    const staleRequest = JSON.parse(outboxBefore!.request_json);
    expect([...mock.files.keys()].some((path) => path.endsWith(`/requests/${staleRequest.request_id}/navigation-admitted-state.json`))).toBe(true);
    expect(await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", staleRequest.request_id).readAdmission()).toBeNull();

    const transactionContext = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const transaction = {
      schema_version: "1.0", project_id: projectId, transaction_id: "TXN-EXECUTION-83220001", base_revision: 1,
      operation: "task.create", created_at: "2026-09-25T10:03:00.000Z", payload: { task_id: "TASK-8322", title: "Advance project revision" }
    };
    expect(await (await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", body: JSON.stringify(encodeAdmission(transaction, transactionContext.context))
    })).json()).toMatchObject({ status: "committed", new_revision: 2 });

    for (let attempt = 0; attempt < 16; attempt++) {
      const head = JSON.parse(mock.files.get(navHeadPath!)!);
      if (head.generation >= 2) break;
      await runDurableObjectAlarm(testEnv.MATERIALIZATION_GUARD.getByName(projectId));
      await runInDurableObject(guard, (instance) => instance.alarm());
    }
    expect(JSON.parse(mock.files.get(navHeadPath!)!)).toMatchObject({ generation: 2, zone: "WORKING" });
    const automaticAdmissions = [...mock.files.entries()]
      .filter(([path, raw]) => path.endsWith("/admission.json") && JSON.parse(raw).admission.operation === "navigation.reconcile")
      .map(([, raw]) => JSON.parse(raw).admission.request_id as string)
      .filter((requestId) => requestId.startsWith("DOCREQ-NAV-AUTO-WORKING-"));
    expect(automaticAdmissions).toContain(`DOCREQ-NAV-AUTO-WORKING-S${outboxBefore!.source_generation}-R2-G1`);
    expect(automaticAdmissions).not.toContain(staleRequest.request_id);
    const refreshed = await runInDurableObject(guard, (_instance, state) =>
      state.storage.sql.exec<{ request_json: string }>("SELECT request_json FROM navigation_refresh_outbox WHERE zone = 'WORKING'").toArray()[0]
    );
    expect(refreshed).toBeUndefined();
  });

  it("keeps a corrupt canonical document intent queued as a visible blocked recovery", async () => {
    const projectId = "PRJ-8319";
    const requestId = "DOC-8319-CORRUPT-INTENT";
    const { guard } = await setup(projectId);
    await runInDurableObject(guard, (instance, state) => {
      state.storage.sql.exec("INSERT INTO request_recovery (kind, request_id) VALUES ('document', ?)", requestId);
      vi.spyOn((instance as any).managedDocumentRequests, "readRecoverableIntent").mockRejectedValue(
        new Error("managed_document_intent_invalid")
      );
    });

    await runInDurableObject(guard, instance =>
      (instance as unknown as { resumePendingRequestRecovery(): Promise<void> }).resumePendingRequestRecovery()
    );
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    expect(await status.json()).toMatchObject({
      status: "recovery_blocked",
      recovery: { code: "document_intent_invalid", classification: "provider_blocked", next_action: "wait_for_dependency" },
      observation: { recovery: { state: "blocked" } }
    });
    await runInDurableObject(guard, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM request_recovery WHERE kind = 'document' AND request_id = ?", requestId).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec<{ stopped: number }>(
        "SELECT stopped FROM request_recovery_failures WHERE kind = 'document' AND request_id = ?", requestId
      ).toArray()[0]).toEqual({ stopped: 1 });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
