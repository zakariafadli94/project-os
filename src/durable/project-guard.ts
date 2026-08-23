import { DurableObject } from "cloudflare:workers";
import { parseArtifactWriteRequest, type ArtifactWriteReceipt, type ArtifactWriteRequest } from "../domain/artifact-write";
import type { Env } from "../env";
import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { applyTransaction } from "../domain/transitions";
import { DropboxClient } from "../dropbox/client";
import { parseLayoutMode } from "../dropbox/layout";
import { ArtifactContentConflictError, ProjectRepository } from "../dropbox/repository";

interface TransactionRow {
  [key: string]: SqlStorageValue;
  receipt_json: string;
}

interface ArtifactRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
}

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

const PROJECT_STATUS_OPERATIONS = new Set<Transaction["operation"]>([
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive"
]);

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
      CREATE TABLE IF NOT EXISTS artifact_requests (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
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
    }), parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === "POST" && pathname === "/artifact") {
      return this.serialize(() => this.handleArtifact(request));
    }

    if (request.method === "POST" && pathname === "/materialize") {
      return this.serialize(async () => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_materialize_request" }, { status: 400 });
        }
        if (!body || typeof body !== "object" || (body as { target?: unknown }).target !== "workspace-v2") {
          return Response.json({ error: "invalid_materialize_target" }, { status: 400 });
        }

        const state = await this.loadOrRecoverState();
        if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });

        await this.repository.materializeV2(state);
        return Response.json({
          project_id: state.project_id,
          revision: state.revision,
          materialized: true
        });
      });
    }

    if (request.method !== "POST" || pathname !== "/transaction") {
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
      if (existing) {
        if (existing.status === "committed" && PROJECT_STATUS_OPERATIONS.has(tx.operation)) {
          const currentState = await this.loadOrRecoverState();
          if (currentState) {
            if (tx.operation === "project.archive") {
              await this.repository.archiveHumanWorkspace(currentState);
            }
            await this.syncRegistryStatus(currentState);
          }
        }
        return Response.json(existing);
      }

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

      const state = await this.loadOrRecoverState();
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

      await this.repository.writeCommit(result.state, result.event, receipt, {
        publishReceipt: tx.operation !== "project.create"
      });
      this.persistCommit(result.state, receipt);
      if (PROJECT_STATUS_OPERATIONS.has(tx.operation)) {
        await this.syncRegistryStatus(result.state);
      }
      return Response.json(receipt);
    });
  }

  private async handleArtifact(request: Request): Promise<Response> {
    let artifact: ArtifactWriteRequest;
    try {
      artifact = parseArtifactWriteRequest(await request.json());
    } catch (error) {
      return Response.json({
        error: "invalid_artifact_request",
        message: error instanceof Error ? error.message : "Invalid artifact request"
      }, { status: 400 });
    }

    const serialized = JSON.stringify(artifact);
    const existing = this.findArtifact(artifact.request_id);
    if (existing) {
      if (existing.request_json !== serialized) {
        return Response.json(this.artifactReceipt(
          artifact,
          "rejected",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "The same request_id was reused with different artifact content or path"
        ));
      }
      return Response.json(JSON.parse(existing.receipt_json) as ArtifactWriteReceipt);
    }

    if (this.ctx.id.name && this.ctx.id.name !== artifact.project_id) {
      return this.finalizeArtifact(
        artifact,
        this.artifactReceipt(artifact, "rejected", "PROJECT_BINDING_MISMATCH", "Durable Object binding does not match artifact project_id")
      );
    }

    const state = await this.loadOrRecoverState();
    if (!state) {
      return this.finalizeArtifact(
        artifact,
        this.artifactReceipt(artifact, "rejected", "PROJECT_NOT_INITIALIZED", "Project state is not initialized")
      );
    }

    if (await sha256Hex(artifact.content) !== artifact.content_sha256) {
      return this.finalizeArtifact(
        artifact,
        this.artifactReceipt(artifact, "rejected", "CONTENT_HASH_MISMATCH", "content_sha256 does not match artifact content")
      );
    }

    try {
      await this.repository.writeArtifact(state, artifact);
    } catch (error) {
      if (error instanceof ArtifactContentConflictError) {
        return this.finalizeArtifact(
          artifact,
          this.artifactReceipt(artifact, "conflict", "ARTIFACT_CONTENT_CONFLICT", error.message)
        );
      }
      throw error;
    }

    return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "committed"));
  }

  private async finalizeArtifact(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): Promise<Response> {
    await this.repository.writeArtifactReceipt(receipt);
    this.persistArtifact(request, receipt);
    return Response.json(receipt);
  }

  private loadState(): ProjectState | null {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    return row ? normalizeProjectState(JSON.parse(row.state_json)) : null;
  }

  private async loadOrRecoverState(): Promise<ProjectState | null> {
    const local = this.loadState();
    if (local) return local;

    const projectId = this.ctx.id.name;
    if (!projectId) return null;
    const recovered = await this.repository.readProjectState(projectId);
    if (!recovered) return null;

    this.ctx.storage.sql.exec(
      "INSERT INTO project_state (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
      JSON.stringify(recovered)
    );
    return recovered;
  }

  private findReceipt(transactionId: string): Receipt | null {
    const row = this.ctx.storage.sql.exec<TransactionRow>(
      "SELECT receipt_json FROM transactions WHERE transaction_id = ?",
      transactionId
    ).toArray()[0];
    return row ? JSON.parse(row.receipt_json) as Receipt : null;
  }

  private findArtifact(requestId: string): ArtifactRow | null {
    return this.ctx.storage.sql.exec<ArtifactRow>(
      "SELECT request_json, receipt_json FROM artifact_requests WHERE request_id = ?",
      requestId
    ).toArray()[0] ?? null;
  }

  private async syncRegistryStatus(state: ProjectState): Promise<void> {
    const stub = this.env.REGISTRY_GUARD.getByName("global");
    const response = await stub.fetch("https://registry-guard.internal/sync-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: state.project_id,
        status: state.status,
        updated_at: state.updated_at
      })
    });
    if (!response.ok) {
      throw new Error(`RegistryGuard status sync returned ${response.status}`);
    }
  }

  private persistReceipt(receipt: Receipt): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO transactions (transaction_id, status, receipt_json) VALUES (?, ?, ?)",
      receipt.transaction_id,
      receipt.status,
      JSON.stringify(receipt)
    );
  }

  private persistArtifact(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO artifact_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)",
      request.request_id,
      JSON.stringify(request),
      JSON.stringify(receipt)
    );
  }

  private artifactReceipt(
    request: ArtifactWriteRequest,
    status: ArtifactWriteReceipt["status"],
    code?: string,
    message?: string
  ): ArtifactWriteReceipt {
    return {
      request_id: request.request_id,
      project_id: request.project_id,
      relative_path: request.relative_path,
      content_sha256: request.content_sha256,
      status,
      ...(code ? { code } : {}),
      ...(message ? { message } : {})
    };
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
