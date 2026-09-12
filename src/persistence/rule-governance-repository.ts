import { z } from "zod";
import { applyRuleGovernance, globalGovernanceTransactionSchema, normalizeRuleMap, normalizeExceptionMap, ruleVersionKey, type GlobalGovernanceState, type GlobalGovernanceTransaction } from "../domain/rule-governance";
import { governanceQualificationSchema, verifyGovernanceQualification, type GovernanceQualification } from "../rules/qualification-record";
import type { Receipt } from "../domain/receipt";
import type { DomainEvent } from "../domain/event";
import { eventIdForRevision } from "../domain/event";
import type { ProjectOsPersistenceRuntime } from "./provider/capabilities";
import { ProviderConflictError } from "./provider/errors";
import { MACHINE_ROOT } from "./layout";

export const globalGovernancePath = `${MACHINE_ROOT}/registry/RULE_GOVERNANCE.json`;
export const globalGovernanceBootstrapPath = `${MACHINE_ROOT}/registry/RULE_GOVERNANCE_BOOTSTRAP.json`;
const bootstrapSchema = z.strictObject({ status: z.enum(["pending", "initialized"]), transaction: globalGovernanceTransactionSchema });
export interface GovernanceJournalEntry { transaction: GlobalGovernanceTransaction; receipt: Receipt; event?: DomainEvent; qualification?: GovernanceQualification; qualification_required?: true }
export interface CanonicalGovernance extends GlobalGovernanceState { journal: Record<string, GovernanceJournalEntry> }
const recordSchema = z.strictObject({
  revision: z.number().int().nonnegative(), rules: z.unknown(), exceptions: z.unknown(), journal: z.record(z.string(), z.unknown())
});
const receiptSchema = z.strictObject({
  schema_version: z.literal("1.0"), transaction_id: z.string(), project_id: z.literal("GLOBAL"),
  status: z.enum(["committed", "rejected", "conflict"]), previous_revision: z.number().int().nonnegative(),
  new_revision: z.number().int().nonnegative(), event_id: z.string().optional(), committed_at: z.string().optional(),
  code: z.string().optional(), message: z.string().optional()
});

/** One conditional canonical object keeps state, history and receipts in the same commit boundary. */
export class RuleGovernanceRepository {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}

  /** Absence is usable only before any canonical initialization evidence exists. Read faults propagate. */
  async isNeverInitialized(): Promise<boolean> {
    if (await this.readBootstrap()) return false;
    return await this.runtime.objects.getMetadata(globalGovernancePath) === null;
  }

  /** Only the exact first authorized proposal may resume an unfinished initialization. */
  async authorizeBootstrap(transaction: GlobalGovernanceTransaction): Promise<void> {
    if (transaction.operation !== "rule.propose" || transaction.base_revision !== 0) throw new Error("Global governance initialization requires an explicit first proposal");
    const bootstrap = await this.readBootstrap();
    if (bootstrap && (bootstrap.value.status === "initialized" || JSON.stringify(bootstrap.value.transaction) !== JSON.stringify(transaction))) throw new Error("Canonical global governance is missing after initialization");
  }

  private async readBootstrap() {
    const before = await this.runtime.objects.getMetadata(globalGovernanceBootstrapPath);
    if (!before) return null;
    if (!before.revisionToken) throw new Error("Governance bootstrap revision missing");
    const text = await this.runtime.objects.readText(globalGovernanceBootstrapPath);
    const after = await this.runtime.objects.getMetadata(globalGovernanceBootstrapPath);
    if (text === null || !after || before.revisionToken !== after.revisionToken) throw new ProviderConflictError("Governance bootstrap changed during read");
    return { value: bootstrapSchema.parse(JSON.parse(text)), token: before.revisionToken };
  }

  private async ensureBootstrapIntent(transaction: GlobalGovernanceTransaction): Promise<void> {
    await this.authorizeBootstrap(transaction);
    const content = JSON.stringify({ status: "pending", transaction });
    try { await this.runtime.objects.createText(globalGovernanceBootstrapPath, content); }
    catch (error) {
      const durable = await this.readBootstrap();
      if (!durable || JSON.stringify(durable.value) !== content) throw error;
    }
  }

  private async confirmBootstrap(state: CanonicalGovernance): Promise<void> {
    const bootstrap = await this.readBootstrap();
    if (!bootstrap) throw new Error("Governance initialization evidence missing");
    const initial = Object.values(state.journal)[0];
    if (!initial || JSON.stringify(initial.transaction) !== JSON.stringify(bootstrap.value.transaction)) throw new Error("Governance initialization evidence mismatch");
    if (bootstrap.value.status === "initialized") return;
    if (Object.keys(state.journal).length !== 1) throw new Error("Unconfirmed governance bootstrap cannot admit later transactions");
    const content = JSON.stringify({ ...bootstrap.value, status: "initialized" });
    try { await this.runtime.conditionalWrite.writeTextConditional(globalGovernanceBootstrapPath, content, bootstrap.token); }
    catch (error) {
      const durable = await this.readBootstrap();
      if (!durable || JSON.stringify(durable.value) !== content) throw error;
    }
  }

  async read(): Promise<{ state: CanonicalGovernance; token: string } | null> {
    const before = await this.runtime.objects.getMetadata(globalGovernancePath);
    if (!before) return null;
    if (!before.revisionToken) throw new Error("Global governance revision token missing");
    const text = await this.runtime.objects.readText(globalGovernancePath);
    const after = await this.runtime.objects.getMetadata(globalGovernancePath);
    if (text === null || !after || before.revisionToken !== after.revisionToken) throw new ProviderConflictError("Global governance changed during read");
    const state = await parseCanonicalGovernance(JSON.parse(text));
    await this.confirmBootstrap(state);
    return { state, token: before.revisionToken };
  }

  async write(state: CanonicalGovernance, expectedToken: string | null): Promise<void> {
    const content = JSON.stringify(await parseCanonicalGovernance(state));
    if (expectedToken === null) await this.ensureBootstrapIntent(Object.values(state.journal)[0].transaction);
    try {
      if (expectedToken === null) await this.runtime.objects.createText(globalGovernancePath, content);
      else await this.runtime.conditionalWrite.writeTextConditional(globalGovernancePath, content, expectedToken);
    } catch (error) {
      // A provider failure after upload is ambiguous: only exact durable content proves success.
      const durable = await this.read();
      if (!durable || JSON.stringify(durable.state) !== content) throw error;
    }
    await this.confirmBootstrap(state);
  }
}

