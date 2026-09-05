import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import { parseArtifactWriteRequest } from "../domain/artifact-write";
import type { Receipt } from "../domain/receipt";
import { parseTransaction, type Transaction } from "../domain/transaction";
import {
  type LayoutMode,
  machineArtifactReceiptPath,
  machineArtifactRequestPath,
  machineTransactionPath
} from "../persistence/layout";
import { PROJECT_OS_ROOT, transactionPath } from "../persistence/paths";
import type { ObjectPersistence, ProviderEntry } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";

export interface InboxProcessSummary {
  scanned: number;
  processed: number;
  failed: number;
}

export interface ArtifactInboxProcessOptions {
  maxEntries?: number;
  maxScanEntries?: number;
  maxWorkItems?: number;
  respectRetryBackoff?: boolean;
}

export const MAX_RETRYABLE_INBOX_ATTEMPTS = 8;
export const ARTIFACT_RETRY_FAST_ATTEMPT_LIMIT = 5;
export const ARTIFACT_RETRY_FAST_DELAY_MS = 1_000;
export const ARTIFACT_RETRY_DEFER_DELAY_MS = 300_000;

export type ExecuteTransaction = (transaction: Transaction) => Promise<Receipt>;
export type ExecuteArtifact = (artifact: ArtifactWriteRequest) => Promise<ArtifactWriteReceipt>;

interface PreparedTransactionInboxEntry {
  entry: ProviderEntry;
  raw?: string | null;
  transaction?: Transaction;
  loadError?: unknown;
}

interface RetryableFailureDiagnostic {
  schema_version: "1.0";
  status: "retryable_failure";
  attempt_count: number;
  first_failed_at: string;
  last_failed_at: string;
  message: string;
}

interface TransactionFailureDiagnostic extends RetryableFailureDiagnostic {
  transaction_id: string;
  project_id: string;
}

interface ArtifactFailureDiagnostic extends RetryableFailureDiagnostic {
  request_id: string;
  project_id: string;
}

export function inboxPath(mode: LayoutMode): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/transactions/incoming`
    : `${PROJECT_OS_ROOT}/TRANSACTIONS/incoming`;
}

export function artifactInboxPath(mode: LayoutMode): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/artifacts/incoming`
    : `${PROJECT_OS_ROOT}/ARTIFACTS/incoming`;
}

