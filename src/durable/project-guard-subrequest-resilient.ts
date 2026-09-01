import type { ProjectState } from "../domain/project-state";
import type { Receipt } from "../domain/receipt";
import type { Env } from "../env";
import { ProjectRepository } from "../persistence/repository";
import { MutationGateProjectGuard } from "./project-guard-mutation-gate";

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

const FAST_FORWARD_PATHS = new Set([
  "/transaction",
  "/artifact",
  "/document",
  "/referral",
  "/recover-inputs",
  "/reconcile-documents",
  "/reconcile-materialization",
  "/materialize"
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
 */
export class SubrequestResilientProjectGuard extends MutationGateProjectGuard {
  private readonly recoveryRepository: ProjectRepository;
  private recoveryQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.recoveryRepository = new ProjectRepository(this.persistence, this.layoutMode);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && FAST_FORWARD_PATHS.has(url.pathname)) {
      return this.serializeRecovery(async () => {
        await this.fastForwardFromVerifiedMachineSnapshot();
        return super.fetch(request);
      });
    }
    return super.fetch(request);
  }

  private async fastForwardFromVerifiedMachineSnapshot(): Promise<void> {
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
