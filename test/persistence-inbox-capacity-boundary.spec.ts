import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { machineCommitRecordPath, machineReceiptPath, machineTransactionPath } from "../src/persistence/layout";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { transactionFailurePath } from "../src/inbox/processor";
import { installDropboxMock } from "./helpers/mock-dropbox";

it("keeps a real inbox transaction pending when ProjectGuard has zero continuation capacity", async () => {
  const testEnv = env as unknown as Env;
  const projectId = "PRJ-8470";
  const mock = installDropboxMock();
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  const create = {
    schema_version: "1.0", transaction_id: "TXN-INBOX-CAPACITY-CREATE-8470", project_id: projectId,
    base_revision: 0, operation: "project.create", created_at: "2026-09-24T12:00:00.000Z",
    payload: { name: "Inbox capacity boundary", slug: "inbox-capacity-boundary", aliases: [], objective: "Preserve queued work when continuation capacity is zero" }
  };
  expect(await (await guard.fetch("https://project-guard.internal/transaction", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create)
  })).json()).toMatchObject({ status: "committed", new_revision: 1 });

  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { env: Env }).env.PROJECT_OS_CONVERGENCE_PROJECT_MODES = JSON.stringify({ [projectId]: "repair" });
  });
  const progress = initialProgress(projectId, "2026-09-24T12:00:00.000Z", "inbox-capacity-zero");
  progress.obligations["b".repeat(64)] = {
    id: "b".repeat(64), layer: "human_handoff", from_revision: 0,
    target: { revision: 1, projection_version: CURRENT_PROJECTION_VERSION }, incident: 1,
    state: "retry_wait", first_pending_at: "2026-09-24T12:00:00.000Z",
    next_attempt_at: "2026-09-24T12:05:00.000Z", failure_count: 1,
    last_attempt_number: 1, last_closed_attempt_number: 1, last_verified_at: null,
    code: "human_write_failed", lease_until: null, continuation: null
  };
  await new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId).save(progress, null);
  await runInDurableObject(testEnv.MATERIALIZATION_GUARD.getByName(projectId), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });

  const transaction = {
    schema_version: "1.0", transaction_id: "TXN-INBOX-CAPACITY-TASK-8470", project_id: projectId,
    base_revision: 1, operation: "task.create", created_at: "2026-09-24T12:01:00.000Z",
    payload: { task_id: "TASK-INBOXCAP8470", title: "Remain queued at capacity zero" }
  };
  const incoming = machineTransactionPath("incoming", transaction.transaction_id);
  mock.files.set(incoming, JSON.stringify(transaction));

  const process = () => worker.fetch(new Request("https://project-os.test/v1/admin/process-inbox", {
    method: "POST", headers: { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` }
  }), testEnv, createExecutionContext());
  const first = await process();
  expect(first.status).toBe(200);
  await expect(first.json()).resolves.toMatchObject({ scanned: 1, processed: 0, failed: 1 });
  expect(mock.files.get(incoming)).toBe(JSON.stringify(transaction));
  expect(JSON.parse(mock.files.get(transactionFailurePath("v2", transaction.transaction_id)) ?? "null"))
    .toMatchObject({ status: "retryable_failure", attempt_count: 1, message: "convergence_capacity_exceeded" });
  expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
  expect(mock.files.has(machineReceiptPath(transaction.transaction_id))).toBe(false);

  const second = await process();
  await expect(second.json()).resolves.toMatchObject({ scanned: 1, processed: 0, failed: 0 });
  expect(JSON.parse(mock.files.get(transactionFailurePath("v2", transaction.transaction_id)) ?? "null"))
    .toMatchObject({ attempt_count: 1, message: "convergence_capacity_exceeded" });
  expect(mock.files.get(incoming)).toBe(JSON.stringify(transaction));
  expect(mock.files.has(machineCommitRecordPath(projectId, 2))).toBe(false);
});
