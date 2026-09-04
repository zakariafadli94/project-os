import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { Receipt } from "../domain/receipt";
import { parseTransaction, type Transaction } from "../domain/transaction";
import {
  isWorkingHeadOperation,
  parseWorkingHeadRequest,
  type WorkingHeadRequest
} from "../domain/working-head-request";
import { ManagedDocumentActivePathIndex } from "../documents/active-path-index";
import { DocumentLedgerRepository } from "../documents/repository";
import { ManagedDocumentRequestIntentConflictError, ManagedDocumentRequestLedger } from "../documents/request-ledger";
import { ManagedDocumentConflictError, type ManagedDocumentReceipt } from "../documents/service";
import { ManagedWorkingHeadService } from "../documents/working-head-service";
import type { Env } from "../env";
import { ProjectRepository } from "../persistence/repository";
import { MutationGateProjectGuard } from "./project-guard-mutation-gate";

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

interface WorkingHeadTerminalReceipt {
  request_id: string;
  project_id: string;
  status: "rejected" | "conflict";
  code: string;
  message: string;
  document_id?: string;
}

type WorkingHeadOperationReceipt = ManagedDocumentReceipt | WorkingHeadTerminalReceipt;

const FAST_FORWARD_PATHS = new Set([
  "/artifact",
  "/document",
  "/referral",
  "/recover-inputs",
  "/reconcile-documents"
]);

/**
 * Bounds canonical catch-up work before mutation execution.
 *
 * ProjectGuard's SQLite state is a cache. The immutable commit records and the
 * machine ProjectState snapshot are canonical. After a deployment or eviction,
 * a stale local cache must not replay hundreds of immutable commits just to
 * reach a snapshot that already represents the same canonical history.
 *
 * We fast-forward only when the machine snapshot is newer and its exact
 * revision is backed by the immutable commit record for that revision. If that
 * proof is unavailable, the base guard's conservative sequential recovery path
 * remains authoritative.
 *
 * The recovery queue serializes canonical recovery and mutation work only.
 * Projection alarms and projection provider I/O belong to MaterializationGuard.
 *
 * This layer also owns path-changing WORKING-head transitions. They are kept
 * outside the legacy managed-document parser so old clients remain compatible,
 * while new clients must explicitly choose supersede or fork semantics.
 */
