import { DurableObject } from "cloudflare:workers";
import type { FleetCursor } from "../convergence/fleet";
import type { Env } from "../env";
import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { machineFleetCursorPath, parseLayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../persistence/provider/errors";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProjectRepository } from "../persistence/repository";
import { renderRegistry, type RegistryEntry } from "../render/registry";
import {
  FallbackContractError,
  parseFallbackEncryptedRequestJson,
  parseFallbackEncryptAndRotateInputJson
} from "../fallback/contract";
import {
  FallbackCryptoError,
  decryptFallbackPayload,
  encryptFallbackPayload,
  exportP256PrivateJwk,
  exportP256PublicJwk,
  generateP256EcdhKeyPair,
  importP256PrivateJwk,
  parseP256PublicJwk,
  type FallbackOperation,
  type P256PublicJwk
} from "../fallback/crypto";

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

interface FallbackKeySessionRow {
  [key: string]: SqlStorageValue;
  key_id: string;
  private_jwk_json: string;
  caller_public_jwk_json: string | null;
  request_id: string | null;
  operation: string | null;
  created_at_ms: number;
  retired_at_ms: number | null;
}

const FALLBACK_KEY_SESSION_TTL_MS = 5 * 60_000;
const MAX_FALLBACK_KEY_SESSIONS = 32;

export class RegistryGuard extends DurableObject<Env> {
  private readonly repository: ProjectRepository;
  private readonly fleetPersistence: ProjectOsPersistenceRuntime;
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
      CREATE TABLE IF NOT EXISTS fallback_key_sessions (
        key_id TEXT PRIMARY KEY,
        private_jwk_json TEXT NOT NULL,
        caller_public_jwk_json TEXT,
        request_id TEXT,
        operation TEXT,
        created_at_ms INTEGER NOT NULL,
        retired_at_ms INTEGER
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('next_project_number', '1');
    `);
    const persistence = createProductionPersistence(env);
    this.repository = new ProjectRepository(persistence, parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
    this.fleetPersistence = persistence;
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
    if (request.method === "GET" && path === "/convergence-fleet") {
      return this.serialize(async () => Response.json(await this.fleetCursorState()));
    }
    if (request.method === "POST" && path === "/convergence-fleet") {
      return this.serialize(() => this.handleFleetCursor(request));
    }
    if (request.method === "GET" && path === "/fallback/key") {
      return this.serialize(() => this.handleFallbackKey());
    }
    if (request.method === "POST" && path === "/fallback/decrypt") {
      return this.serialize(() => this.handleFallbackDecrypt(request));
    }
    if (request.method === "POST" && path === "/fallback/encrypt-and-rotate") {
      return this.serialize(() => this.handleFallbackEncryptAndRotate(request));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleFallbackKey(): Promise<Response> {
    try {
      const keyPair = await generateP256EcdhKeyPair();
      const keyId = `fkey_${crypto.randomUUID().replaceAll("-", "")}`;
      const privateJwk = await exportP256PrivateJwk(keyPair.privateKey);
      const serverPublicKey = await exportP256PublicJwk(keyPair.publicKey);
      this.pruneFallbackSessions(Date.now());
      this.ctx.storage.sql.exec(
        `INSERT INTO fallback_key_sessions
         (key_id, private_jwk_json, caller_public_jwk_json, request_id, operation, created_at_ms, retired_at_ms)
         VALUES (?, ?, NULL, NULL, NULL, ?, NULL)`,
        keyId,
        JSON.stringify(privateJwk),
        Date.now()
      );
      return fallbackJson({ schema_version: "1.0", key_id: keyId, server_public_key: serverPublicKey });
    } catch {
      return fallbackError("fallback_key_unavailable", 503);
    }
  }

  private async handleFallbackDecrypt(request: Request): Promise<Response> {
    let envelope;
    try {
      envelope = parseFallbackEncryptedRequestJson(await request.text());
    } catch (error) {
      return fallbackError(error instanceof FallbackContractError && error.code === "payload_too_large" ? "fallback_payload_too_large" : "invalid_fallback_envelope", 400);
    }
    const session = this.liveFallbackSession(envelope.key_id, Date.now());
    if (!session) return fallbackError("fallback_key_retired", 409);
    try {
      const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(await decryptFallbackPayload({
        key_id: envelope.key_id,
        request_id: envelope.request_id,
        operation: envelope.operation,
        direction: "client_to_server",
        recipient_private_key: await importP256PrivateJwk(JSON.parse(session.private_jwk_json)),
        sender_public_key: envelope.caller_public_key,
        iv: envelope.iv,
        ciphertext: envelope.ciphertext
      }));
      const caller = JSON.stringify(parseP256PublicJwk(envelope.caller_public_key));
      if (
        session.caller_public_jwk_json !== null
        && (session.caller_public_jwk_json !== caller || session.request_id !== envelope.request_id || session.operation !== envelope.operation)
      ) return fallbackError("fallback_key_retired", 409);
      if (session.caller_public_jwk_json === null) {
        this.ctx.storage.sql.exec(
          `UPDATE fallback_key_sessions
           SET caller_public_jwk_json = ?, request_id = ?, operation = ?
           WHERE key_id = ? AND retired_at_ms IS NULL`,
          caller,
          envelope.request_id,
          envelope.operation,
          envelope.key_id
        );
      }
      return fallbackJson({
        key_id: envelope.key_id,
        request_id: envelope.request_id,
        operation: envelope.operation,
        plaintext
      });
    } catch (error) {
      const code = error instanceof FallbackCryptoError && error.code === "payload_too_large"
        ? "fallback_payload_too_large"
        : "invalid_fallback_envelope";
      return fallbackError(code, 400);
    }
  }

  private async handleFallbackEncryptAndRotate(request: Request): Promise<Response> {
    let input;
    try {
      input = parseFallbackEncryptAndRotateInputJson(await request.text());
    } catch (error) {
      return fallbackError(error instanceof FallbackContractError && error.code === "payload_too_large" ? "fallback_payload_too_large" : "invalid_fallback_response", 400);
    }
    const session = this.liveFallbackSession(input.key_id, Date.now());
    if (
      !session
      || !session.caller_public_jwk_json
      || session.request_id !== input.request_id
      || session.operation !== input.operation
    ) return fallbackError("fallback_key_retired", 409);
    try {
      const encrypted = await encryptFallbackPayload({
        key_id: input.key_id,
        request_id: input.request_id,
        operation: input.operation,
        direction: "server_to_client",
        sender_private_key: await importP256PrivateJwk(JSON.parse(session.private_jwk_json)),
        recipient_public_key: parseP256PublicJwk(JSON.parse(session.caller_public_jwk_json)),
        plaintext: new TextEncoder().encode(input.plaintext)
      });
      this.ctx.storage.sql.exec(
        "UPDATE fallback_key_sessions SET retired_at_ms = ? WHERE key_id = ? AND retired_at_ms IS NULL",
        Date.now(),
        input.key_id
      );
      return fallbackJson({
        schema_version: "1.0",
        key_id: input.key_id,
        request_id: input.request_id,
        operation: input.operation,
        ...encrypted
      });
    } catch (error) {
      const code = error instanceof FallbackCryptoError && error.code === "payload_too_large"
        ? "fallback_payload_too_large"
        : "fallback_response_unavailable";
      return fallbackError(code, 503);
    }
  }

  private liveFallbackSession(keyId: string, nowMs: number): FallbackKeySessionRow | null {
    const session = this.ctx.storage.sql.exec<FallbackKeySessionRow>(
      "SELECT * FROM fallback_key_sessions WHERE key_id = ?",
      keyId
    ).toArray()[0] ?? null;
    if (!session || session.retired_at_ms !== null) return null;
    if (nowMs - session.created_at_ms > FALLBACK_KEY_SESSION_TTL_MS) {
      this.ctx.storage.sql.exec("UPDATE fallback_key_sessions SET retired_at_ms = ? WHERE key_id = ?", nowMs, keyId);
      return null;
    }
    return session;
  }

  private pruneFallbackSessions(nowMs: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM fallback_key_sessions WHERE created_at_ms < ? OR (retired_at_ms IS NOT NULL AND retired_at_ms < ?)",
      nowMs - FALLBACK_KEY_SESSION_TTL_MS,
      nowMs - FALLBACK_KEY_SESSION_TTL_MS
    );
    const sessions = this.ctx.storage.sql.exec<FallbackKeySessionRow>(
      "SELECT * FROM fallback_key_sessions ORDER BY created_at_ms ASC"
    ).toArray();
    for (const session of sessions.slice(0, Math.max(0, sessions.length - MAX_FALLBACK_KEY_SESSIONS + 1))) {
      this.ctx.storage.sql.exec("DELETE FROM fallback_key_sessions WHERE key_id = ?", session.key_id);
    }
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

  private async handleFleetCursor(request: Request): Promise<Response> {
    let body: { expected_token?: unknown; cursor?: unknown };
    try {
      body = await request.json() as { expected_token?: unknown; cursor?: unknown };
    } catch {
      return Response.json({ error: "invalid_fleet_cursor" }, { status: 400 });
    }
    if ((body.expected_token !== null && typeof body.expected_token !== "string") || body.cursor === undefined) {
      return Response.json({ error: "invalid_fleet_cursor" }, { status: 400 });
    }

    let cursor: FleetCursor;
    try {
      cursor = parseFleetCursor(body.cursor);
    } catch {
      return Response.json({ error: "invalid_fleet_cursor" }, { status: 400 });
    }

    const current = await this.fleetCursorState();
    if (body.expected_token !== current.token) {
      return Response.json({ error: "fleet_cursor_conflict", cursor: current.cursor, token: current.token }, { status: 409 });
    }
    let token: string;
    try {
      token = await this.writeFleetCheckpoint(cursor, current.token === "0" ? null : current.token);
    } catch (error) {
      if (error instanceof ProviderConflictError || error instanceof ProviderPreconditionFailedError) {
        const latest = await this.fleetCursorState();
        return Response.json({ error: "fleet_cursor_conflict", cursor: latest.cursor, token: latest.token }, { status: 409 });
      }
      throw error;
    }
    this.persistFleetCursor(cursor, token);
    return Response.json({ cursor, token });
  }

  private async fleetCursorState(): Promise<{ cursor: FleetCursor; token: string }> {
    const checkpoint = await this.readFleetCheckpoint();
    if (checkpoint) {
      this.persistFleetCursor(checkpoint.cursor, checkpoint.token);
      return checkpoint;
    }
    return { cursor: emptyFleetCursor(), token: "0" };
  }

  private async readFleetCheckpoint(): Promise<{ cursor: FleetCursor; token: string } | null> {
    const path = machineFleetCursorPath();
    const metadata = await this.fleetPersistence.objects.getMetadata(path);
    if (!metadata) return null;
    if (!metadata.revisionToken) throw new Error("Fleet cursor checkpoint is missing a revision token");
    const text = await this.fleetPersistence.objects.readText(path);
    if (text === null) throw new Error("Fleet cursor checkpoint disappeared during read");
    const confirmation = await this.fleetPersistence.objects.getMetadata(path);
    if (!confirmation || confirmation.revisionToken !== metadata.revisionToken) {
      throw new ProviderConflictError("Fleet cursor checkpoint changed during read");
    }
    return { cursor: parseFleetCursor(JSON.parse(text)), token: metadata.revisionToken };
  }

  private async writeFleetCheckpoint(cursor: FleetCursor, expectedToken: string | null): Promise<string> {
    const path = machineFleetCursorPath();
    const content = JSON.stringify(cursor);
    if (expectedToken === null) {
      await this.fleetPersistence.objects.createText(path, content);
      const metadata = await this.fleetPersistence.objects.getMetadata(path);
      if (!metadata?.revisionToken) throw new Error("Fleet cursor checkpoint create has no revision token");
      return metadata.revisionToken;
    }
    const metadata = await this.fleetPersistence.conditionalWrite.writeTextConditional(path, content, expectedToken);
    if (!metadata.revisionToken) throw new Error("Fleet cursor checkpoint write has no revision token");
    return metadata.revisionToken;
  }

  private persistFleetCursor(cursor: FleetCursor, token: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('fleet_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(cursor)
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('fleet_cursor_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        token
      );
    });
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

function emptyFleetCursor(): FleetCursor {
  return {
    schema_version: "1.0",
    after_project_id: null,
    pending_project_ids: [],
    turn_started_at: "1970-01-01T00:00:00.000Z",
    last_success_at: null
  };
}

function parseFleetCursor(value: unknown): FleetCursor {
  if (!value || typeof value !== "object") throw new Error("invalid fleet cursor");
  const cursor = value as Record<string, unknown>;
  if (
    cursor.schema_version !== "1.0"
    || (cursor.after_project_id !== null && !isProjectId(cursor.after_project_id))
    || !Array.isArray(cursor.pending_project_ids)
    || cursor.pending_project_ids.some((projectId) => !isProjectId(projectId))
    || new Set(cursor.pending_project_ids).size !== cursor.pending_project_ids.length
    || !isTimestamp(cursor.turn_started_at)
    || (cursor.last_success_at !== null && !isTimestamp(cursor.last_success_at))
  ) throw new Error("invalid fleet cursor");
  return {
    schema_version: "1.0",
    after_project_id: cursor.after_project_id as string | null,
    pending_project_ids: [...cursor.pending_project_ids] as string[],
    turn_started_at: cursor.turn_started_at as string,
    last_success_at: cursor.last_success_at as string | null
  };
}

function isProjectId(value: unknown): value is string {
  return typeof value === "string" && /^PRJ-\d{4,}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function fallbackJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function fallbackError(error: string, status: number): Response {
  return fallbackJson({ error }, status);
}
