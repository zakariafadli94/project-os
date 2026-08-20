import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { ProjectState } from "../domain/project-state";
import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { applyTransaction } from "../domain/transitions";
import { DropboxClient } from "../dropbox/client";
import { ProjectRepository } from "../dropbox/repository";

interface TransactionRow {
  receipt_json: string;
}

interface StateRow {
  state_json: string;
}

export class ProjectGuard extends DurableObject<Env> {
  private readonly repository: ProjectRepository;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL
      );
    `);
    this.repository = new ProjectRepository(new DropboxClient({
      appKey: env.DROPBOX_APP_KEY,
      appSecret: env.DROPBOX_APP_SECRET,
      refreshToken: env.DROPBOX_REFRESH_TOKEN
    }));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/transaction") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return this.serialize(async () => {
      let tx: Transaction;
      try {
        tx = parseTransaction(await request.json());
      } catch (error) {
        return Response.json({
          error: "invalid_transaction",
          message: error instanceof Error ? error.message : "Invalid transaction"
        }, { status: 400 });
      }

      const existing = this.findReceipt(tx.transaction_id);
      if (existing) return Response.json(existing);

      if (tx.project_id === AUTO_PROJECT_ID) {
        const receipt = this.terminalReceipt(tx, "rejected", "UNALLOCATED_PROJECT_ID", "project.create must be allocated by RegistryGuard");
        await this.repository.writeTerminalTransaction(tx, receipt);
        this.persistReceipt(receipt);
        return Response.json(receipt);
      }

      if (this.ctx.id.name && this.ctx.id.name !== tx.project_id) {
        const receipt = this.terminalReceipt(tx, "rejected", "PROJECT_BINDING_MISMATCH", "Durable Object binding does not match transaction project_id");
        await this.repository.writeTerminalTransaction(tx, receipt);
        this.persistReceipt(receipt);
        return Response.json(receipt);
      }

      const state = this.loadState();
      const result = applyTransaction(state, tx);

      if (result.kind === "rejected" || result.kind === "conflict") {
        const receipt = this.terminalReceipt(tx, result.kind, result.code, result.message, state?.revision ?? 0);
        await this.repository.writeTerminalTransaction(tx, receipt);
        this.persistReceipt(receipt);
        return Response.json(receipt);
      }

      const previousRevision = state?.revision ?? 0;
      const receipt: Receipt = {
        schema_version: "1.0",
        transaction_id: tx.transaction_id,
        status: "committed",
        project_id: tx.project_id,
        previous_revision: previousRevision,
        new_revision: result.state.revision,
        event_id: result.event.event_id,
        committed_at: tx.created_at
      };

      await this.repository.writeCommit(result.state, result.event, receipt);
      this.persistCommit(result.state, receipt);
      return Response.json(receipt);
    });
  }

  private loadState(): ProjectState | null {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    return row ? JSON.parse(row.state_json) as ProjectState : null;
  }

  private findReceipt(transactionId: string): Receipt | null {
    const row = this.ctx.storage.sql.exec<TransactionRow>(
      "SELECT receipt_json FROM transactions WHERE transaction_id = ?",
      transactionId
    ).toArray()[0];
    return row ? JSON.parse(row.receipt_json) as Receipt : null;
  }

  private persistReceipt(receipt: Receipt): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO transactions (transaction_id, status, receipt_json) VALUES (?, ?, ?)",
      receipt.transaction_id,
      receipt.status,
      JSON.stringify(receipt)
    );
  }

  private persistCommit(state: ProjectState, receipt: Receipt): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
        JSON.stringify(state)
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO transactions (transaction_id, status, receipt_json) VALUES (?, ?, ?)",
        receipt.transaction_id,
        receipt.status,
        JSON.stringify(receipt)
      );
    });
  }

  private terminalReceipt(
    tx: Transaction,
    status: "rejected" | "conflict",
    code: string,
    message: string,
    revision = 0
  ): Receipt {
    return {
      schema_version: "1.0",
      transaction_id: tx.transaction_id,
      status,
      project_id: tx.project_id,
      previous_revision: revision,
      new_revision: revision,
      code,
      message
    };
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