async function parseCanonicalGovernance(input: unknown): Promise<CanonicalGovernance> {
  const raw = recordSchema.parse(input);
  if (raw.rules === undefined || raw.exceptions === undefined) throw new Error("Global governance maps missing");
  const rules = normalizeRuleMap(raw.rules, "GLOBAL");
  const exceptions = normalizeExceptionMap(raw.exceptions, "GLOBAL");
  const journal: Record<string, GovernanceJournalEntry> = {};
  let rebuilt: GlobalGovernanceState = { revision: 0, rules: {}, exceptions: {} };
  for (const [id, value] of Object.entries(raw.journal)) {
    const entry = z.strictObject({ transaction: globalGovernanceTransactionSchema, receipt: receiptSchema, event: z.unknown().optional(), qualification: governanceQualificationSchema.optional(), qualification_required: z.literal(true).optional() }).parse(value);
    if (entry.qualification_required && !entry.qualification) throw new Error("Required canonical activation qualification missing");
    if (id !== entry.transaction.transaction_id || id !== entry.receipt.transaction_id) throw new Error("Governance journal transaction mismatch");
    const { transaction, receipt } = entry;
    if (receipt.status === "committed") {
      if (entry.qualification) {
        if (transaction.operation !== "rule.activate") throw new Error("Qualification attached to a nonactivation transaction");
        await verifyGovernanceQualification(entry.qualification, transaction, rebuilt.rules[ruleVersionKey(transaction.payload.rule_id, transaction.payload.version)]);
      }
      if (transaction.base_revision !== rebuilt.revision || receipt.previous_revision !== rebuilt.revision || receipt.new_revision !== rebuilt.revision + 1) throw new Error("Governance journal revision mismatch");
      const result = applyRuleGovernance(rebuilt, transaction, "GLOBAL");
      if (result.kind !== "commit") throw new Error("Invalid governance history");
      const event: DomainEvent = { schema_version: "1.0", event_id: eventIdForRevision(receipt.new_revision),
        project_id: "GLOBAL", revision: receipt.new_revision, transaction_id: id,
        type: transaction.operation, timestamp: transaction.created_at, payload: transaction.payload };
      if (JSON.stringify(entry.event) !== JSON.stringify(event) || receipt.event_id !== event.event_id || receipt.committed_at !== transaction.created_at) throw new Error("Governance event evidence mismatch");
      rebuilt = { ...result.state, revision: receipt.new_revision };
      journal[id] = { transaction, receipt, event, ...(entry.qualification ? { qualification: entry.qualification } : {}), ...(entry.qualification_required ? { qualification_required: true } : {}) };
    } else {
      if (entry.event !== undefined || entry.qualification !== undefined || receipt.new_revision !== receipt.previous_revision || receipt.previous_revision !== rebuilt.revision) throw new Error("Invalid terminal governance receipt");
      journal[id] = { transaction, receipt };
    }
  }
  if (raw.revision !== rebuilt.revision || JSON.stringify(rules) !== JSON.stringify(rebuilt.rules) || JSON.stringify(exceptions) !== JSON.stringify(rebuilt.exceptions)) throw new Error("Governance snapshot does not match canonical history");
  return { revision: raw.revision, rules, exceptions, journal };
}