export async function processTransactionInbox(
  objects: ObjectPersistence,
  mode: LayoutMode,
  executeTransaction: ExecuteTransaction
): Promise<InboxProcessSummary> {
  const listedEntries = await objects.listChildren(inboxPath(mode));
  const transactionEntries = listedEntries
    .filter((item) => item.kind === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const preparedEntries = await prepareTransactionInboxEntries(objects, transactionEntries);
  const summary: InboxProcessSummary = {
    scanned: transactionEntries.length,
    processed: 0,
    failed: 0
  };

  for (const prepared of preparedEntries) {
    const entry = prepared.entry;
    try {
      const sourcePath = entry.path;
      if (!sourcePath) {
        summary.failed += 1;
        console.error("Project OS inbox entry missing provider path", { name: entry.name });
        continue;
      }
      if (prepared.loadError) {
        summary.failed += 1;
        console.error("Project OS inbox entry could not be loaded", {
          name: entry.name,
          sourcePath,
          message: prepared.loadError instanceof Error ? prepared.loadError.message : String(prepared.loadError)
        });
        continue;
      }
      const raw = prepared.raw;
      if (raw === null || raw === undefined) {
        summary.failed += 1;
        console.error("Project OS inbox entry disappeared before processing", { name: entry.name, sourcePath });
        continue;
      }

      const filenameTransactionId = transactionIdFromFilename(entry.name);
      let transaction: Transaction;
      try {
        transaction = prepared.transaction ?? parseTransaction(JSON.parse(raw));
        if (!filenameTransactionId || filenameTransactionId !== transaction.transaction_id) {
          throw new Error("Transaction filename must exactly match transaction_id");
        }
      } catch (error) {
        const fallbackId = filenameTransactionId ?? await syntheticInboxId("TXN-INVALID", entry.name, raw);
        const rejectedPath = terminalTransactionPath(mode, "rejected", fallbackId);
        await safeAdd(objects, rejectedPath, `${JSON.stringify({
          status: "rejected",
          code: "INVALID_TRANSACTION_FILE",
          message: error instanceof Error ? error.message : "Invalid transaction file",
          source_name: entry.name
        }, null, 2)}\n`);
        await archiveSource(objects, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
        summary.processed += 1;
        continue;
      }

      let receipt: Receipt;
      try {
        receipt = await executeTransaction(transaction);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS transaction processing failed", transaction.transaction_id, error);
        try {
          const diagnostic = await recordTransactionFailure(objects, mode, transaction, error);
          if (diagnostic.attempt_count >= MAX_RETRYABLE_INBOX_ATTEMPTS) {
            await archiveSource(objects, sourcePath, transactionQuarantinePath(mode, transaction.transaction_id));
          }
        } catch (diagnosticError) {
          console.error("Project OS transaction failure diagnostic could not be persisted", {
            transaction_id: transaction.transaction_id,
            project_id: transaction.project_id,
            message: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
          });
        }
        continue;
      }

      const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
      const canonicalTerminalPath = terminalTransactionPath(mode, statusFolder, transaction.transaction_id);
      const archivePath = receipt.status === "committed"
        ? canonicalTerminalPath
        : canonicalTerminalPath.replace(/\.json$/, ".source.json");
      await archiveSource(objects, sourcePath, archivePath);
      await clearFailureBestEffort(
        objects,
        transactionFailurePath(mode, transaction.transaction_id),
        "transaction",
        transaction.transaction_id
      );
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Project OS transaction inbox entry failed", {
        name: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return summary;
}

async function persistArtifactReceipt(
  objects: ObjectPersistence,
  receipt: ArtifactWriteReceipt
): Promise<void> {
  const path = machineArtifactReceiptPath(receipt.request_id);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await objects.createText(path, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await objects.readText(path);
    if (existing !== content) throw new Error(`Artifact receipt conflict: ${receipt.request_id}`);
  }
}

export async function processArtifactInbox(
  objects: ObjectPersistence,
  mode: LayoutMode,
  executeArtifact: ExecuteArtifact,
  options: ArtifactInboxProcessOptions = {}
): Promise<InboxProcessSummary> {
  const entries = await objects.listChildren(artifactInboxPath(mode));
  const artifactEntries = entries
    .filter((item) => item.kind === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const scanEntries = boundedArtifactEntries(artifactEntries, options.maxScanEntries ?? options.maxEntries);
  const maxWorkItems = options.maxWorkItems ?? options.maxEntries;
  if (maxWorkItems !== undefined && (!Number.isSafeInteger(maxWorkItems) || maxWorkItems < 1)) {
    throw new Error("Artifact inbox maxWorkItems must be a positive safe integer");
  }
  let workItems = 0;
  const summary: InboxProcessSummary = {
    scanned: artifactEntries.length,
    processed: 0,
    failed: 0
  };

  for (const entry of scanEntries) {
    try {
      const sourcePath = entry.path;
      if (!sourcePath) {
        summary.failed += 1;
        console.error("Project OS artifact inbox entry missing provider path", { name: entry.name });
        continue;
      }
      const raw = await objects.readText(sourcePath);
      if (raw === null) {
        summary.failed += 1;
        console.error("Project OS artifact inbox entry disappeared before processing", { name: entry.name, sourcePath });
        continue;
      }

      const filenameRequestId = artifactRequestIdFromFilename(entry.name);
      let artifact: ArtifactWriteRequest;
      try {
        artifact = parseArtifactWriteRequest(JSON.parse(raw));
        if (!filenameRequestId || filenameRequestId !== artifact.request_id) {
          throw new Error("Artifact filename must exactly match request_id");
        }
      } catch (error) {
        const fallbackId = filenameRequestId ?? await syntheticInboxId("ART-INVALID", entry.name, raw);
        const rejectedPath = terminalArtifactRequestPath(mode, "rejected", fallbackId);
        await safeAdd(objects, rejectedPath, `${JSON.stringify({
          status: "rejected",
          code: "INVALID_ARTIFACT_FILE",
          message: error instanceof Error ? error.message : "Invalid artifact file",
          source_name: entry.name
        }, null, 2)}\n`);
        await archiveSource(objects, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
        summary.processed += 1;
        continue;
      }

      const failurePath = artifactFailurePath(mode, artifact.request_id);
      const previousFailure = await readArtifactFailure(objects, failurePath, artifact);
      if (previousFailure?.attempt_count && previousFailure.attempt_count >= MAX_RETRYABLE_INBOX_ATTEMPTS) {
      continue;
    }
    if (previousFailure && options.respectRetryBackoff && !artifactRetryDue(previousFailure)) {
        continue;
      }

    if (maxWorkItems !== undefined && workItems >= maxWorkItems) break;
    workItems += 1;
      let receipt: ArtifactWriteReceipt;
      try {
        receipt = await executeArtifact(artifact);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS artifact processing failed", artifact.request_id, error);
        try {
          const diagnostic = await recordArtifactFailure(objects, mode, artifact, error, previousFailure);
          if (diagnostic.attempt_count >= MAX_RETRYABLE_INBOX_ATTEMPTS) {
            await archiveSource(objects, sourcePath, artifactQuarantinePath(mode, artifact.request_id));
          }
        } catch (diagnosticError) {
          console.error("Project OS artifact failure diagnostic could not be persisted", {
            request_id: artifact.request_id,
            project_id: artifact.project_id,
            message: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
          });
        }
        continue;
      }

      if (receipt.code !== "ARTIFACT_INTENT_CONFLICT" && receipt.code !== "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        await persistArtifactReceipt(objects, receipt);
      }
      const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
      const terminalPath = terminalArtifactRequestPath(mode, statusFolder, artifact.request_id);
      await archiveSource(objects, sourcePath, terminalPath);
      await clearFailureBestEffort(
        objects,
        failurePath,
        "artifact",
        artifact.request_id
      );
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Project OS artifact inbox entry failed", {
        name: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return summary;
}

async function prepareTransactionInboxEntries(
  objects: ObjectPersistence,
  entries: ProviderEntry[]
): Promise<PreparedTransactionInboxEntry[]> {
  const prepared: PreparedTransactionInboxEntry[] = [];

  for (const entry of entries) {
    const sourcePath = entry.path;
    if (!sourcePath) {
      prepared.push({ entry });
      continue;
    }

    let raw: string | null;
    try {
      raw = await objects.readText(sourcePath);
    } catch (error) {
      prepared.push({ entry, loadError: error });
      continue;
    }

    let transaction: Transaction | undefined;
    if (raw !== null) {
      try {
        const parsed = parseTransaction(JSON.parse(raw));
        if (transactionIdFromFilename(entry.name) === parsed.transaction_id) transaction = parsed;
      } catch {
        // Invalid entries remain eligible for rejection/cleanup after valid work is ordered.
      }
    }
    prepared.push({ entry, raw, transaction });
  }

  return prepared.sort(comparePreparedTransactionEntries);
}

function comparePreparedTransactionEntries(a: PreparedTransactionInboxEntry, b: PreparedTransactionInboxEntry): number {
  if (a.transaction && b.transaction) {
    if (a.transaction.project_id === b.transaction.project_id) {
      const revisionOrder = a.transaction.base_revision - b.transaction.base_revision;
      if (revisionOrder !== 0) return revisionOrder;
    }
    const createdOrder = a.transaction.created_at.localeCompare(b.transaction.created_at);
    if (createdOrder !== 0) return createdOrder;
    return a.entry.name.localeCompare(b.entry.name);
  }
  if (a.transaction) return -1;
  if (b.transaction) return 1;
  return a.entry.name.localeCompare(b.entry.name);
}

function terminalTransactionPath(
  mode: LayoutMode,
  status: "committed" | "rejected" | "conflicts",
  transactionId: string
): string {
  return mode === "v2"
    ? machineTransactionPath(status, transactionId)
    : transactionPath(status, transactionId);
}

function transactionFailurePath(mode: LayoutMode, transactionId: string): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/transactions/failures/${transactionId}.json`
    : `${PROJECT_OS_ROOT}/TRANSACTIONS/failures/${transactionId}.json`;
}

function transactionQuarantinePath(mode: LayoutMode, transactionId: string): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/transactions/quarantine/${transactionId}.json`
    : `${PROJECT_OS_ROOT}/TRANSACTIONS/quarantine/${transactionId}.json`;
}

function terminalArtifactRequestPath(
  mode: LayoutMode,
  status: "committed" | "rejected" | "conflicts",
  requestId: string
): string {
  return mode === "v2"
    ? machineArtifactRequestPath(status, requestId)
    : `${PROJECT_OS_ROOT}/ARTIFACTS/${status}/${requestId}.json`;
}

function artifactFailurePath(mode: LayoutMode, requestId: string): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/artifacts/failures/${requestId}.json`
    : `${PROJECT_OS_ROOT}/ARTIFACTS/failures/${requestId}.json`;
}

function artifactQuarantinePath(mode: LayoutMode, requestId: string): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/artifacts/quarantine/${requestId}.json`
    : `${PROJECT_OS_ROOT}/ARTIFACTS/quarantine/${requestId}.json`;
}

function transactionIdFromFilename(filename: string): string | null {
  const match = /^(TXN-[A-Z0-9-]{10,})\.json$/.exec(filename);
  return match?.[1] ?? null;
}

function artifactRequestIdFromFilename(filename: string): string | null {
  const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(filename);
  return match?.[1] ?? null;
}

async function syntheticInboxId(prefix: "TXN-INVALID" | "ART-INVALID", filename: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${filename}\0${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${prefix}-${hex.slice(0, 24)}`;
}

async function recordTransactionFailure(
  objects: ObjectPersistence,
  mode: LayoutMode,
  transaction: Transaction,
  error: unknown
): Promise<TransactionFailureDiagnostic> {
  const path = transactionFailurePath(mode, transaction.transaction_id);
  const previous = await readTransactionFailure(objects, path, transaction);
  const common = retryableFailure(previous, error);
  const diagnostic: TransactionFailureDiagnostic = {
    ...common,
    transaction_id: transaction.transaction_id,
    project_id: transaction.project_id
  };
  await objects.upsertText(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return diagnostic;
}

async function readTransactionFailure(
  objects: ObjectPersistence,
  path: string,
  transaction: Transaction
): Promise<TransactionFailureDiagnostic | null> {
  const raw = await objects.readText(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TransactionFailureDiagnostic>;
    if (
      !validRetryableFailure(parsed)
      || parsed.transaction_id !== transaction.transaction_id
      || parsed.project_id !== transaction.project_id
    ) return null;
    return parsed as TransactionFailureDiagnostic;
  } catch {
    return null;
  }
}

async function recordArtifactFailure(
  objects: ObjectPersistence,
  mode: LayoutMode,
  artifact: ArtifactWriteRequest,
  error: unknown,
  previous: ArtifactFailureDiagnostic | null = null
): Promise<ArtifactFailureDiagnostic> {
  const path = artifactFailurePath(mode, artifact.request_id);
  const prior = previous ?? await readArtifactFailure(objects, path, artifact);
  const common = retryableFailure(prior, error);
  const diagnostic: ArtifactFailureDiagnostic = {
    ...common,
    request_id: artifact.request_id,
    project_id: artifact.project_id
  };
  await objects.upsertText(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return diagnostic;
}

async function readArtifactFailure(
  objects: ObjectPersistence,
  path: string,
  artifact: ArtifactWriteRequest
): Promise<ArtifactFailureDiagnostic | null> {
  const raw = await objects.readText(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArtifactFailureDiagnostic>;
    if (
      !validRetryableFailure(parsed)
      || parsed.request_id !== artifact.request_id
      || parsed.project_id !== artifact.project_id
    ) return null;
    return parsed as ArtifactFailureDiagnostic;
  } catch {
    return null;
  }
}

function retryableFailure(
  previous: RetryableFailureDiagnostic | null,
  error: unknown
): RetryableFailureDiagnostic {
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    status: "retryable_failure",
    attempt_count: (previous?.attempt_count ?? 0) + 1,
    first_failed_at: previous?.first_failed_at ?? now,
    last_failed_at: now,
    message: error instanceof Error ? error.message : String(error)
  };
}

function validRetryableFailure(parsed: Partial<RetryableFailureDiagnostic>): boolean {
  return parsed.schema_version === "1.0"
    && parsed.status === "retryable_failure"
    && Number.isSafeInteger(parsed.attempt_count)
    && (parsed.attempt_count ?? 0) >= 1
    && typeof parsed.first_failed_at === "string"
    && typeof parsed.last_failed_at === "string"
    && typeof parsed.message === "string";
}

function artifactRetryDue(failure: ArtifactFailureDiagnostic, now = Date.now()): boolean {
  const lastFailedAt = Date.parse(failure.last_failed_at);
  if (!Number.isFinite(lastFailedAt)) return true;
  const delay = failure.attempt_count <= ARTIFACT_RETRY_FAST_ATTEMPT_LIMIT
    ? ARTIFACT_RETRY_FAST_DELAY_MS
    : ARTIFACT_RETRY_DEFER_DELAY_MS;
  return now >= lastFailedAt + delay;
}

function boundedArtifactEntries(entries: ProviderEntry[], maxEntries: number | undefined): ProviderEntry[] {
  if (maxEntries === undefined) return entries;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Artifact inbox maxEntries must be a positive safe integer");
  }
  return entries.slice(0, maxEntries);
}

async function clearFailureBestEffort(
  objects: ObjectPersistence,
  path: string,
  kind: "transaction" | "artifact",
  id: string
): Promise<void> {
  try {
    if (await objects.readText(path) !== null) await objects.delete(path);
  } catch (error) {
    console.error(`Project OS ${kind} failure diagnostic cleanup failed`, {
      id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function safeAdd(objects: ObjectPersistence, path: string, content: string): Promise<void> {
  try {
    await objects.createText(path, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await objects.readText(path);
    if (existing !== content) throw new Error(`Conflicting terminal inbox artifact at ${path}`);
  }
}

async function archiveSource(objects: ObjectPersistence, source: string, destination: string): Promise<void> {
  try {
    await objects.move(source, destination);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const sourceStillExists = await objects.readText(source);
    if (sourceStillExists === null) return;
    const destinationExists = await objects.readText(destination);
    if (destinationExists === sourceStillExists) {
      await objects.delete(source);
      return;
    }
    throw error;
  }
}
