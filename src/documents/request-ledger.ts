import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { machineDocumentRoot } from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { sha256Text } from "./hash";

export interface ManagedDocumentRequestIntentRecord {
  schema_version: "1.0";
  project_id: string;
  request_id: string;
  request_sha256: string;
  /** New intents retain their exact request so automatic recovery never
   * depends on a chat replay. Hash-only records from prior versions stay
   * readable but are intentionally not recoverable. */
  request_json?: string;
}

export interface ManagedDocumentRequestReceiptRecord extends ManagedDocumentRequestIntentRecord {
  receipt_json: string;
}

export interface RecoverableManagedDocumentRequestIntent extends ManagedDocumentRequestIntentRecord {
  request_json: string;
}

export class ManagedDocumentRequestIntentConflictError extends Error {
  constructor(public readonly requestId: string) {
    super(`Managed document request intent conflict: ${requestId}`);
    this.name = "ManagedDocumentRequestIntentConflictError";
  }
}

export class ManagedDocumentRequestLedger {
  private readonly objects: ObjectPersistence;

  constructor(input: ObjectPersistence | PersistenceInput) {
    this.objects = isObjectPersistence(input)
      ? input
      : asProjectOsPersistence(input).objects;
  }

  async readIntent(projectId: string, requestId: string): Promise<ManagedDocumentRequestIntentRecord | null> {
    assertRequestId(requestId);
    const raw = await this.objects.readText(intentPath(projectId, requestId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedDocumentRequestIntentRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.request_id !== requestId
      || typeof parsed.request_sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.request_sha256)
      || (parsed.request_json !== undefined && typeof parsed.request_json !== "string")
    ) {
      throw new Error(`Invalid durable managed-document request intent: ${projectId}/${requestId}`);
    }
    return parsed as ManagedDocumentRequestIntentRecord;
  }

  /** Returns an exact, digest-verified request only for intents written by
   * the recoverable format. A legacy hash-only intent remains historical
   * evidence, never permission to invent a replay payload. */
  async readRecoverableIntent(projectId: string, requestId: string): Promise<RecoverableManagedDocumentRequestIntent | null> {
    const intent = await this.readIntent(projectId, requestId);
    if (!intent?.request_json) return null;
    if (await sha256Text(intent.request_json) !== intent.request_sha256) {
      throw new Error(`Durable managed-document request intent payload mismatch: ${projectId}/${requestId}`);
    }
    return intent as RecoverableManagedDocumentRequestIntent;
  }

  async ensureIntent(projectId: string, requestId: string, requestJson: string): Promise<ManagedDocumentRequestIntentRecord> {
    assertRequestId(requestId);
    const requestSha256 = await sha256Text(requestJson);
    const record: ManagedDocumentRequestIntentRecord = {
      schema_version: "1.0",
      project_id: projectId,
      request_id: requestId,
      request_sha256: requestSha256,
      request_json: requestJson
    };
    const content = pretty(record);
    try {
      await this.objects.createText(intentPath(projectId, requestId), content);
      return record;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readIntent(projectId, requestId);
      if (!existing) throw error;
      if (existing.request_sha256 !== requestSha256) {
        throw new ManagedDocumentRequestIntentConflictError(requestId);
      }
      return existing;
    }
  }

  async readReceipt(projectId: string, requestId: string): Promise<ManagedDocumentRequestReceiptRecord | null> {
    assertRequestId(requestId);
    const raw = await this.objects.readText(receiptPath(projectId, requestId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedDocumentRequestReceiptRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.request_id !== requestId
      || typeof parsed.request_sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.request_sha256)
      || typeof parsed.receipt_json !== "string"
    ) {
      throw new Error(`Invalid durable managed-document request receipt: ${projectId}/${requestId}`);
    }
    return parsed as ManagedDocumentRequestReceiptRecord;
  }

  async writeReceipt(
    projectId: string,
    requestId: string,
    requestJson: string,
    receiptJson: string
  ): Promise<ManagedDocumentRequestReceiptRecord> {
    const requestSha256 = await sha256Text(requestJson);
    const intent = await this.readIntent(projectId, requestId);
    if (!intent || intent.request_sha256 !== requestSha256) {
      throw new Error(`Managed document receipt has no matching durable intent: ${requestId}`);
    }
    const record: ManagedDocumentRequestReceiptRecord = {
      ...intent,
      receipt_json: receiptJson
    };
    const content = pretty(record);
    try {
      await this.objects.createText(receiptPath(projectId, requestId), content);
      return record;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readReceipt(projectId, requestId);
      if (!existing) throw error;
      if (existing.request_sha256 !== requestSha256 || existing.receipt_json !== receiptJson) {
        throw new Error(`Immutable managed-document request receipt conflict: ${requestId}`);
      }
      return existing;
    }
  }
}

function intentPath(projectId: string, requestId: string): string {
  return `${machineDocumentRoot(projectId)}/requests/${assertRequestId(requestId)}/intent.json`;
}

function receiptPath(projectId: string, requestId: string): string {
  return `${machineDocumentRoot(projectId)}/requests/${assertRequestId(requestId)}/receipt.json`;
}

function assertRequestId(value: string): string {
  if (!/^[A-Z][A-Z0-9-]{7,}$/.test(value) || value.length > 160) {
    throw new Error(`Unsafe managed document request id: ${value}`);
  }
  return value;
}

function isObjectPersistence(input: ObjectPersistence | PersistenceInput): input is ObjectPersistence {
  return typeof input === "object"
    && input !== null
    && "readText" in input
    && "createText" in input
    && "upsertText" in input;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
