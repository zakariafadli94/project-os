import { DurableObject } from "cloudflare:workers";
import { issueRuleAdmissionPermit, parseRuleAdmissionInput } from "../admission/rule-admission";
import { canonicalJson, compareCodePoints, ruleReference } from "../rules/contract";
import { matchesResource } from "../rules/resolution";
import { ruleVersionSchema } from "../domain/rule-governance";
import type { FleetCursor } from "../convergence/fleet";
import type { Env } from "../env";
import type { Receipt } from "../domain/receipt";
import { eventIdForRevision } from "../domain/event";
import { applyRuleGovernance, globalGovernanceTransactionSchema, ruleVersionKey, type GlobalGovernanceTransaction } from "../domain/rule-governance";
import { resolveAndQualifyRuleActivation, unavailableQualificationResolver, type RuleQualificationEvidenceResolver } from "../rules/qualification";
import { createProductionRuleQualificationResolver } from "../rules/production-qualification";
import { createGovernanceQualification, type GovernanceQualification } from "../rules/qualification-record";
import { RuleGovernanceRepository, type CanonicalGovernance, type GovernanceJournalEntry } from "../persistence/rule-governance-repository";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { machineFleetCursorPath, parseLayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../persistence/provider/errors";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { persistenceObservation } from "../persistence/observation";
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

interface FallbackExchangeRow {
  [key: string]: SqlStorageValue;
  exchange_id: string;
  project_id: string;
  transaction_id: string;
  request_sha256: string;
  authority_sha256: string;
  created_at_ms: number;
}

const FALLBACK_KEY_SESSION_TTL_MS = 5 * 60_000;
const MAX_FALLBACK_KEY_SESSIONS = 32;
const STATUS_LOOKUP_DEADLINE_MS = 2_000;
class GovernanceNotInitializedError extends Error {}

function withReadDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("status_lookup_timeout")), STATUS_LOOKUP_DEADLINE_MS);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function governanceTokenMatches(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function minimalFallbackStatus(exchangeId: string, projectId: string, transactionId: string, requestSha256: string, evidence: Record<string, unknown>): Record<string, unknown> {
  if (evidence.request_id !== transactionId || evidence.kind !== "transaction" || evidence.project_id !== projectId) {
    return { exchange_id: exchangeId, status: "unknown", code: "request_status_identity_mismatch" };
  }
  const execution = evidence.execution && typeof evidence.execution === "object"
    ? evidence.execution as { status?: unknown; terminal?: unknown; finalization_ref?: unknown; request_hash?: unknown; lease?: unknown }
    : null;
  const recovery = evidence.recovery && typeof evidence.recovery === "object"
    ? evidence.recovery as { durable_intent?: unknown; scheduled?: unknown; next_attempt_at?: unknown; code?: unknown }
    : null;
  const codeCandidate = typeof evidence.code === "string" ? evidence.code : recovery?.code;
  const code = typeof codeCandidate === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(codeCandidate) ? codeCandidate : null;
  if (execution?.request_hash !== undefined && execution.request_hash !== requestSha256) {
    return { exchange_id: exchangeId, transaction_id: transactionId, status: "unknown", code: "request_status_digest_mismatch" };
  }
  const lease = execution?.lease && typeof execution.lease === "object"
    ? execution.lease as { owner?: unknown; until?: unknown }
    : null;
  const leaseUntil = typeof lease?.until === "string" ? Date.parse(lease.until) : Number.NaN;
  const validLease = typeof lease?.owner === "string" && lease.owner.length > 0 && Number.isFinite(leaseUntil) && leaseUntil > Date.now();
  const scheduledAt = recovery?.scheduled === true && typeof recovery.next_attempt_at === "string"
    && Number.isFinite(Date.parse(recovery.next_attempt_at)) ? recovery.next_attempt_at : undefined;
  const observation = persistenceObservation({
    project_id: projectId,
    kind: "transaction",
    request_id: transactionId,
    observed_at: new Date().toISOString(),
    correlation_id: exchangeId,
    ...(evidence.receipt !== undefined ? { receipt: evidence.receipt } : {}),
    execution: execution && typeof execution.status === "string" ? {
      status: execution.status,
      ...(typeof execution.terminal === "boolean" ? { terminal: execution.terminal } : {}),
      ...(typeof execution.finalization_ref === "string" || execution.finalization_ref === null
        ? { finalization_ref: execution.finalization_ref } : {})
    } : null,
    ...(typeof recovery?.durable_intent === "boolean" ? { durable_intent: recovery.durable_intent } : {}),
    wake_scheduled: scheduledAt !== undefined,
    ...(scheduledAt ? { next_attempt_at: scheduledAt } : {}),
    absence_verified: evidence.status === "not_received",
    blocked: evidence.status === "recovery_blocked",
    running: validLease,
    code
  });
  return {
    exchange_id: exchangeId,
    transaction_id: transactionId,
    status: observation.status,
    recovery: observation.recovery,
    ...(observation.code ? { code: observation.code } : {})
  };
}

export class RegistryGuard extends DurableObject<Env> {
  protected ruleQualificationResolver: RuleQualificationEvidenceResolver = unavailableQualificationResolver;
  private readonly repository: ProjectRepository;
  private readonly fleetPersistence: ProjectOsPersistenceRuntime;
  private readonly governanceRepository: RuleGovernanceRepository;
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
      CREATE TABLE IF NOT EXISTS fallback_exchanges (
        exchange_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        authority_sha256 TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('next_project_number', '1');
      CREATE TABLE IF NOT EXISTS governance_events (
        revision INTEGER PRIMARY KEY,
        event_json TEXT NOT NULL
      );
    `);
    const fallbackExchangeColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(fallback_exchanges)").toArray();
    if (!fallbackExchangeColumns.some(column => column.name === "authority_sha256")) {
      this.ctx.storage.sql.exec("ALTER TABLE fallback_exchanges ADD COLUMN authority_sha256 TEXT NOT NULL DEFAULT ''");
    }
    const persistence = createProductionPersistence(env);
    this.repository = new ProjectRepository(persistence, parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
    this.fleetPersistence = persistence;
    this.governanceRepository = new RuleGovernanceRepository(persistence);
    this.ruleQualificationResolver = createProductionRuleQualificationResolver(persistence, env, { projectGuardStateReads: true });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/governance") {
      return this.serialize(async () => {
        const { state } = await this.globalGovernanceState(undefined, true);
        const unavailable = this.unqualifiedGovernanceResponse(state);
        if (unavailable) return unavailable;
        return Response.json({ revision: state.revision, rules: state.rules, exceptions: state.exceptions });
      }).catch(error => error instanceof GovernanceNotInitializedError
        ? Response.json({ error: "governance_not_initialized" }, { status: 404 })
        : Response.json({ error: "governance_unavailable" }, { status: 503 }));
    }
    if (request.method === "POST" && path === "/governance/transaction") {
      return this.serialize(() => this.handleGovernanceTransaction(request))
        .catch(() => Response.json({ error: "governance_unavailable" }, { status: 503 }));
    }
    if (request.method === "POST" && path === "/rule-admission") {
      return this.serialize(() => this.handleRuleAdmission(request))
        .catch(() => Response.json({ error: "governance_unavailable" }, { status: 503 }));
    }
    if (request.method === "POST" && path === "/create") {
      return this.serialize(() => this.handleCreate(request));
    }
    if (request.method === "GET" && path === "/registry") {
      return this.serialize(async () => {
        await this.ensureRegistryRecovered();
        return Response.json({ schema_version: "1.0", projects: this.registryEntries() });
      });
    }
    if (request.method === "GET" && path === "/create-status") {
      return this.handleCreateStatus(new URL(request.url));
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
    if (request.method === "POST" && path === "/fallback/track") {
      return this.serialize(() => this.handleFallbackTrack(request));
    }
    if (request.method === "GET" && path === "/fallback/status") {
      return this.handleFallbackStatus(request);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async globalGovernanceState(initialTransaction?: GlobalGovernanceTransaction, allowNeverInitialized = false): Promise<{ state: CanonicalGovernance; token: string | null }> {
    const canonical = await this.governanceRepository.read();
    const row = this.ctx.storage.sql.exec<MetaRow>("SELECT value FROM meta WHERE key = 'rule_governance'").toArray()[0];
    if (!canonical) {
      const cached = this.ctx.storage.sql.exec<CountRow>("SELECT (SELECT COUNT(*) FROM governance_events) + (SELECT COUNT(*) FROM requests WHERE project_id = 'GLOBAL') AS count").one().count;
      if (!row && !cached && allowNeverInitialized && await this.governanceRepository.isNeverInitialized()) throw new GovernanceNotInitializedError();
      if (row || cached || !initialTransaction) throw new Error("Canonical global governance unavailable");
      await this.governanceRepository.authorizeBootstrap(initialTransaction);
      return { state: { revision: 0, rules: {}, exceptions: {}, journal: {} }, token: null };
    }
    if (row && JSON.parse(row.value).revision > canonical.state.revision) throw new Error("Canonical global governance regressed");
    this.persistGovernanceCache(canonical.state);
    return canonical;
  }

  private persistGovernanceCache(state: CanonicalGovernance): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('rule_governance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ revision: state.revision }));
      for (const entry of Object.values(state.journal)) {
        if (entry.event) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO governance_events (revision, event_json) VALUES (?, ?)", entry.event.revision, JSON.stringify(entry.event));
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO requests (transaction_id, transaction_json, project_id, status, receipt_json) VALUES (?, ?, 'GLOBAL', ?, ?)", entry.transaction.transaction_id, JSON.stringify(entry.transaction), entry.receipt.status, JSON.stringify(entry.receipt));
      }
    });
  }

  private async handleGovernanceTransaction(request: Request): Promise<Response> {
    const token = this.env.RULE_GOVERNANCE_TOKEN;
    const ordinaryAuthorities = [this.env.INGRESS_TOKEN, this.env.CONTROL_TOWER_OPERATOR_TOKEN,
      this.env.INPUT_RECOVERY_OPERATOR_TOKEN, this.env.MUTATION_GATE_OPERATOR_TOKEN, this.env.MUTATION_CONTEXT_SIGNING_KEY, this.env.RULE_ADMISSION_SIGNING_KEY];
    if (!token || !token.trim() || ordinaryAuthorities.some(value => value && governanceTokenMatches(token, value)) || !governanceTokenMatches(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
      return Response.json({ error: "governance_authority_required" }, { status: 403 });
    }
    let tx: GlobalGovernanceTransaction;
    try { tx = globalGovernanceTransactionSchema.parse(await request.json()); }
    catch { return Response.json({ error: "invalid_governance_transaction" }, { status: 400 }); }
    const { state, token: canonicalToken } = await this.globalGovernanceState(tx);
    const receiptBase = {
      schema_version: "1.0" as const, transaction_id: tx.transaction_id, project_id: "GLOBAL",
      previous_revision: state.revision, new_revision: state.revision
    };
    const existing = state.journal[tx.transaction_id];
    if (existing) {
      if (JSON.stringify(existing.transaction) !== JSON.stringify(tx)) return Response.json({ ...receiptBase, status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH", message: "The same transaction_id was reused with different content" });
      return Response.json(existing.receipt);
    }
    if (this.requestRow(tx.transaction_id)) return Response.json({ ...receiptBase, status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH", message: "Transaction ID already exists outside this canonical governance history" });
    const result = tx.base_revision !== state.revision
      ? { kind: "conflict" as const, code: "STALE_REVISION", message: "Global governance requires the current revision" }
      : applyRuleGovernance(state, tx, "GLOBAL");
    let qualificationRecord: GovernanceQualification | undefined;
    if (result.kind === "commit" && tx.operation === "rule.activate") {
      const rule = state.rules[ruleVersionKey(tx.payload.rule_id, tx.payload.version)];
      const qualification = await resolveAndQualifyRuleActivation(this.ruleQualificationResolver, {
        rule, known_active_rules: Object.values(state.rules), ...(canonicalToken ? { known_global_governance: { state, token: canonicalToken } } : {}), requested_evidence_refs: tx.payload.activation_evidence, now: new Date().toISOString()
      });
      if (qualification.verdict !== "allow") return Response.json({ error: qualification.code, qualification }, { status: qualification.verdict === "unavailable" ? 503 : 409 });
      if (!qualification.qualification_proof) return Response.json({ error: "QUALIFICATION_EVIDENCE_UNAVAILABLE" }, { status: 503 });
      qualificationRecord = await createGovernanceQualification(tx, rule, qualification.qualification_proof);
    }
    const revision = state.revision + 1;
    const eventId = eventIdForRevision(revision);
    const receipt: Receipt = result.kind === "commit"
      ? { ...receiptBase, status: "committed", new_revision: revision, event_id: eventId, committed_at: tx.created_at }
      : { ...receiptBase, status: result.kind, code: result.code, message: result.message };
    const entry: GovernanceJournalEntry = { transaction: tx, receipt, ...(qualificationRecord ? { qualification: qualificationRecord, qualification_required: true } : {}) };
    if (result.kind === "commit") entry.event = {
      schema_version: "1.0", event_id: eventId, project_id: "GLOBAL", revision,
      transaction_id: tx.transaction_id, type: tx.operation, timestamp: tx.created_at, payload: tx.payload
    };
    const next: CanonicalGovernance = {
      ...(result.kind === "commit" ? { ...result.state, revision } : state),
      journal: { ...state.journal, [tx.transaction_id]: entry }
    };
    await this.governanceRepository.write(next, canonicalToken);
    this.persistGovernanceCache(next);
    return Response.json(receipt);
  }

  private async handleRuleAdmission(request: Request): Promise<Response> {
    const secret = this.env.RULE_ADMISSION_SIGNING_KEY;
    if (!secret) return Response.json({ error: "governance_unavailable" }, { status: 503 });
    let input;
    try {
      input = parseRuleAdmissionInput(await request.json());
    } catch {
      return Response.json({ error: "invalid_rule_admission" }, { status: 400 });
    }
    const { state } = await this.globalGovernanceState();
    const unavailable = this.unqualifiedGovernanceResponse(state);
    if (unavailable) return unavailable;
    if (input.global_revision !== state.revision || input.ruleset.global_revision !== state.revision) {
      return Response.json({ error: "global_governance_stale" }, { status: 409 });
    }
    const canonicalGlobalRules = Object.values(state.rules)
      .map(rule => ruleVersionSchema.safeParse(rule))
      .filter((result): result is { success: true; data: ReturnType<typeof ruleVersionSchema.parse> } => result.success)
      .map(result => result.data)
      .filter(rule => rule.status === "active" && rule.operations.includes(input.operation) && input.resources.some(resource => matchesResource(rule, resource)))
      .map(ruleReference)
      .sort((left, right) => compareCodePoints(canonicalJson(left), canonicalJson(right)));
    const requestedGlobalRules = input.ruleset.rules.filter(rule => rule.scope.kind === "global");
    if (canonicalJson(requestedGlobalRules) !== canonicalJson(canonicalGlobalRules)) {
      return Response.json({ error: "global_ruleset_mismatch" }, { status: 409 });
    }
    return Response.json(await issueRuleAdmissionPermit(input, secret, Date.now()));
  }

  /** History remains replayable for migration; only an activation with a canonical
   * attestation verified by the repository may contribute effective authority. */
  private unqualifiedGovernanceResponse(state: CanonicalGovernance): Response | null {
    const entries = Object.values(state.journal);
    const unqualified = Object.values(state.rules).filter(rule => rule.status === "active" && !entries.some(entry =>
      entry.receipt.status === "committed" && entry.transaction.operation === "rule.activate" &&
      entry.transaction.payload.rule_id === rule.rule_id && entry.transaction.payload.version === rule.version && entry.qualification
    ));
    return unqualified.length ? Response.json({
      error: "governance_qualification_unavailable", rules: unqualified.map(ruleReference),
      required_action: "Propose and explicitly qualify a successor for each legacy activation; canonical history alone is not active authority"
    }, { status: 503 }) : null;
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

  private async handleFallbackTrack(request: Request): Promise<Response> {
    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return fallbackError("invalid_fallback_exchange", 400);
    }
    const allowed = ["exchange_id", "project_id", "transaction_id", "request_sha256", "authority_sha256"];
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).sort().join(",") !== allowed.slice().sort().join(",")
      || typeof input.exchange_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(input.exchange_id)
      || typeof input.project_id !== "string" || !/^PRJ-[0-9]{4,}$/.test(input.project_id)
      || typeof input.transaction_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,511}$/.test(input.transaction_id)
      || typeof input.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.request_sha256)
      || typeof input.authority_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.authority_sha256)) {
      return fallbackError("invalid_fallback_exchange", 400);
    }
    const values = [input.exchange_id, input.project_id, input.transaction_id, input.request_sha256, input.authority_sha256] as const;
    const existing = this.ctx.storage.sql.exec<FallbackExchangeRow>(
      "SELECT * FROM fallback_exchanges WHERE exchange_id = ?", input.exchange_id
    ).toArray()[0];
    if (existing) {
      if (existing.project_id !== input.project_id || existing.transaction_id !== input.transaction_id
        || existing.request_sha256 !== input.request_sha256 || existing.authority_sha256 !== input.authority_sha256) {
        return fallbackError("fallback_exchange_conflict", 409);
      }
      return fallbackJson({ status: "tracked", exchange_id: existing.exchange_id });
    }
    const priorBusinessRequest = this.ctx.storage.sql.exec<FallbackExchangeRow>(
      "SELECT * FROM fallback_exchanges WHERE project_id = ? AND transaction_id = ? LIMIT 1",
      input.project_id,
      input.transaction_id
    ).toArray()[0];
    if (priorBusinessRequest && (priorBusinessRequest.request_sha256 !== input.request_sha256
      || priorBusinessRequest.authority_sha256 !== input.authority_sha256)) {
      return fallbackError("fallback_exchange_conflict", 409);
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO fallback_exchanges (exchange_id, project_id, transaction_id, request_sha256, authority_sha256, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ...values,
      Date.now()
    );
    return fallbackJson({ status: "tracked", exchange_id: input.exchange_id });
  }

  private async handleFallbackStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const exchangeId = url.searchParams.get("exchange_id");
    const authoritySha256 = request.headers.get("x-authority-sha256");
    if (!exchangeId || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(exchangeId)) {
      return Response.json({ error: "exchange_identity_required" }, { status: 400 });
    }
    if (!authoritySha256 || !/^[a-f0-9]{64}$/.test(authoritySha256)) {
      return Response.json({ exchange_id: exchangeId, status: "unknown", code: "lookup_identity_unavailable" }, { status: 503 });
    }
    const exchange = this.ctx.storage.sql.exec<FallbackExchangeRow>(
      "SELECT * FROM fallback_exchanges WHERE exchange_id = ?", exchangeId
    ).toArray()[0];
    if (!exchange) {
      return Response.json({ exchange_id: exchangeId, status: "unknown", code: "exchange_binding_unavailable" });
    }
    if (exchange && !exchange.authority_sha256) {
      return Response.json({ exchange_id: exchangeId, status: "unknown", code: "exchange_authority_unavailable" });
    }
    if (exchange && !governanceTokenMatches(exchange.authority_sha256, authoritySha256)) {
      return Response.json({ error: "fallback_exchange_forbidden" }, { status: 403 });
    }
    const projectId = exchange.project_id;
    const transactionId = exchange.transaction_id;
    try {
      const response = await withReadDeadline(this.env.PROJECT_GUARD.getByName(projectId).fetch(
        `https://project-guard.internal/request-status?kind=transaction&request_id=${encodeURIComponent(transactionId)}`
      ));
      const status = await withReadDeadline(response.json<Record<string, unknown>>());
      if (!response.ok) return Response.json({ exchange_id: exchangeId, status: "unknown", code: "request_status_unavailable" }, { status: 503 });
      return Response.json(minimalFallbackStatus(exchangeId, projectId, transactionId, exchange.request_sha256, status));
    } catch {
      return Response.json({ exchange_id: exchangeId, status: "unknown", code: "request_status_unavailable" }, { status: 503 });
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

  private async handleCreateStatus(url: URL): Promise<Response> {
    const transactionId = url.searchParams.get("transaction_id");
    if (!transactionId || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,511}$/.test(transactionId)) {
      return Response.json({ error: "transaction_identity_required" }, { status: 400 });
    }
    const row = this.requestRow(transactionId);
    if (!row) {
      try {
        const receipt = await withReadDeadline(this.repository.readReceipt(transactionId));
        if (receipt?.status === "committed" && receipt.transaction_id === transactionId
          && /^PRJ-[0-9]{4,}$/.test(receipt.project_id) && Number.isSafeInteger(receipt.new_revision)) {
          const commit = await withReadDeadline(this.repository.readCommitRecord(receipt.project_id, receipt.new_revision));
          if (commit?.transaction.operation === "project.create"
            && commit.transaction.transaction_id === transactionId
            && commit.transaction.project_id === receipt.project_id
            && commit.project_id === receipt.project_id
            && commit.new_revision === receipt.new_revision
            && canonicalJson(commit.receipt) === canonicalJson(receipt)) {
            return Response.json({ transaction_id: transactionId, status: "committed", project_id: receipt.project_id, receipt });
          }
        }
      } catch {
        return Response.json({ transaction_id: transactionId, status: "unknown", code: "create_status_unavailable" }, { status: 503 });
      }
      return Response.json({ transaction_id: transactionId, status: "unknown", code: "canonical_evidence_not_found" });
    }
    let transaction: Transaction;
    try {
      transaction = parseTransaction(JSON.parse(row.transaction_json));
    } catch {
      return Response.json({ transaction_id: transactionId, status: "unknown", code: "request_record_invalid" }, { status: 503 });
    }
    if (transaction.operation !== "project.create" || transaction.transaction_id !== transactionId) {
      return Response.json({ transaction_id: transactionId, status: "unknown", code: "request_record_mismatch" });
    }
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as Receipt : null;
    const status = row.status === "allocated" || row.status === "guard_committed"
      ? "pending"
      : receipt?.status ?? "unknown";
    return Response.json({
      transaction_id: transactionId,
      status,
      ...(row.project_id ? { project_id: row.project_id } : {}),
      ...(receipt ? { receipt } : {})
    });
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
