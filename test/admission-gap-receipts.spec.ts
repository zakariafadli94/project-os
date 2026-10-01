import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAdmission } from "../src/admission/transport";
import { normalizeTransactionAdmission } from "../src/admission/operation-context";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import type { Env } from "../src/env";
import { ExecutionJournal } from "../src/execution/journal";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { readReceipt } from "../src/schema/receipt";
import { TransactionRequestLedger } from "../src/transactions/request-ledger";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";

const testEnv = env as unknown as Env;
const createdAt = "2026-10-01T10:00:00.000Z";
const signingKey = "admission-gap-receipts";
const gap = {
  rule: { rule_id: "RULE-GAP-RECEIPT-0001", version: 1, scope: { kind: "global" as const } },
  code: "ACCEPTED_UNENFORCED",
  check_id: "expected_version"
};
let dropbox: ReturnType<typeof installDropboxMock>;

async function createProject(transactionId: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: createdAt,
      payload: { name: `Gap receipt ${transactionId.slice(-4)}`, slug: `gap-receipt-${transactionId.slice(-4).toLowerCase()}`, aliases: [], objective: "Expose admission gaps" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

async function installGapAdmission(projectId: string, evaluatedGap = gap): Promise<void> {
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, instance => {
    Object.assign((instance as unknown as { env: Env }).env, {
      MUTATION_CONTEXT_SIGNING_KEY: signingKey,
      RULE_ADMISSION_SIGNING_KEY: signingKey,
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" })
    });
    vi.spyOn(instance as any, "ruleAdmissionRequired").mockResolvedValue(true);
    vi.spyOn(instance as any, "admitRules").mockImplementation(async (state: any, normalized: any, actor: any) => ({
      project_id: projectId,
      operation: normalized.operation,
      resources: normalized.resources,
      request_hash: normalized.request_hash,
      actor,
      global_revision: 1,
      project_revision: state.revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: state.revision },
      verdict: "allow",
      results: [],
      gaps: [evaluatedGap],
      deferred_rules: []
    }));
  });
}