export class SubrequestResilientProjectGuard extends MutationGateProjectGuard {
  private readonly recoveryRepository: ProjectRepository;
  private readonly workingHeads: ManagedWorkingHeadService;
  private readonly workingHeadRequests: ManagedDocumentRequestLedger;
  private readonly documentLedger: DocumentLedgerRepository;
  private readonly activePaths: ManagedDocumentActivePathIndex;
  private recoveryQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.recoveryRepository = new ProjectRepository(this.persistence, this.layoutMode);
    this.workingHeads = new ManagedWorkingHeadService(this.persistence);
    this.workingHeadRequests = new ManagedDocumentRequestLedger(this.persistence.objects);
    this.documentLedger = new DocumentLedgerRepository(this.persistence);
    this.activePaths = new ManagedDocumentActivePathIndex(this.persistence);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/transaction") {
      const transaction = await inspectTransaction(request.clone());
      return this.serializeRecovery(async () => {
        if (transaction && this.shouldFastForwardTransaction(transaction)) {
          await this.fastForwardFromVerifiedMachineSnapshot();
        }
        return super.fetch(request);
      });
    }

    if (request.method === "POST" && url.pathname === "/document") {
      const inspected = await inspectWorkingHeadRequest(request.clone());
      if (inspected.kind === "invalid") {
        return Response.json({
          error: "invalid_document_request",
          message: inspected.message
        }, { status: 400 });
      }
      if (inspected.kind === "working_head") {
        return this.serializeRecovery(async () => {
          await this.fastForwardFromVerifiedMachineSnapshot();
          return this.handleWorkingHead(inspected.request);
        });
      }
    }

    if (request.method === "POST" && FAST_FORWARD_PATHS.has(url.pathname)) {
      return this.serializeRecovery(async () => {
        await this.fastForwardFromVerifiedMachineSnapshot();
        return super.fetch(request);
      });
    }
    return super.fetch(request);
  }

  private shouldFastForwardTransaction(transaction: Transaction): boolean {
    if (this.layoutMode !== "v2") return false;
    const projectId = this.ctx.id.name;
    if (!projectId || projectId === "PRJ-AUTO" || transaction.project_id !== projectId) return false;

    const localRevision = this.localRevision();
    if (localRevision < 0) {
      // Cold caches with a non-zero client base can jump directly to a verified
      // snapshot. project.create/base=0 stays on the base guard's normal cold
      // initialization path and avoids a redundant snapshot read.
      return transaction.base_revision > 0;
    }
    return transaction.base_revision > localRevision;
  }

  private async handleWorkingHead(operation: WorkingHeadRequest): Promise<Response> {
    if (this.ctx.id.name && this.ctx.id.name !== operation.project_id) {
      return Response.json(workingHeadTerminalReceipt(
        operation,
        "rejected",
        "PROJECT_BINDING_MISMATCH",
        "Durable Object binding does not match managed document project_id"
      ));
    }

    let state = this.localState();
    if (!state) state = await this.loadOrRecoverState();
    if (!state) {
      return Response.json(workingHeadTerminalReceipt(
        operation,
        "rejected",
        "PROJECT_NOT_INITIALIZED",
        "Project state is not initialized"
      ));
    }

    const serialized = JSON.stringify(operation);
    try {
      await this.workingHeadRequests.ensureIntent(operation.project_id, operation.request_id, serialized);
    } catch (error) {
      if (error instanceof ManagedDocumentRequestIntentConflictError) {
        return Response.json(workingHeadTerminalReceipt(
          operation,
          "rejected",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "The same request_id was reused with a different managed-document payload"
        ));
      }
      throw error;
    }

    const durableReceipt = await this.workingHeadRequests.readReceipt(operation.project_id, operation.request_id);
    if (durableReceipt) {
      const replay = JSON.parse(durableReceipt.receipt_json) as WorkingHeadOperationReceipt;
      await this.syncWorkingHeadIndexes(operation, replay);
      return Response.json(replay);
    }

    let receipt: WorkingHeadOperationReceipt;
    try {
      receipt = operation.operation === "working.supersede"
        ? await this.workingHeads.supersedeWorking(operation, state)
        : await this.workingHeads.forkWorking(operation, state);
    } catch (error) {
      if (error instanceof ManagedDocumentConflictError) {
        receipt = workingHeadTerminalReceipt(
          operation,
          "conflict",
          error.code,
          error.message,
          error.documentId
        );
      } else if (error instanceof Error && error.message.startsWith("Managed document content SHA-256 mismatch:")) {
        receipt = workingHeadTerminalReceipt(
          operation,
          "rejected",
          "CONTENT_HASH_MISMATCH",
          error.message
        );
      } else {
        throw error;
      }
    }

    await this.syncWorkingHeadIndexes(operation, receipt);
    await this.workingHeadRequests.writeReceipt(
      operation.project_id,
      operation.request_id,
      serialized,
      JSON.stringify(receipt)
    );
    return Response.json(receipt);
  }

  private async syncWorkingHeadIndexes(
    operation: WorkingHeadRequest,
    receipt: WorkingHeadOperationReceipt
  ): Promise<void> {
    if (receipt.status !== "committed") return;
    const version = await this.documentLedger.readVersion(receipt.project_id, receipt.document_id, receipt.version_id);
    if (!version || version.stage !== "working") {
      throw new Error(`Committed working-head receipt references missing working version: ${receipt.request_id}`);
    }

    await this.activePaths.bind(receipt.project_id, version.logical_path, receipt.document_id);
    const head = await this.documentLedger.readHead(receipt.project_id, receipt.document_id);
    const providerFileId = head?.provider?.working?.file_id;
    if (providerFileId) {
      await this.documentLedger.writeProviderFileBinding({
        schema_version: "1.0",
        project_id: receipt.project_id,
        provider_file_id: providerFileId,
        document_id: receipt.document_id
      });
    }

    if (operation.operation !== "working.supersede" || !version.parent_version_id) return;
    const parent = await this.documentLedger.readVersion(receipt.project_id, receipt.document_id, version.parent_version_id);
    if (parent && parent.logical_path !== version.logical_path) {
      await this.activePaths.unbind(receipt.project_id, parent.logical_path, receipt.document_id);
    }
  }

  protected async fastForwardFromLatestCanonicalCommit(): Promise<void> {
    if (this.layoutMode !== "v2") return;
    const projectId = this.ctx.id.name;
    if (!projectId || projectId === "PRJ-AUTO") return;

    await this.fastForwardFromVerifiedMachineSnapshot();
    const baseRevision = this.localRevision();
    if (baseRevision < 0) return;
    const head = await this.recoveryRepository.readMaterializationHead(projectId);
    if (!head || head.target_revision <= baseRevision) return;

    const materialization = await this.recoveryRepository.readMaterializationRecord(
      projectId,
      head.target_revision,
      head.projection_version
    );
    if (
      !materialization
      || materialization.result_root_hash !== head.result_root_hash
      || materialization.workspace_location !== head.workspace_location
      || materialization.completed_at !== head.completed_at
    ) {
      throw new Error(`Verified materialization head binding mismatch for ${projectId} revision ${head.target_revision}`);
    }

    const record = await this.recoveryRepository.readCommitRecord(projectId, head.target_revision);
    if (!record || record.event.event_id !== materialization.source_event_id) {
      throw new Error(`Materialization canonical commit binding mismatch for ${projectId} revision ${head.target_revision}`);
    }
    this.persistVerifiedSnapshot(record.state, record.receipt);
  }

  protected async fastForwardFromVerifiedMachineSnapshot(): Promise<void> {
    if (this.layoutMode !== "v2") return;
    const projectId = this.ctx.id.name;
    if (!projectId || projectId === "PRJ-AUTO") return;

    const localRevision = this.localRevision();
    const snapshot = await this.recoveryRepository.readProjectState(projectId);
    if (!snapshot || snapshot.revision <= localRevision) return;

    if (snapshot.revision === 0) {
      this.persistVerifiedSnapshot(snapshot, null);
      return;
    }

    const record = await this.recoveryRepository.readCommitRecord(projectId, snapshot.revision);
    if (!record) return;
    if (
      record.project_id !== projectId
      || record.new_revision !== snapshot.revision
      || record.state.project_id !== projectId
      || record.state.revision !== snapshot.revision
      || record.state.last_event_id !== snapshot.last_event_id
      || record.event.event_id !== snapshot.last_event_id
      || record.receipt.status !== "committed"
      || record.receipt.project_id !== projectId
      || record.receipt.new_revision !== snapshot.revision
    ) {
      throw new Error(`Verified machine snapshot binding mismatch for ${projectId} revision ${snapshot.revision}`);
    }

    // Persist the immutable commit's state, not the mutable snapshot bytes. The
    // snapshot is used only to discover a newer proven revision.
    this.persistVerifiedSnapshot(record.state, record.receipt);
  }

  private localRevision(): number {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    if (!row) return -1;
    try {
      const parsed = JSON.parse(row.state_json) as { revision?: unknown };
      return Number.isSafeInteger(parsed.revision) ? parsed.revision as number : -1;
    } catch {
      return -1;
    }
  }

  private localState(): ProjectState | null {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    if (!row) return null;
    try {
      return normalizeProjectState(JSON.parse(row.state_json));
    } catch {
      return null;
    }
  }

  private persistVerifiedSnapshot(state: ProjectState, receipt: Receipt | null): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
        JSON.stringify(state)
      );
      if (receipt) {
        this.ctx.storage.sql.exec(
          `INSERT INTO transactions (transaction_id, status, receipt_json) VALUES (?, ?, ?)
           ON CONFLICT(transaction_id) DO UPDATE SET status = excluded.status, receipt_json = excluded.receipt_json`,
          receipt.transaction_id,
          receipt.status,
          JSON.stringify(receipt)
        );
      }
    });
  }

  private async serializeRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.recoveryQueue;
    let release!: () => void;
    this.recoveryQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

interface JsonReadableRequest {
  json(): Promise<unknown>;
}

async function inspectTransaction(request: JsonReadableRequest): Promise<Transaction | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  try {
    return parseTransaction(raw);
  } catch {
    return null;
  }
}

async function inspectWorkingHeadRequest(request: JsonReadableRequest): Promise<
  | { kind: "other" }
  | { kind: "invalid"; message: string }
  | { kind: "working_head"; request: WorkingHeadRequest }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { kind: "other" };
  }
  if (!isWorkingHeadOperation(raw)) return { kind: "other" };
  try {
    return { kind: "working_head", request: parseWorkingHeadRequest(raw) };
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : "Invalid working-head request"
    };
  }
}

function workingHeadTerminalReceipt(
  operation: WorkingHeadRequest,
  status: "rejected" | "conflict",
  code: string,
  message: string,
  documentId?: string
): WorkingHeadTerminalReceipt {
  return {
    request_id: operation.request_id,
    project_id: operation.project_id,
    status,
    code,
    message,
    ...(documentId ? { document_id: documentId } : {})
  };
}
