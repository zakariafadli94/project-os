import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { DropboxClient } from "../dropbox/client";
import { parseLayoutMode } from "../dropbox/layout";
import { ProjectRepository } from "../dropbox/repository";
import { renderRegistry, type RegistryEntry } from "../render/registry";

interface RequestRow {
  [key: string]: SqlStorageValue;
  transaction_json: string;
  project_id: string | null;
  status: string;
  receipt_json: string | null;
}

interface ProjectRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  name: string;
  slug: string;
  aliases_json: string;
  status: RegistryEntry["status"];
  created_at: string;
  updated_at: string;
}

interface MetaRow {
  [key: string]: SqlStorageValue;
  value: string;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

export class RegistryGuard extends DurableObject<Env> {
  private readonly repository: ProjectRepository;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        transaction_id TEXT PRIMARY KEY,
        transaction_json TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        receipt_json TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        aliases_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('next_project_number', '1');
    `);
    this.repository = new ProjectRepository(new DropboxClient({
      appKey: env.DROPBOX_APP_KEY,
      appSecret: env.DROPBOX_APP_SECRET,
      refreshToken: env.DROPBOX_REFRESH_TOKEN
    }), parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/create") {
      return this.serialize(() => this.handleCreate(request));
    }
    if (request.method === "GET" && path === "/registry") {
      return this.serialize(async () => {
        await this.ensureRegistryRecovered();
        return Response.json({ schema_version: "1.0", projects: this.registryEntries() });
      });
    }
    if (request.method === "POST" && path === "/sync-status") {
      return this.serialize(() => this.handleStatusSync(request));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleCreate(request: Request): Promise<Response> {
    let tx: Transaction;
    try {
      tx = parseTransaction(await request.json());
    } catch (error) {
      return Response.json({ error: "invalid_transaction", message: error instanceof Error ? error.message : "Invalid transaction" }, { status: 400 });
    }

    if (tx.operation !== "project.create") {
      return Response.json({ error: "invalid_operation" }, { status: 400 });
    }

    await this.ensureRegistryRecovered();

    const existing = this.requestRow(tx.transaction_id);
    if (existing) {
      if (existing.transaction_json !== JSON.stringify(tx)) {
        const receipt = this.rejectedReceipt(tx, "IDEMPOTENCY_PAYLOAD_MISMATCH", "The same transaction_id was reused with different content", existing.project_id ?? AUTO_PROJECT_ID);
        return Response.json(receipt);
      }
      if (existing.receipt_json) return Response.json(JSON.parse(existing.receipt_json) as Receipt);
      if (!existing.project_id) throw new Error("Registry request has no allocated project ID");
      return this.finishAllocatedCreate(tx, existing.project_id);
    }

    if (tx.project_id !== AUTO_PROJECT_ID) {
      const receipt = this.rejectedReceipt(tx, "PROJECT_ID_MUST_BE_AUTO", "External project.create must use PRJ-AUTO", tx.project_id);
      this.persistTerminalRequest(tx, receipt, null);
      await this.repository.writeTerminalTransaction(tx, receipt);
      return Response.json(receipt);
    }

    if (this.hasDuplicateProjectIdentity(tx)) {
      const receipt = this.rejectedReceipt(tx, "DUPLICATE_PROJECT", "Project name, slug, or alias conflicts with an existing or in-flight project", AUTO_PROJECT_ID);
      this.persistTerminalRequest(tx, receipt, null);
      await this.repository.writeTerminalTransaction(tx, receipt);
      return Response.json(receipt);
    }

    const projectId = this.allocateProjectId(tx);
    return this.finishAllocatedCreate(tx, projectId);
  }

  private async finishAllocatedCreate(original: Extract<Transaction, { operation: "project.create" }>, projectId: string): Promise<Response> {
    const normalized: Extract<Transaction, { operation: "project.create" }> = {
      ...original,
      project_id: projectId,
      base_revision: 0
    };

    const stub = this.env.PROJECT_GUARD.getByName(projectId);
    const guardResponse = await stub.fetch("https://project-guard.internal/transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(normalized)
    });
    if (!guardResponse.ok) {
      return Response.json({ error: "project_guard_failed", status: guardResponse.status }, { status: 502 });
    }
    const receipt = await guardResponse.json<Receipt>();

    if (receipt.status !== "committed") {
      this.persistTerminalRequest(original, receipt, projectId);
      return Response.json(receipt);
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO projects (project_id, name, slug, aliases_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           name = excluded.name,
           slug = excluded.slug,
           aliases_json = excluded.aliases_json,
           updated_at = excluded.updated_at`,
        projectId,
        original.payload.name,
        original.payload.slug,
        JSON.stringify(original.payload.aliases),
        original.created_at,
        original.created_at
      );
      this.ctx.storage.sql.exec(
        "UPDATE requests SET status = 'guard_committed' WHERE transaction_id = ?",
        original.transaction_id
      );
    });

    const entries = this.registryEntries();
    await this.repository.writeRegistry({ schema_version: "1.0", projects: entries }, renderRegistry(entries));
    await this.repository.writeReceipt(receipt);

    this.ctx.storage.sql.exec(
      "UPDATE requests SET status = 'committed', receipt_json = ? WHERE transaction_id = ?",
      JSON.stringify(receipt),
      original.transaction_id
    );
    return Response.json(receipt);
  }

  private async handleStatusSync(request: Request): Promise<Response> {
    const body = await request.json() as { project_id?: string; status?: RegistryEntry["status"]; updated_at?: string };
    if (!body.project_id || !body.status || !body.updated_at || !["active", "paused", "completed", "archived"].includes(body.status)) {
      return Response.json({ error: "invalid_status_sync" }, { status: 400 });
    }

    await this.ensureRegistryRecovered();

    const existing = this.ctx.storage.sql.exec<ProjectRow>(
      "SELECT * FROM projects WHERE project_id = ?",
      body.project_id
    ).toArray()[0];
    if (!existing) return Response.json({ error: "project_not_found" }, { status: 404 });

    this.ctx.storage.sql.exec(
      "UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?",
      body.status,
      body.updated_at,
      body.project_id
    );
    const entries = this.registryEntries();
    await this.repository.writeRegistry({ schema_version: "1.0", projects: entries }, renderRegistry(entries));
    return Response.json({ status: "ok" });
  }

  private async ensureRegistryRecovered(): Promise<void> {
    const projectCount = this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM projects").one().count;
    if (projectCount > 0) return;

    const pendingCount = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM requests WHERE status IN ('allocated', 'guard_committed')"
    ).one().count;
    if (pendingCount > 0) return;

    const canonical = parseCanonicalRegistry(await this.repository.readRegistry());
    if (!canonical) return;

    this.ctx.storage.transactionSync(() => {
      for (const project of canonical) {
        this.ctx.storage.sql.exec(
          `INSERT INTO projects (project_id, name, slug, aliases_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             name = excluded.name,
             slug = excluded.slug,
             aliases_json = excluded.aliases_json,
             status = excluded.status,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          project.project_id,
          project.name,
          project.slug,
          JSON.stringify(project.aliases),
          project.status,
          project.created_at,
          project.updated_at
        );
      }

      if (canonical.length > 0) {
        const highestProjectNumber = canonical.reduce(
          (highest, project) => Math.max(highest, Number.parseInt(project.project_id.slice(4), 10)),
          0
        );
        const allocator = this.ctx.storage.sql.exec<MetaRow>(
          "SELECT value FROM meta WHERE key = 'next_project_number'"
        ).one();
        const currentNext = Number.parseInt(allocator.value, 10);
        if (!Number.isSafeInteger(currentNext) || currentNext < 1) {
          throw new Error("Invalid project allocator state");
        }
        if (currentNext <= highestProjectNumber) {
          this.ctx.storage.sql.exec(
            "UPDATE meta SET value = ? WHERE key = 'next_project_number'",
            String(highestProjectNumber + 1)
          );
        }
      }
    });
  }

  private requestRow(transactionId: string): RequestRow | null {
    return this.ctx.storage.sql.exec<RequestRow>(
      "SELECT transaction_json, project_id, status, receipt_json FROM requests WHERE transaction_id = ?",
      transactionId
    ).toArray()[0] ?? null;
  }

  private allocateProjectId(tx: Extract<Transaction, { operation: "project.create" }>): string {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<MetaRow>(
        "SELECT value FROM meta WHERE key = 'next_project_number'"
      ).one();
      const next = Number.parseInt(row.value, 10);
      if (!Number.isSafeInteger(next) || next < 1) throw new Error("Invalid project allocator state");
      const projectId = `PRJ-${next.toString().padStart(4, "0")}`;
      this.ctx.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'next_project_number'",
        String(next + 1)
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO requests (transaction_id, transaction_json, project_id, status, receipt_json) VALUES (?, ?, ?, 'allocated', NULL)",
        tx.transaction_id,
        JSON.stringify(tx),
        projectId
      );
      return projectId;
    });
  }

  private hasDuplicateProjectIdentity(tx: Extract<Transaction, { operation: "project.create" }>): boolean {
    const candidates = new Set([tx.payload.name, tx.payload.slug, ...tx.payload.aliases].map(normalizeIdentity));
    for (const project of this.ctx.storage.sql.exec<ProjectRow>("SELECT * FROM projects").toArray()) {
      const identities = [project.name, project.slug, ...(JSON.parse(project.aliases_json) as string[])].map(normalizeIdentity);
      if (identities.some((identity) => candidates.has(identity))) return true;
    }
    for (const request of this.ctx.storage.sql.exec<RequestRow>(
      "SELECT transaction_json, project_id, status, receipt_json FROM requests WHERE status IN ('allocated', 'guard_committed')"
    ).toArray()) {
      const pending = JSON.parse(request.transaction_json) as Extract<Transaction, { operation: "project.create" }>;
      const identities = [pending.payload.name, pending.payload.slug, ...pending.payload.aliases].map(normalizeIdentity);
      if (identities.some((identity) => candidates.has(identity))) return true;
    }
    return false;
  }

  private registryEntries(): RegistryEntry[] {
    return this.ctx.storage.sql.exec<ProjectRow>("SELECT * FROM projects ORDER BY project_id").toArray().map((row) => ({
      project_id: row.project_id,
      name: row.name,
      slug: row.slug,
      aliases: JSON.parse(row.aliases_json) as string[],
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
  }

  private persistTerminalRequest(tx: Extract<Transaction, { operation: "project.create" }>, receipt: Receipt, projectId: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO requests (transaction_id, transaction_json, project_id, status, receipt_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET status = excluded.status, receipt_json = excluded.receipt_json`,
      tx.transaction_id,
      JSON.stringify(tx),
      projectId,
      receipt.status,
      JSON.stringify(receipt)
    );
  }

  private rejectedReceipt(tx: Extract<Transaction, { operation: "project.create" }>, code: string, message: string, projectId: string): Receipt {
    return {
      schema_version: "1.0",
      transaction_id: tx.transaction_id,
      status: "rejected",
      project_id: projectId,
      previous_revision: 0,
      new_revision: 0,
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

function parseCanonicalRegistry(value: unknown): RegistryEntry[] | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Canonical registry must be an object");
  const registry = value as { schema_version?: unknown; projects?: unknown };
  if (registry.schema_version !== "1.0" || !Array.isArray(registry.projects)) {
    throw new Error("Canonical registry has an unsupported shape");
  }

  return registry.projects.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Canonical registry project must be an object");
    const project = raw as Record<string, unknown>;
    if (
      typeof project.project_id !== "string" || !/^PRJ-\d{4,}$/.test(project.project_id)
      || typeof project.name !== "string"
      || typeof project.slug !== "string"
      || !Array.isArray(project.aliases) || project.aliases.some((alias) => typeof alias !== "string")
      || typeof project.status !== "string" || !["active", "paused", "completed", "archived"].includes(project.status)
      || typeof project.created_at !== "string"
      || typeof project.updated_at !== "string"
    ) {
      throw new Error(`Invalid canonical registry project: ${JSON.stringify(raw)}`);
    }
    return {
      project_id: project.project_id,
      name: project.name,
      slug: project.slug,
      aliases: project.aliases as string[],
      status: project.status as RegistryEntry["status"],
      created_at: project.created_at,
      updated_at: project.updated_at
    };
  });
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
