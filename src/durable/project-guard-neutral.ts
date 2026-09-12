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
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
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
import { ManagedDocumentConflictError, ManagedDocumentService, type ManagedDocumentReceipt } from "../documents/service";
import { DocumentLedgerRepository } from "../documents/repository";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { requestMaterializationTargetSafely } from "../materialization/handoff";
import { MutationIntentConflictError } from "../mutation-gate/repository";
import { parseLayoutMode, machineCommitRecordPath, machineReceiptPath, machineArtifactReceiptPath, machineDocumentRoot, machineDocumentHeadPath, machineDocumentVersionPath, type LayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ArtifactContentConflictError, ProjectRepository } from "../persistence/repository";
import { parseMutationGateMode } from "../mutation-gate/service";
import { AdmissionError, issueMutationContext, verifyMutationContext, type MutationContext } from "../admission/mutation-context";
import { normalizeArtifactAdmission, normalizeDocumentAdmission, normalizeSystemAdmission, normalizeTransactionAdmission, type NormalizedAdmissionOperation } from "../admission/operation-context";
import { RuleAdmissionError, verifyRuleAdmissionPermit, type RuleAdmissionInput, type RuleAdmissionPermit } from "../admission/rule-admission";
import { decodeAdmission } from "../admission/transport";
import { discoverCanonical } from "../convergence/discovery";
import { initialProgress } from "../convergence/journal";
import { sha256Canonical } from "../materialization/hash";
import {
  admissionModeForProject,
  assertCapacity,
  convergenceModeForProject,
  type CapacityObservation
} from "../convergence/rollout";
import { freshnessRejectionMetric, workerLogConvergenceTelemetry } from "../convergence/observability";
import { deploymentIdentity } from "../deployment/identity";
import { evaluateRules } from "../rules/evaluator";
import type { EvaluationResult, RuleObservation } from "../rules/contract";
import type { GlobalGovernanceState } from "../domain/rule-governance";
import { ruleVersionSchema } from "../domain/rule-governance";
import { matchesResource } from "../rules/resolution";
import { ExecutionJournal } from "../execution/journal";
import type { ExecutionAdmission, ExecutionAdapter, ExecutionPlan } from "../execution/contract";
import { ExecutionCoordinator } from "../execution/coordinator";
import { authorizeRepair, normalizeRepairAdmission, parseRepairIntent, unavailableRepairEvidence, type RepairEvidenceResolver } from "../execution/repair";

interface TransactionRow {
  [key: string]: SqlStorageValue;
  receipt_json: string;
}

interface ArtifactRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
}

interface DocumentRequestRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
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

type ManagedDocumentOperationReceipt = ManagedDocumentReceipt | ManagedDocumentTerminalReceipt;

const PROJECT_STATUS_OPERATIONS = new Set<Transaction["operation"]>([
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive"
]);

class RuleAdmissionRejection extends Error {
  constructor(readonly evaluation: EvaluationResult) {
    super(evaluation.code);
  }
}

