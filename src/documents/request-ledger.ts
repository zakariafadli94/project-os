import { DropboxConflictError, type DropboxTransport } from "../dropbox/client";
import { machineDocumentRoot } from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";

export interface ManagedDocumentRequestIntentRecord {
  schema_version: "1.0";
  project_id: string;
  request_id: string;
  request_json: string;
}

export interface ManagedDocumentRequestReceiptRecord extends ManagedDocumentRequestIntentRecord {
  receipt_json: string;
}

export class ManagedDocumentRequestLedger {
  private readonly transport: ResilientDropboxTransport;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
  }

  async readIntent(projectId: string, requestId: string): Promise<ManagedDocumentRequestIntentRecord | null> {
    assertRequestId(requestId);
    const raw = await this.transport.download(intentPath(projectId, requestId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedDocumentRequestIntentRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.request_id !== requestId
      || typeof parsed.request_json !== "string"
    ) {
      throw new Error(`Invalid durable managed-document request intent: ${projectId}/${requestId}`);
    }
    return parsed as ManagedDocumentRequestIntentRecord;
  }

  async ensureIntent(projectId: string, requestId: string, requestJson: string): Promise<ManagedDocumentRequestIntentRecord> {
    assertRequestId(requestId);
    const record: ManagedDocumentRequestIntentRecord = {
      schema_version: "1.0",
      project_id: projectId,
      request_id: requestId,
      request_json: requestJson
    };
    const content = pretty(record);
    try {
      await this.transport.upload(intentPath(projectId, requestId), content, "add");
      return record;
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.readIntent(projectId, requestId);
      if (!existing) throw error;
      if (existing.request_json !== requestJson) {
        throw new Error(`Managed document request intent conflict: ${requestId}`);
      }
      return existing;
    }
  }

  async readReceipt(projectId: string, requestId: string): Promise<ManagedDocumentRequestReceiptRecord | null> {
    assertRequestId(requestId);
    const raw = await this.transport.download(receiptPath(projectId, requestId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedDocumentRequestReceiptRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.request_id !== requestId
      || typeof parsed.request_json !== "string"
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
    const intent = await this.readIntent(projectId, requestId);
    if (!intent || intent.request_json !== requestJson) {
      throw new Error(`Managed document receipt has no matching durable intent: ${requestId}`);
    }
    const record: ManagedDocumentRequestReceiptRecord = {
      ...intent,
      receipt_json: receiptJson
    };
    const content = pretty(record);
    try {
      await this.transport.upload(receiptPath(projectId, requestId), content, "add");
      return record;
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.readReceipt(projectId, requestId);
      if (!existing) throw error;
      if (existing.request_json !== requestJson || existing.receipt_json !== receiptJson) {
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

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
