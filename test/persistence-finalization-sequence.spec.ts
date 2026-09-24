import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encodeAdmission } from "../src/admission/transport";
import type { MutationContext } from "../src/admission/mutation-context";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { ExecutionJournal } from "../src/execution/journal";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { machineMaterializationHeadPath, machineMaterializationRecordPath, machineStatePath } from "../src/persistence/layout";
import { commitFixture, seedCommits } from "./helpers/convergence-fixture";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("finalizes three strict commits using alarms, with the middle revision explicitly coalesced", async () => {
  const environment = env as unknown as Env;
  const projectId = "PRJ-8460";
  const mock = installDropboxMock();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  const initial = commitFixture(projectId, 1)[0]!;
  seedCommits(mock, [initial]);
  mock.files.set(machineStatePath(projectId), JSON.stringify(initial.state));
  const project = environment.PROJECT_GUARD.getByName(projectId);
  const materializer = environment.MATERIALIZATION_GUARD.getByName(projectId);
  const settings = {
    PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
    PROJECT_OS_CONVERGENCE_PROJECT_MODES: JSON.stringify({ [projectId]: "repair" }),
    MUTATION_CONTEXT_SIGNING_KEY: "sequence-context-fixture",
    RULE_ADMISSION_SIGNING_KEY: "sequence-rules-fixture"
  };
  for (const stub of [project, materializer]) {
    await runInDurableObject(stub, instance => Object.assign((instance as unknown as { env: Env }).env, settings));
  }
  await bootstrapRuleAdmissionGovernance(environment, settings.RULE_ADMISSION_SIGNING_KEY, projectId);

  const requestIds: string[] = [];
  async function submit(baseRevision: number) {
    const contextResponse = await project.fetch("https://guard.internal/mutation-context?include_state=false");
    expect(contextResponse.status).toBe(200);
    const { context } = await contextResponse.json<{ context: MutationContext }>();
    const requestId = `TXN-8460-SEQUENCE-${baseRevision}`;
    const request = {
      schema_version: "1.0", project_id: projectId, transaction_id: requestId,
      base_revision: baseRevision, operation: "task.create", created_at: new Date().toISOString(),
      payload: { task_id: `TASK-8460SEQ${baseRevision}`, title: `Sequence ${baseRevision}` }
    };
    const response = await project.fetch("https://guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(request, context))
    });
    expect(await response.json()).toMatchObject({ status: "committed", new_revision: baseRevision + 1 });
    requestIds.push(requestId);
  }

  async function drainThrough(target: number) {
    for (let wake = 0; wake < 128; wake += 1) {
      for (const stub of [materializer, project]) {
        const due = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
        if (due !== null) {
          vi.setSystemTime(Math.max(Date.now(), due));
          await runDurableObjectAlarm(stub);
        }
      }
      const head = JSON.parse(mock.files.get(machineMaterializationHeadPath(projectId)) ?? "null");
      const pending = await Promise.all([materializer, project].map(stub =>
        runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())));
      if (head?.target_revision === target && pending.every(value => value === null)) return;
    }
    throw new Error(`sequence_did_not_quiesce_at_${target}`);
  }

  await submit(1);
  await drainThrough(2);
  await submit(2);
  await submit(3);
  await drainThrough(4);

  const latest = JSON.parse(mock.files.get(machineMaterializationRecordPath(projectId, 4, CURRENT_PROJECTION_VERSION)) ?? "null");
  expect(latest?.coalesced_revisions).toContain(3);
  for (const requestId of requestIds) {
    const journal = new ExecutionJournal(createProductionPersistence(environment, projectId), projectId, "transaction", requestId);
    const status = await journal.status();
    expect(status, requestId).toMatchObject({ status: "finalized", terminal: true });
    expect(status?.finalization_ref).toBeTruthy();
    expect(mock.files.has(status!.finalization_ref!)).toBe(true);
  }
}, 60_000);