interface AdmissionProof {
  project_id: string;
  operation: string;
  resources: NormalizedAdmissionOperation["resources"];
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
  protected readonly layoutMode: LayoutMode;
  private queue: Promise<void> = Promise.resolve();

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
      }
    );
    this.managedDocumentRequests = new ManagedDocumentRequestLedger(this.persistence.objects);
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
      return this.serialize(async () => {
        const projectId = this.ctx.id.name;
        const kind = url.searchParams.get("kind");
        const requestId = url.searchParams.get("request_id");
        if (!projectId || !kind || !requestId) return Response.json({ error: "execution_identity_required" }, { status: 400 });
        const status = await new ExecutionJournal(this.persistence, projectId, kind, requestId).status();
        return status ? Response.json(status) : Response.json({ error: "execution_not_found" }, { status: 404 });
      }).catch((error) => this.admissionErrorResponse(error));
    }

    if (request.method === "POST" && pathname === "/reconcile-documents") {
      return this.serialize(async () => {
        const state = await this.loadOrRecoverState();
        if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
        // A supplied body is always a typed repair request.  It must not be
        // ignored merely because this project is still in the legacy rollout:
        // repair authorization is bound to the signed intent and exact
        // server-side diagnosis below.
        if (request.body) return this.handleTypedRepair(request, state);
        const normalized = await normalizeSystemAdmission(
          state.project_id, "project.repair", "DOCUMENTS", `document-reconcile@${state.revision}`, String(state.revision)
        );
        if (await this.ruleAdmissionRequired(state, normalized)) {
          const proof = await this.admitRules(state, normalized);
          await this.persistAdmissionProof("document-reconcile", `document-reconcile@${state.revision}`, proof);
        }
        return Response.json(await this.managedDocumentChanges.reconcile(state, {
          scheduled: url.searchParams.get("scheduled") === "1"
        }));
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

    if (request.method === "POST" && pathname === "/materialize") {
      return this.handleMaterializationMutation(request, "/materialize", "project.materialize");
    }

    if (request.method === "GET" && pathname === "/mutation-context") {
      return this.serialize(() => this.handleMutationContextRead(request));
    }

    if (request.method === "GET" && pathname === "/receipt") {
      return this.serialize(() => this.handleReceiptRead(new URL(request.url)));
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
        const localState = this.loadState();
        if (this.strictAdmissionEnabled(tx.project_id) && localState) {
          await this.verifyAdmission(mutationContext, tx, localState);
        }
        reconciledState = await this.reconcileCanonicalCommits();
        const reconciled = this.findReceipt(tx.transaction_id);
        if (reconciled) {
          await this.verifyCommittedReplayPayload(tx, reconciled);
          await this.replayStatusSideEffects(tx, reconciled);
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
        return Response.json(canonicalReceipt);
      }

      const admissionState = reconciledState ?? await this.loadOrRecoverState();
      const normalized = await normalizeTransactionAdmission(tx);
      if (!admissionState && this.strictAdmissionEnabled(tx.project_id)) throw new AdmissionError("canonical_unavailable", 503);
      if (admissionState && await this.ruleAdmissionRequired(admissionState, normalized)) {
        await this.verifyAdmission(mutationContext, tx, admissionState);
        const proof = await this.admitRules(admissionState, normalized, mutationContext!.actor);
        await this.persistAdmissionProof("transaction", tx.transaction_id, proof);
      }

      // A refused strict admission must not reserve an idempotency key.  Only
      // bind this intent after the verified permit and second rules evaluation.
      await this.ensureTransactionIntent(tx);

      const state = this.layoutMode === "v2"
        ? reconciledState
        : await this.loadOrRecoverState();
      await this.assertCommitCapacity(tx.project_id);
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
      return Response.json(receipt);
    }).catch((error) => this.admissionErrorResponse(error));
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
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
      if (existingReceipt.status === "committed") await this.repository.cleanupStagedArtifact(artifact);
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
      return Response.json(JSON.parse(existing.receipt_json) as ManagedDocumentOperationReceipt);
    }

    if (this.ctx.id.name && this.ctx.id.name !== operation.project_id) {
      return Response.json(this.documentTerminalReceipt(
        operation,
        "rejected",
        "PROJECT_BINDING_MISMATCH",
        "Durable Object binding does not match managed document project_id"
      ));
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
      const proof = await this.admitRules(state, normalized, mutationContext.actor);
      if (operation.expected_project_revision !== state.revision) return Response.json({ status: "conflict", code: "PACKAGE_PROJECT_REVISION_CONFLICT" });
      await this.managedDocumentRequests.ensureIntent(operation.project_id, operation.request_id, serialized);
      const durable = await this.managedDocumentRequests.readReceipt(operation.project_id, operation.request_id);
      if (durable) return Response.json(JSON.parse(durable.receipt_json));
      try {
        let receipt: unknown;
        if (operation.operation === "package.freeze") {
          await this.persistAdmissionProof("document", operation.request_id, proof);
          const candidate = await this.managedDocumentService.freezePackageDocument(operation, state);
          receipt = { request_id: operation.request_id, project_id: operation.project_id, status: "committed", candidate };
        } else {
          const global = await this.readGlobalGovernance();
          if (global.revision !== proof.global_revision) throw new Error("package_ruleset_changed");
          const progress = await this.managedDocumentService.replacePackage(operation, state, { ...proof, kind: "document", request_id: operation.request_id }, { effectBudget: 20, postcheckRules: [...Object.values(global.rules), ...Object.values(state.local_rules)] });
          if (progress.status !== "finalized") return Response.json(progress);
          receipt = { request_id: operation.request_id, project_id: operation.project_id, status: "committed", execution_status: "finalized", candidate: operation.candidate, finalization_ref: progress.finalization_ref };
        }
        await this.managedDocumentRequests.writeReceipt(operation.project_id, operation.request_id, serialized, JSON.stringify(receipt));
        return Response.json(receipt);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("package_")) return Response.json({ request_id: operation.request_id, project_id: operation.project_id, status: "conflict", code: error.message });
        throw error;
      }
    }
    if (rulesRequired) await this.persistAdmissionProof("document", operation.request_id, await this.admitRules(state, normalized, mutationContext!.actor));

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
      throw error;
    }

    const durableReceipt = await this.managedDocumentRequests.readReceipt(operation.project_id, operation.request_id);
    if (durableReceipt) {
      const receipt = JSON.parse(durableReceipt.receipt_json) as ManagedDocumentOperationReceipt;
      this.persistDocumentRequest(operation, receipt);
      return Response.json(receipt);
    }

    try {
      const receipt = await this.executeManagedDocument(operation, state);
      return this.finalizeDocument(operation, receipt);
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
      throw error;
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

  private async executeManagedDocument(
    request: ManagedDocumentRequest,
    state: ProjectState
  ): Promise<ManagedDocumentReceipt> {
    switch (request.operation) {
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
      case "reference.classify":
        return this.managedDocumentService.classifyReference(request, state);
    }
  }

  private async finalizeArtifact(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): Promise<Response> {
    if (isReviewCandidate(request)) await this.repository.reviewJournal.recordTerminal(request, receipt);
    await this.repository.writeArtifactReceipt(receipt);
    if (this.strictAdmissionEnabled(request.project_id)) await new ExecutionJournal(this.persistence, request.project_id, "artifact", request.request_id).recordReceipt(receipt.status, machineArtifactReceiptPath(request.request_id));
    this.persistArtifact(request, receipt);
    if (receipt.status === "committed") await this.repository.cleanupStagedArtifact(request);
    return Response.json(receipt);
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
    if (this.strictAdmissionEnabled(request.project_id)) await new ExecutionJournal(this.persistence, request.project_id, "document", request.request_id).recordReceipt(receipt.status, `${machineDocumentRoot(request.project_id)}/requests/${request.request_id}/receipt.json`);
    this.persistDocumentRequest(request, receipt);
    return Response.json(receipt);
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
    const progress = initialProgress(projectId, new Date().toISOString(), crypto.randomUUID());
    let latest: ProjectState | null = null;
    const historicalSnapshot = await this.repository.readProjectState(projectId);
    if (historicalSnapshot) {
      // Older projects predate the immutable commit log. Their validated
      // machine snapshot is a read-only baseline; discovery still requires a
      // contiguous immutable chain for every later revision.
      progress.canonical_observed_revision = historicalSnapshot.revision;
      progress.baseline_revision = historicalSnapshot.revision;
      progress.baseline_kind = "pre_commit001";
      latest = historicalSnapshot;
    }
    for (let page = 0; page < 4; page += 1) {
      const budget = {
        deadline_ms: Number.MAX_SAFE_INTEGER,
        calls_left: 1024,
        now: () => Date.now(),
        signal: new AbortController().signal,
        beforeHttp() { this.calls_left -= 1; },
        canStartEffect: () => true
      };
      const discovered = await discoverCanonical(this.repository, this.persistence, progress, budget);
      if (!discovered) {
        if (!latest) return Response.json({ error: "canonical_unavailable" }, { status: 503 });
        const context = await issueMutationContext(latest, secret, Date.now(), this.contextActor(request));
        return Response.json({ context, canonical_state: latest });
      }
      latest = discovered.state;
      progress.canonical_observed_revision = discovered.state.revision;
      if (discovered.complete) {
        const context = await issueMutationContext(discovered.state, secret, Date.now(), this.contextActor(request));
        return Response.json({ context, canonical_state: discovered.state });
      }
    }
    return Response.json({ error: "canonical_unavailable" }, { status: 503 });
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
    } catch {
      throw new AdmissionError("convergence_capacity_exceeded", 503);
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
    if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
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

  private async reconcileCanonicalCommits(): Promise<ProjectState | null> {
    const projectId = this.ctx.id.name;
    if (!projectId) return this.loadState();

    let recoveredCanonicalState = false;
    let state = this.loadState();
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

  private async handleMaterializationMutation(request: Request, targetPath: string, operation: "project.materialize" | "project.repair"): Promise<Response> {
    const body = await request.text();
    return this.serialize(async () => {
      const projectId = this.ctx.id.name;
      if (!projectId || projectId === AUTO_PROJECT_ID) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      const state = await this.loadOrRecoverState();
      if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      if (operation === "project.repair" && body) {
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

  private async handleReceiptRead(url: URL): Promise<Response> {
    const requestId = url.searchParams.get("request_id");
    const kind = url.searchParams.get("kind");
    if (!requestId || !["transaction", "document", "artifact"].includes(kind ?? "")) {
      return Response.json({ error: "invalid_receipt_query" }, { status: 400 });
    }
    const row = kind === "transaction"
      ? this.findReceipt(requestId)
      : kind === "document"
        ? this.findDocumentRequest(requestId)
        : this.findArtifact(requestId);
    const receipt = row && typeof row === "object" && "receipt_json" in row
      ? JSON.parse(row.receipt_json)
      : row;
    return receipt ? Response.json(receipt) : Response.json({ error: "receipt_not_found" }, { status: 404 });
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

  private persistDocumentRequest(
    request: ManagedDocumentRequest,
    receipt: ManagedDocumentOperationReceipt
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO document_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)",
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

  protected async serialize<T>(operation: () => Promise<T>): Promise<T> {
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
