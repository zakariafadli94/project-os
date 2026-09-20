import type { Transaction } from "../domain/transaction";
import { parseTransaction } from "../domain/transaction";
import { canonicalJson } from "../rules/contract";
import { sha256Text } from "../documents/hash";
import { machineTransactionRequestIntentPath } from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";

export interface TransactionRequestIntent {
  schema_version: "1.0";
  project_id: string;
  transaction_id: string;
  request_sha256: string;
  request_json: string;
  actor?: { actor_id: string; authority: string };
}

export class TransactionRequestLedger {
  constructor(private readonly objects: ObjectPersistence) {}

  async ensureTransactionRequest(projectId: string, tx: Transaction, actor?: { actor_id: string; authority: string }): Promise<TransactionRequestIntent> {
    if (tx.project_id !== projectId) throw new Error("transaction_intent_project_mismatch");
    const requestJson = canonicalJson(tx);
    const record: TransactionRequestIntent = {
      schema_version: "1.0", project_id: projectId, transaction_id: tx.transaction_id,
      request_sha256: await sha256Text(requestJson), request_json: requestJson,
      ...(actor ? { actor } : {})
    };
    const path = machineTransactionRequestIntentPath(projectId, tx.transaction_id);
    try {
      await this.objects.createText(path, JSON.stringify(record));
      return record;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readIntent(projectId, tx.transaction_id);
      if (!existing || existing.request_sha256 !== record.request_sha256
        || (actor && (existing.actor?.actor_id !== actor.actor_id || existing.actor.authority !== actor.authority))) {
        throw new Error("idempotency_payload_mismatch");
      }
      return existing;
    }
  }

  async readIntent(projectId: string, transactionId: string): Promise<TransactionRequestIntent | null> {
    const raw = await this.objects.readText(machineTransactionRequestIntentPath(projectId, transactionId));
    if (raw === null) return null;
    const record = JSON.parse(raw) as Partial<TransactionRequestIntent>;
    if (record.schema_version !== "1.0" || record.project_id !== projectId || record.transaction_id !== transactionId
      || !record.request_json || !record.request_sha256 || !/^[a-f0-9]{64}$/.test(record.request_sha256)
      || await sha256Text(record.request_json) !== record.request_sha256
      || (record.actor !== undefined && (!record.actor || typeof record.actor.actor_id !== "string" || typeof record.actor.authority !== "string"))) {
      throw new Error("transaction_intent_invalid");
    }
    return record as TransactionRequestIntent;
  }

  async readRecoverableTransaction(projectId: string, transactionId: string): Promise<Transaction | null> {
    const intent = await this.readIntent(projectId, transactionId);
    if (!intent) return null;
    const tx = parseTransaction(JSON.parse(intent.request_json));
    if (tx.project_id !== projectId || tx.transaction_id !== transactionId || canonicalJson(tx) !== intent.request_json) {
      throw new Error("transaction_intent_identity_mismatch");
    }
    return tx;
  }
}
