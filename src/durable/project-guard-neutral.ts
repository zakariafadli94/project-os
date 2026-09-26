import { ReviewCapabilityExpiredError } from "../artifacts/review-policy";
import { binaryArtifactPolicyViolation } from "../artifacts/policy";
import { ReviewCandidateRevisionError } from "../mutation-gate/artifact-intent";
import { DurableObject } from "cloudflare:workers";
import {
  StagedArtifactConflictError,
  StagedArtifactSourceMismatchError
} from "../artifacts/staged-publication";
import {
  isReviewCandidate,
  isStagedArtifactWriteRequest,
  parseArtifactWriteRequest,
  type ArtifactWriteReceipt,
  type ArtifactWriteRequest
} from "../domain/artifact-write";
import type { CanonicalCommitRecord } from "../domain/commit-record";
import { parseManagedDocumentRequest, type ManagedDocumentRequest } from "../domain/managed-document-request";
import { navigationReconcileSchema, zoneNavigationHeadSchema, zoneNavigationReceiptSchema, type NavigationReconcileRequest, type NavigationZone, type ZoneNavigationReceipt } from "../domain/zone-navigation";
import type { PackageRef } from "../domain/document-package";
import { CURRENT_PROJECTION_VERSION, MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH, type CompletedMaterializationRecord } from "../domain/materialization";
import type { Env } from "../env";
import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "../domain/transaction";
import { applyTransaction } from "../domain/transitions";
import { ruleVersionKey } from "../domain/rule-governance";
import { unavailableQualificationResolver, type RuleQualificationEvidenceResolver } from "../rules/qualification";
import { prepareLocalRuleActivation, type LocalRuleActivationCapability } from "../rules/local-rule-qualification";
import { createProductionRuleQualificationResolver } from "../rules/production-qualification";
import { ManagedDocumentChangeCoordinator } from "../documents/change-coordinator";
import { ManagedDocumentRequestIntentConflictError, ManagedDocumentRequestLedger } from "../documents/request-ledger";
import { TransactionRequestLedger } from "../transactions/request-ledger";
import { ManagedDocumentConflictError, ManagedDocumentService, type ManagedDocumentReceipt } from "../documents/service";
import { ZoneNavigationEngine, zoneNavigationHeadPath } from "../documents/zone-navigation";
import { ZoneNavigationInventory } from "../documents/zone-navigation-inventory";
import { ZoneNavigationSources } from "../documents/zone-navigation-sources";
import { DocumentLedgerRepository } from "../documents/repository";
import type { ProviderObjectMetadata, ProviderRequestScope } from "../persistence/provider/contract";
import { requestMaterializationTargetSafely } from "../materialization/handoff";
import { MutationIntentConflictError, MutationGateRepository } from "../mutation-gate/repository";
import { parseLayoutMode, machineCommitRecordPath, machineReceiptPath, machineArtifactReceiptPath, machineMutationIntentPath, machineDocumentRoot, machineDocumentHeadPath, machineDocumentVersionPath, machineMaterializationHeadPath, machineMaterializationRecordPath, machineMaterializationRoot, workspaceProjectRoot, type LayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ArtifactContentConflictError, ProjectRepository } from "../persistence/repository";
import { resolveArtifactDestination } from "../persistence/artifact-routing";
import { parseMutationGateMode } from "../mutation-gate/service";
import { AdmissionError, issueMutationContext, verifyMutationContext, type MutationContext } from "../admission/mutation-context";
import { normalizeArtifactAdmission, normalizeDocumentAdmission, normalizeSystemAdmission, normalizeTransactionAdmission, type NormalizedAdmissionOperation } from "../admission/operation-context";
import { RuleAdmissionError, verifyRuleAdmissionPermit, type RuleAdmissionInput, type RuleAdmissionPermit } from "../admission/rule-admission";
import { decodeAdmission } from "../admission/transport";
import { sha256Canonical } from "../materialization/hash";
import { sha256Text } from "../documents/hash";
import { ProviderConflictError, ProviderOperationError } from "../persistence/provider/errors";
import {
  admissionModeForProject,
  assertCapacity,
  ConvergenceAdmissionError,
  convergenceModeForProject,
  type CapacityObservation
} from "../convergence/rollout";
import { freshnessRejectionMetric, workerLogConvergenceTelemetry } from "../convergence/observability";
import { deploymentIdentity } from "../deployment/identity";
import { evaluateRules } from "../rules/evaluator";
import { canonicalJson, type EvaluationResult, type RuleObservation } from "../rules/contract";
import type { GlobalGovernanceState } from "../domain/rule-governance";
import { ruleVersionSchema } from "../domain/rule-governance";
import { matchesResource } from "../rules/resolution";
import { ExecutionJournal } from "../execution/journal";
import type { ExecutionAdmission, ExecutionAdapter, ExecutionPlan } from "../execution/contract";
import { ExecutionCoordinator } from "../execution/coordinator";
import { persistenceObservation, type RequestKind } from "../persistence/observation";
import { authorizeRepair, normalizeRepairAdmission, parseRepairIntent, unavailableRepairEvidence, type RepairEvidenceResolver } from "../execution/repair";
import { createSliceBudget } from "../convergence/budget";

interface TransactionRow {
  [key: string]: SqlStorageValue;
  receipt_json: string;
}

interface ArtifactRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
}

interface NavigationRefreshRow {
  [key: string]: SqlStorageValue;
  zone: string;
  source_generation: number;
  request_json: string | null;
}

interface DocumentRequestRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
}

interface RecoveryRequestRow {
  [key: string]: SqlStorageValue;
  kind: string;
  request_id: string;
  failure_message: string | null;
}

type RecoveryFailureClassification = "provider_temporary" | "provider_blocked" | "continuation" | "internal";

interface RecoveryFailureDiagnostic {
  code: string;
  classification: RecoveryFailureClassification;
  error_name: string;
  progress_sha256: string;
  external_progress_sha256?: string;
  next_attempt_at: string | null;
}

interface RecoveryFailureResult extends RecoveryFailureDiagnostic {
  count: number;
  stopped: boolean;
  delay_ms: number;
}

interface RecoveryCursorRow {
  [key: string]: SqlStorageValue;
  kind: string;
  request_id: string;
}

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

function isCapacityObservation(value: unknown): value is CapacityObservation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapacityObservation>;
  const queuedOutputs = candidate.queued_outputs;
  const oldestPendingSeconds = candidate.oldest_pending_seconds;
  return typeof queuedOutputs === "number"
    && Number.isSafeInteger(queuedOutputs)
    && queuedOutputs >= 0
    && typeof oldestPendingSeconds === "number"
    && Number.isFinite(oldestPendingSeconds)
    && oldestPendingSeconds >= 0
    && typeof candidate.continuation_available === "boolean"
    && typeof candidate.within_qualified_envelope === "boolean";
}

interface ManagedDocumentTerminalReceipt {
  request_id: string;
  project_id: string;
  status: "rejected" | "conflict";
  code: string;
  message: string;
  document_id?: string;
}

interface PackageDocumentReceipt {
  request_id: string;
  project_id: string;
  status: "committed" | "conflict";
  candidate?: PackageRef;
  execution_status?: "finalized";
  finalization_ref?: string | null;
  code?: string;
}

interface NavigationDocumentReceipt {
  operation: "navigation.reconcile";
  request_id: string;
  project_id: string;
  status: "committed" | "conflict";
  execution_status: "pending" | "finalized" | "conflict";
  navigation_receipt?: ZoneNavigationReceipt;
  code?: string;
  finalization_ref?: string | null;
}

type ManagedDocumentOperationReceipt = ManagedDocumentReceipt | ManagedDocumentTerminalReceipt | NavigationDocumentReceipt;
type StoredDocumentReceipt = ManagedDocumentOperationReceipt | PackageDocumentReceipt;

const PROJECT_STATUS_OPERATIONS = new Set<Transaction["operation"]>([
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive"
]);

/** Recovery is per-project and bounded. The local queue temporarily retains
 * an admitted request until its immutable Dropbox intent and receipt exist. */
const REQUEST_RECOVERY_BATCH_SIZE = 4;
const REQUEST_RECOVERY_RETRY_DELAY_MS = 30_000;
const MATERIALIZATION_FINALIZATION_WORK_KEY = "materialization-finalization-work";
const MATERIALIZATION_FINALIZATION_REQUEST_KEY = "materialization-finalization-request";
const MATERIALIZATION_FINALIZATION_LINEAGE_BATCH_SIZE = 4;
const MATERIALIZATION_FINALIZATION_CERTIFICATE_BATCH_SIZE = 4;
const MATERIALIZATION_FINALIZATION_PROVIDER_CALL_BUDGET = 32;
const MATERIALIZATION_FINALIZATION_SLICE_MS = 20_000;
const MATERIALIZATION_FINALIZATION_CHECKPOINT_RESERVE_MS = 3_000;
const MATERIALIZATION_FINALIZATION_INFERRED_RANGE_MAX = 64;
const MATERIALIZATION_FINALIZATION_LEGACY_INFERENCE_MAX_PROJECTION_VERSION = 5;
const MATERIALIZATION_FINALIZATION_COVERAGE_VERSION = 2;
const MATERIALIZATION_FINALIZATION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;
const MATERIALIZATION_FINALIZATION_INTERNAL_FAILURE_LIMIT = 6;
const RECOVERY_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

function retryAfterDelayMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(RECOVERY_MAX_RETRY_AFTER_MS, Math.ceil(delay)) : undefined;
}

function isTransientRecoveryFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError"
    || error.name === "TimeoutError"
    || /dropbox_request_timeout|fetch failed|network (?:error|failure|unavailable)|timed? out|\bECONN(?:RESET|REFUSED|TIMEDOUT)\b|\bEAI_AGAIN\b|\bENOTFOUND\b/i.test(error.message)
  );
}

interface MaterializationFinalizationCandidate {
  revision: number;
  coverage: "explicit" | "canonical_range";
  materialization_revision: number;
  projection_version: number;
  result_root_hash: string;
  completed_at: string;
  source_event_id: string | null;
}

interface MaterializationFinalizationWork {
  coverage_version: number;
  head: {
    target_revision: number;
    projection_version: number;
    result_root_hash: string;
    completed_at: string;
  };
  next_generation: { target_revision: number; projection_version: number } | null;
  previous_child: { target_revision: number; projection_version: number; chain_depth: number } | null;
  scan_complete: boolean;
  candidates: MaterializationFinalizationCandidate[];
  uncovered_ranges?: Array<{ from_revision: number; to_revision: number }>;
  legacy_range_cursor?: LegacyRangeVerificationCursor | null;
}

interface LegacyRangeVerificationCursor {
  materialization_revision: number;
  projection_version: number;
  result_root_hash: string;
  completed_at: string;
  source_event_id: string | null;
  parent_revision: number;
  next_revision: number;
  verified: boolean;
}

interface MaterializationFinalizationRequest {
  target_revision: number;
  projection_version: number;
}

interface ContextReadCheckpoint {
  schema_version: "1.0";
  project_id: string;
  revision: number;
  event_id: string | null;
  state_sha256: string;
}

const CONTEXT_READ_CHECKPOINT_KEY = "project-guard-canonical-context-checkpoint-v1";

class RuleAdmissionRejection extends Error {
  constructor(readonly evaluation: EvaluationResult) {
    super(evaluation.code);
  }
}

interface AdmissionProof {
  project_id: string;
  operation: string;
  resources: NormalizedAdmissionOperation["resources"];
  resource_effect_scopes?: ExecutionAdmission["resource_effect_scopes"];
  diagnosed_drift_refs?: string[];
  request_hash: string;
  actor: { actor_id: string; authority: string };
  global_revision: number;
  project_revision: number;
  ruleset: EvaluationResult["ruleset"];
  verdict: EvaluationResult["verdict"];
  results: EvaluationResult["results"];
  gaps: EvaluationResult["gaps"];
  deferred_rules: EvaluationResult["deferred_rules"];
}