describe("external admission gap receipts", () => {
  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("keeps legacy receipts without a gaps field valid", () => {
    expect(readReceipt({
      schema_version: "1.0",
      transaction_id: "TXN-GAP-LEGACY-0001",
      status: "committed",
      project_id: "PRJ-9001",
      previous_revision: 0,
      new_revision: 1,
      event_id: "EVT-000001",
      committed_at: createdAt
    })).not.toHaveProperty("gaps");
  });

  it("returns accepted-unenforced gaps on a committed transaction receipt", async () => {
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey);
    const created = await createProject("TXN-GAP-RECEIPT-TRANS-0001");
    const reevaluatedGap = { ...gap, code: "REEVALUATED_GAP_MUST_NOT_ESCAPE" };
    await installGapAdmission(created.project_id, reevaluatedGap);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-GAP-RECEIPT-TRANS-0002",
      project_id: created.project_id,
      base_revision: created.new_revision,
      operation: "task.create" as const,
      created_at: createdAt,
      payload: { task_id: "TASK-GAPRECEIPT0001", title: "Visible gap" }
    };
    const normalized = await normalizeTransactionAdmission(transaction);
    await new ExecutionJournal(createProductionPersistence(testEnv), created.project_id, "transaction", transaction.transaction_id).commit({
      project_id: created.project_id,
      request_id: transaction.transaction_id,
      kind: "transaction",
      operation: normalized.operation,
      request_hash: normalized.request_hash,
      actor: (context as any).actor,
      resources: normalized.resources,
      global_revision: 1,
      project_revision: created.new_revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: created.new_revision },
      verdict: "allow",
      results: [],
      gaps: [gap],
      deferred_rules: []
    }, null);
    const response = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(transaction, context))
    });

    const committed = await response.json<Record<string, unknown>>();
    expect(committed).toMatchObject({ status: "committed", gaps: [gap] });
    const legacy = { ...committed };
    delete legacy.gaps;
    await runInDurableObject(guard, instance => {
      (instance as any).ctx.storage.sql.exec(
        "UPDATE transactions SET receipt_json = ? WHERE transaction_id = ?",
        JSON.stringify(legacy), transaction.transaction_id
      );
    });
    const replay = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(transaction, context))
    });
    expect(await replay.json()).toMatchObject({ status: "committed", gaps: [gap] });
    const read = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await read.json()).toMatchObject({ status: "committed", gaps: [gap] });
    await runInDurableObject(guard, instance => { (instance as any).queueDepth = 1; });
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await status.json()).toMatchObject({ status: "committed", receipt: { gaps: [gap] } });
    await runInDurableObject(guard, instance => { (instance as any).queueDepth = 0; });
  });

  it("retains a committed admission gap when recovery no longer requires a new rule evaluation", async () => {
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey);
    const created = await createProject("TXN-GAP-RECOVERY-TRANS-9001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await installGapAdmission(created.project_id);
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const transaction = {
      schema_version: "1.0" as const,
      transaction_id: "TXN-GAP-RECOVERY-TRANS-9002",
      project_id: created.project_id,
      base_revision: created.new_revision,
      operation: "task.create" as const,
      created_at: createdAt,
      payload: { task_id: "TASK-GAPRECOVERY0001", title: "Keep historical gap" }
    };
    const normalized = await normalizeTransactionAdmission(transaction);
    const persistence = createProductionPersistence(testEnv);
    await new TransactionRequestLedger(persistence.objects).ensureTransactionRequest(created.project_id, transaction);
    await new ExecutionJournal(persistence, created.project_id, "transaction", transaction.transaction_id).commit({
      project_id: created.project_id,
      request_id: transaction.transaction_id,
      kind: "transaction",
      operation: normalized.operation,
      request_hash: normalized.request_hash,
      actor: (context as any).actor,
      resources: normalized.resources,
      global_revision: 1,
      project_revision: created.new_revision,
      ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: created.new_revision },
      verdict: "allow",
      results: [], gaps: [gap], deferred_rules: []
    }, null);
    await runInDurableObject(guard, instance => {
      vi.spyOn(instance as any, "ruleAdmissionRequired").mockResolvedValue(false);
    });

    const response = await guard.fetch("https://project-guard.internal/transaction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission(transaction, context))
    });
    expect(await response.json()).toMatchObject({ status: "committed", gaps: [gap] });
    const admissionPath = `${await new ExecutionJournal(persistence, created.project_id, "transaction", transaction.transaction_id).root()}/admission.json`;
    dropbox.downloadCalls.length = 0;
    const readOnce = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await readOnce.json()).toMatchObject({ status: "committed", gaps: [gap] });
    const readTwice = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await readTwice.json()).toMatchObject({ status: "committed", gaps: [gap] });
    expect(dropbox.downloadCalls.filter(path => path === admissionPath)).toHaveLength(1);
    await runInDurableObject(guard, async (_instance, ctx) => {
      const key = `admission-gaps:v1:transaction:${transaction.transaction_id}`;
      const cached = await ctx.storage.get<Record<string, unknown>>(key);
      await ctx.storage.put(key, { ...cached, gaps: "invalid-cache-entry" });
    });
    const afterCorruption = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${transaction.transaction_id}`);
    expect(await afterCorruption.json()).toMatchObject({ status: "committed", gaps: [gap] });
    expect(dropbox.downloadCalls.filter(path => path === admissionPath)).toHaveLength(2);
  });

  it("returns the immutable admission gaps on a committed document receipt", async () => {
    await bootstrapRuleAdmissionGovernance(testEnv, signingKey);
    const created = await createProject("TXN-GAP-RECEIPT-DOC-D001");
    await installGapAdmission(created.project_id);
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const { context } = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
    const content = "# Visible admission gap";

    const request = {
      operation: "working.write" as const,
      request_id: "DOCREQ-GAP-RECEIPT-0001",
      project_id: created.project_id,
      logical_path: "gap.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: createdAt
    };
    const envelope = JSON.stringify(encodeAdmission(request, context));
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope
    });

    const committed = await response.json<Record<string, unknown>>();
    expect(committed).toMatchObject({ status: "committed", gaps: [gap] });
    const admissionPath = `${await new ExecutionJournal(createProductionPersistence(testEnv), created.project_id, "document", request.request_id).root()}/admission.json`;
    dropbox.downloadCalls.length = 0;
    const freshRead = await guard.fetch(`https://project-guard.internal/receipt?kind=document&request_id=${request.request_id}`);
    expect(await freshRead.json()).toMatchObject({ status: "committed", gaps: [gap] });
    expect(dropbox.downloadCalls).not.toContain(admissionPath);
    const legacy = { ...committed };
    delete legacy.gaps;
    await runInDurableObject(guard, instance => {
      (instance as any).ctx.storage.sql.exec(
        "UPDATE document_requests SET receipt_json = ? WHERE request_id = ?",
        JSON.stringify(legacy), request.request_id
      );
    });
    const replay = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: envelope
    });
    expect(await replay.json()).toMatchObject({ status: "committed", gaps: [gap] });
    const read = await guard.fetch(`https://project-guard.internal/receipt?kind=document&request_id=${request.request_id}`);
    expect(await read.json()).toMatchObject({ status: "committed", gaps: [gap] });
    const status = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${request.request_id}`);
    expect(await status.json()).toMatchObject({ receipt: { status: "committed", gaps: [gap] } });
  });
});