export class ProjectGuard extends DurableObject<Env> {
  protected repairEvidenceResolver: RepairEvidenceResolver = unavailableRepairEvidence;
  protected executionAdapterResolver: (admission: ExecutionAdmission) => Promise<ExecutionAdapter | null> = async () => null;
  protected executionPlanResolver: (admission: ExecutionAdmission) => Promise<ExecutionPlan | null> = async () => null;
  protected ruleQualificationResolver: RuleQualificationEvidenceResolver = unavailableQualificationResolver;
  protected readonly persistence: ProjectOsPersistenceRuntime;
  private readonly repository: ProjectRepository;
  private readonly managedDocumentService: ManagedDocumentService;
  private readonly managedDocumentChanges: ManagedDocumentChangeCoordinator;
  private readonly managedDocumentRequests: ManagedDocumentRequestLedger;
  private readonly transactionRequests: TransactionRequestLedger;
  protected readonly layoutMode: LayoutMode;
  private queue: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  /** One fresh canonical read is shared by concurrent callers. This prevents a
   * second legitimate request from being rejected while the first is verifying
   * the same Dropbox state. */
  private contextReadPending: Promise<ProjectState | null> | null = null;
  /** In-memory provenance only. It is intentionally lost on DO eviction; a
   * later instance must prove the cached state against its exact commit again. */
  private contextVerifiedState: ProjectState | null = null;
  private contextCheckpointWriteQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transaction_intents (
        transaction_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_requests (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_requests (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_recovery (
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL,
        PRIMARY KEY (kind, request_id)
      );
      CREATE TABLE IF NOT EXISTS request_recovery_payload (
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        PRIMARY KEY (kind, request_id)
      );
      CREATE TABLE IF NOT EXISTS request_recovery_failures (
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        count INTEGER NOT NULL,
        stopped INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        PRIMARY KEY (kind, request_id)
      );
      CREATE TABLE IF NOT EXISTS request_recovery_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS navigation_refresh_outbox (
        zone TEXT NOT NULL,
        source_generation INTEGER NOT NULL,
        request_json TEXT,
        PRIMARY KEY (zone, source_generation)
      );
      CREATE TABLE IF NOT EXISTS navigation_refresh_scan (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        requested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transaction_recovery_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        request_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_floor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        strict INTEGER NOT NULL CHECK (strict = 1)
      );
      CREATE TABLE IF NOT EXISTS admission_proofs (
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        PRIMARY KEY (kind, request_id)
      );
    `);
    this.layoutMode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    this.persistence = createProductionPersistence(env);
    this.ruleQualificationResolver = createProductionRuleQualificationResolver(this.persistence, env);
    this.repository = new ProjectRepository(this.persistence, this.layoutMode);
    this.managedDocumentService = new ManagedDocumentService(this.persistence);
    this.managedDocumentChanges = new ManagedDocumentChangeCoordinator(
      this.persistence,
      this.ctx.storage,
      parseMutationGateMode(env.PROJECT_OS_MUTATION_GATE_MODE),
      async (state, operation, findingId) => {
        if (!await this.ruleAdmissionRequired(state, operation)) return;
        await this.persistAdmissionProof("document-drift", findingId, await this.admitRules(state, operation));
      },
      (projectId, zone, resourceId) => this.recordObservedNavigationSourceMutation(projectId, zone, resourceId)
    );
    this.managedDocumentRequests = new ManagedDocumentRequestLedger(this.persistence.objects);
    this.transactionRequests = new TransactionRequestLedger(this.persistence.objects);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "POST" && pathname === "/artifact") {
      return this.serialize(() => this.handleArtifact(request)).catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "POST" && pathname === "/document") {
      return this.serialize(() => this.handleManagedDocument(request)).catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "GET" && pathname === "/document-status") {
      return this.serialize(() => this.handleManagedDocumentStatus(url));
    }

    if (request.method === "GET" && pathname === "/execution-status") {
      const projectId = this.ctx.id.name;
      const kind = url.searchParams.get("kind");
      const requestId = url.searchParams.get("request_id");
      if (!projectId || !requestId || !kind) {
        return Response.json({ error: "execution_identity_required" }, { status: 400 });
      }
      if (!["transaction", "document", "artifact", "recovery"].includes(kind)) {
        return Response.json({ error: "execution_kind_invalid" }, { status: 400 });
      }
      if (this.queueDepth > 0) {
        const correlationId = this.observationCorrelationId(request, url);
        return ["transaction", "document", "artifact"].includes(kind)
          ? this.unknownObservationResponse(projectId, kind, requestId, correlationId, "PROJECT_OS_READ_BUSY")
          : Response.json({ project_id: projectId, kind, request_id: requestId, status: "unknown", code: "PROJECT_OS_READ_BUSY", correlation_id: correlationId }, { status: 503 });
      }
      return this.readWhenIdle(async () => {
        const journal = new ExecutionJournal(this.persistence, projectId, kind, requestId);
        const status = await journal.status();
        return status ? Response.json(status) : Response.json({ error: "execution_not_found" }, { status: 404 });
      }).catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "GET" && pathname === "/request-status") {
      const projectId = this.ctx.id.name;
      const kind = url.searchParams.get("kind");
      const requestId = url.searchParams.get("request_id");
      if (!projectId || !kind || !requestId || !["transaction", "document", "artifact"].includes(kind)) {
        return Response.json({ error: "request_identity_required" }, { status: 400 });
      }
      if (url.searchParams.has("project_id") && url.searchParams.get("project_id") !== projectId) {
        return Response.json({ error: "request_identity_mismatch" }, { status: 404 });
      }
      const correlationId = this.observationCorrelationId(request, url);
      if (this.queueDepth > 0) {
        return this.readFinalizedRequestStatusWhileBusy(url, projectId, kind, requestId, correlationId);
      }
      return this.readWhenIdle(() => this.readBoundedRequestStatus(url, correlationId));
    }

    if (request.method === "POST" && pathname === "/finalize-materialization") {
      return this.serialize(() => this.finalizeCurrentMaterialization(request))
        .catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "POST" && pathname === "/reconcile-documents") {
      return this.serialize(async () => {
        const state = await this.loadOrRecoverState();
        if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
        // A supplied body is always a typed repair request.  It must not be
        // ignored merely because this project is still in the legacy rollout:
        // repair authorization is bound to the signed intent and exact
        // server-side diagnosis below.
        if (request.body && url.searchParams.get("scheduled") !== "1") {
          return this.handleTypedRepair(request, state);
        }
        const scheduled = url.searchParams.get("scheduled") === "1";
        const normalized = await normalizeSystemAdmission(
          state.project_id,
          scheduled ? "project.materialize" : "project.repair",
          "DOCUMENTS",
          `document-reconcile@${state.revision}`,
          String(state.revision)
        );
        if (await this.ruleAdmissionRequired(state, normalized)) {
          const proof = await this.admitRules(state, normalized);
          await this.persistAdmissionProof("document-reconcile", `document-reconcile@${state.revision}`, proof);
        }
        // The coordinator may write several canonical heads before its
        // durable cursor is advanced. Keep a wake armed across that boundary;
        // the alarm discovers any dirty marker whose SQL outbox write was
        // interrupted.
        this.ctx.storage.sql.exec(
          "INSERT INTO navigation_refresh_scan (singleton, requested_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
          new Date().toISOString()
        );
        await this.armRequestRecoveryAlarm(1_000);
        const result = await this.managedDocumentChanges.reconcile(state, {
          scheduled: url.searchParams.get("scheduled") === "1"
        });
        await this.enqueueNavigationRefreshForDirtyZones(state.project_id);
        this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_scan WHERE singleton = 1");
        return Response.json(result);
      }).catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "GET" && pathname === "/materialization-status") {
      return this.forwardMaterializationRequest(request, "/status");
    }

    if (request.method === "GET" && pathname === "/materialization-diagnostic-status") {
      return this.forwardMaterializationRequest(request, "/diagnostic-status");
    }

    if (request.method === "POST" && pathname === "/reconcile-materialization") {
      return this.handleMaterializationMutation(request, "/reconcile", "project.repair");
    }

    if (request.method === "POST" && pathname === "/scheduled-reconcile-materialization") {
      return this.handleMaterializationMutation(request, "/reconcile", "project.materialize", true);
    }

    if (request.method === "POST" && pathname === "/materialize") {
      return this.handleMaterializationMutation(request, "/materialize", "project.materialize");
    }

    if (request.method === "GET" && pathname === "/mutation-context") {
      return this.handleMutationContextRead(request);
    }

    if (request.method === "GET" && pathname === "/receipt") {
      const url = new URL(request.url);
      const projectId = this.ctx.id.name;
      const kind = url.searchParams.get("kind");
      const requestId = url.searchParams.get("request_id");
      if (!projectId || !requestId || !kind || !["transaction", "document", "artifact"].includes(kind)) {
        return this.handleReceiptRead(url);
      }
      const correlationId = this.observationCorrelationId(request, url);
      if (url.searchParams.has("project_id") && url.searchParams.get("project_id") !== projectId) {
        return Response.json({ error: "receipt_not_found" }, { status: 404 });
      }
      const localReceipt = await this.handleReceiptRead(url);
      if (localReceipt.status !== 404) return localReceipt;
      if (this.queueDepth > 0) {
        try {
          const canonicalReceipt = await this.readBoundedRequestStatusReceipt(projectId, kind as RequestKind, requestId);
          if (canonicalReceipt) return Response.json(canonicalReceipt);
        } catch {
          return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "PROJECT_OS_READ_BUSY");
        }
        return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "PROJECT_OS_READ_BUSY");
      }
      return this.readWhenIdle(async () => {
        const recheckedLocal = await this.handleReceiptRead(url);
        if (recheckedLocal.status !== 404) return recheckedLocal;
        try {
          const canonicalReceipt = await this.readBoundedRequestStatusReceipt(projectId, kind as RequestKind, requestId);
          if (canonicalReceipt) return Response.json(canonicalReceipt);
          return Response.json({ error: "receipt_not_found" }, { status: 404 });
        } catch {
          return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "canonical_receipt_unavailable");
        }
      });
    }

    if (request.method !== "POST" || pathname !== "/transaction") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return this.serialize(async () => {
      let tx: Transaction;
      let mutationContext: MutationContext | null;
      try {
        const admission = decodeAdmission(await request.json(), parseTransaction);
        tx = admission.request;
        mutationContext = admission.mutation_context;
      } catch (error) {
        if (error instanceof AdmissionError) throw error;
        return Response.json({
          error: "invalid_transaction",
          message: error instanceof Error ? error.message : "Invalid transaction"
        }, { status: 400 });
      }

      const existing = this.findReceipt(tx.transaction_id);
      if (existing) {
        await this.verifyCommittedReplayPayload(tx, existing);
        await this.replayStatusSideEffects(tx, existing);
        await this.clearTransactionRecovery(tx.transaction_id);
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

      let reconciledState: ProjectState | null = null;
      if (this.layoutMode === "v2") {
        reconciledState = await this.reconcileCanonicalCommits(mutationContext?.state_hash);
        const reconciled = this.findReceipt(tx.transaction_id);
        if (reconciled) {
          await this.verifyCommittedReplayPayload(tx, reconciled);
          await this.replayStatusSideEffects(tx, reconciled);
          await this.clearTransactionRecovery(tx.transaction_id);
          return Response.json(reconciled);
        }
      }

      const canonicalReceipt = await this.repository.readReceipt(tx.transaction_id);
      if (canonicalReceipt) {
        if (canonicalReceipt.project_id !== tx.project_id) {
          throw new Error(`Canonical receipt project binding mismatch for ${tx.transaction_id}`);
        }
        await this.verifyCommittedReplayPayload(tx, canonicalReceipt);
        this.persistReceipt(canonicalReceipt);
        await this.replayStatusSideEffects(tx, canonicalReceipt);
        await this.clearTransactionRecovery(tx.transaction_id);
        return Response.json(canonicalReceipt);
      }

      const admissionState = reconciledState ?? await this.loadOrRecoverState();
      const normalized = await normalizeTransactionAdmission(tx);
      if (!admissionState && this.strictAdmissionEnabled(tx.project_id)) throw new AdmissionError("canonical_unavailable", 503);
      let proof: AdmissionProof | null = null;
      if (admissionState && await this.ruleAdmissionRequired(admissionState, normalized)) {
        await this.verifyAdmission(mutationContext, tx, admissionState);
        proof = await this.admitRules(admissionState, normalized, mutationContext!.actor);
      }

      // Capacity refusal is pre-admission: it must not reserve an idempotency
      // intent that can serialize or conflict with otherwise independent work.
      await this.assertCommitCapacity(tx.project_id);

      // Bind exact, server-admitted bytes before the journal can describe an
      // admission. An interrupted provider write leaves an alarm, not a
      // receipt-shaped progress record without any replayable request.
      await this.enqueueRequestRecovery("transaction", tx.transaction_id, canonicalJson({ request: tx, actor: proof?.actor ?? null }));
      try {
        await this.transactionRequests.ensureTransactionRequest(tx.project_id, tx, proof?.actor);
      } catch (error) {
        if (error instanceof Error && error.message === "idempotency_payload_mismatch") throw new AdmissionError(error.message, 409);
        throw error;
      }
      if (proof) await this.persistAdmissionProof("transaction", tx.transaction_id, proof);

      // A refused strict admission must not reserve an idempotency key.  Only
      // bind this intent after the verified permit and second rules evaluation.
      await this.ensureTransactionIntent(tx);

      const state = this.layoutMode === "v2"
        ? reconciledState
        : await this.loadOrRecoverState();
      let localRuleActivation: LocalRuleActivationCapability | undefined;
      if (tx.operation === "rule.activate" && state) {
        try {
          localRuleActivation = await prepareLocalRuleActivation(state, tx, this.ruleQualificationResolver, new Date().toISOString());
        } catch (error) {
          const code = error instanceof Error ? error.message : "LOCAL_RULE_QUALIFICATION_UNAVAILABLE";
          return Response.json({ error: code }, { status: code.endsWith("MISMATCH") ? 409 : 503 });
        }
      }
      const result = applyTransaction(state, tx, { localRuleActivation });

      if (result.kind === "rejected" || result.kind === "conflict") {
        const receipt = this.terminalReceipt(tx, result.kind, result.code, result.message, state?.revision ?? 0);
        await this.repository.writeTerminalTransaction(tx, receipt);
        this.persistReceipt(receipt);
        await this.clearTransactionRecovery(tx.transaction_id);
        return Response.json(receipt);
      }

      const previousRevision = state?.revision ?? 0;
      const receipt: CanonicalCommitRecord["receipt"] = {
        schema_version: "1.0",
        transaction_id: tx.transaction_id,
        status: "committed",
        project_id: tx.project_id,
        previous_revision: previousRevision,
        new_revision: result.state.revision,
        event_id: result.event.event_id,
        committed_at: tx.created_at
      };

      if (this.layoutMode === "v2") {
        const record: CanonicalCommitRecord = {
          schema_version: "1.0",
          project_id: tx.project_id,
          previous_revision: previousRevision,
          new_revision: result.state.revision,
          transaction: tx,
          state: result.state,
          event: result.event,
          receipt
        };
        await this.repository.writeCommitRecord(record);
        this.persistCommit(result.state, receipt);
        await this.requestMaterializationSafely(result.state.revision);
      } else {
        await this.repository.writeCommit(result.state, result.event, receipt, {
          publishReceipt: tx.operation !== "project.create"
        });
        this.persistCommit(result.state, receipt);
      }

      if (PROJECT_STATUS_OPERATIONS.has(tx.operation)) {
        await this.syncRegistryStatus(result.state);
      }
      await this.recordTransactionExecutionReceipt(tx, receipt);
      await this.clearTransactionRecovery(tx.transaction_id);
      return Response.json(receipt);
    }).catch((error) => this.admissionErrorResponse(error));
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      await this.resumePendingRequestRecovery();
      await this.resumePendingNavigationRefreshes();
      await this.resumePendingMaterializationFinalization();
    });
    // Transaction replay must enter the normal serialized admission path, so
    // it runs after the document/artifact recovery lock has been released.
    await this.resumePendingTransactionRecovery();
  }

  private async handleArtifact(request: Request): Promise<Response> {
    let artifact: ArtifactWriteRequest;
    let mutationContext: MutationContext | null;
    try {
      const admission = decodeAdmission(await request.json(), parseArtifactWriteRequest);
      artifact = admission.request;
      mutationContext = admission.mutation_context;
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
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
      const existingReceipt = JSON.parse(existing.receipt_json) as ArtifactWriteReceipt;
      if (existingReceipt.status === "committed") return this.finalizeArtifact(artifact, existingReceipt);
      return Response.json(existingReceipt);
    }

    if (isReviewCandidate(artifact)) {
      try {
        const terminal = await this.repository.reviewJournal.terminal(artifact);
        if (terminal) return this.finalizeArtifact(artifact, terminal);
      } catch (error) {
        if (error instanceof MutationIntentConflictError) return Response.json(this.artifactReceipt(artifact, "rejected", "IDEMPOTENCY_PAYLOAD_MISMATCH", "Request ID already has different terminal evidence"));
        throw error;
      }
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

    const normalized = await normalizeArtifactAdmission(artifact, state);
    const strictRules = await this.ruleAdmissionRequired(state, normalized);
    // The legacy review capability is only a pre-activation rollout channel.
    // Once a canonical rule applies (or the project is floored), its signed
    // admission is the governing authorization; an old env mode cannot veto
    // or substitute for that rule.
    if (isReviewCandidate(artifact) && !strictRules) {
      if (this.env.PROJECT_OS_LAYOUT_MODE !== "v2" || this.env.PROJECT_OS_MUTATION_GATE_MODE !== "enforce") {
        return Response.json(this.artifactReceipt(artifact, "rejected", "REVIEW_GOVERNANCE_REQUIRED", "Review requires V2 layout and enforced MutationGate before rule activation"));
      }
      const violation = binaryArtifactPolicyViolation(this.env, artifact);
      if (violation) return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "rejected", violation.code, violation.message));
    }
    await this.verifyEffectAdmission(mutationContext, artifact.project_id, state, strictRules);
    if (strictRules) {
      const proof = await this.admitRules(state, normalized, mutationContext!.actor);
      if (isReviewCandidate(artifact) && proof.ruleset.rules.length === 0) {
        return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "rejected", "REVIEW_CANDIDATE_DISABLED", "Review candidate ingress requires an applicable active canonical rule"));
      }
      await this.persistAdmissionProof("artifact", artifact.request_id, proof);
    }

    if (!isStagedArtifactWriteRequest(artifact) && await sha256Hex(artifact.content) !== artifact.content_sha256) {
      return this.finalizeArtifact(
        artifact,
        this.artifactReceipt(artifact, "rejected", "CONTENT_HASH_MISMATCH", "content_sha256 does not match artifact content")
      );
    }

    try {
      // Staged artifacts have no document head to fence. If the canonical
      // destination belongs to an adopted navigation zone, persist its
      // in-flight source marker before the destination/binding can change.
      await this.beginArtifactNavigationSource(state, artifact);
      await this.repository.writeArtifact(state, artifact, undefined, undefined, isReviewCandidate(artifact) ? () => {
        if (!strictRules && binaryArtifactPolicyViolation(this.env, artifact)) throw new ReviewCapabilityExpiredError();
      } : undefined);
    } catch (error) {
      if (error instanceof ReviewCapabilityExpiredError) {
        return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "rejected", "REVIEW_CAPABILITY_DENIED", error.message));
      }
      if (error instanceof ReviewCandidateRevisionError) {
        return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "conflict", "BASE_REVISION_CONFLICT", error.message));
      }
      if (error instanceof ArtifactContentConflictError || error instanceof StagedArtifactConflictError) {
        return this.finalizeArtifact(
          artifact,
          this.artifactReceipt(artifact, "conflict", "ARTIFACT_CONTENT_CONFLICT", error.message)
        );
      }
      if (error instanceof StagedArtifactSourceMismatchError) {
        return this.finalizeArtifact(
          artifact,
          this.artifactReceipt(artifact, "rejected", "ARTIFACT_EVIDENCE_MISMATCH", error.message)
        );
      }
      if (error instanceof MutationIntentConflictError) {
        return Response.json(
          this.artifactReceipt(artifact, "conflict", "ARTIFACT_INTENT_CONFLICT", error.message)
        );
      }
      throw error;
    }

    const committed = this.artifactReceipt(artifact, "committed");
    if (isReviewCandidate(artifact)) committed.final_observation = await this.repository.reviewCandidateObservation(state, artifact);
    return this.finalizeArtifact(artifact, committed);
  }

  private async handleManagedDocument(request: Request): Promise<Response> {
    let operation: ManagedDocumentRequest;
    let mutationContext: MutationContext | null;
    try {
      const admission = decodeAdmission(await request.json(), parseManagedDocumentRequest);
      operation = admission.request;
      mutationContext = admission.mutation_context;
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      return Response.json({
        error: "invalid_document_request",
        message: error instanceof Error ? error.message : "Invalid managed document request"
      }, { status: 400 });
    }

    const serialized = JSON.stringify(operation);
    const existing = this.findDocumentRequest(operation.request_id);
    if (existing) {
      if (existing.request_json !== serialized) {
        return Response.json(this.documentTerminalReceipt(
          operation,
          "rejected",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "The same request_id was reused with a different managed-document payload"
        ));
      }
      const cached = JSON.parse(existing.receipt_json) as ManagedDocumentOperationReceipt;
      if (operation.operation === "navigation.reconcile") {
        await this.settleNavigationReceipt(operation, cached as NavigationDocumentReceipt);
        return Response.json(await this.currentNavigationReceipt(operation, cached as NavigationDocumentReceipt));
      }
      return Response.json(cached);
    }

    if (this.ctx.id.name && this.ctx.id.name !== operation.project_id) {
      return Response.json(this.documentTerminalReceipt(
        operation,
        "rejected",
        "PROJECT_BINDING_MISMATCH",
        "Durable Object binding does not match managed document project_id"
      ));
    }

    if (operation.operation === "navigation.reconcile") {
      return this.handleNavigationReconcile(operation, mutationContext);
    }

    const state = await this.loadOrRecoverState();
    if (!state) {
      return Response.json(this.documentTerminalReceipt(
        operation,
        "rejected",
        "PROJECT_NOT_INITIALIZED",
        "Project state is not initialized"
      ));
    }

    const normalized = await normalizeDocumentAdmission(operation);
    const rulesRequired = await this.ruleAdmissionRequired(state, normalized);
    await this.verifyEffectAdmission(mutationContext, operation.project_id, state, rulesRequired);
    if (operation.operation === "package.freeze" || operation.operation === "package.replace") {
      if (!this.strictAdmissionEnabled(operation.project_id) || !mutationContext) return Response.json({ request_id: operation.request_id, project_id: operation.project_id, status: "rejected", code: "PACKAGE_GOVERNANCE_REQUIRED" });
      if (operation.expected_project_revision !== state.revision) return Response.json({ status: "conflict", code: "PACKAGE_PROJECT_REVISION_CONFLICT" });
      const digest = await sha256Text(serialized);
      const existingIntent = await this.managedDocumentRequests.readIntent(operation.project_id, operation.request_id);
      const stagedRequest = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_sha256: string }>(
        "SELECT request_sha256 FROM request_recovery_payload WHERE kind = ? AND request_id = ?", "document", operation.request_id
      ).toArray()[0];
      if ((existingIntent && existingIntent.request_sha256 !== digest) || (stagedRequest && stagedRequest.request_sha256 !== digest)) {
        return Response.json(this.documentTerminalReceipt(operation, "rejected", "IDEMPOTENCY_PAYLOAD_MISMATCH", "The same request_id was reused with a different managed-document payload"));
      }
      const existingProof = await this.readPackageAdmissionProof(operation);
      const proof = existingProof ?? await this.admitRules(state, normalized, mutationContext.actor);
      if (!existingProof) await this.persistAdmissionProof(operation.operation === "package.freeze" ? "document" : "package-admission", operation.request_id, proof);
      try {
        await this.enqueueRequestRecovery("document", operation.request_id, serialized);
      } catch (error) {
        if (error instanceof ManagedDocumentRequestIntentConflictError) {
          return Response.json(this.documentTerminalReceipt(operation, "rejected", "IDEMPOTENCY_PAYLOAD_MISMATCH", "The same request_id was reused with a different managed-document payload"));
        }
        throw error;
      }
      try {
        await this.managedDocumentRequests.ensureIntent(operation.project_id, operation.request_id, serialized);
      } catch (error) {
        if (error instanceof ManagedDocumentRequestIntentConflictError) {
          return Response.json(this.documentTerminalReceipt(
            operation,
            "rejected",
            "IDEMPOTENCY_PAYLOAD_MISMATCH",
            "The same request_id was reused with a different managed-document payload"
          ));
        }
        await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
        return Response.json({ request_id: operation.request_id, project_id: operation.project_id, status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED" }, { status: 503 });
      }
      const durable = await this.managedDocumentRequests.readReceipt(operation.project_id, operation.request_id);
      if (durable) {
        this.clearRequestRecovery("document", operation.request_id);
        return Response.json(JSON.parse(durable.receipt_json));
      }
      try {
        return Response.json(await this.resumePackageManagedDocument(operation));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("package_")) {
          return Response.json(await this.finalizePackageDocument(operation, {
            request_id: operation.request_id,
            project_id: operation.project_id,
            status: "conflict",
            code: error.message
          }));
        }
        // The complete request and its server-owned admission proof exist
        // before package effects begin. A transient provider failure therefore
        // resumes automatically from the same package request and never asks
        // a founder to submit or validate it again.
        await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
        return Response.json({
          request_id: operation.request_id,
          project_id: operation.project_id,
          status: "pending",
          code: "DOCUMENT_RECOVERY_SCHEDULED"
        }, { status: 503 });
      }
    }
    if (rulesRequired) await this.persistAdmissionProof("document", operation.request_id, await this.admitRules(state, normalized, mutationContext!.actor));

    try {
      await this.enqueueRequestRecovery("document", operation.request_id, serialized);
    } catch (error) {
      if (error instanceof ManagedDocumentRequestIntentConflictError) {
        return Response.json(this.documentTerminalReceipt(operation, "rejected", "IDEMPOTENCY_PAYLOAD_MISMATCH", "The same request_id was reused with a different managed-document payload"));
      }
      throw error;
    }

    try {
      await this.managedDocumentRequests.ensureIntent(operation.project_id, operation.request_id, serialized);
    } catch (error) {
      if (error instanceof ManagedDocumentRequestIntentConflictError) {
        return Response.json(this.documentTerminalReceipt(
          operation,
          "rejected",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "The same request_id was reused with a different managed-document payload"
        ));
      }
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({ request_id: operation.request_id, project_id: operation.project_id, status: "pending", code: "DOCUMENT_RECOVERY_SCHEDULED" }, { status: 503 });
    }

    const durableReceipt = await this.managedDocumentRequests.readReceipt(operation.project_id, operation.request_id);
    if (durableReceipt) {
      const receipt = JSON.parse(durableReceipt.receipt_json) as ManagedDocumentOperationReceipt;
      await this.settleDocumentReceipt(operation, receipt);
      return Response.json(receipt);
    }

    // This is written after admission and before the provider effect. It is
    // therefore safe to resume exactly this immutable request after a Worker
    // interruption, without asking a chat to submit or approve it again.
    try {
      const receipt = await this.executeManagedDocument(operation, state);
      return await this.finalizeDocument(operation, receipt);
    } catch (error) {
      if (error instanceof ManagedDocumentConflictError) {
        return this.finalizeDocument(
          operation,
          this.documentTerminalReceipt(operation, "conflict", error.code, error.message, error.documentId)
        );
      }
      if (error instanceof Error && error.message.startsWith("Managed document content SHA-256 mismatch:")) {
        return this.finalizeDocument(
          operation,
          this.documentTerminalReceipt(operation, "rejected", "CONTENT_HASH_MISMATCH", error.message)
        );
      }
      // The intent and wake signal were persisted before the provider effect.
      // Return an explicit temporary state so Durable Object storage commits;
      // throwing here would roll back the wake signal and force a caller to
      // recreate the same request manually.
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({
        request_id: operation.request_id,
        project_id: operation.project_id,
        status: "pending",
        code: "DOCUMENT_RECOVERY_SCHEDULED"
      }, { status: 503 });
    }
  }

  private async handleManagedDocumentStatus(url: URL): Promise<Response> {
    const documentId = url.searchParams.get("document_id");
    if (!documentId || !/^DOC-[A-F0-9]{24}$/.test(documentId)) {
      return Response.json({ error: "invalid_document_id" }, { status: 400 });
    }
    const state = await this.loadOrRecoverState();
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const head = await this.managedDocumentService.status(state.project_id, documentId);
    if (!head) return Response.json({ error: "document_not_found" }, { status: 404 });
    const { provider: _provider, ...logical } = head;
    return Response.json(logical);
  }

  private async handleNavigationReconcile(request: NavigationReconcileRequest, mutationContext: MutationContext | null): Promise<Response> {
    if (!this.strictAdmissionEnabled(request.project_id)) {
      return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "rejected", code: "NAVIGATION_GOVERNANCE_REQUIRED" });
    }
    const requestHash = await sha256Canonical(request);
    const journal = new ExecutionJournal(this.persistence, request.project_id, "document", request.request_id);
    let existingAdmission = await journal.readAdmission();
    let frozenState: ProjectState;

    if (existingAdmission) {
      if (existingAdmission.admission.operation !== request.operation || existingAdmission.admission.kind !== "document"
        || existingAdmission.admission.project_id !== request.project_id || existingAdmission.admission.request_id !== request.request_id
        || existingAdmission.admission.request_hash !== requestHash || existingAdmission.plan !== null) {
        return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "conflict", code: "NAVIGATION_ADMISSION_BINDING_MISMATCH" }, { status: 409 });
      }
      // Revalidate the immutable journal envelope and recover only a torn
      // navigation admission/progress boundary before the engine's intent.
      await journal.commit(existingAdmission.admission, null);
      frozenState = await this.readFrozenNavigationState(request, requestHash);
    } else {
      const current = await this.loadOrRecoverState();
      if (!current) return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "rejected", code: "PROJECT_NOT_INITIALIZED" });
      if (request.expected_project_revision !== current.revision) {
        return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "conflict", code: "NAVIGATION_PROJECT_REVISION_CONFLICT" }, { status: 409 });
      }
      if (!mutationContext) return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "rejected", code: "NAVIGATION_GOVERNANCE_REQUIRED" });
      await this.verifyEffectAdmission(mutationContext, request.project_id, current, true);
      const normalized = await normalizeDocumentAdmission(request);
      const proof = await this.admitRules(current, normalized, mutationContext.actor);
      const indexPath = `${workspaceProjectRoot(current.project_id, current.slug)}/${request.zone}/${request.expected_index?.basename ?? "00-CURRENT.md"}`;
      const resourceId = `navigation:${request.zone}`;
      const preservationPath = request.expected_index
        ? `${workspaceProjectRoot(current.project_id, current.slug)}/ARCHIVES/NAVIGATION/${request.zone}/${request.expected_generation + 1}-${request.expected_index.content_sha256}.md`
        : null;
      proof.resource_effect_scopes = [{
        resource_id: resourceId,
        resource_version: String(request.expected_generation),
        provider_id: this.persistence.providerId,
        sources: request.expected_index ? [{ path: indexPath, logical_path: `${request.zone}/${request.expected_index.basename}` }] : [],
        destinations: [{ path: indexPath, logical_path: `${request.zone}/${request.expected_index?.basename ?? "00-CURRENT.md"}` }],
        preservation_copies: preservationPath ? [{ path: preservationPath, logical_path: `ARCHIVES/NAVIGATION/${request.zone}/${request.expected_generation + 1}-${request.expected_index!.content_sha256}.md` }] : []
      }];
      frozenState = current;
      await this.writeFrozenNavigationState(request, requestHash, frozenState);
      await this.persistAdmissionProof("document", request.request_id, proof);
      existingAdmission = await journal.readAdmission();
      if (!existingAdmission) throw new Error("execution_admission_unavailable");
    }

    await this.enqueueRequestRecovery("document", request.request_id, JSON.stringify(request));
    try {
      await this.managedDocumentRequests.ensureIntent(request.project_id, request.request_id, JSON.stringify(request));
    } catch (error) {
      if (error instanceof ManagedDocumentRequestIntentConflictError) {
        return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "conflict", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" }, { status: 409 });
      }
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "pending", code: "NAVIGATION_RECOVERY_SCHEDULED" }, { status: 503 });
    }
    const durable = await this.managedDocumentRequests.readReceipt(request.project_id, request.request_id);
    if (durable) {
      const receipt = JSON.parse(durable.receipt_json) as NavigationDocumentReceipt;
      await this.settleNavigationReceipt(request, receipt);
      return Response.json(await this.currentNavigationReceipt(request, receipt));
    }
    return this.executeNavigationSlice(request, frozenState, existingAdmission.admission as ExecutionAdmission);
  }

  private async executeNavigationSlice(request: NavigationReconcileRequest, state: ProjectState, admission: ExecutionAdmission): Promise<Response> {
    const budget = createSliceBudget(() => Date.now(), new AbortController().signal);
    const sources = new ZoneNavigationSources(this.persistence);
    let adoptionStarted = false;
    const sourceState = await sources.readState(request.project_id, request.zone, budget);
    if (!sourceState.adopted) {
      adoptionStarted = true;
      if (!await sources.beginAdoption(request.project_id, request.zone, request.request_id, sourceState.generation, budget)) {
        await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
        return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "pending", code: "NAVIGATION_ADOPTION_PENDING" }, { status: 503 });
      }
    }
    const inventory = new ZoneNavigationInventory(this.persistence, sources);
    const result = await new ZoneNavigationEngine(this.persistence, inventory).reconcile(request, state, admission, budget);
    if (result.status === "pending") {
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "pending", code: "NAVIGATION_REFRESH_PENDING", cursor: result.cursor }, { status: 503 });
    }
    if (result.status === "conflict") {
      if (adoptionStarted && result.code === "navigation_listing_stalled") {
        await sources.abortAdoption(request.project_id, request.zone, request.request_id, sourceState.generation);
      }
      const receipt: NavigationDocumentReceipt = { operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "conflict", execution_status: "conflict", code: result.code };
      await this.managedDocumentRequests.writeReceipt(request.project_id, request.request_id, JSON.stringify(request), JSON.stringify(receipt));
      await this.settleNavigationReceipt(request, receipt);
      return Response.json(receipt, { status: 409 });
    }
    if (adoptionStarted && budget.calls_left >= 5) {
      if (!await sources.finishAdoption(request.project_id, request.zone, request.request_id, sourceState.generation, budget)) {
        await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
        return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "pending", code: "NAVIGATION_ADOPTION_PENDING" }, { status: 503 });
      }
    } else if (adoptionStarted) {
      // Leave the alarm armed: a fresh slice can settle adoption after the
      // engine's request-local progress short-circuits to its receipt.
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({ operation: request.operation, request_id: request.request_id, project_id: request.project_id, status: "pending", code: "NAVIGATION_ADOPTION_PENDING" }, { status: 503 });
    }
    const receipt: NavigationDocumentReceipt = {
      operation: request.operation, request_id: request.request_id, project_id: request.project_id,
      status: "committed", execution_status: "pending", navigation_receipt: result.receipt
    };
    await this.managedDocumentRequests.writeReceipt(request.project_id, request.request_id, JSON.stringify(request), JSON.stringify(receipt));
    await this.settleNavigationReceipt(request, receipt);
    return Response.json(await this.currentNavigationReceipt(request, receipt));
  }

  private async writeFrozenNavigationState(request: NavigationReconcileRequest, requestHash: string, state: ProjectState): Promise<void> {
    const path = `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/navigation-admitted-state.json`;
    const record = { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, request_hash: requestHash, project_revision: state.revision, state, state_hash: await sha256Canonical(state) };
    const content = canonicalJson(record);
    try { await this.persistence.objects.createText(path, content); }
    catch (error) { if (await this.persistence.objects.readText(path) !== content) throw error; }
  }

  private async readFrozenNavigationState(request: NavigationReconcileRequest, requestHash: string): Promise<ProjectState> {
    const path = `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/navigation-admitted-state.json`;
    const raw = await this.persistence.objects.readText(path);
    if (raw !== null) {
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (record.schema_version !== "1.0" || record.project_id !== request.project_id || record.request_id !== request.request_id
        || record.request_hash !== requestHash || record.project_revision !== request.expected_project_revision
        || !record.state || typeof record.state !== "object" || (record.state as ProjectState).revision !== request.expected_project_revision
        || await sha256Canonical(record.state) !== record.state_hash || canonicalJson(record) !== raw) throw new Error("navigation_admitted_state_invalid");
      return normalizeProjectState(record.state as ProjectState);
    }
    const commit = await this.repository.readCommitRecord(request.project_id, request.expected_project_revision);
    if (commit?.state && commit.state.revision === request.expected_project_revision) {
      await this.writeFrozenNavigationState(request, requestHash, commit.state);
      return commit.state;
    }
    const current = await this.loadOrRecoverState();
    if (current?.revision === request.expected_project_revision) {
      await this.writeFrozenNavigationState(request, requestHash, current);
      return current;
    }
    throw new Error("navigation_admitted_state_unavailable");
  }

  private async settleNavigationReceipt(request: NavigationReconcileRequest, receipt: NavigationDocumentReceipt): Promise<void> {
    this.persistDocumentRequest(request, receipt);
    const receiptPath = `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/receipt.json`;
    const journal = new ExecutionJournal(this.persistence, request.project_id, "document", request.request_id);
    await journal.recordReceipt(receipt.status, receiptPath);
    if (receipt.status === "conflict") {
      this.clearRequestRecovery("document", request.request_id);
      return;
    }
    const navigationReceipt = zoneNavigationReceiptSchema.parse(receipt.navigation_receipt);
    await journal.finalizeVerifiedNavigation({ receipt_ref: receiptPath, receipt: navigationReceipt });
    if ((await journal.status())?.terminal) this.clearRequestRecovery("document", request.request_id);
  }

  private async currentNavigationReceipt(request: NavigationReconcileRequest, receipt: NavigationDocumentReceipt): Promise<NavigationDocumentReceipt> {
    if (receipt.status !== "committed") return receipt;
    const progress = await new ExecutionJournal(this.persistence, request.project_id, "document", request.request_id).status();
    return progress?.terminal && progress.status === "finalized"
      ? { ...receipt, execution_status: "finalized", finalization_ref: progress.finalization_ref }
      : { ...receipt, execution_status: "pending" };
  }

  private async executeManagedDocument(
    request: ManagedDocumentRequest,
    state: ProjectState
  ): Promise<ManagedDocumentReceipt> {
    switch (request.operation) {
      case "navigation.reconcile":
        throw new Error("navigation_governance_dispatch_required");
      case "package.freeze":
      case "package.replace":
        throw new Error("package_governance_dispatch_required");
      case "working.write":
        return this.managedDocumentService.writeWorking(request, state);
      case "review.write":
        return this.managedDocumentService.writeReview(request, state);
      case "review.promote":
        return this.managedDocumentService.promoteToReview(request, state);
      case "publish":
        return this.managedDocumentService.publish(request, state);
      case "review_candidate.promote":
        return this.managedDocumentService.promoteReviewCandidate(request, state);
      case "reopen":
        return this.managedDocumentService.reopenPublished(request, state);
      case "document.archive":
        return this.managedDocumentService.archiveActiveDocument(request, state);
      case "reference.classify":
        return this.managedDocumentService.classifyReference(request, state);
    }
  }

  private async finalizeArtifact(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): Promise<Response> {
    await this.completeArtifactNavigationSource(request);
    if (isReviewCandidate(request)) await this.repository.reviewJournal.recordTerminal(request, receipt);
    // Store the frozen family record and its wake signal *before* the
    // canonical receipt. If a provider acknowledgement is interrupted after
    // the physical artifact exists, the alarm can safely write the same
    // immutable receipt and certify it without replaying the artifact effect.
    this.persistArtifact(request, receipt);
    if (receipt.status === "committed") {
      await this.enqueueRequestRecovery("artifact", request.request_id);
    }
    try {
      await this.repository.writeArtifactReceipt(receipt);
      await this.settleArtifactReceipt(request, receipt);
      if (receipt.status === "committed") await this.repository.cleanupStagedArtifact(request);
      return Response.json(receipt);
    } catch (error) {
      if (receipt.status !== "committed") throw error;
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return Response.json({
        request_id: request.request_id,
        project_id: request.project_id,
        status: "pending",
        code: "ARTIFACT_FINALIZATION_SCHEDULED"
      }, { status: 503 });
    }
  }

  private async artifactNavigationResource(state: ProjectState, request: ArtifactWriteRequest): Promise<{ zone: NavigationZone; resource_id: string } | null> {
    const destination = resolveArtifactDestination(state, request.relative_path, request);
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!destination.path.startsWith(root)) return null;
    const first = destination.path.slice(root.length).split("/")[0];
    if (first !== "WORKING" && first !== "REVIEW" && first !== "DELIVERABLES") return null;
    return { zone: first, resource_id: `artifact:${await sha256Text(destination.path)}` };
  }

  private async beginArtifactNavigationSource(state: ProjectState, request: ArtifactWriteRequest): Promise<void> {
    const resource = await this.artifactNavigationResource(state, request);
    if (!resource) return;
    await new ZoneNavigationSources(this.persistence).beginHeadWrite(
      request.project_id, resource.zone, resource.resource_id, undefined, null
    );
  }

  private async completeArtifactNavigationSource(request: ArtifactWriteRequest): Promise<void> {
    const state = await this.loadOrRecoverState();
    if (!state || state.project_id !== request.project_id) return;
    const resource = await this.artifactNavigationResource(state, request);
    if (!resource) return;
    const sources = new ZoneNavigationSources(this.persistence);
    const sourceState = await sources.readState(request.project_id, resource.zone);
    // beginArtifactNavigationSource is persisted before canonical provider
    // writes. On retry, only finish that exact pending fence; creating a new
    // ticket here would advance generation repeatedly after an interrupted
    // receipt finalization.
    if (!sourceState.in_flight_resource_ids.includes(resource.resource_id)) return;
    const ticket = await sources.beginHeadWrite(request.project_id, resource.zone, resource.resource_id, undefined, null);
    if (!ticket) return;
    await sources.completeHeadWrites([ticket]);
  }

  private async beginPackageNavigationSource(
    operation: Extract<ManagedDocumentRequest, { operation: "package.replace" }>
  ): Promise<void> {
    await new ZoneNavigationSources(this.persistence).beginHeadWrite(
      operation.project_id,
      operation.zone,
      `package:${operation.candidate.package_id}`,
      undefined,
      null
    );
  }

  private async completePackageNavigationSource(
    operation: Extract<ManagedDocumentRequest, { operation: "package.replace" }>
  ): Promise<void> {
    const sources = new ZoneNavigationSources(this.persistence);
    const source = await sources.readState(operation.project_id, operation.zone);
    const resourceId = `package:${operation.candidate.package_id}`;
    if (!source.in_flight_resource_ids.includes(resourceId)) return;
    const ticket = await sources.beginHeadWrite(operation.project_id, operation.zone, resourceId, undefined, null);
    if (!ticket) return;
    await sources.completeHeadWrites([ticket]);
  }

  private async finalizeDocument(
    request: ManagedDocumentRequest,
    receipt: ManagedDocumentOperationReceipt
  ): Promise<Response> {
    const requestJson = JSON.stringify(request);
    const receiptJson = JSON.stringify(receipt);
    await this.managedDocumentRequests.writeReceipt(
      request.project_id,
      request.request_id,
      requestJson,
      receiptJson
    );
    // The family cache must be available before certification. Certification
    // is deliberately a separate retryable step and can now be resumed by the
    // alarm if the initial invocation ends between receipt and certificate.
    await this.settleDocumentReceipt(request, receipt);
    return Response.json(receipt);
  }

  /** Store the response cache before verification, then keep a wake signal
   * until the independent execution certificate has actually become terminal.
   * The alarm never invents a request: it only follows an immutable intent
   * already accepted by this guard. */
  private async settleDocumentReceipt(
    request: ManagedDocumentRequest,
    receipt: ManagedDocumentOperationReceipt
  ): Promise<void> {
    if (request.operation === "navigation.reconcile") {
      await this.settleNavigationReceipt(request, receipt as NavigationDocumentReceipt);
      return;
    }
    this.persistDocumentRequest(request, receipt);
    if (receipt.status === "committed") await this.enqueueNavigationRefreshForDirtyZones(request.project_id);
    if (!this.strictAdmissionEnabled(request.project_id) || receipt.status !== "committed") {
      this.clearRequestRecovery("document", request.request_id);
      return;
    }
    await this.enqueueRequestRecovery("document", request.request_id);
    const journal = new ExecutionJournal(this.persistence, request.project_id, "document", request.request_id);
    await journal.recordReceipt(
      receipt.status,
      `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/receipt.json`
    );
    await this.finalizeVerifiedDocument(journal);
    if ((await journal.status())?.terminal) this.clearRequestRecovery("document", request.request_id);
  }

  private async settleArtifactReceipt(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): Promise<void> {
    if (receipt.status === "committed") await this.enqueueNavigationRefreshForDirtyZones(request.project_id);
    if (!this.strictAdmissionEnabled(request.project_id) || receipt.status !== "committed") {
      this.clearRequestRecovery("artifact", request.request_id);
      return;
    }
    const journal = new ExecutionJournal(this.persistence, request.project_id, "artifact", request.request_id);
    await journal.recordReceipt(receipt.status, machineArtifactReceiptPath(request.request_id));
    await this.finalizeVerifiedArtifact(journal);
    if ((await journal.status())?.terminal) this.clearRequestRecovery("artifact", request.request_id);
  }

  private async enqueueNavigationRefreshForDirtyZones(projectId: string): Promise<void> {
    const sources = new ZoneNavigationSources(this.persistence);
    for (const zone of ["WORKING", "REVIEW", "DELIVERABLES"] as const) {
      const source = await sources.readState(projectId, zone);
      if (!source.adopted || source.in_flight_resource_ids.length) continue;
      const dirty = await sources.listDirtyPage(projectId, zone, null, 1);
      if (!dirty.resource_ids.length) continue;
      // Arm first: if the following SQLite write is interrupted, the wake is
      // harmless; if it commits, the durable outbox cannot be stranded.
      await this.armRequestRecoveryAlarm(1_000);
      this.ctx.storage.sql.exec(
        `INSERT INTO navigation_refresh_outbox (zone, source_generation, request_json) VALUES (?, ?, NULL)
         ON CONFLICT(zone, source_generation) DO NOTHING`,
        zone, source.generation
      );
    }
  }

  private async recordObservedNavigationSourceMutation(
    projectId: string,
    zone: NavigationZone,
    resourceId: string
  ): Promise<void> {
    const sources = new ZoneNavigationSources(this.persistence);
    const source = await sources.readState(projectId, zone);
    if (!source.adopted && !source.adoption_request_id) return;
    const hasInFlightTicket = source.in_flight_resource_ids.includes(resourceId);
    // A marker with no flight is already a durable invalidation. If the ticket
    // remains in flight, however, its completion may have been interrupted
    // after beginHeadWrite or after writing the marker; replay that exact
    // ticket instead of allowing an orphaned fence to block this zone forever.
    if (!hasInFlightTicket && await sources.hasDirtyMarker(projectId, zone, resourceId)) return;
    const ticket = await sources.beginHeadWrite(projectId, zone, resourceId, undefined, null);
    if (ticket) await sources.completeHeadWrites([ticket]);
  }

  private async resumePendingNavigationRefreshes(): Promise<void> {
    const projectId = this.ctx.id.name;
    if (!projectId) return;
    try {
      // External reconciliation has no per-request recovery row. Its durable
      // scan flag is written before invoking the coordinator, so only that
      // path needs a bounded scan to bridge a torn marker->outbox boundary.
      const scanRequested = this.ctx.storage.sql.exec(
        "SELECT singleton FROM navigation_refresh_scan WHERE singleton = 1"
      ).toArray().length > 0;
      if (scanRequested) {
        await this.enqueueNavigationRefreshForDirtyZones(projectId);
        this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_scan WHERE singleton = 1");
      }
    } catch {
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
    }
    const rows = this.ctx.storage.sql.exec<NavigationRefreshRow>(
      "SELECT zone, source_generation, request_json FROM navigation_refresh_outbox ORDER BY source_generation, zone LIMIT 3"
    ).toArray();
    for (const row of rows) {
      if (row.zone !== "WORKING" && row.zone !== "REVIEW" && row.zone !== "DELIVERABLES") continue;
      const zone = row.zone as NavigationZone;
      try {
        const sources = new ZoneNavigationSources(this.persistence);
        const source = await sources.readState(projectId, zone);
        if (!source.adopted) {
          this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_outbox WHERE zone = ? AND source_generation = ?", zone, row.source_generation);
          continue;
        }
        if (source.in_flight_resource_ids.length) {
          await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
          continue;
        }
        const dirty = await sources.listDirtyPage(projectId, zone, null, 1);
        if (!dirty.resource_ids.length) {
          this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_outbox WHERE zone = ? AND source_generation = ?", zone, row.source_generation);
          continue;
        }
        let request: NavigationReconcileRequest | null = row.request_json
          ? navigationReconcileSchema.parse(JSON.parse(row.request_json))
          : null;
        const journal = request
          ? new ExecutionJournal(this.persistence, projectId, "document", request.request_id)
          : null;
        const admitted = journal ? await journal.readAdmission() : null;
        const current = await this.readFreshCanonicalState(projectId);
        if (!current) throw new Error("navigation_auto_refresh_state_unavailable");
        const headRaw = await this.persistence.objects.readText(zoneNavigationHeadPath(projectId, zone));
        if (!headRaw) throw new Error("navigation_auto_refresh_head_unavailable");
        const head = zoneNavigationHeadSchema.parse(JSON.parse(headRaw));
        if (head.project_id !== projectId || head.zone !== zone) throw new Error("navigation_auto_refresh_head_binding");
        if (source.generation > row.source_generation && !admitted) {
          this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_outbox WHERE zone = ? AND source_generation = ?", zone, row.source_generation);
          await this.armNavigationRefreshOutbox(zone, source.generation);
          continue;
        }
        if (!request || (!admitted && (request.expected_project_revision !== current.revision || request.expected_generation !== head.generation))) {
          request = {
            operation: "navigation.reconcile",
            // Frozen admission state is immutable even before its journal
            // admission exists. If recovery's prior request becomes stale,
            // bind a fresh identity to the exact revision/head snapshot
            // instead of rewriting a payload under that frozen identity.
            request_id: `DOCREQ-NAV-AUTO-${zone}-S${row.source_generation}-R${current.revision}-G${head.generation}`,
            project_id: projectId,
            zone,
            expected_project_revision: current.revision,
            expected_generation: head.generation,
            expected_index: head.index,
            created_at: new Date().toISOString()
          };
          const requestJson = canonicalJson(request);
          this.ctx.storage.sql.exec(
            "UPDATE navigation_refresh_outbox SET request_json = ? WHERE zone = ? AND source_generation = ?",
            requestJson, zone, row.source_generation
          );
        }
        if (admitted) {
          // Re-enter the same governed ingress with the frozen request. This
          // closes a crash after journal admission but before request recovery
          // was enqueued; it never invokes the engine directly.
          await this.handleNavigationReconcile(request!, null);
        } else {
          const secret = this.env.MUTATION_CONTEXT_SIGNING_KEY;
          if (!secret) throw new Error("navigation_auto_refresh_context_unavailable");
          const context = await issueMutationContext(current, secret, Date.now(), {
            actor_id: "project_guard",
            authority: "durable_object"
          });
          await this.handleNavigationReconcile(request!, context);
        }
        const recovered = await new ExecutionJournal(this.persistence, projectId, "document", request!.request_id).readAdmission();
        if (recovered) {
          this.ctx.storage.sql.exec("DELETE FROM navigation_refresh_outbox WHERE zone = ? AND source_generation = ?", zone, row.source_generation);
        } else {
          await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
        }
      } catch {
        await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      }
    }
  }

  private async armNavigationRefreshOutbox(zone: NavigationZone, generation: number): Promise<void> {
    await this.armRequestRecoveryAlarm(1_000);
    this.ctx.storage.sql.exec(
      `INSERT INTO navigation_refresh_outbox (zone, source_generation, request_json) VALUES (?, ?, NULL)
       ON CONFLICT(zone, source_generation) DO NOTHING`,
      zone, generation
    );
  }

  private async enqueueRequestRecovery(kind: "artifact" | "document" | "transaction", requestId: string, requestJson?: string): Promise<void> {
    if ((kind === "document" || kind === "transaction") && requestJson) {
      const digest = await sha256Text(requestJson);
      const canonical = kind === "document" && this.ctx.id.name ? await this.managedDocumentRequests.readIntent(this.ctx.id.name, requestId) : null;
      if (canonical && canonical.request_sha256 !== digest) throw new ManagedDocumentRequestIntentConflictError(requestId);
      const staged = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_sha256: string }>(
        "SELECT request_sha256 FROM request_recovery_payload WHERE kind = ? AND request_id = ?", kind, requestId
      ).toArray()[0];
      if (staged && staged.request_sha256 !== digest) {
        if (kind === "document") throw new ManagedDocumentRequestIntentConflictError(requestId);
        throw new AdmissionError("idempotency_payload_mismatch", 409);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO request_recovery_payload (kind, request_id, request_json, request_sha256) VALUES (?, ?, ?, ?) ON CONFLICT(kind, request_id) DO NOTHING",
        kind, requestId, requestJson, digest
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO request_recovery (kind, request_id) VALUES (?, ?) ON CONFLICT(kind, request_id) DO NOTHING",
      kind,
      requestId
    );
    // Keep the queue write and wake-up adjacent storage operations. Cloudflare
    // batches them without an intervening external await, so a committed
    // staged request cannot be left without its initial alarm.
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  private clearRequestRecovery(kind: "artifact" | "document" | "transaction", requestId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM request_recovery WHERE kind = ? AND request_id = ?",
      kind,
      requestId
    );
    this.ctx.storage.sql.exec("DELETE FROM request_recovery_payload WHERE kind = ? AND request_id = ?", kind, requestId);
    this.ctx.storage.sql.exec("DELETE FROM request_recovery_failures WHERE kind = ? AND request_id = ?", kind, requestId);
  }

  private async clearTransactionRecovery(requestId: string): Promise<void> {
    this.clearRequestRecovery("transaction", requestId);
    if (!this.hasPendingRequestRecovery() && !await this.hasPendingMaterializationFinalization()) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async hasPendingMaterializationFinalization(): Promise<boolean> {
    return Boolean(
      await this.ctx.storage.get(MATERIALIZATION_FINALIZATION_REQUEST_KEY)
      || await this.ctx.storage.get(MATERIALIZATION_FINALIZATION_WORK_KEY)
    );
  }

  private async blockRequestRecovery(kind: "artifact" | "document" | "transaction", requestId: string, code: string): Promise<void> {
    const progressSha256 = await sha256Text(`${kind}:${requestId}:${code}`);
    const diagnostic: RecoveryFailureDiagnostic = {
      code,
      classification: "provider_blocked",
      error_name: "InvalidRecoveryEvidence",
      progress_sha256: progressSha256,
      next_attempt_at: null
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message)
       VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(kind, request_id) DO UPDATE SET fingerprint = excluded.fingerprint,
         count = excluded.count, stopped = 1, message = excluded.message`,
      kind, requestId, progressSha256, JSON.stringify(diagnostic)
    );
  }

  private async recoveryProgressFingerprint(kind: "artifact" | "document" | "transaction", requestId: string): Promise<string> {
    const payload = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_sha256: string }>(
      "SELECT request_sha256 FROM request_recovery_payload WHERE kind = ? AND request_id = ?", kind, requestId
    ).toArray()[0]?.request_sha256 ?? null;
    let localEvidence: unknown = null;
    if (kind === "transaction") {
      const row = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; status: string; receipt_json: string }>(
        "SELECT status, receipt_json FROM transactions WHERE transaction_id = ?", requestId
      ).toArray()[0];
      const intent = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; payload_hash: string }>(
        "SELECT payload_hash FROM transaction_intents WHERE transaction_id = ?", requestId
      ).toArray()[0];
      localEvidence = row ? { status: row.status, receipt_sha256: await sha256Text(row.receipt_json), intent_hash: intent?.payload_hash ?? null } : intent ?? null;
    } else {
      const table = kind === "document" ? "document_requests" : "artifact_requests";
      const row = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_json: string; receipt_json: string }>(
        `SELECT request_json, receipt_json FROM ${table} WHERE request_id = ?`, requestId
      ).toArray()[0];
      localEvidence = row ? {
        request_sha256: await sha256Text(row.request_json),
        receipt_sha256: await sha256Text(row.receipt_json)
      } : null;
    }
    return sha256Text(JSON.stringify({ kind, request_id: requestId, payload_sha256: payload, local_evidence: localEvidence }));
  }

  /** Read execution progress only at the internal-failure stop boundary. This
   * avoids a provider round trip for ordinary retries while ensuring durable
   * completed steps reset the identical-no-progress streak. */
  private async externalRecoveryProgressFingerprint(
    kind: "artifact" | "document" | "transaction",
    requestId: string
  ): Promise<string> {
    const projectId = this.ctx.id.name;
    if (!projectId) throw new Error("project_id_unavailable");
    const deadlineMs = Date.now() + 5_000;
    const controller = new AbortController();
    let calls = 0;
    const runtime = createProductionPersistence(this.env, projectId, {
      deadlineMs,
      signal: controller.signal,
      now: () => Date.now(),
      beforeHttp: () => {
        if (Date.now() >= deadlineMs || calls >= 8) throw new Error("recovery_progress_probe_budget_exhausted");
        calls += 1;
      }
    });
    const source = new ExecutionJournal(runtime, projectId, kind, requestId).status();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("recovery_progress_probe_deadline");
        controller.abort(error);
        reject(error);
      }, Math.max(1, deadlineMs - Date.now()));
    });
    let progress: Awaited<ReturnType<ExecutionJournal["status"]>>;
    try {
      progress = await Promise.race([source, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!progress) return sha256Text("no_execution_progress");
    return sha256Text(JSON.stringify({
      status: progress.status,
      terminal: progress.terminal,
      completed_steps: progress.completed_steps,
      postchecks: progress.postchecks,
      receipt_ref: progress.receipt_ref,
      finalization_ref: progress.finalization_ref ?? null
    }));
  }

  private async recordRecoveryFailure(
    kind: "artifact" | "document" | "transaction" | "materialization",
    requestId: string,
    error: unknown,
    progressSha256: string
  ): Promise<RecoveryFailureResult> {
    const message = error instanceof Error ? error.message : "";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const usefulContinuation = error instanceof Error
      && /(?:^|_)slice_budget_exhausted$/i.test(message);
    const networkTemporary = isTransientRecoveryFailure(error);
    const providerTemporary = !usefulContinuation && ((error instanceof ProviderOperationError && error.retryable) || networkTemporary);
    const providerBlocked = error instanceof ProviderOperationError && !error.retryable;
    const classification: RecoveryFailureClassification = usefulContinuation
      ? "continuation"
      : providerTemporary
      ? "provider_temporary"
      : providerBlocked ? "provider_blocked" : "internal";
    const code = error instanceof ProviderOperationError
      ? (error.diagnostics?.code && /^[A-Za-z0-9._/-]{1,96}$/.test(error.diagnostics.code)
        ? error.diagnostics.code
        : error instanceof ProviderConflictError
          ? "provider_conflict"
          : error.diagnostics?.status
            ? `provider_http_${error.diagnostics.status}`
            : "provider_operation_failed")
      : usefulContinuation ? "slice_budget_exhausted"
        : networkTemporary ? "network_transport_unavailable"
          : message === "materialization_evidence_no_progress" ? message : "internal_error";
    const previous = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; fingerprint: string; count: number; message: string }>(
      "SELECT fingerprint, count, message FROM request_recovery_failures WHERE kind = ? AND request_id = ?", kind, requestId
    ).toArray()[0];
    const previousDiagnostic = this.parseRecoveryFailureDiagnostic(previous?.message);
    let externalProgressSha256 = previousDiagnostic?.external_progress_sha256;
    const errorSha256 = await sha256Text(`${errorName}:${message}`);
    let fingerprint = await sha256Text(JSON.stringify({ classification, error_name: errorName, error_sha256: errorSha256, progress_sha256: progressSha256, external_progress_sha256: externalProgressSha256 ?? null }));
    let count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
    let stopped = providerBlocked || (classification === "internal" && count >= MATERIALIZATION_FINALIZATION_INTERNAL_FAILURE_LIMIT);
    if (classification === "internal" && kind !== "materialization"
      && (count === 1 || count >= MATERIALIZATION_FINALIZATION_INTERNAL_FAILURE_LIMIT)) {
      try {
        const currentExternalProgress = await this.externalRecoveryProgressFingerprint(kind, requestId);
        if (externalProgressSha256 === undefined || currentExternalProgress !== externalProgressSha256) {
          externalProgressSha256 = currentExternalProgress;
          fingerprint = await sha256Text(JSON.stringify({ classification, error_name: errorName, error_sha256: errorSha256, progress_sha256: progressSha256, external_progress_sha256: externalProgressSha256 }));
          count = 1;
          stopped = false;
        }
      } catch {
        // A missing/slow progress probe is not evidence that it is safe to stop.
        stopped = false;
      }
    }
    const retryAfterMs = error instanceof ProviderOperationError ? error.diagnostics?.retryAfterMs ?? NaN : NaN;
    const delayMs = usefulContinuation ? 1_000 : providerTemporary
      ? Math.max(MATERIALIZATION_FINALIZATION_RETRY_DELAYS_MS[Math.min(count - 1, MATERIALIZATION_FINALIZATION_RETRY_DELAYS_MS.length - 1)]!,
          Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0)
      : stopped ? 0 : REQUEST_RECOVERY_RETRY_DELAY_MS;
    const diagnostic: RecoveryFailureDiagnostic = {
      code: stopped && classification === "internal" ? "identical_internal_failure_limit" : code,
      classification,
      error_name: errorName,
      progress_sha256: progressSha256,
      ...(externalProgressSha256 ? { external_progress_sha256: externalProgressSha256 } : {}),
      next_attempt_at: stopped ? null : new Date(Date.now() + delayMs).toISOString()
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO request_recovery_failures (kind, request_id, fingerprint, count, stopped, message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, request_id) DO UPDATE SET fingerprint = excluded.fingerprint,
         count = excluded.count, stopped = excluded.stopped, message = excluded.message`,
      kind, requestId, fingerprint, count, stopped ? 1 : 0, JSON.stringify(diagnostic)
    );
    return { ...diagnostic, count, stopped, delay_ms: delayMs };
  }

  private requestRecoveryFailureDue(message: string | null | undefined): boolean {
    if (!message) return true;
    try {
      const diagnostic = JSON.parse(message) as { next_attempt_at?: unknown };
      const dueAt = typeof diagnostic.next_attempt_at === "string" ? Date.parse(diagnostic.next_attempt_at) : NaN;
      return !Number.isFinite(dueAt) || dueAt <= Date.now();
    } catch {
      return true;
    }
  }

  private parseRecoveryFailureDiagnostic(message: string | null | undefined): RecoveryFailureDiagnostic | null {
    if (!message) return null;
    try {
      const value = JSON.parse(message) as Partial<RecoveryFailureDiagnostic>;
      if (typeof value.code !== "string" || !/^[A-Za-z0-9._/-]{1,96}$/.test(value.code)
        || !["provider_temporary", "provider_blocked", "continuation", "internal"].includes(value.classification ?? "")
        || typeof value.error_name !== "string"
        || typeof value.progress_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.progress_sha256)
        || (value.external_progress_sha256 !== undefined && (typeof value.external_progress_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.external_progress_sha256)))
        || (value.next_attempt_at !== null && (typeof value.next_attempt_at !== "string" || !Number.isFinite(Date.parse(value.next_attempt_at))))) return null;
      return value as RecoveryFailureDiagnostic;
    } catch {
      return null;
    }
  }

  private async scheduleNextRequestRecoveryWake(excludeTransactions = false): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; message: string | null }>(
      `SELECT f.message FROM request_recovery r
       LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
       WHERE COALESCE(f.stopped, 0) = 0 ${excludeTransactions ? "AND r.kind <> 'transaction'" : ""}`
    ).toArray();
    if (!rows.length) return;
    const dueTimes = rows.map(({ message }) => {
      if (!message) return Date.now();
      try {
        const diagnostic = JSON.parse(message) as { next_attempt_at?: unknown };
        const dueAt = typeof diagnostic.next_attempt_at === "string" ? Date.parse(diagnostic.next_attempt_at) : NaN;
        return Number.isFinite(dueAt) ? dueAt : Date.now();
      } catch {
        return Date.now();
      }
    });
    const next = Math.min(...dueTimes);
    await this.armRequestRecoveryAlarm(Math.max(1_000, next - Date.now()));
  }

  private pendingRequestRecovery(): RecoveryRequestRow[] {
    const cursor = this.ctx.storage.sql.exec<RecoveryCursorRow>(
      "SELECT kind, request_id FROM request_recovery_cursor WHERE singleton = 1"
    ).toArray()[0];
    const rows = cursor
      ? this.ctx.storage.sql.exec<RecoveryRequestRow>(
          `SELECT r.kind, r.request_id FROM request_recovery r
           LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
           WHERE r.kind <> 'transaction' AND COALESCE(f.stopped, 0) = 0 AND (r.kind > ? OR (r.kind = ? AND r.request_id > ?))
           ORDER BY r.kind, r.request_id LIMIT ?`,
          cursor.kind, cursor.kind, cursor.request_id, REQUEST_RECOVERY_BATCH_SIZE
        ).toArray()
      : this.ctx.storage.sql.exec<RecoveryRequestRow>(
          `SELECT r.kind, r.request_id FROM request_recovery r
           LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
           WHERE r.kind <> 'transaction' AND COALESCE(f.stopped, 0) = 0 ORDER BY r.kind, r.request_id LIMIT ?`,
          REQUEST_RECOVERY_BATCH_SIZE
        ).toArray();
    if (cursor && rows.length < REQUEST_RECOVERY_BATCH_SIZE) {
      rows.push(...this.ctx.storage.sql.exec<RecoveryRequestRow>(
        `SELECT r.kind, r.request_id FROM request_recovery r
         LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
         WHERE r.kind <> 'transaction' AND COALESCE(f.stopped, 0) = 0 AND (r.kind < ? OR (r.kind = ? AND r.request_id <= ?))
         ORDER BY r.kind, r.request_id LIMIT ?`,
        cursor.kind, cursor.kind, cursor.request_id, REQUEST_RECOVERY_BATCH_SIZE - rows.length
      ).toArray());
    }
    const last = rows.at(-1);
    if (last) {
      this.ctx.storage.sql.exec(
        `INSERT INTO request_recovery_cursor (singleton, kind, request_id) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET kind = excluded.kind, request_id = excluded.request_id`,
        last.kind, last.request_id
      );
    }
    return rows.filter((row) => {
      const failure = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; message: string }>(
        "SELECT message FROM request_recovery_failures WHERE kind = ? AND request_id = ?", row.kind, row.request_id
      ).toArray()[0];
      return this.requestRecoveryFailureDue(failure?.message);
    });
  }

  private hasPendingRequestRecovery(): boolean {
    return this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; pending: number }>(
      `SELECT COUNT(*) AS pending FROM request_recovery r
       LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
       WHERE COALESCE(f.stopped, 0) = 0`
    ).toArray()[0]?.pending > 0;
  }

  private async armRequestRecoveryAlarm(delayMs: number): Promise<void> {
    const dueAt = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null || existing > dueAt) await this.ctx.storage.setAlarm(dueAt);
  }

  private async resumePendingRequestRecovery(): Promise<void> {
    for (const recovery of this.pendingRequestRecovery()) {
      try {
        if (recovery.kind === "document") await this.resumeManagedDocument(recovery.request_id);
        else if (recovery.kind === "artifact") await this.resumeArtifactFinalization(recovery.request_id);
        else if (recovery.kind !== "transaction") this.clearRequestRecovery("document", recovery.request_id);
      } catch (error) {
        const progress = await this.recoveryProgressFingerprint(
          recovery.kind as "artifact" | "document", recovery.request_id
        );
        await this.recordRecoveryFailure(recovery.kind as "artifact" | "document", recovery.request_id, error, progress);
      }
    }
    // Transactions are processed in a separate phase later in alarm(). Do
    // not let their unfailed rows schedule an immediate wake before that
    // phase records its real retry deadline.
    await this.scheduleNextRequestRecoveryWake(true);
  }

  private async armMaterializationFinalizationAlarm(): Promise<void> {
    await this.armRequestRecoveryAlarm(1_000);
  }

  private materializationFinalizationFailureRequestId(target: MaterializationFinalizationRequest): string {
    return `${target.target_revision}:${target.projection_version}`;
  }

  private async materializationFinalizationProgress(target: MaterializationFinalizationRequest): Promise<string> {
    const work = await this.ctx.storage.get<MaterializationFinalizationWork>(MATERIALIZATION_FINALIZATION_WORK_KEY);
    return sha256Text(JSON.stringify({
      target,
      work: work ? {
        head: work.head,
        next_generation: work.next_generation,
        previous_child: work.previous_child,
        scan_complete: work.scan_complete,
        candidates: work.candidates,
        uncovered_ranges: work.uncovered_ranges ?? null,
        legacy_range_cursor: work.legacy_range_cursor ?? null
      } : null
    }));
  }

  private async recordMaterializationFinalizationFailure(
    target: MaterializationFinalizationRequest,
    error: unknown
  ): Promise<void> {
    const requestId = this.materializationFinalizationFailureRequestId(target);
    const progress = await this.materializationFinalizationProgress(target);
    const failure = await this.recordRecoveryFailure("materialization", requestId, error, progress);
    if (failure.stopped) {
      console.error("Project OS materialization finalization blocked", {
        project_id: this.ctx.id.name,
        target_revision: target.target_revision,
        projection_version: target.projection_version,
        attempts: failure.count,
        code: failure.code,
        progress_sha256: progress
      });
      if (this.hasPendingRequestRecovery()) await this.scheduleNextRequestRecoveryWake();
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    // The alarm is the existing durable wake mechanism. Its due time, together
    // with the failure row's next_attempt_at, survives eviction and prevents
    // unrelated earlier alarms from turning this into a one-second loop.
    await this.armRequestRecoveryAlarm(failure.delay_ms);
  }

  private async persistMaterializationFinalizationRequest(
    target: MaterializationFinalizationRequest,
    armWake = true
  ): Promise<void> {
    const dueAt = Date.now() + 1_000;
    const existing = await this.ctx.storage.getAlarm();
    // Arm before publishing work: interruption between these writes leaves a
    // harmless empty wake, never a durable continuation without a wake.
    if (armWake && (existing == null || existing > dueAt)) await this.ctx.storage.setAlarm(dueAt);
    await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_REQUEST_KEY, target);
  }

  private async resumePendingMaterializationFinalization(): Promise<void> {
    const requested = await this.ctx.storage.get<MaterializationFinalizationRequest>(MATERIALIZATION_FINALIZATION_REQUEST_KEY);
    const work = await this.ctx.storage.get<MaterializationFinalizationWork>(MATERIALIZATION_FINALIZATION_WORK_KEY);
    const target = requested ?? (work ? {
      target_revision: work.head.target_revision,
      projection_version: work.head.projection_version
    } : null);
    if (!target) return;

    const failureRequestId = this.materializationFinalizationFailureRequestId(target);
    const priorFailure = this.ctx.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      stopped: number;
      message: string;
    }>(
      "SELECT stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
      failureRequestId
    ).toArray()[0];
    if (priorFailure?.stopped) {
      if (this.hasPendingRequestRecovery()) await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
      return;
    }
    if (priorFailure) {
      try {
        const diagnostic = JSON.parse(priorFailure.message) as { next_attempt_at?: unknown };
        const nextAttemptAt = typeof diagnostic.next_attempt_at === "string" ? Date.parse(diagnostic.next_attempt_at) : NaN;
        if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
          await this.armRequestRecoveryAlarm(nextAttemptAt - Date.now());
          return;
        }
      } catch {
        // Legacy/non-JSON rows do not delay this continuation.
      }
    }

    // Install a durable fallback before provider work. The active alarm is
    // consumed on entry, so a process interruption must still leave a wake.
    await this.armRequestRecoveryAlarm(this.hasPendingRequestRecovery() ? REQUEST_RECOVERY_RETRY_DELAY_MS : 5_000);

    try {
      const progressBefore = await this.materializationFinalizationProgress(target);
      const response = await this.finalizeCurrentMaterialization(new Request("https://project-guard.internal/finalize-materialization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target)
      }), false);
      if (response.status >= 500) {
        await this.recordMaterializationFinalizationFailure(target, new ProviderOperationError(
          `materialization_finalization_http_${response.status}`,
          true,
          { providerId: "persistence", status: response.status }
        ));
      } else if (response.status === 409) {
        const body = await response.clone().json<{ error?: unknown }>().catch((): { error?: unknown } => ({}));
        const code = typeof body.error === "string" && /^[A-Za-z0-9._/-]{1,96}$/.test(body.error)
          ? body.error
          : "materialization_finalization_conflict";
        await this.recordMaterializationFinalizationFailure(target, new ProviderConflictError(
          code,
          { providerId: "project-guard", status: response.status, code }
        ));
      }
      else if (response.status === 202 && await this.hasPendingMaterializationFinalization()) {
        const progressAfter = await this.materializationFinalizationProgress(target);
        if (progressAfter === progressBefore) {
          await this.recordMaterializationFinalizationFailure(target, new Error("materialization_evidence_no_progress"));
        } else {
          await this.armMaterializationFinalizationAlarm();
        }
      } else if (!await this.hasPendingMaterializationFinalization()) {
        this.ctx.storage.sql.exec(
          "DELETE FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
          failureRequestId
        );
      }
    } catch (error) {
      // Preserve the accepted intent, classify the failure, and either apply
      // provider backoff or stop a repeated internal defect with an incident.
      await this.recordMaterializationFinalizationFailure(target, error);
    }
  }

  private async resumePendingTransactionRecovery(): Promise<void> {
    const projectId = this.ctx.id.name;
    if (!projectId) return;
    const cursor = this.ctx.storage.sql.exec<{ request_id: string }>(
      "SELECT request_id FROM transaction_recovery_cursor WHERE singleton = 1"
    ).toArray()[0]?.request_id;
    const select = (condition: string, parameters: unknown[]) => this.ctx.storage.sql.exec<RecoveryRequestRow>(
      `SELECT r.kind, r.request_id, COALESCE(f.message, '') AS failure_message FROM request_recovery r
       LEFT JOIN request_recovery_failures f ON f.kind = r.kind AND f.request_id = r.request_id
       WHERE r.kind = 'transaction' AND COALESCE(f.stopped, 0) = 0 ${condition}
       ORDER BY r.request_id LIMIT ?`, ...parameters
    ).toArray();
    const selected = cursor
      ? select("AND r.request_id > ?", [cursor, REQUEST_RECOVERY_BATCH_SIZE])
      : select("", [REQUEST_RECOVERY_BATCH_SIZE]);
    if (cursor && selected.length < REQUEST_RECOVERY_BATCH_SIZE) {
      selected.push(...select("AND r.request_id <= ?", [cursor, REQUEST_RECOVERY_BATCH_SIZE - selected.length]));
    }
    const pending = selected.filter((item) => this.requestRecoveryFailureDue(item.failure_message));
    const lastSelected = selected.at(-1);
    if (lastSelected) {
      this.ctx.storage.sql.exec(
        `INSERT INTO transaction_recovery_cursor (singleton, request_id) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET request_id = excluded.request_id`,
        lastSelected.request_id
      );
    }
    if (pending.length) {
      // Preserve a wake-up even if an external provider call exhausts this alarm.
      await this.armRequestRecoveryAlarm(REQUEST_RECOVERY_RETRY_DELAY_MS);
    }
    for (const item of pending) {
      try {
        let tx = await this.transactionRequests.readRecoverableTransaction(projectId, item.request_id);
        let intent = await this.transactionRequests.readIntent(projectId, item.request_id);
        if (!intent) {
          const staged = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_json: string; request_sha256: string }>(
            "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = 'transaction' AND request_id = ?", item.request_id
          ).toArray()[0];
          if (!staged || await sha256Text(staged.request_json) !== staged.request_sha256) throw new Error("transaction_staged_payload_unavailable");
          const envelope = JSON.parse(staged.request_json) as { request?: unknown; actor?: { actor_id: string; authority: string } | null };
          tx = parseTransaction(envelope.request);
          if (tx.project_id !== projectId || tx.transaction_id !== item.request_id) throw new Error("transaction_staged_identity_mismatch");
          intent = await this.transactionRequests.ensureTransactionRequest(projectId, tx, envelope.actor ?? undefined);
        }
        if (!tx || !intent) throw new Error("transaction_intent_unavailable");
        const admitted = await new ExecutionJournal(this.persistence, projectId, "transaction", item.request_id).readAdmission();
        const actor = admitted?.admission.actor ?? intent.actor;
        const state = await this.loadOrRecoverState();
        if (this.strictAdmissionEnabled(projectId) && !actor) throw new Error("transaction_admission_actor_unavailable");
        const context = state && actor && this.env.MUTATION_CONTEXT_SIGNING_KEY
          ? await issueMutationContext(state, this.env.MUTATION_CONTEXT_SIGNING_KEY, Date.now(), actor)
          : null;
        const response = await this.fetch(new Request("https://project-guard.internal/transaction", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ admission_version: "1.0", request: tx, mutation_context: context })
        }));
        if (!response.ok) {
          const diagnostics = {
            providerId: "project-guard",
            status: response.status,
            code: response.status === 409 ? "transaction_recovery_conflict" : `provider_http_${response.status}`,
            retryAfterMs: retryAfterDelayMs(response.headers.get("retry-after"))
          };
          if (response.status === 409) throw new ProviderConflictError(`transaction_recovery_http_${response.status}`, diagnostics);
          const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
          throw new ProviderOperationError(`transaction_recovery_http_${response.status}`, retryable, diagnostics);
        }
        const receipt = await response.json<Receipt>();
        if (receipt.status === "committed" || receipt.status === "conflict" || receipt.status === "rejected") {
          await this.clearTransactionRecovery(item.request_id);
        } else {
          throw new Error("transaction_recovery_nonterminal_response");
        }
      } catch (error) {
        const progress = await this.recoveryProgressFingerprint("transaction", item.request_id);
        await this.recordRecoveryFailure("transaction", item.request_id, error, progress);
      }
    }
    await this.scheduleNextRequestRecoveryWake();
  }

  private async readPackageAdmissionProof(operation: Extract<ManagedDocumentRequest, {
    operation: "package.freeze" | "package.replace";
  }>): Promise<AdmissionProof | null> {
    const kind = operation.operation === "package.freeze" ? "document" : "package-admission";
    const record = await new ExecutionJournal(this.persistence, operation.project_id, kind, operation.request_id).readAdmission();
    const legacy = !record ? this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; proof_json: string }>(
      "SELECT proof_json FROM admission_proofs WHERE kind = ? AND request_id = ?", "package", operation.request_id
    ).toArray()[0] : null;
    if (!record && !legacy) return null;
    const proof = record ? record.admission as Partial<AdmissionProof> : JSON.parse(legacy!.proof_json) as Partial<AdmissionProof>;
    if (
      proof.project_id !== operation.project_id
      || proof.operation !== operation.operation
      || proof.project_revision !== operation.expected_project_revision
      || proof.verdict !== "allow"
      || !proof.actor
      || !proof.ruleset
      || proof.request_hash !== await sha256Canonical(operation)
    ) {
      throw new Error("package_admission_binding");
    }
    // Previous deployments kept package proof only in DO SQLite. Promote a
    // validated legacy proof to the canonical journal before continuing it.
    if (!record) await this.persistAdmissionProof(kind, operation.request_id, proof as AdmissionProof);
    return proof as AdmissionProof;
  }

  private async finalizePackageDocument(
    operation: Extract<ManagedDocumentRequest, { operation: "package.freeze" | "package.replace" }>,
    receipt: PackageDocumentReceipt
  ): Promise<PackageDocumentReceipt> {
    const serialized = JSON.stringify(operation);
    await this.managedDocumentRequests.writeReceipt(
      operation.project_id,
      operation.request_id,
      serialized,
      JSON.stringify(receipt)
    );
    if (operation.operation === "package.replace") {
      await this.completePackageNavigationSource(operation);
      await this.enqueueNavigationRefreshForDirtyZones(operation.project_id);
    }
    this.persistDocumentRequest(operation, receipt);
    this.clearRequestRecovery("document", operation.request_id);
    return receipt;
  }

  private async resumePackageManagedDocument(
    operation: Extract<ManagedDocumentRequest, { operation: "package.freeze" | "package.replace" }>
  ): Promise<unknown> {
    const durableReceipt = await this.managedDocumentRequests.readReceipt(operation.project_id, operation.request_id);
    if (durableReceipt) {
      const receipt = JSON.parse(durableReceipt.receipt_json) as PackageDocumentReceipt;
      if (operation.operation === "package.replace") {
        await this.completePackageNavigationSource(operation);
        await this.enqueueNavigationRefreshForDirtyZones(operation.project_id);
      }
      this.persistDocumentRequest(operation, receipt);
      this.clearRequestRecovery("document", operation.request_id);
      return receipt;
    }
    const state = await this.loadOrRecoverState();
    if (!state || state.project_id !== operation.project_id) throw new Error("package_project_not_initialized");
    if (state.revision !== operation.expected_project_revision) throw new Error("package_project_revision_conflict");
    const proof = await this.readPackageAdmissionProof(operation);
    if (!proof) throw new Error("package_admission_unavailable");
    if (operation.operation === "package.freeze") {
      const candidate = await this.managedDocumentService.freezePackageDocument(operation, state);
      return this.finalizePackageDocument(operation, {
        request_id: operation.request_id,
        project_id: operation.project_id,
        status: "committed",
        candidate
      });
    }
    await this.beginPackageNavigationSource(operation);
    const global = await this.readGlobalGovernance();
    if (global.revision !== proof.global_revision) throw new Error("package_ruleset_changed");
    const progress = await this.managedDocumentService.replacePackage(
      operation,
      state,
      { ...proof, kind: "document", request_id: operation.request_id },
      { effectBudget: 20, postcheckRules: [...Object.values(global.rules), ...Object.values(state.local_rules)] }
    );
    if (progress.status === "conflict" || progress.status === "failed" || progress.status === "rejected") {
      return this.finalizePackageDocument(operation, {
        request_id: operation.request_id,
        project_id: operation.project_id,
        status: "conflict",
        code: progress.code ?? (progress.status === "failed" ? "PACKAGE_EXECUTION_FAILED" : "PACKAGE_EXECUTION_CONFLICT")
      });
    }
    if (progress.status !== "finalized") return progress;
    return this.finalizePackageDocument(operation, {
      request_id: operation.request_id,
      project_id: operation.project_id,
      status: "committed",
      execution_status: "finalized",
      candidate: operation.candidate,
      finalization_ref: progress.finalization_ref
    });
  }

  private async resumeManagedDocument(requestId: string): Promise<void> {
    const projectId = this.ctx.id.name;
    if (!projectId) {
      this.clearRequestRecovery("document", requestId);
      return;
    }
    const staged = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_json: string; request_sha256: string }>(
      "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = ? AND request_id = ?",
      "document", requestId
    ).toArray()[0];
    let intent;
    try {
      intent = await this.managedDocumentRequests.readRecoverableIntent(projectId, requestId);
    } catch (error) {
      if (error instanceof ProviderOperationError || isTransientRecoveryFailure(error)) throw error;
      // Corrupt evidence is never replayed. It remains observable through the
      // read-only status endpoint instead of creating an untrusted effect or
      // being mistaken for absent work.
      await this.blockRequestRecovery("document", requestId, "document_intent_invalid");
      return;
    }
    if (intent && staged && intent.request_sha256 !== staged.request_sha256) {
      await this.blockRequestRecovery("document", requestId, "document_intent_binding_mismatch");
      return;
    }
    if (!intent) {
      if (!staged) {
        this.clearRequestRecovery("document", requestId);
        return;
      }
      if (await sha256Text(staged.request_json) !== staged.request_sha256) {
        await this.blockRequestRecovery("document", requestId, "document_staged_payload_invalid");
        return;
      }
      let parsed: ManagedDocumentRequest;
      try {
        parsed = parseManagedDocumentRequest(JSON.parse(staged.request_json));
      } catch {
        await this.blockRequestRecovery("document", requestId, "document_staged_payload_invalid");
        return;
      }
      if (parsed.project_id !== projectId || parsed.request_id !== requestId) {
        await this.blockRequestRecovery("document", requestId, "document_staged_identity_invalid");
        return;
      }
      await this.managedDocumentRequests.ensureIntent(projectId, requestId, staged.request_json);
      const persisted = await this.managedDocumentRequests.readIntent(projectId, requestId);
      if (!persisted || persisted.request_sha256 !== staged.request_sha256) throw new Error("document_intent_unavailable_after_stage");
      // Legacy hash-only intents cannot be rewritten, but their digest still
      // binds the exact server-staged payload used by this continuation.
      intent = { ...persisted, request_json: staged.request_json };
    }
    let operation: ManagedDocumentRequest;
    try {
      operation = parseManagedDocumentRequest(JSON.parse(intent.request_json));
    } catch {
      await this.blockRequestRecovery("document", requestId, "document_intent_invalid");
      return;
    }
    if (operation.project_id !== projectId || operation.request_id !== requestId) {
      await this.blockRequestRecovery("document", requestId, "document_intent_identity_invalid");
      return;
    }
    if (operation.operation === "package.freeze" || operation.operation === "package.replace") {
      try {
        await this.resumePackageManagedDocument(operation);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("package_")) {
          await this.finalizePackageDocument(operation, {
            request_id: operation.request_id,
            project_id: operation.project_id,
            status: "conflict",
            code: error.message
          });
          return;
        }
        throw error;
      }
      return;
    }
    if (operation.operation === "navigation.reconcile") {
      const durableReceipt = await this.managedDocumentRequests.readReceipt(operation.project_id, requestId);
      if (durableReceipt) {
        await this.settleNavigationReceipt(operation, JSON.parse(durableReceipt.receipt_json) as NavigationDocumentReceipt);
        return;
      }
      const journal = new ExecutionJournal(this.persistence, operation.project_id, "document", operation.request_id);
      const admitted = await journal.readAdmission();
      if (!admitted || admitted.admission.operation !== "navigation.reconcile" || admitted.admission.request_hash !== await sha256Canonical(operation)) {
        await this.blockRequestRecovery("document", requestId, "navigation_admission_unavailable");
        return;
      }
      const frozen = await this.readFrozenNavigationState(operation, admitted.admission.request_hash);
      await this.executeNavigationSlice(operation, frozen, admitted.admission);
      return;
    }
    const durableReceipt = await this.managedDocumentRequests.readReceipt(operation.project_id, requestId);
    if (durableReceipt) {
      await this.settleDocumentReceipt(operation, JSON.parse(durableReceipt.receipt_json) as ManagedDocumentOperationReceipt);
      return;
    }
    const state = await this.loadOrRecoverState();
    if (!state) throw new Error("project_not_initialized");
    try {
      await this.finalizeDocument(operation, await this.executeManagedDocument(operation, state));
    } catch (error) {
      if (error instanceof ManagedDocumentConflictError) {
        await this.finalizeDocument(
          operation,
          this.documentTerminalReceipt(operation, "conflict", error.code, error.message, error.documentId)
        );
        return;
      }
      if (error instanceof Error && error.message.startsWith("Managed document content SHA-256 mismatch:")) {
        await this.finalizeDocument(
          operation,
          this.documentTerminalReceipt(operation, "rejected", "CONTENT_HASH_MISMATCH", error.message)
        );
        return;
      }
      throw error;
    }
  }

  private async resumeArtifactFinalization(requestId: string): Promise<void> {
    const row = this.findArtifact(requestId);
    if (!row) {
      this.clearRequestRecovery("artifact", requestId);
      return;
    }
    const request = parseArtifactWriteRequest(JSON.parse(row.request_json));
    const receipt = JSON.parse(row.receipt_json) as ArtifactWriteReceipt;
    await this.repository.writeArtifactReceipt(receipt);
    await this.settleArtifactReceipt(request, receipt);
  }

  private loadState(): ProjectState | null {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    return row ? normalizeProjectState(JSON.parse(row.state_json)) : null;
  }

  private async handleMutationContextRead(request: Request): Promise<Response> {
    const projectId = this.ctx.id.name;
    const secret = this.env.MUTATION_CONTEXT_SIGNING_KEY;
    if (!projectId || projectId === AUTO_PROJECT_ID || !secret) {
      return Response.json({ error: "canonical_unavailable" }, { status: 503 });
    }
    const includeState = new URL(request.url).searchParams.get("include_state") !== "false";
    // A context must be fresh or unavailable. The snapshot is an accelerator,
    // not an authority over newer immutable commits, so verify its bounded
    // suffix before signing. Never authorize from a stale local cache.
    let latest: ProjectState | null;
    try {
      latest = await this.readFreshCanonicalState(projectId);
    } catch {
      return Response.json({ error: "canonical_unavailable" }, { status: 503 });
    }
    if (!latest) return Response.json({ error: "canonical_unavailable" }, { status: 503 });
    const stateBeforePersist = this.loadState();
    if (stateBeforePersist && stateBeforePersist.revision > latest.revision) {
      return Response.json({ error: "canonical_unavailable" }, { status: 503 });
    }
    this.persistState(latest);
    this.contextVerifiedState = normalizeProjectState(latest);
    const context = await issueMutationContext(latest, secret, Date.now(), this.contextActor(request));
    const stateAfterSign = this.loadState();
    if (stateAfterSign && stateAfterSign.revision > latest.revision) {
      return Response.json({ error: "canonical_unavailable" }, { status: 503 });
    }
    return Response.json(includeState ? { context, canonical_state: latest } : { context });
  }

  private canonicalContextReadDeadlineMs(): number {
    return 5_000;
  }

  /** Context reads use their own bounded provider runtime. A request that cannot
   * finish inside the freshness window is aborted, rather than occupying this
   * project's read gate until the provider's general 30-second timeout. */
  private canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository {
    return new ProjectRepository(createProductionPersistence(this.env, projectId, scope), this.layoutMode);
  }

  private async readContextSnapshot(repository: ProjectRepository, projectId: string): Promise<ProjectState | null> {
    return repository.readProjectState(projectId);
  }

  private async readFreshCanonicalState(projectId: string): Promise<ProjectState | null> {
    if (this.contextReadPending) return this.contextReadPending;
    const deadline = Date.now() + this.canonicalContextReadDeadlineMs();
    const controller = new AbortController();
    const budget = { calls: 0, maxCalls: 32 };
    const repository = this.canonicalContextRepository(projectId, {
      deadlineMs: deadline,
      signal: controller.signal,
      now: () => Date.now(),
      beforeHttp: () => {
        if (Date.now() >= deadline || budget.calls >= budget.maxCalls) {
          throw new Error("canonical_context_budget_exhausted");
        }
        budget.calls += 1;
      }
    });
    const source = this.readCanonicalState(repository, projectId, deadline, budget);
    const pending = new Promise<ProjectState | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        const error = new Error("canonical_read_deadline");
        controller.abort(error);
        reject(error);
      }, this.canonicalContextReadDeadlineMs());
      void source.then(
        (state) => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          resolve(state);
        },
        (error) => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          reject(error);
        }
      );
    });
    const shared = pending.finally(() => {
      if (this.contextReadPending === shared) this.contextReadPending = null;
    });
    this.contextReadPending = shared;
    return shared;
  }

  private async readCanonicalState(
    repository: ProjectRepository,
    projectId: string,
    deadline: number,
    budget: { calls: number; maxCalls: number }
  ): Promise<ProjectState | null> {
    const ensureBudget = () => {
      if (Date.now() >= deadline || budget.calls >= budget.maxCalls) {
        throw new Error("canonical_context_budget_exhausted");
      }
    };
    const readCommit = async (revision: number) => {
      ensureBudget();
      const record = await repository.readCommitRecord(projectId, revision);
      if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
      return record;
    };
    const sameState = (left: ProjectState, right: ProjectState) => canonicalJson(left) === canonicalJson(right);
    const checkpoint = await this.readContextCheckpoint(projectId);
    const exactRecordState = async (state: ProjectState): Promise<ProjectState | null> => {
      if (state.project_id !== projectId || state.revision < 1) return null;
      const record = await readCommit(state.revision);
      if (!record || record.project_id !== projectId || record.new_revision !== state.revision) return null;
      return sameState(state, record.state) ? state : record.state;
    };

    let local = this.loadState();
    let latest: ProjectState | null = null;
    if (local && this.layoutMode === "v2" && this.contextVerifiedState
      && this.contextVerifiedState.revision === local.revision
      && sameState(this.contextVerifiedState, local)) {
      latest = local;
    } else if (local && this.layoutMode === "v2") {
      latest = await exactRecordState(local);
    }

    if (checkpoint && (!latest || checkpoint.revision > latest.revision)) {
      const record = await readCommit(checkpoint.revision);
      if (record && record.project_id === projectId && record.new_revision === checkpoint.revision
        && record.event.event_id === checkpoint.event_id
        && await sha256Canonical(record.state) === checkpoint.state_sha256
        && Date.now() < deadline) {
        latest = record.state;
      }
    }

    if (!latest) {
      const snapshot = await this.readContextSnapshot(repository, projectId);
      if (snapshot) latest = await exactRecordState(snapshot);
    }
    if (!latest && this.layoutMode === "v2") {
      const firstRecord = await readCommit(1);
      if (firstRecord) {
        if (firstRecord.previous_revision !== 0) throw new Error("canonical_commit_chain_gap");
        latest = firstRecord.state;
      }
    }
    if (!latest) return null;
    await this.persistContextCheckpoint(latest, deadline);

    // Verify only the immutable suffix from the proven baseline. Provider
    // call accounting is shared with snapshot/baseline reads for this request.
    for (;;) {
      ensureBudget();
      const next = await readCommit(latest.revision + 1);
      if (next) {
        if (next.previous_revision !== latest.revision || next.new_revision !== latest.revision + 1) {
          throw new Error("canonical_commit_chain_gap");
        }
        latest = next.state;
        await this.persistContextCheckpoint(latest, deadline);
        continue;
      }

      // A commit may have completed while the provider lookup was pending.
      // Its local cache is usable only when this instance itself recorded the
      // same verified state; otherwise prove it against the exact commit.
      local = this.loadState();
      if (local && local.revision > latest.revision) {
        if (this.contextVerifiedState && this.contextVerifiedState.revision === local.revision
          && sameState(this.contextVerifiedState, local)) {
          latest = local;
          await this.persistContextCheckpoint(latest, deadline);
          continue;
        }
        const newer = await exactRecordState(local);
        if (!newer) throw new Error("canonical_context_raced_unverified_state");
        latest = newer;
        await this.persistContextCheckpoint(latest, deadline);
        continue;
      }
      return latest;
    }
  }

  private async readContextCheckpoint(projectId: string): Promise<ContextReadCheckpoint | null> {
    const raw = await this.ctx.storage.get<unknown>(CONTEXT_READ_CHECKPOINT_KEY);
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<ContextReadCheckpoint>;
    if (value.schema_version !== "1.0" || value.project_id !== projectId
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !(value.event_id === null || typeof value.event_id === "string")
      || typeof value.state_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.state_sha256)) return null;
    return value as ContextReadCheckpoint;
  }

  /** Persist only a proven historical checkpoint, never an unverified suffix.
   * Serializing writes and comparing revisions prevents a late lower-revision
   * reader from replacing a newer cursor. */
  private async persistContextCheckpoint(state: ProjectState, deadline: number): Promise<void> {
    if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
    const stateHash = await sha256Canonical(state);
    if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
    const candidate: ContextReadCheckpoint = {
      schema_version: "1.0",
      project_id: state.project_id,
      revision: state.revision,
      event_id: state.last_event_id,
      state_sha256: stateHash
    };
    const write = this.contextCheckpointWriteQueue.then(async () => {
      if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
      const current = this.loadState();
      if (current && current.revision > candidate.revision) return;
      const saved = await this.readContextCheckpoint(candidate.project_id);
      if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
      if (saved && saved.revision > candidate.revision) return;
      if (saved && saved.revision === candidate.revision
        && saved.event_id === candidate.event_id && saved.state_sha256 === candidate.state_sha256) return;
      await this.ctx.storage.put(CONTEXT_READ_CHECKPOINT_KEY, candidate);
      if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
    });
    this.contextCheckpointWriteQueue = write.catch(() => undefined);
    await write;
    if (Date.now() >= deadline) throw new Error("canonical_context_budget_exhausted");
  }

  private contextActor(request: Request): { actor_id: string; authority: string } {
    const authorization = request.headers.get("authorization") ?? "";
    if (this.env.CONTROL_TOWER_OPERATOR_TOKEN && authorization === `Bearer ${this.env.CONTROL_TOWER_OPERATOR_TOKEN}`) return { actor_id: "control_tower", authority: "control_tower_operator" };
    if (this.env.INGRESS_TOKEN && authorization === `Bearer ${this.env.INGRESS_TOKEN}`) return { actor_id: "ingress", authority: "ingress_token" };
    return { actor_id: "project_guard", authority: "durable_object" };
  }

  protected strictAdmissionEnabled(projectId: string): boolean {
    const configuredStrict = admissionModeForProject(
      this.env.PROJECT_OS_ADMISSION_PROJECT_MODES,
      projectId
    ) === "strict";
    if (configuredStrict && this.ctx.id.name === projectId) {
      this.persistAdmissionFloor();
      return true;
    }
    return this.ctx.storage.sql.exec<{ strict: number }>(
      "SELECT strict FROM admission_floor WHERE singleton = 1"
    ).toArray()[0]?.strict === 1;
  }

  /** A project which has ever observed an applicable active rule is never
   * permitted to fall back to legacy admission.  The floor deliberately uses
   * the existing per-project storage, so an unavailable global reader after
   * activation fails closed in admitRules rather than selecting a client rule
   * subset or silently returning to observe mode. */
  protected async ruleAdmissionRequired(state: ProjectState, normalized: NormalizedAdmissionOperation): Promise<boolean> {
    if (this.strictAdmissionEnabled(state.project_id)) return true;
    const global = await this.readGlobalGovernanceSnapshot();
    if (this.hasApplicableActiveRule(state.local_rules, normalized)) {
      this.persistAdmissionFloor();
      return true;
    }
    if (this.hasApplicableActiveRule(global.rules, normalized)) {
      this.persistAdmissionFloor();
      return true;
    }
    return false;
  }

  private persistAdmissionFloor(): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO admission_floor (singleton, strict) VALUES (1, 1) ON CONFLICT(singleton) DO NOTHING"
    );
  }

  private hasApplicableActiveRule(rules: Record<string, unknown>, normalized: NormalizedAdmissionOperation): boolean {
    return Object.values(rules).some(value => {
      const parsed = ruleVersionSchema.safeParse(value);
      return parsed.success && parsed.data.status === "active"
        && parsed.data.operations.includes(normalized.operation)
        && normalized.resources.some(resource => matchesResource(parsed.data, resource));
    });
  }

  /**
   * Capacity gates new canonical work only once the explicit repair writer is
   * enabled for this project. Existing durable repairs bypass this path.
   */
  private async assertCommitCapacity(projectId: string): Promise<void> {
    if (convergenceModeForProject(this.env.PROJECT_OS_CONVERGENCE_PROJECT_MODES, projectId) !== "repair") return;
    let response: Response;
    try {
      response = await this.env.MATERIALIZATION_GUARD.getByName(projectId).fetch(
        "https://materialization-guard.internal/capacity"
      );
    } catch {
      throw new AdmissionError("convergence_capacity_exceeded", 503);
    }
    if (!response.ok) throw new AdmissionError("convergence_capacity_exceeded", 503);
    let observation: unknown;
    try {
      observation = await response.json();
    } catch {
      throw new AdmissionError("convergence_capacity_exceeded", 503);
    }
    if (!isCapacityObservation(observation)) throw new AdmissionError("convergence_capacity_exceeded", 503);
    try {
      assertCapacity(observation);
    } catch (error) {
      if (error instanceof ConvergenceAdmissionError) {
        throw new AdmissionError("convergence_capacity_exceeded", 503, error.detail as unknown as Record<string, unknown>);
      }
      throw error;
    }
  }

  private async verifyAdmission(context: MutationContext | null, tx: Transaction, state: ProjectState): Promise<void> {
    const secret = this.env.MUTATION_CONTEXT_SIGNING_KEY;
    if (!secret) {
      const error = new AdmissionError("canonical_unavailable", 503);
      this.reportAdmissionRejection(error, tx.project_id, state.revision, context?.canonical_revision ?? null);
      throw error;
    }
    try {
      await verifyMutationContext(context, state, tx.base_revision, secret, Date.now());
    } catch (error) {
      if (error instanceof AdmissionError) {
        this.reportAdmissionRejection(error, tx.project_id, state.revision, context?.canonical_revision ?? null);
      }
      throw error;
    }
  }

  protected async verifyEffectAdmission(
    context: MutationContext | null,
    projectId: string,
    state: ProjectState,
    required = this.strictAdmissionEnabled(projectId)
  ): Promise<void> {
    if (!required) return;
    const secret = this.env.MUTATION_CONTEXT_SIGNING_KEY;
    if (!secret) {
      const error = new AdmissionError("canonical_unavailable", 503);
      this.reportAdmissionRejection(error, projectId, state.revision, context?.canonical_revision ?? null);
      throw error;
    }
    try {
      await verifyMutationContext(context, state, context?.canonical_revision ?? state.revision, secret, Date.now());
    } catch (error) {
      if (error instanceof AdmissionError) {
        this.reportAdmissionRejection(error, projectId, state.revision, context?.canonical_revision ?? null);
      }
      throw error;
    }
  }

  private reportAdmissionRejection(
    error: AdmissionError,
    projectId: string,
    targetRevision: number,
    observedRevision: number | null
  ): void {
    try {
      workerLogConvergenceTelemetry().emit(freshnessRejectionMetric({
        projectId,
        targetRevision,
        observedRevision,
        code: error.code,
        deploymentSha: deploymentIdentity(this.env).git_sha ?? "unknown"
      }));
    } catch {
      // Admission protection must not depend on a telemetry sink.
    }
  }

  protected admissionErrorResponse(error: unknown): Response {
    if (error instanceof Error && error.message === "repair_diagnosed_drift_required") return Response.json({ error: "REPAIR_INTENT_REQUIRED" }, { status: 409 });
    if (error instanceof Error && error.message.startsWith("execution_")) return Response.json({ error: error.message }, { status: error.message.endsWith("conflict") ? 409 : 503 });
    if (error instanceof Error && error.message.startsWith("repair_")) return Response.json({ error: error.message }, { status: error.message.endsWith("unavailable") ? 503 : 409 });
    if (error instanceof AdmissionError) return Response.json({
      error: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail })
    }, { status: error.status });
    if (error instanceof RuleAdmissionError) return Response.json({ error: error.code }, { status: error.code === "rule_admission_expired" ? 409 : 503 });
    if (error instanceof RuleAdmissionRejection) {
      const result = error.evaluation;
      return Response.json({ error: result.code, rule: result.rule, expected: result.expected, observed: result.observed, required_action: result.required_action }, { status: result.verdict === "unavailable" ? 503 : 409 });
    }
    throw error;
  }

  protected async admitRules(state: ProjectState, normalized: NormalizedAdmissionOperation, actor = { actor_id: "project_guard", authority: "durable_object" }): Promise<AdmissionProof> {
    const global = await this.readGlobalGovernance();
    const evaluate = async (global_governance: GlobalGovernanceState): Promise<EvaluationResult> => evaluateRules({
      actor,
      project_id: normalized.project_id,
      operation: normalized.operation,
      expected_project_revision: state.revision,
      stage: "pre_admission",
      now: new Date().toISOString(),
      state,
      global_governance,
      resources: normalized.resources,
      observations: await this.resolveServerObservations(state, normalized),
      approvals: []
    });
    const first = await evaluate(global);
    if (first.verdict !== "allow") throw new RuleAdmissionRejection(first);
    const input: RuleAdmissionInput = {
      actor,
      project_id: normalized.project_id,
      operation: normalized.operation,
      resources: normalized.resources,
      request_hash: normalized.request_hash,
      global_revision: global.revision,
      ruleset: first.ruleset
    };
    const permit = await this.requestRulePermit(input);
    const secret = this.env.RULE_ADMISSION_SIGNING_KEY;
    if (!secret) throw new RuleAdmissionRejection({ ...first, verdict: "unavailable", code: "GLOBAL_GOVERNANCE_UNAVAILABLE", expected: "Rule admission signing key", observed: "Missing signing key", required_action: "Restore rule-admission authority" });
    await verifyRuleAdmissionPermit(permit, input, secret, Date.now());
    const currentGlobal = await this.readGlobalGovernance();
    const final = await evaluate(currentGlobal);
    if (final.verdict !== "allow" || final.ruleset.digest !== permit.ruleset.digest || currentGlobal.revision !== permit.global_revision) {
      throw new RuleAdmissionRejection(final.verdict === "allow"
        ? { ...final, verdict: "unavailable", code: "RULE_ADMISSION_STALE", expected: permit.ruleset.digest, observed: final.ruleset.digest, required_action: "Refresh the operation under the current ruleset" }
        : final);
    }
    return {
      project_id: normalized.project_id,
      operation: normalized.operation,
      resources: normalized.resources,
      request_hash: normalized.request_hash,
      actor: input.actor,
      global_revision: currentGlobal.revision,
      project_revision: state.revision,
      ruleset: final.ruleset,
      verdict: final.verdict,
      results: final.results,
      gaps: final.gaps,
      deferred_rules: final.deferred_rules
    };
  }

  /** Only registered document controls may contribute objective observations.
   * The request contributes no evidence: both the current version and its
   * immutable version-record reference are read from the canonical ledger. */
  private async resolveServerObservations(state: ProjectState, normalized: NormalizedAdmissionOperation): Promise<RuleObservation[]> {
    if (normalized.operation !== "working.write") return [];
    const resources = normalized.resources.filter(resource => resource.resource_type === "document" && resource.expected_version !== undefined);
    if (!resources.length) return [];
    const ledger = new DocumentLedgerRepository(this.persistence);
    const now = new Date();
    const expires = new Date(now.getTime() + 300_000).toISOString();
    const observations: RuleObservation[] = [];
    for (const resource of resources) {
      try {
        const headPath = machineDocumentHeadPath(state.project_id, resource.resource_id);
        const before = await this.persistence.objects.getMetadata(headPath);
        if (!before?.revisionToken) continue;
        const head = await ledger.readHead(state.project_id, resource.resource_id);
        const currentVersion = head?.working_version_id ?? head?.published_version_id;
        if (!currentVersion) continue;
        const versionPath = machineDocumentVersionPath(state.project_id, resource.resource_id, currentVersion);
        const versionBefore = await this.persistence.objects.getMetadata(versionPath);
        if (!versionBefore) continue;
        const version = await ledger.readVersion(state.project_id, resource.resource_id, currentVersion);
        const versionAfter = await this.persistence.objects.getMetadata(versionPath);
        const after = await this.persistence.objects.getMetadata(headPath);
        if (!version || !after || !sameProviderObject(before, after) || !versionAfter || !sameProviderObject(versionBefore, versionAfter)) continue;
        const headEvidence = providerEvidenceReference(before);
        const versionEvidence = providerEvidenceReference(versionBefore);
        if (!headEvidence || !versionEvidence) continue;
        observations.push({
          project_id: state.project_id,
          resource_id: resource.resource_id,
          resource_version: resource.version,
          current_version: currentVersion,
          observed_at: now.toISOString(),
          expires_at: expires,
          evidence_refs: [headEvidence, versionEvidence]
        });
      } catch {
        // Partial, unstable and unavailable reads remain no evidence; the
        // common evaluator consequently fails closed for a rule that needs it.
      }
    }
    return observations;
  }

  protected async persistAdmissionProof(kind: string, requestId: string, proof: AdmissionProof): Promise<void> {
    const admission: ExecutionAdmission = { ...proof, kind, request_id: requestId };
    // The canonical journal is authority. SQL is only a cache; awaiting this
    // boundary is mandatory before every admitted family starts an effect.
    try {
      await new ExecutionJournal(this.persistence, proof.project_id, kind, requestId).commit(admission, await this.executionPlanResolver(admission));
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("execution_") || error.message === "repair_diagnosed_drift_required")) throw error;
      throw new Error("execution_evidence_unavailable");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO admission_proofs (kind, request_id, proof_json) VALUES (?, ?, ?)
       ON CONFLICT(kind, request_id) DO UPDATE SET proof_json = excluded.proof_json`,
      kind, requestId, JSON.stringify(proof)
    );
  }

  private async readGlobalGovernance(): Promise<GlobalGovernanceState> {
    return this.readGlobalGovernanceSnapshot();
  }

  /** The Registry alone can attest that no governance history exists.  A
   * missing/invalid snapshot is not an empty ruleset: callers suspend until
   * they can read this canonical distinction. */
  private async readGlobalGovernanceSnapshot(): Promise<GlobalGovernanceState> {
    let response: Response;
    try { response = await this.env.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/governance", { method: "GET" }); }
    catch { throw new RuleAdmissionRejection(this.unavailableGlobalResult()); }
    if (response.status === 404) {
      try {
        const body = await response.json<{ error?: unknown }>();
        if (body.error === "governance_not_initialized") return { revision: 0, rules: {}, exceptions: {} };
      } catch {
        // A malformed 404 is not a canonical absence proof.
      }
      throw new RuleAdmissionRejection(this.unavailableGlobalResult());
    }
    if (!response.ok) throw new RuleAdmissionRejection(this.unavailableGlobalResult());
    try {
      const state = await response.json<GlobalGovernanceState>();
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !state.rules || !state.exceptions) throw new Error("invalid governance");
      return state;
    } catch { throw new RuleAdmissionRejection(this.unavailableGlobalResult()); }
  }

  private async requestRulePermit(input: RuleAdmissionInput): Promise<RuleAdmissionPermit> {
    let response: Response;
    try {
      response = await this.env.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/rule-admission", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
      });
    } catch { throw new RuleAdmissionRejection(this.unavailableGlobalResult()); }
    if (!response.ok) throw new RuleAdmissionRejection(this.unavailableGlobalResult());
    try { return await response.json<RuleAdmissionPermit>(); }
    catch { throw new RuleAdmissionRejection(this.unavailableGlobalResult()); }
  }

  private unavailableGlobalResult(): EvaluationResult {
    return { verdict: "unavailable", code: "GLOBAL_GOVERNANCE_UNAVAILABLE", rule: null, expected: "Fresh canonical global governance", observed: "Global governance unavailable", required_action: "Restore the canonical governance reader; do not bypass global rules", ruleset: { digest: "", rules: [], global_revision: null, project_revision: 0 }, results: [], gaps: [], deferred_rules: [] };
  }

  private async ensureTransactionIntent(tx: Transaction): Promise<void> {
    const payloadHash = await sha256Canonical(tx);
    const row = this.ctx.storage.sql.exec<{ payload_hash: string }>(
      "SELECT payload_hash FROM transaction_intents WHERE transaction_id = ?",
      tx.transaction_id
    ).toArray()[0];
    if (row && row.payload_hash !== payloadHash) throw new AdmissionError("idempotency_payload_mismatch", 409);
    if (!row) this.ctx.storage.sql.exec(
      "INSERT INTO transaction_intents (transaction_id, payload_hash) VALUES (?, ?)",
      tx.transaction_id,
      payloadHash
    );
  }

  private async verifyCommittedReplayPayload(tx: Transaction, receipt: Receipt): Promise<void> {
    if (receipt.status !== "committed" || this.layoutMode !== "v2") return;
    const record = await this.repository.readCommitRecord(tx.project_id, receipt.new_revision);
    if (record && await sha256Canonical(record.transaction) !== await sha256Canonical(tx)) {
      throw new AdmissionError("idempotency_payload_mismatch", 409);
    }
  }

  protected async loadOrRecoverState(): Promise<ProjectState | null> {
    if (this.layoutMode === "v2") {
      return this.reconcileCanonicalCommits();
    }

    const local = this.loadState();
    if (local) return local;

    const projectId = this.ctx.id.name;
    if (!projectId) return null;
    const recovered = await this.repository.readProjectState(projectId);
    if (!recovered) return null;

    this.persistState(recovered);
    return recovered;
  }

  private async reconcileCanonicalCommits(expectedContextStateHash?: string): Promise<ProjectState | null> {
    const projectId = this.ctx.id.name;
    if (!projectId) return this.loadState();

    let recoveredCanonicalState = false;
    let state = this.loadState();
    if (state && state.revision > 0 && expectedContextStateHash && await sha256Canonical(state) !== expectedContextStateHash) {
      // A local SQL row is only a cache. A signed context is issued from
      // immutable canonical state, so a same-revision hash mismatch requires
      // rebuilding the cache before the context is verified for admission.
      const currentRecord = await this.repository.readCommitRecord(projectId, state.revision);
      if (currentRecord) {
        if (currentRecord.previous_revision !== state.revision - 1) {
          throw new Error(`Canonical commit record for ${projectId} revision ${state.revision} is not revision-contiguous`);
        }
        if (await sha256Canonical(state) !== await sha256Canonical(currentRecord.state)) {
          await this.recoverCommittedRecord(currentRecord);
          state = currentRecord.state;
          recoveredCanonicalState = true;
        }
      }
    }
    if (!state) {
      const snapshot = await this.repository.readProjectState(projectId);
      if (snapshot) {
        const sameRevisionRecord = snapshot.revision > 0
          ? await this.repository.readCommitRecord(projectId, snapshot.revision)
          : null;
        if (sameRevisionRecord) {
          await this.recoverCommittedRecord(sameRevisionRecord);
          state = sameRevisionRecord.state;
          recoveredCanonicalState = true;
        } else {
          this.persistState(snapshot);
          state = snapshot;
        }
      } else {
        const firstRecord = await this.repository.readCommitRecord(projectId, 1);
        if (!firstRecord) return null;
        if (firstRecord.previous_revision !== 0) {
          throw new Error(`First canonical commit record for ${projectId} is not revision-contiguous`);
        }
        await this.recoverCommittedRecord(firstRecord);
        state = firstRecord.state;
        recoveredCanonicalState = true;
      }
    }

    while (state) {
      const nextRecord = await this.repository.readCommitRecord(projectId, state.revision + 1);
      if (!nextRecord) {
        if (recoveredCanonicalState) await this.requestMaterializationSafely(state.revision);
        return state;
      }
      if (nextRecord.previous_revision !== state.revision) {
        throw new Error(`Canonical commit record gap for ${projectId}: expected previous revision ${state.revision}`);
      }
      await this.recoverCommittedRecord(nextRecord);
      state = nextRecord.state;
      recoveredCanonicalState = true;
    }

    return state;
  }

  private async recoverCommittedRecord(record: CanonicalCommitRecord): Promise<void> {
    this.persistCommit(record.state, record.receipt);
  }

  private async requestMaterializationSafely(revision: number): Promise<void> {
    const projectId = this.ctx.id.name;
    if (!projectId || projectId === AUTO_PROJECT_ID || this.layoutMode !== "v2") return;
    await requestMaterializationTargetSafely(
      this.env,
      projectId,
      revision,
      CURRENT_PROJECTION_VERSION
    );
  }

  private async handleMaterializationMutation(request: Request, targetPath: string, operation: "project.materialize" | "project.repair", fleetReconcile = false): Promise<Response> {
    const body = await request.text();
    return this.serialize(async () => {
      const projectId = this.ctx.id.name;
      if (!projectId || projectId === AUTO_PROJECT_ID) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      const state = await this.loadOrRecoverState();
      if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      if (operation === "project.repair" && body && !fleetReconcile) {
        return this.handleTypedRepair(new Request(request.url, { method: "POST", body }), state);
      }
      const normalized = await normalizeSystemAdmission(
        projectId, operation, "MATERIALIZATION", `${targetPath}@${state.revision}`, String(state.revision), { target_path: targetPath, body }
      );
      if (await this.ruleAdmissionRequired(state, normalized)) {
        const proof = await this.admitRules(state, normalized);
        await this.persistAdmissionProof("materialization", `${targetPath}@${state.revision}`, proof);
      }
      return this.forwardMaterializationRequest(request, targetPath, body);
    }).catch((error) => this.admissionErrorResponse(error));
  }

  private async handleTypedRepair(request: Request, state: ProjectState): Promise<Response> {
    let decoded;
    try { decoded = decodeAdmission(await request.json(), parseRepairIntent); }
    catch (error) {
      if (error instanceof AdmissionError) throw error;
      return Response.json({ error: "REPAIR_INTENT_REQUIRED" }, { status: 409 });
    }
    const intent = decoded.request;
    // Repair is never an observe-only effect.  Even for a legacy project the
    // resume authority must come from the server-signed context, not payload.
    await this.verifyEffectAdmission(decoded.mutation_context, intent.project_id, state, true);
    if (intent.project_id !== state.project_id || intent.project_id !== this.ctx.id.name) throw new Error("repair_project_conflict");
    const journal = new ExecutionJournal(this.persistence, intent.project_id, intent.action.original_kind, intent.action.original_request_id);
    const original = await journal.readAdmission();
    if (!original) throw new Error("repair_original_evidence_unavailable");
    const refs = await authorizeRepair(intent, state.revision, original, this.repairEvidenceResolver);
    const proof = await this.admitRules(state, await normalizeRepairAdmission(intent), decoded.mutation_context!.actor);
    proof.diagnosed_drift_refs = refs;
    await this.persistAdmissionProof("repair", intent.request_id, proof);
    const adapter = await this.executionAdapterResolver(original.admission);
    if (!original.plan || !adapter) throw new Error("repair_finalization_adapter_unavailable");
    return Response.json(await new ExecutionCoordinator(journal).resume(original.plan, adapter));
  }

  private async forwardMaterializationRequest(request: Request, targetPath: string, suppliedBody?: string): Promise<Response> {
    const projectId = this.ctx.id.name;
    if (!projectId || projectId === AUTO_PROJECT_ID) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }
    const body = suppliedBody ?? (request.method === "GET" || request.method === "HEAD" ? undefined : await request.text());
    return this.env.MATERIALIZATION_GUARD.getByName(projectId).fetch(
      `https://materialization-guard.internal${targetPath}`,
      {
        method: request.method,
        headers: request.headers,
        ...(body !== undefined ? { body } : {})
      }
    );
  }

  private persistState(state: ProjectState): void {
    const current = this.loadState();
    if (current && current.project_id === state.project_id && current.revision > state.revision) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO project_state (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
      JSON.stringify(state)
    );
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

  private findDocumentRequest(requestId: string): DocumentRequestRow | null {
    return this.ctx.storage.sql.exec<DocumentRequestRow>(
      "SELECT request_json, receipt_json FROM document_requests WHERE request_id = ?",
      requestId
    ).toArray()[0] ?? null;
  }

  protected async handleReceiptRead(url: URL): Promise<Response> {
    const requestId = url.searchParams.get("request_id");
    const kind = url.searchParams.get("kind");
    if (!requestId || !["transaction", "document", "artifact"].includes(kind ?? "")) {
      return Response.json({ error: "invalid_receipt_query" }, { status: 400 });
    }
    if (url.searchParams.has("project_id") && url.searchParams.get("project_id") !== this.ctx.id.name) {
      return Response.json({ error: "receipt_not_found" }, { status: 404 });
    }
    const row = kind === "transaction"
      ? this.findReceipt(requestId)
      : kind === "document"
        ? this.findDocumentRequest(requestId)
        : this.findArtifact(requestId);
    const receipt = row && typeof row === "object" && "receipt_json" in row
      ? JSON.parse(row.receipt_json)
      : row;
    const identityKey = kind === "transaction" ? "transaction_id" : "request_id";
    if (receipt && typeof receipt === "object" && (!(identityKey in receipt) || receipt[identityKey] !== requestId)) {
      return Response.json({ error: "receipt_identity_conflict" }, { status: 503 });
    }
    if (receipt && typeof receipt === "object" && !("project_id" in receipt)) {
      return Response.json({ error: "receipt_identity_conflict" }, { status: 503 });
    }
    if (receipt && typeof receipt === "object" && receipt.project_id !== this.ctx.id.name) {
      return Response.json({ error: "receipt_not_found" }, { status: 404 });
    }
    return receipt ? Response.json(receipt) : Response.json({ error: "receipt_not_found" }, { status: 404 });
  }

  protected observationCorrelationId(request: Request, url: URL): string {
    const value = request.headers.get("x-project-os-correlation-id")
      ?? url.searchParams.get("correlation_id");
    return value && value.length <= 128 ? value : crypto.randomUUID();
  }

  protected unknownObservationResponse(
    projectId: string,
    kind: string,
    requestId: string,
    correlationId: string,
    code: string
  ): Response {
    const observedAt = new Date().toISOString();
    const observation = persistenceObservation({
      project_id: projectId,
      kind: kind as RequestKind,
      request_id: requestId,
      observed_at: observedAt,
      correlation_id: correlationId,
      code
    });
    return Response.json({
      project_id: projectId, kind, request_id: requestId,
      status: "unknown", code, correlation_id: correlationId, observed_at: observedAt,
      observation
    }, { status: 503, headers: { "Retry-After": "1" } });
  }

  private async readMaterializationFailureForExecution(
    projectId: string,
    kind: string,
    receipt: unknown,
    execution: Awaited<ReturnType<ExecutionJournal["status"]>>
  ): Promise<{
    target_revision: number;
    projection_version: number;
    blocked: boolean;
    code: string;
    classification: string;
    progress_sha256: string;
    next_attempt_at: string | null;
    wake_scheduled: boolean;
  } | null> {
    if (kind !== "transaction" || execution?.terminal === true || !receipt || typeof receipt !== "object") return null;
    const transactionReceipt = receipt as { project_id?: unknown; status?: unknown; new_revision?: unknown };
    if (transactionReceipt.project_id !== projectId || transactionReceipt.status !== "committed"
      || !Number.isSafeInteger(transactionReceipt.new_revision) || (transactionReceipt.new_revision as number) < 1) return null;
    const revision = transactionReceipt.new_revision as number;
    const request = await this.ctx.storage.get<MaterializationFinalizationRequest>(MATERIALIZATION_FINALIZATION_REQUEST_KEY);
    const work = await this.ctx.storage.get<MaterializationFinalizationWork>(MATERIALIZATION_FINALIZATION_WORK_KEY);
    const target = request ?? (work ? {
      target_revision: work.head.target_revision,
      projection_version: work.head.projection_version
    } : null);
    if (!target) return null;
    const candidateMatches = work?.uncovered_ranges
      ? work.uncovered_ranges.some((range) => revision >= range.from_revision && revision <= range.to_revision)
      : Boolean(work?.candidates.some((candidate) => candidate.revision === revision));
    if (work ? !candidateMatches : target.target_revision !== revision) return null;
    const row = this.ctx.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      count: number;
      stopped: number;
      message: string;
    }>(
      "SELECT count, stopped, message FROM request_recovery_failures WHERE kind = 'materialization' AND request_id = ?",
      this.materializationFinalizationFailureRequestId(target)
    ).toArray()[0];
    if (!row) return null;
    let diagnostic: { code?: unknown; classification?: unknown; progress_sha256?: unknown; next_attempt_at?: unknown };
    try {
      diagnostic = JSON.parse(row.message) as typeof diagnostic;
    } catch {
      return null;
    }
    if (typeof diagnostic.code !== "string" || typeof diagnostic.classification !== "string"
      || typeof diagnostic.progress_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(diagnostic.progress_sha256)) return null;
    const nextAttemptAt = typeof diagnostic.next_attempt_at === "string" && Number.isFinite(Date.parse(diagnostic.next_attempt_at))
      ? diagnostic.next_attempt_at
      : null;
    const wakeScheduled = !row.stopped && nextAttemptAt !== null && await this.ctx.storage.getAlarm() !== null;
    return {
      target_revision: target.target_revision,
      projection_version: target.projection_version,
      blocked: Boolean(row.stopped),
      code: diagnostic.code,
      classification: diagnostic.classification,
      progress_sha256: diagnostic.progress_sha256,
      next_attempt_at: nextAttemptAt,
      wake_scheduled: wakeScheduled
    };
  }

  /** A read-only recovery view. In particular, it must not certify an effect,
   * replay a write, or create a receipt merely because a chat asked about it. */
  private async handleRequestStatus(
    url: URL,
    correlationId: string,
    runtime: ProjectOsPersistenceRuntime = this.persistence,
    repository: ProjectRepository = this.repository,
    requireFinalizationProof = false
  ): Promise<Response> {
    const projectId = this.ctx.id.name;
    const requestId = url.searchParams.get("request_id");
    const kind = url.searchParams.get("kind");
    if (!projectId || !requestId || !kind || !["transaction", "document", "artifact"].includes(kind)) {
      return Response.json({ error: "request_identity_required" }, { status: 400 });
    }
    try {
      const execution = await new ExecutionJournal(runtime, projectId, kind, requestId).status();
      const receipt = await this.readRequestStatusReceipt(projectId, kind as RequestKind, requestId, runtime, repository);
      if (requireFinalizationProof && execution?.status === "finalized") {
        if (!await this.hasValidFinalizationEvidence(projectId, kind, requestId, receipt, execution, runtime)) {
          return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "finalization_proof_unavailable");
        }
        const observedAt = new Date().toISOString();
        const observation = persistenceObservation({
          project_id: projectId, kind: kind as RequestKind, request_id: requestId, observed_at: observedAt,
          correlation_id: correlationId, receipt, execution, durable_intent: true
        });
        return Response.json({ project_id: projectId, kind, request_id: requestId, status: "finalized", observation, receipt, execution });
      }
      const materializationFailure = await this.readMaterializationFailureForExecution(projectId, kind, receipt, execution);
      const intent = kind === "document" ? await new ManagedDocumentRequestLedger(runtime.objects).readIntent(projectId, requestId)
        : kind === "transaction" ? await new TransactionRequestLedger(runtime.objects).readIntent(projectId, requestId) : null;
      const artifactIntent = kind === "artifact" ? await new MutationGateRepository(runtime).readArtifactIntent(projectId, requestId) : null;
      const queued = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_id: string }>(
        "SELECT request_id FROM request_recovery WHERE kind = ? AND request_id = ?", kind, requestId
      ).toArray().length > 0;
      const alarmAt = queued ? await this.ctx.storage.getAlarm() : null;
      const wakeScheduled = queued && alarmAt !== null;
      const staged = (kind === "document" || kind === "transaction") ? this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; request_json: string; request_sha256: string }>(
        "SELECT request_json, request_sha256 FROM request_recovery_payload WHERE kind = ? AND request_id = ?", kind, requestId
      ).toArray()[0] : undefined;
      const failure = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; count: number; stopped: number; message: string }>(
        "SELECT count, stopped, message FROM request_recovery_failures WHERE kind = ? AND request_id = ?", kind, requestId
      ).toArray()[0];
      const failureDiagnostic = this.parseRecoveryFailureDiagnostic(failure?.message);
      const receiptStatus = receipt && typeof receipt === "object" && "status" in receipt && typeof receipt.status === "string"
        ? receipt.status
        : null;
      let recoverableIntent = false;
      let recoveryCode: string | null = null;
      if (intent && kind === "transaction") {
        try {
          recoverableIntent = Boolean(await this.transactionRequests.readRecoverableTransaction(projectId, requestId));
        } catch {
          recoveryCode = "intent_payload_invalid";
        }
      } else if (intent) {
        try {
          const recoverable = await this.managedDocumentRequests.readRecoverableIntent(projectId, requestId);
          if (recoverable) {
            // A digest alone is insufficient: malformed bytes cannot be
            // presented as scheduled work when they cannot be parsed into a
            // governed request. Status remains read-only throughout.
            parseManagedDocumentRequest(JSON.parse(recoverable.request_json));
            recoverableIntent = true;
          }
        } catch {
          recoveryCode = "intent_payload_invalid";
        }
      }
      if (!recoverableIntent && staged && !recoveryCode) {
        try {
          if (await sha256Text(staged.request_json) !== staged.request_sha256) throw new Error("staged_request_hash_invalid");
          if (kind === "document") {
            if (intent && intent.request_sha256 !== staged.request_sha256) throw new Error("staged_request_binding_invalid");
            const parsed = parseManagedDocumentRequest(JSON.parse(staged.request_json));
            if (parsed.project_id !== projectId || parsed.request_id !== requestId) throw new Error("staged_request_identity_invalid");
          } else {
            const envelope = JSON.parse(staged.request_json) as { request?: unknown };
            const parsed = parseTransaction(envelope.request);
            if (parsed.project_id !== projectId || parsed.transaction_id !== requestId
              || (intent && canonicalJson(parsed) !== intent.request_json)) throw new Error("staged_request_identity_invalid");
          }
          recoverableIntent = true;
        } catch {
          recoveryCode = "staged_payload_invalid";
        }
      }
      if (kind === "document" && intent && staged && intent.request_sha256 !== staged.request_sha256) recoverableIntent = false;
      const status = execution?.status === "finalized"
        ? "finalized"
        : receiptStatus === "committed"
          ? "committed"
          : receiptStatus === "rejected" || receiptStatus === "conflict"
            ? receiptStatus
            : queued && failure?.stopped
              ? "recovery_blocked"
            : execution && (execution.status === "admitted" || (execution.status === "committed" && !execution.receipt_ref))
              ? "admitted_uncommitted"
              : wakeScheduled && recoverableIntent
                ? "recovery_scheduled"
              : intent || artifactIntent || staged || queued
                ? "recovery_unavailable"
              : "not_received";
      const observedAt = new Date().toISOString();
      const lease = execution?.lease && typeof execution.lease === "object"
        ? execution.lease as { owner?: unknown; until?: unknown }
        : null;
      const leaseUntil = typeof lease?.until === "string" ? Date.parse(lease.until) : Number.NaN;
      const running = typeof lease?.owner === "string" && lease.owner.length > 0
        && Number.isFinite(leaseUntil) && leaseUntil > Date.now();
      const requestFailureWakeScheduled = queued && !failure?.stopped && wakeScheduled && alarmAt !== null;
      const observationWakeScheduled = requestFailureWakeScheduled || Boolean(materializationFailure?.wake_scheduled);
      const observationNextAttempt = materializationFailure?.wake_scheduled
        ? materializationFailure.next_attempt_at
        : requestFailureWakeScheduled
          ? failureDiagnostic?.next_attempt_at ?? new Date(alarmAt!).toISOString()
          : null;
      const observation = persistenceObservation({
        project_id: projectId,
        kind: kind as RequestKind,
        request_id: requestId,
        observed_at: observedAt,
        correlation_id: correlationId,
        ...(receipt ? { receipt } : {}),
        execution: execution && typeof execution.status === "string" ? {
          status: execution.status,
          ...(typeof execution.terminal === "boolean" ? { terminal: execution.terminal } : {}),
          ...(typeof execution.finalization_ref === "string" || execution.finalization_ref === null
            ? { finalization_ref: execution.finalization_ref } : {})
        } : null,
        durable_intent: Boolean(intent || artifactIntent || recoverableIntent || staged || execution),
        absence_verified: status === "not_received",
        wake_scheduled: observationWakeScheduled,
        ...(observationWakeScheduled && observationNextAttempt ? { next_attempt_at: observationNextAttempt } : {}),
        running,
        blocked: Boolean((queued && failure?.stopped) || materializationFailure?.blocked),
        code: recoveryCode ?? (failure?.stopped
          ? failureDiagnostic?.code ?? (failure.message === "document_intent_binding_mismatch" ? failure.message : "identical_internal_failure_limit")
          : materializationFailure?.code ?? null)
      });
      return Response.json({
        project_id: projectId,
        kind,
        request_id: requestId,
        status,
        observation,
        ...(receipt ? { receipt } : {}),
        ...(execution ? { execution } : {}),
        ...(intent || artifactIntent || staged || queued || materializationFailure || (kind === "transaction" && execution && !receipt) ? {
          recovery: {
            durable_intent: Boolean(intent || artifactIntent || materializationFailure),
            recoverable: recoverableIntent,
            scheduled: requestFailureWakeScheduled || Boolean(materializationFailure?.wake_scheduled),
            ...(materializationFailure ? {
              finalization: {
                target_revision: materializationFailure.target_revision,
                projection_version: materializationFailure.projection_version,
                blocked: materializationFailure.blocked,
                code: materializationFailure.code,
                classification: materializationFailure.classification,
                progress_sha256: materializationFailure.progress_sha256,
                next_attempt_at: materializationFailure.next_attempt_at,
                next_action: materializationFailure.blocked ? "wait_for_dependency"
                  : materializationFailure.wake_scheduled ? "resume_execution" : "check_status"
              }
            } : {}),
            ...(failure?.stopped ? {
              code: failureDiagnostic?.code ?? (failure.message === "document_intent_binding_mismatch" ? failure.message : "identical_internal_failure_limit"),
              ...(failureDiagnostic ? {
                classification: failureDiagnostic.classification,
                progress_sha256: failureDiagnostic.progress_sha256,
                next_attempt_at: failureDiagnostic.next_attempt_at,
                next_action: failureDiagnostic.classification === "provider_blocked" || failureDiagnostic.code === "identical_internal_failure_limit"
                  ? "wait_for_dependency" : "check_status"
              } : {}),
              attempts: failure.count
            }
              : recoveryCode ? { code: recoveryCode }
              : kind === "transaction" && execution && !receipt && !recoverableIntent ? { code: "recovery_unavailable" } : {})
          }
        } : {})
      });
    } catch {
      return Response.json({
        project_id: projectId,
        kind,
        request_id: requestId,
        status: "unknown",
        code: "request_status_unavailable",
        correlation_id: correlationId,
        observed_at: new Date().toISOString(),
        observation: persistenceObservation({
          project_id: projectId, kind: kind as RequestKind, request_id: requestId,
          observed_at: new Date().toISOString(), correlation_id: correlationId,
          code: "request_status_unavailable"
        })
      }, { status: 503 });
    }
  }

  private async readRequestStatusReceipt(
    projectId: string,
    kind: "transaction" | "document" | "artifact",
    requestId: string,
    runtime: ProjectOsPersistenceRuntime = this.persistence,
    repository: ProjectRepository = this.repository,
    pendingIsUnknown = false
  ): Promise<unknown | null> {
    if (kind === "transaction") {
      const receipt = this.findReceipt(requestId) ?? await repository.readReceipt(requestId);
      if (receipt) {
        if (typeof receipt.project_id !== "string") throw new Error("receipt_project_binding_missing");
        if (receipt.project_id !== projectId) return null;
        if (receipt.transaction_id !== requestId) throw new Error("receipt_identity_conflict");
        return receipt;
      }
      const admitted = await new ExecutionJournal(runtime, projectId, "transaction", requestId).readAdmission();
      if (!admitted) {
        if (pendingIsUnknown && await new TransactionRequestLedger(runtime.objects).readIntent(projectId, requestId)) {
          throw new Error("receipt_pending_durable_intent");
        }
        return null;
      }
      if (pendingIsUnknown) throw new Error("receipt_pending_execution_admission");
      const record = await repository.readCommitRecord(projectId, admitted.admission.project_revision + 1);
      if (!record) return null;
      if (record.project_id !== projectId || record.transaction.transaction_id !== requestId
        || record.receipt.project_id !== projectId || record.receipt.transaction_id !== requestId
        || await sha256Canonical(record.transaction) !== admitted.admission.request_hash) {
        throw new Error("receipt_commit_binding_conflict");
      }
      return record.receipt;
    }
    if (kind === "document") {
      const durable = await new ManagedDocumentRequestLedger(runtime.objects).readReceipt(projectId, requestId);
      if (!durable) {
        if (pendingIsUnknown && await new ManagedDocumentRequestLedger(runtime.objects).readIntent(projectId, requestId)) {
          throw new Error("receipt_pending_durable_intent");
        }
        return null;
      }
      const receipt = JSON.parse(durable.receipt_json) as { request_id?: unknown; project_id?: unknown };
      if (receipt.request_id !== requestId || receipt.project_id !== projectId) throw new Error("receipt_identity_conflict");
      return receipt;
    }
    const raw = await runtime.objects.readText(machineArtifactReceiptPath(requestId));
    if (raw === null) {
      if (pendingIsUnknown) {
        const execution = await new ExecutionJournal(runtime, projectId, "artifact", requestId).status();
        const artifactIntent = await new MutationGateRepository(runtime).readArtifactIntent(projectId, requestId);
        if (execution || artifactIntent) throw new Error("receipt_pending_durable_intent");
      }
      return null;
    }
    const receipt = JSON.parse(raw) as { request_id?: unknown; project_id?: unknown };
    if (typeof receipt.project_id !== "string" || typeof receipt.request_id !== "string") {
      throw new Error("artifact_receipt_binding_missing");
    }
    if (receipt.project_id !== projectId) return null;
    if (receipt.request_id !== requestId) throw new Error("artifact_receipt_identity_conflict");
    return receipt;
  }

  private async hasValidFinalizationEvidence(
    projectId: string,
    kind: string,
    requestId: string,
    receiptValue: unknown,
    execution: Awaited<ReturnType<ExecutionJournal["status"]>>,
    runtime: ProjectOsPersistenceRuntime
  ): Promise<boolean> {
    if (!execution || execution.status !== "finalized" || execution.terminal !== true
      || !execution.finalization_ref || !execution.receipt_ref || !receiptValue || typeof receiptValue !== "object") return false;
    const receipt = receiptValue as Record<string, unknown>;
    if (receipt.project_id !== projectId || receipt.status !== "committed"
      || (kind === "transaction" ? receipt.transaction_id !== requestId : receipt.request_id !== requestId)) return false;
    try {
      const journal = new ExecutionJournal(runtime, projectId, kind, requestId);
      const root = await journal.root();
      const prefix = `${root}/finalizations/`;
      if (!execution.finalization_ref.startsWith(prefix)) return false;
      const expectedHash = execution.finalization_ref.slice(prefix.length).replace(/\.json$/, "");
      if (!/^[a-f0-9]{64}$/.test(expectedHash) || !execution.finalization_ref.endsWith(".json")) return false;
      const raw = await runtime.objects.readText(execution.finalization_ref);
      if (raw === null) return false;
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (await sha256Text(canonicalJson(record)) !== expectedHash
        || record.schema_version !== "1.0"
        || record.project_id !== projectId || record.kind !== kind || record.request_id !== requestId
        || record.request_hash !== execution.request_hash || record.receipt_ref !== execution.receipt_ref) return false;
      if (kind === "transaction") {
        const revision = receipt.new_revision;
        return Number.isSafeInteger(revision) && typeof revision === "number" && revision > 0
          && typeof receipt.event_id === "string" && receipt.event_id.length > 0
          && record.target_revision === revision
          && record.source_event_id === receipt.event_id
          && record.canonical_commit_ref === machineCommitRecordPath(projectId, revision)
          && execution.receipt_ref === `${machineCommitRecordPath(projectId, revision)}#receipt`
          && record.receipt_ref === execution.receipt_ref
          && record.materialization_head_ref === machineMaterializationHeadPath(projectId)
          && typeof record.materialization_record_ref === "string"
          && record.materialization_record_ref.startsWith(`${machineMaterializationRoot(projectId)}/REV-${String(revision).padStart(6, "0")}-PV-`)
          && /^\d{4}\.json$/.test(record.materialization_record_ref.slice(`${machineMaterializationRoot(projectId)}/REV-${String(revision).padStart(6, "0")}-PV-`.length))
          && typeof record.result_root_hash === "string" && /^[a-f0-9]{64}$/.test(record.result_root_hash);
      }
      if (kind === "document") {
        const expectedReceiptRef = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
        if (receipt.operation === "navigation.reconcile") {
          const navigationReceipt = zoneNavigationReceiptSchema.safeParse(receipt.navigation_receipt);
          return navigationReceipt.success && execution.receipt_ref === expectedReceiptRef
            && navigationReceipt.data.project_id === projectId && navigationReceipt.data.request_id === requestId
            && record.navigation_head_ref === navigationReceipt.data.head_ref
            && record.navigation_finalization_ref === navigationReceipt.data.finalization_ref
            && record.generation === navigationReceipt.data.generation
            && canonicalJson(record.index) === canonicalJson(navigationReceipt.data.index)
            && record.source_snapshot_id === navigationReceipt.data.source_snapshot_id;
        }
        return execution.receipt_ref === expectedReceiptRef
          && record.document_id === receipt.document_id && record.version_id === receipt.version_id
          && record.stage === receipt.stage && record.logical_path === receipt.logical_path
          && record.provider_rev === receipt.provider_rev
          && [record.document_id, record.version_id, record.stage, record.logical_path, record.provider_rev]
            .every((value) => typeof value === "string" && value.length > 0);
      }
      if (kind === "artifact") {
        return execution.receipt_ref === machineArtifactReceiptPath(requestId)
          && record.mutation_intent_ref === machineMutationIntentPath(projectId, requestId)
          && record.content_sha256 === receipt.content_sha256
          && typeof record.destination_path === "string"
          && record.destination_path.startsWith(`/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-`)
          && record.destination_path.endsWith(`/${String(receipt.relative_path)}`)
          && typeof record.content_sha256 === "string" && /^[a-f0-9]{64}$/.test(record.content_sha256);
      }
      return false;
    } catch {
      return false;
    }
  }

  protected async readBoundedRequestStatusReceipt(
    projectId: string,
    kind: RequestKind,
    requestId: string
  ): Promise<unknown | null> {
    const deadlineMs = Date.now() + this.observationReadDeadlineMs();
    const controller = new AbortController();
    let calls = 0;
    const runtime = createProductionPersistence(this.env, projectId, {
      deadlineMs,
      signal: controller.signal,
      now: () => Date.now(),
      beforeHttp: () => {
        if (Date.now() >= deadlineMs || calls >= 8) throw new Error("canonical_receipt_budget_exhausted");
        calls += 1;
      }
    });
    const repository = new ProjectRepository(runtime, this.layoutMode);
    const source = this.readRequestStatusReceipt(projectId, kind, requestId, runtime, repository, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("canonical_receipt_deadline");
        controller.abort(error);
        reject(error);
      }, Math.max(1, deadlineMs - Date.now()));
    });
    try {
      return await Promise.race([source, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  protected async readFinalizedRequestStatusWhileBusy(
    url: URL,
    projectId: string,
    kind: string,
    requestId: string,
    correlationId: string
  ): Promise<Response> {
    try {
      const response = await this.readBoundedRequestStatus(url, correlationId, true);
      if (!response.ok) throw new Error("request_status_not_verified");
      const body = await response.clone().json() as Record<string, any>;
      const receipt = body.receipt as Record<string, any> | undefined;
      const execution = body.execution as Record<string, any> | undefined;
      const observation = body.observation as Record<string, any> | undefined;
      const receiptId = kind === "transaction" ? receipt?.transaction_id : receipt?.request_id;
      const executionRoot = await new ExecutionJournal(this.persistence, projectId, kind, requestId).root();
      const finalizationRef = execution?.finalization_ref;
      const finalizationPrefix = `${executionRoot}/finalizations/`;
      const validFinalizationRef = typeof finalizationRef === "string" && finalizationRef.startsWith(finalizationPrefix)
        && /^[a-f0-9]{64}\.json$/.test(finalizationRef.slice(finalizationPrefix.length));
      const receiptRevision = receipt?.new_revision;
      const receiptRefMatches = kind === "transaction"
        ? Number.isSafeInteger(receiptRevision) && typeof receiptRevision === "number" && receiptRevision > 0
          && execution?.receipt_ref === `${machineCommitRecordPath(projectId, receiptRevision)}#receipt`
        : kind === "document"
          ? execution?.receipt_ref === `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`
          : kind === "artifact" && execution?.receipt_ref === machineArtifactReceiptPath(requestId);
      const finalizedAndBound = body.project_id === projectId && body.kind === kind && body.request_id === requestId
        && body.status === "finalized"
        && receipt?.project_id === projectId && receiptId === requestId && receipt.status === "committed"
        && execution?.project_id === projectId && execution.kind === kind && execution.request_id === requestId
        && execution.status === "finalized" && execution.terminal === true
        && execution.admission_ref === `${executionRoot}/admission.json`
        && typeof execution.request_hash === "string" && /^[a-f0-9]{64}$/.test(execution.request_hash)
        && receiptRefMatches
        && validFinalizationRef
        && observation?.project_id === projectId && observation.kind === kind && observation.request_id === requestId
        && observation.status === "finalized" && observation.receipt_status === "committed"
        && observation.execution_status === "finalized" && observation.terminal === true;
      if (finalizedAndBound) return response;
    } catch {
      // A bounded read that is absent, malformed, mismatched, or unavailable
      // is still unknown while work is queued; it must never imply absence.
    }
    return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "PROJECT_OS_READ_BUSY");
  }

  protected async readBoundedRequestStatus(url: URL, correlationId: string, requireFinalizationProof = false): Promise<Response> {
    const projectId = this.ctx.id.name;
    const kind = url.searchParams.get("kind");
    const requestId = url.searchParams.get("request_id");
    if (!projectId || !requestId || !kind || !["transaction", "document", "artifact"].includes(kind)) {
      return Response.json({ error: "request_identity_required" }, { status: 400 });
    }
    const deadlineMs = Date.now() + this.observationReadDeadlineMs();
    const controller = new AbortController();
    let calls = 0;
    const runtime = createProductionPersistence(this.env, projectId, {
      deadlineMs,
      signal: controller.signal,
      now: () => Date.now(),
      beforeHttp: () => {
        if (Date.now() >= deadlineMs || calls >= 32) throw new Error("request_status_budget_exhausted");
        calls += 1;
      }
    });
    const repository = new ProjectRepository(runtime, this.layoutMode);
    const source = this.handleRequestStatus(url, correlationId, runtime, repository, requireFinalizationProof);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("request_status_deadline");
        controller.abort(error);
        reject(error);
      }, Math.max(1, deadlineMs - Date.now()));
    });
    try {
      return await Promise.race([source, timeout]);
    } catch {
      return this.unknownObservationResponse(projectId, kind, requestId, correlationId, "request_status_unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private observationReadDeadlineMs(): number {
    return 5_000;
  }

  private async replayStatusSideEffects(tx: Transaction, receipt: Receipt): Promise<void> {
    await this.recordTransactionExecutionReceipt(tx, receipt);
    if (receipt.status !== "committed" || !PROJECT_STATUS_OPERATIONS.has(tx.operation)) return;
    const currentState = await this.loadOrRecoverState();
    if (!currentState) return;
    await this.syncRegistryStatus(currentState);
  }

  private async recordTransactionExecutionReceipt(tx: Transaction, receipt: Receipt): Promise<void> {
    if (!this.strictAdmissionEnabled(tx.project_id)) return;
    const ref = receipt.status === "committed" && this.layoutMode === "v2"
      ? `${machineCommitRecordPath(tx.project_id, receipt.new_revision)}#receipt`
      : machineReceiptPath(tx.transaction_id);
    await new ExecutionJournal(this.persistence, tx.project_id, "transaction", tx.transaction_id).recordReceipt(receipt.status, ref);
  }

  /** Transaction commits have no independent provider effect plan. They become
   * finalized only when the immutable commit is covered by the current,
   * completed materialization ancestry. */
  private async finalizeMaterializedTransaction(
    journal: ExecutionJournal,
    verifiedMaterialization: MaterializationFinalizationCandidate,
    repository: ProjectRepository,
    work?: MaterializationFinalizationWork,
    budget?: { deadlineMs: number },
    controller?: AbortController
  ): Promise<void> {
    const admitted = await journal.readAdmission();
    const progress = await journal.status();
    if (
      !admitted
      || admitted.admission.kind !== "transaction"
      || admitted.plan !== null
      || !progress
      || progress.terminal
      || progress.status !== "finalizing"
    ) return;
    const targetRevision = admitted.admission.project_revision + 1;
    const commitRef = machineCommitRecordPath(admitted.admission.project_id, targetRevision);
    const receiptRef = `${commitRef}#receipt`;
    if (progress.receipt_ref !== receiptRef) return;
    const record = await repository.readCommitRecord(admitted.admission.project_id, targetRevision);
    if (
      !record
      || record.transaction.transaction_id !== admitted.admission.request_id
      || record.receipt.transaction_id !== admitted.admission.request_id
      || record.receipt.status !== "committed"
      || record.receipt.new_revision !== targetRevision
      || await sha256Canonical(record.transaction) !== admitted.admission.request_hash
    ) return;
    const materialization = await repository.readMaterializationRecord(
      admitted.admission.project_id,
      verifiedMaterialization.materialization_revision,
      verifiedMaterialization.projection_version
    );
    if (!materialization
      || materialization.result_root_hash !== verifiedMaterialization.result_root_hash
      || materialization.completed_at !== verifiedMaterialization.completed_at
      || materialization.source_event_id !== verifiedMaterialization.source_event_id
      || !(await this.verifiedCandidateCoversTransaction(
        verifiedMaterialization,
        materialization,
        targetRevision,
        record.event.event_id,
        repository,
        work,
        budget?.deadlineMs,
        controller?.signal
      ))) return;
    await journal.finalizeMaterializedTransaction({
      canonical_commit_ref: commitRef,
      receipt_ref: receiptRef,
      materialization_head_ref: machineMaterializationHeadPath(admitted.admission.project_id),
      materialization_record_ref: machineMaterializationRecordPath(
        admitted.admission.project_id,
        materialization.target_revision,
        materialization.projection_version
      ),
      target_revision: targetRevision,
      source_event_id: record.event.event_id,
      result_root_hash: materialization.result_root_hash
    });
  }

  /**
   * Current generations record every coalesced revision explicitly. A small
   * number of historical generations were published with a partial list even
   * though their immutable target state already covered the missing first
   * revision. Accept that legacy shape only after independently proving the
   * complete canonical commit range; normal direct status reads remain strict.
   */
  private async verifiedCandidateCoversTransaction(
    verified: MaterializationFinalizationCandidate,
    materialization: CompletedMaterializationRecord,
    targetRevision: number,
    targetEventId: string,
    repository?: ProjectRepository,
    work?: MaterializationFinalizationWork,
    deadlineMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (coversTransactionRevision(materialization, targetRevision, targetEventId)) return true;
    if (
      verified.coverage !== "canonical_range"
      || materialization.projection_version > MATERIALIZATION_FINALIZATION_LEGACY_INFERENCE_MAX_PROJECTION_VERSION
      || materialization.parent === null
      || targetRevision <= materialization.parent.target_revision
      || targetRevision >= materialization.target_revision
      || materialization.target_revision - materialization.parent.target_revision - 1 > MATERIALIZATION_FINALIZATION_INFERRED_RANGE_MAX
    ) return false;

    if (!repository || !work || deadlineMs === undefined || !signal) return false;

    const cursorBinding = {
      materialization_revision: materialization.target_revision,
      projection_version: materialization.projection_version,
      result_root_hash: materialization.result_root_hash,
      completed_at: materialization.completed_at,
      source_event_id: materialization.source_event_id,
      parent_revision: materialization.parent.target_revision
    };
    let cursor = work.legacy_range_cursor;
    if (!cursor || cursor.materialization_revision !== cursorBinding.materialization_revision
      || cursor.projection_version !== cursorBinding.projection_version
      || cursor.result_root_hash !== cursorBinding.result_root_hash
      || cursor.completed_at !== cursorBinding.completed_at
      || cursor.source_event_id !== cursorBinding.source_event_id
      || cursor.parent_revision !== cursorBinding.parent_revision
      || !Number.isSafeInteger(cursor.next_revision)
      || cursor.next_revision < cursor.parent_revision + 1
      || cursor.next_revision > materialization.target_revision + 1) {
      cursor = { ...cursorBinding, next_revision: materialization.parent.target_revision + 1, verified: false };
      work.legacy_range_cursor = cursor;
      await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
    }
    if (cursor.verified) return true;

    while (cursor.next_revision <= materialization.target_revision) {
      if (Date.now() >= deadlineMs || signal.aborted) {
        work.legacy_range_cursor = cursor;
        await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
        return false;
      }
      const revision = cursor.next_revision;
      let commit: CanonicalCommitRecord | null;
      try {
        commit = await repository.readCommitRecord(materialization.project_id, revision);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("slice_budget_exhausted")) throw error;
        work.legacy_range_cursor = cursor;
        await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
        return false;
      }
      if (
        !commit
        || commit.previous_revision !== revision - 1
        || commit.new_revision !== revision
        || commit.state.revision !== revision
        || commit.state.last_event_id !== commit.event.event_id
        || commit.receipt.status !== "committed"
        || commit.receipt.new_revision !== revision
        || commit.receipt.event_id !== commit.event.event_id
        || (revision === targetRevision && commit.event.event_id !== targetEventId)
      ) return false;
      cursor.next_revision += 1;
      if (cursor.next_revision > materialization.target_revision) cursor.verified = true;
      work.legacy_range_cursor = cursor;
      await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
    }
    return cursor.verified;
  }

  private async finalizeVerifiedArtifact(journal: ExecutionJournal): Promise<void> {
    const admitted = await journal.readAdmission();
    const progress = await journal.status();
    if (!admitted || admitted.admission.kind !== "artifact" || admitted.plan !== null || !progress
      || progress.terminal || progress.status !== "finalizing") return;
    const row = this.findArtifact(admitted.admission.request_id);
    if (!row) return;
    const request = parseArtifactWriteRequest(JSON.parse(row.request_json));
    const receipt = JSON.parse(row.receipt_json) as ArtifactWriteReceipt;
    const receiptRef = machineArtifactReceiptPath(request.request_id);
    if (request.project_id !== admitted.admission.project_id
      || await sha256Canonical(request) !== admitted.admission.request_hash
      || receipt.status !== "committed"
      || receipt.request_id !== request.request_id
      || receipt.project_id !== request.project_id
      || receipt.relative_path !== request.relative_path
      || receipt.content_sha256 !== request.content_sha256
      || progress.receipt_ref !== receiptRef) return;
    const status = await this.repository.artifactStatus(request);
    if (!status || status.verification_state !== "canonical_verified" || status.receipt_status !== "committed") return;
    await journal.finalizeVerifiedArtifact({
      receipt_ref: receiptRef,
      mutation_intent_ref: machineMutationIntentPath(request.project_id, request.request_id),
      destination_path: status.destination_path,
      content_sha256: request.content_sha256
    });
  }

  private async finalizeVerifiedDocument(journal: ExecutionJournal): Promise<void> {
    const admitted = await journal.readAdmission();
    const progress = await journal.status();
    if (!admitted || admitted.admission.kind !== "document" || admitted.plan !== null || !progress
      || progress.terminal || progress.status !== "finalizing") return;
    const row = this.findDocumentRequest(admitted.admission.request_id);
    if (!row) return;
    const request = parseManagedDocumentRequest(JSON.parse(row.request_json));
    if (request.operation === "navigation.reconcile") return;
    const receipt = JSON.parse(row.receipt_json) as ManagedDocumentReceipt | ManagedDocumentTerminalReceipt;
    const receiptRef = `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/receipt.json`;
    if (request.project_id !== admitted.admission.project_id
      || await sha256Canonical(request) !== admitted.admission.request_hash
      || receipt.status !== "committed"
      || receipt.request_id !== request.request_id
      || receipt.project_id !== request.project_id
      || !receipt.provider_rev
      || progress.receipt_ref !== receiptRef) return;
    await journal.finalizeVerifiedDocument({
      receipt_ref: receiptRef,
      document_id: receipt.document_id,
      version_id: receipt.version_id,
      stage: receipt.stage,
      logical_path: receipt.logical_path,
      provider_rev: receipt.provider_rev
    });
  }

  private async finalizeCurrentMaterialization(request: Request, armInitialWake = true): Promise<Response> {
    const body: { target_revision?: unknown; projection_version?: unknown } = await request
      .json<{ target_revision?: unknown; projection_version?: unknown }>()
      .catch(() => ({}));
    if (!Number.isSafeInteger(body.target_revision) || !Number.isSafeInteger(body.projection_version)) {
      return Response.json({ error: "invalid_materialization_finalization_request" }, { status: 400 });
    }
    const projectId = this.ctx.id.name;
    if (!projectId) return Response.json({ error: "project_binding_required" }, { status: 400 });
    const target: MaterializationFinalizationRequest = {
      target_revision: body.target_revision as number,
      projection_version: body.projection_version as number
    };
    const startedAt = Date.now();
    const deadlineMs = startedAt + this.materializationFinalizationSliceBudgetMs();
    const controller = new AbortController();
    const budget = { calls: 0, deadlineMs, exhausted: false };
    const scope: ProviderRequestScope = {
      deadlineMs,
      signal: controller.signal,
      now: () => Date.now(),
      beforeHttp: () => {
        if (Date.now() >= deadlineMs || budget.calls >= this.materializationFinalizationProviderCallBudget()) {
          budget.exhausted = true;
          throw new Error("materialization_finalization_slice_budget_exhausted");
        }
        budget.calls += 1;
      }
    };
    const runtime = createProductionPersistence(this.env, projectId, scope);
    const repository = new ProjectRepository(runtime, this.layoutMode);
    // Persist the exact wake target before the first provider read. On an
    // eviction between this point and the response, the alarm owns the retry.
    await this.persistMaterializationFinalizationRequest(target, armInitialWake);
    const abortAtDeadline = setTimeout(
      () => controller.abort(new Error("materialization_finalization_slice_budget_exhausted")),
      Math.max(1, deadlineMs - Date.now())
    );
    try {
      return await this.finalizeCurrentMaterializationSlice(projectId, target, runtime, repository, budget, controller);
    } catch (error) {
      if (!budget.exhausted && Date.now() < deadlineMs && !controller.signal.aborted
        && !(error instanceof Error && error.message === "materialization_finalization_slice_budget_exhausted")) throw error;
      await this.armMaterializationFinalizationAlarm();
      return Response.json({
        project_id: projectId,
        target_revision: target.target_revision,
        finalization_pending: true,
        code: "materialization_finalization_slice_budget_exhausted"
      }, { status: 202 });
    } finally {
      clearTimeout(abortAtDeadline);
    }
  }

  private materializationFinalizationSliceBudgetMs(): number {
    return MATERIALIZATION_FINALIZATION_SLICE_MS - MATERIALIZATION_FINALIZATION_CHECKPOINT_RESERVE_MS;
  }

  private materializationFinalizationProviderCallBudget(): number {
    return MATERIALIZATION_FINALIZATION_PROVIDER_CALL_BUDGET;
  }

  private async finalizeCurrentMaterializationSlice(
    projectId: string,
    target: MaterializationFinalizationRequest,
    runtime: ProjectOsPersistenceRuntime,
    repository: ProjectRepository,
    budget: { calls: number; deadlineMs: number; exhausted: boolean },
    controller: AbortController
  ): Promise<Response> {
    const head = await repository.readMaterializationHead(projectId);
    if (!head
      || head.target_revision !== target.target_revision
      || head.projection_version !== target.projection_version) {
      if (head) {
        if (head.projection_version === target.projection_version && head.target_revision > target.target_revision) {
          const newerRecord = await repository.readMaterializationRecord(
            projectId,
            head.target_revision,
            head.projection_version
          );
          const newerCommit = await repository.readCommitRecord(projectId, head.target_revision);
          if (newerRecord
            && newerCommit
            && newerRecord.target_revision === head.target_revision
            && newerRecord.projection_version === head.projection_version
            && newerRecord.result_root_hash === head.result_root_hash
            && newerRecord.workspace_location === head.workspace_location
            && newerRecord.completed_at === head.completed_at
            && newerRecord.source_event_id === newerCommit.event.event_id) {
            const newerTarget = {
              target_revision: head.target_revision,
              projection_version: head.projection_version
            };
            await this.persistMaterializationFinalizationRequest(newerTarget);
            await this.ctx.storage.delete(MATERIALIZATION_FINALIZATION_WORK_KEY);
            await this.armMaterializationFinalizationAlarm();
            return Response.json({
              project_id: projectId,
              target_revision: head.target_revision,
              finalization_pending: true,
              code: "materialization_head_advanced"
            }, { status: 202 });
          }
        }
      }
      return Response.json({ error: "materialization_head_mismatch" }, { status: 409 });
    }
    const record = await repository.readMaterializationRecord(
      projectId,
      head.target_revision,
      head.projection_version
    );
    if (!record
      || record.result_root_hash !== head.result_root_hash
      || record.workspace_location !== head.workspace_location
      || record.completed_at !== head.completed_at) {
      await this.armMaterializationFinalizationAlarm();
      return Response.json({ error: "materialization_evidence_unavailable", finalization_pending: true }, { status: 202 });
    }
    // A current head can be a descendant of the generation that covered a
    // committed transaction. The lineage can be long in a busy project, so
    // store a short, durable cursor instead of holding this ProjectGuard's
    // serialized queue while reading every historical generation.
    const expectedHead = {
      target_revision: head.target_revision,
      projection_version: head.projection_version,
      result_root_hash: head.result_root_hash,
      completed_at: head.completed_at
    };
    let work = await this.ctx.storage.get<MaterializationFinalizationWork>(MATERIALIZATION_FINALIZATION_WORK_KEY);
    if (
      !work
      || work.coverage_version !== MATERIALIZATION_FINALIZATION_COVERAGE_VERSION
      || !sameFinalizationHead(work.head, expectedHead)
    ) {
      work = {
        coverage_version: MATERIALIZATION_FINALIZATION_COVERAGE_VERSION,
        head: expectedHead,
        next_generation: { target_revision: record.target_revision, projection_version: record.projection_version },
        previous_child: null,
        scan_complete: false,
        candidates: [],
        legacy_range_cursor: null
      };
    }
    // Establish a durable baseline cursor before provider work in this slice.
    await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);

    if (!work.scan_complete) {
      const queued = new Set(work.candidates.map((candidate) => candidate.revision));
      for (let count = 0; count < MATERIALIZATION_FINALIZATION_LINEAGE_BATCH_SIZE && work.next_generation; count += 1) {
        const generation = work.next_generation;
        const candidate = generation.target_revision === record.target_revision
          && generation.projection_version === record.projection_version
          ? record
          : await repository.readMaterializationRecord(projectId, generation.target_revision, generation.projection_version);
        if (!candidate) {
          await this.armMaterializationFinalizationAlarm();
          return Response.json({ error: "materialization_evidence_unavailable", finalization_pending: true }, { status: 202 });
        }
        if (work.previous_child === null) {
          if (candidate.target_revision !== expectedHead.target_revision
            || candidate.projection_version !== expectedHead.projection_version
            || candidate.result_root_hash !== expectedHead.result_root_hash
            || candidate.completed_at !== expectedHead.completed_at) {
            return Response.json({ error: "materialization_evidence_unavailable" }, { status: 409 });
          }
        } else if (
          work.previous_child.target_revision <= candidate.target_revision
          || work.previous_child.projection_version !== candidate.projection_version
          || work.previous_child.chain_depth !== candidate.chain_depth + 1
        ) {
          return Response.json({ error: "materialization_chain_invalid" }, { status: 409 });
        }
        if (candidate.parent !== null
          && candidate.projection_version > MATERIALIZATION_FINALIZATION_LEGACY_INFERENCE_MAX_PROJECTION_VERSION) {
          const expectedCoalescedCount = candidate.target_revision - candidate.parent.target_revision - 1;
          const orderedCoalesced = [...candidate.coalesced_revisions].sort((left, right) => left - right);
          const hasExactCoalescence = orderedCoalesced.length === expectedCoalescedCount
            && orderedCoalesced.every((revision, index) => revision === candidate.parent!.target_revision + index + 1);
          if (!hasExactCoalescence) {
            appendFinalizationCandidate(work, candidate, candidate.target_revision, queued);
            for (const revision of candidate.coalesced_revisions) appendFinalizationCandidate(work, candidate, revision, queued);
            work.uncovered_ranges = missingCoalescedRevisionRanges(
              candidate.parent.target_revision,
              candidate.target_revision,
              candidate.coalesced_revisions
            );
            await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
            return Response.json({ error: "materialization_coalescence_gap" }, { status: 409 });
          }
        }
        appendFinalizationCandidate(work, candidate, candidate.target_revision, queued);
        for (const revision of candidate.coalesced_revisions) appendFinalizationCandidate(work, candidate, revision, queued);
        if (
          candidate.parent !== null
          // Only legacy records that retained a partial tail can prove that
          // a historical coalescence happened. An empty list is not evidence
          // of a jump and must remain strict.
          && candidate.coalesced_revisions.length > 0
          && candidate.projection_version <= MATERIALIZATION_FINALIZATION_LEGACY_INFERENCE_MAX_PROJECTION_VERSION
          && candidate.target_revision - candidate.parent.target_revision - 1 <= MATERIALIZATION_FINALIZATION_INFERRED_RANGE_MAX
        ) {
          for (let revision = candidate.parent.target_revision + 1; revision < candidate.target_revision; revision += 1) {
            if (!candidate.coalesced_revisions.includes(revision)) {
              appendFinalizationCandidate(work, candidate, revision, queued, "canonical_range");
            }
          }
        }
        if (candidate.parent === null) {
          if (candidate.record_kind !== "snapshot" || candidate.chain_depth !== 0) {
            return Response.json({ error: "materialization_chain_invalid" }, { status: 409 });
          }
          work.next_generation = null;
          work.scan_complete = true;
          await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
          break;
        }
        if (candidate.record_kind !== "delta"
          || candidate.parent.target_revision >= candidate.target_revision
          || candidate.parent.projection_version !== candidate.projection_version
          || candidate.chain_depth > MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH) {
          return Response.json({ error: "materialization_chain_invalid" }, { status: 409 });
        }
        work.previous_child = {
          target_revision: candidate.target_revision,
          projection_version: candidate.projection_version,
          chain_depth: candidate.chain_depth
        };
        work.next_generation = candidate.parent;
        // The verified lineage cursor is durable before any following provider
        // read can consume the remaining slice.
        await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
      }
    }

    const finalizedRevisions: number[] = [];
    if (work.scan_complete) {
      let processed = 0;
      while (processed < MATERIALIZATION_FINALIZATION_CERTIFICATE_BATCH_SIZE && work.candidates.length > 0) {
        if (Date.now() >= budget.deadlineMs || controller.signal.aborted) {
          throw new Error("materialization_finalization_slice_budget_exhausted");
        }
        const candidate = work.candidates[0]!;
        // Every candidate consumes the bounded slice, including missing or
        // already-terminal work. Otherwise a large historical tail can hold
        // the serialized ProjectGuard callback indefinitely.
        processed += 1;
        const commit = await repository.readCommitRecord(projectId, candidate.revision);
        if (!commit || commit.receipt.status !== "committed" || commit.receipt.new_revision !== candidate.revision) {
          work.candidates.shift();
          await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
          continue;
        }
        const journal = new ExecutionJournal(runtime, projectId, "transaction", commit.transaction.transaction_id);
        const before = await journal.status();
        if (!before || before.terminal) {
          work.candidates.shift();
          await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
          continue;
        }
        await this.finalizeMaterializedTransaction(journal, candidate, repository, work, budget, controller);
        const after = await journal.status();
        if (after?.terminal && after.status === "finalized") {
          finalizedRevisions.push(candidate.revision);
          work.candidates.shift();
          await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
        } else {
          // Peek until all evidence checks and the certificate write succeed.
          // A provider failure therefore cannot lose the exact candidate.
          break;
        }
      }
    }
    const finalizationPending = !work.scan_complete || work.candidates.length > 0;
    if (finalizationPending) {
      await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_WORK_KEY, work);
      await this.ctx.storage.put(MATERIALIZATION_FINALIZATION_REQUEST_KEY, target);
    } else {
      await this.ctx.storage.delete(MATERIALIZATION_FINALIZATION_WORK_KEY);
      await this.ctx.storage.delete(MATERIALIZATION_FINALIZATION_REQUEST_KEY);
    }
    return Response.json({
      project_id: projectId,
      target_revision: head.target_revision,
      finalized_revisions: finalizedRevisions,
      finalization_pending: finalizationPending
    }, { status: finalizationPending ? 202 : 200 });
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
      "INSERT INTO artifact_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING",
      request.request_id,
      JSON.stringify(request),
      JSON.stringify(receipt)
    );
  }

  private persistDocumentRequest(
    request: ManagedDocumentRequest,
    receipt: StoredDocumentReceipt
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO document_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING",
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
      ...(isReviewCandidate(request) ? { operation: "REVIEW_CANDIDATE" as const, accepted: false as const, published: false as const } : {}),
      ...(code ? { code } : {}),
      ...(message ? { message } : {})
    };
  }

  private documentTerminalReceipt(
    request: ManagedDocumentRequest,
    status: ManagedDocumentTerminalReceipt["status"],
    code: string,
    message: string,
    documentId?: string
  ): ManagedDocumentTerminalReceipt {
    return {
      request_id: request.request_id,
      project_id: request.project_id,
      status,
      code,
      message,
      ...(documentId ? { document_id: documentId } : {})
    };
  }

  private persistCommit(state: ProjectState, receipt: Receipt): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO project_state (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
        JSON.stringify(state)
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO transactions (transaction_id, status, receipt_json) VALUES (?, ?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET status = excluded.status, receipt_json = excluded.receipt_json`,
        receipt.transaction_id,
        receipt.status,
        JSON.stringify(receipt)
      );
    });
    if (this.layoutMode === "v2") this.contextVerifiedState = normalizeProjectState(state);
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

  /** Do not turn a racing, not-yet-persisted receipt into a false 404. A
   * pending mutation yields a prompt, explicitly unknown status instead. */
  private readWhenIdle(operation: () => Promise<Response>): Promise<Response> {
    if (this.queueDepth > 0) {
      return Promise.resolve(Response.json({ status: "unavailable", code: "PROJECT_OS_READ_BUSY", retry_after_seconds: 1 }, {
        status: 503,
        headers: { "Retry-After": "1" }
      }));
    }
    return this.serialize(operation);
  }

  protected async serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      this.queueDepth -= 1;
      release();
    }
  }
}

function sameFinalizationHead(
  left: MaterializationFinalizationWork["head"],
  right: MaterializationFinalizationWork["head"]
): boolean {
  return left.target_revision === right.target_revision
    && left.projection_version === right.projection_version
    && left.result_root_hash === right.result_root_hash
    && left.completed_at === right.completed_at;
}

function appendFinalizationCandidate(
  work: MaterializationFinalizationWork,
  record: CompletedMaterializationRecord,
  revision: number,
  queued: Set<number>,
  coverage: MaterializationFinalizationCandidate["coverage"] = "explicit"
): void {
  if (queued.has(revision)) return;
  queued.add(revision);
  work.candidates.push({
    revision,
    coverage,
    materialization_revision: record.target_revision,
    projection_version: record.projection_version,
    result_root_hash: record.result_root_hash,
    completed_at: record.completed_at,
    source_event_id: record.source_event_id
  });
}

function missingCoalescedRevisionRanges(
  parentRevision: number,
  targetRevision: number,
  coalescedRevisions: number[]
): Array<{ from_revision: number; to_revision: number }> {
  const ranges: Array<{ from_revision: number; to_revision: number }> = [];
  const ordered = [...coalescedRevisions].sort((left, right) => left - right);
  let nextRevision = parentRevision + 1;
  let malformed = false;
  for (const revision of ordered) {
    if (!Number.isSafeInteger(revision) || revision < parentRevision + 1 || revision >= targetRevision) {
      malformed = true;
      continue;
    }
    if (revision < nextRevision) {
      malformed = true;
      continue;
    }
    if (revision > nextRevision) ranges.push({ from_revision: nextRevision, to_revision: revision - 1 });
    nextRevision = revision + 1;
  }
  if (nextRevision < targetRevision) ranges.push({ from_revision: nextRevision, to_revision: targetRevision - 1 });
  // A malformed list with no explicit hole makes the entire claimed span
  // unverifiable; keep it visible without treating any revision as covered.
  if (malformed && ranges.length === 0 && targetRevision > parentRevision + 1) {
    return [{ from_revision: parentRevision + 1, to_revision: targetRevision - 1 }];
  }
  return ranges;
}

function coversTransactionRevision(
  record: CompletedMaterializationRecord,
  revision: number,
  eventId: string
): boolean {
  return (record.target_revision === revision && record.source_event_id === eventId)
    || record.coalesced_revisions.includes(revision);
}

function sameProviderObject(left: ProviderObjectMetadata, right: ProviderObjectMetadata): boolean {
  return left.path === right.path && left.objectId === right.objectId && left.revisionToken === right.revisionToken
    && left.integrityHash?.algorithm === right.integrityHash?.algorithm && left.integrityHash?.value === right.integrityHash?.value;
}

/** Carries each immutable object identity on its own canonical path.  In
 * particular, a head revision is never presented as evidence for a version
 * record, even when both records point at the same document lifecycle state. */
function providerEvidenceReference(metadata: ProviderObjectMetadata): string | null {
  if (!metadata.path || !metadata.objectId || !metadata.revisionToken || !metadata.integrityHash?.algorithm || !metadata.integrityHash.value) return null;
  return `${metadata.path}#object_id=${encodeURIComponent(metadata.objectId)}&revision_token=${encodeURIComponent(metadata.revisionToken)}&integrity_hash_algorithm=${encodeURIComponent(metadata.integrityHash.algorithm)}&integrity_hash=${encodeURIComponent(metadata.integrityHash.value)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
