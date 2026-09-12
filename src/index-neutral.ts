import { isReviewCandidate } from "./domain/artifact-write";
import { checkCatalogue } from "./rules/check-catalogue";
import { ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION, ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION } from "./inbox/runtime";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "./domain/artifact-write";
import { parseArtifactWriteRequest } from "./domain/artifact-write";
import { binaryArtifactPolicyViolation } from "./artifacts/policy";
import { continuityStatus } from "./continuity/policy";
import { executeWithRollback, type TransactionExecutor } from "./continuity/rollback";
import type { ConvergenceHealth } from "./convergence/contract";
import type { Env } from "./env";
import { parseManagedDocumentRequest, type ManagedDocumentRequest } from "./domain/managed-document-request";
import { countProjectInputFiles } from "./documents/input-recovery";
import type { Receipt } from "./domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "./domain/transaction";
import {
  artifactInboxPath,
  inboxPath,
  processArtifactInbox,
  processTransactionInbox,
  type InboxProcessSummary
} from "./inbox/processor";
import { mirrorLegacyEvents, mirrorLegacyLedger } from "./migration/workspace-v2";
import { parseLayoutMode } from "./persistence/layout";
import { assertSafeProjectId } from "./persistence/paths";
import { createProductionPersistence } from "./persistence/production-factory";
import { parseSearchQuery, type SearchFreshness, type SearchIndexProjectStatus } from "./search/contract";
import { searchSyncEnabled } from "./search/sync-mode";
import { verifyDropboxSignature } from "./webhook/dropbox";
import { AdmissionError, type MutationContext, type MutationContextResponse } from "./admission/mutation-context";
import { decodeAdmission } from "./admission/transport";
import { renderState } from "./render/state";
import { renderHandoff } from "./render/handoff";

export { ProjectGuard } from "./durable/project-guard";
export { RegistryGuard } from "./durable/registry-guard";
export { inboxPath, artifactInboxPath } from "./inbox/processor";

const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
const OPERATOR_TOKEN_FUTURE_SKEW_MS = 60_000;

export function runScheduledMaintenance<TInbox, TMaterialization, TDocuments, TSearch>(jobs: {
  inbox: () => Promise<TInbox>;
  materialization: () => Promise<TMaterialization>;
  documents: () => Promise<TDocuments>;
  search: () => Promise<TSearch>;
}): Promise<[TInbox, TMaterialization, TDocuments, TSearch]> {
  return Promise.all([jobs.inbox(), jobs.materialization(), jobs.documents(), jobs.search()]);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/continuity") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(continuityStatus(env.PROJECT_OS_CONTINUITY_MODE));
    }

    if (request.method === "GET" && url.pathname === "/dropbox/webhook") {
      const challenge = url.searchParams.get("challenge");
      if (challenge === null) return new Response("missing challenge", { status: 400 });
      return new Response(challenge, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/dropbox/webhook") {
      const rawBody = await request.text();
      const valid = await verifyDropboxSignature(env.DROPBOX_APP_SECRET, rawBody, request.headers.get("x-dropbox-signature"));
      if (!valid) return new Response("invalid signature", { status: 401 });
      ctx.waitUntil(Promise.all([processInbox(env), reconcileManagedDocuments(env)]).then(() => undefined));
      return new Response("", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/workspace-v2/materialize") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return materializeExistingProjects(request, env);
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/workspace-v2/status") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const projectId = url.searchParams.get("project_id");
      if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
        return Response.json({ error: "invalid_project_id" }, { status: 400 });
      }
      return env.PROJECT_GUARD.getByName(projectId).fetch(
        "https://project-guard.internal/materialization-diagnostic-status"
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/workspace-v2/migrate-ledger") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        return Response.json(await migrateLegacyLedger(env));
      } catch (error) {
        return Response.json({
          error: "ledger_migration_failed",
          message: error instanceof Error ? error.message : String(error)
        }, { status: 502 });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/process-inbox") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
      try {
        const summary = await processInbox(env);
        return Response.json({
          mode,
          inbox: inboxPath(mode),
          artifact_inbox: artifactInboxPath(mode),
          ...summary
        });
      } catch (error) {
        return Response.json({
          error: "inbox_processing_failed",
          mode,
          inbox: inboxPath(mode),
          artifact_inbox: artifactInboxPath(mode),
          message: error instanceof Error ? error.message : String(error)
        }, { status: 502 });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/recover-inputs") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return recoverInputs(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/search") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return searchProjectOs(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/transactions") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let transaction: Transaction;
      let mutationContext: MutationContext | null;
      try {
        const admission = decodeAdmission(await request.json(), parseTransaction);
        transaction = admission.request;
        mutationContext = admission.mutation_context;
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        return Response.json({
          error: "invalid_transaction",
          message: error instanceof Error ? error.message : "Invalid transaction"
        }, { status: 400 });
      }

      try {
        return Response.json(await executeTransactionWithContinuity(env, transaction, undefined, mutationContext));
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    }

    const mutationContextMatch = url.pathname.match(/^\/v1\/projects\/(PRJ-[0-9]{4,})\/mutation-context$/);
    if (request.method === "GET" && mutationContextMatch) {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const projectId = mutationContextMatch[1];
      const response = await env.PROJECT_GUARD.getByName(projectId).fetch(
        "https://project-guard.internal/mutation-context",
        { headers: { authorization: request.headers.get("authorization") ?? "" } }
      );
      if (!response.ok) {
        const error: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
        return Response.json({ error: error.error ?? "canonical_unavailable" }, { status: response.status });
      }
      const canonical = await response.json<Pick<MutationContextResponse, "context" | "canonical_state">>();
      return Response.json({
        ...canonical,
        views: {
          state: renderState(canonical.canonical_state),
          handoff: renderHandoff(canonical.canonical_state),
          status: "unknown",
          verified_at: null
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/artifacts") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let artifact: ArtifactWriteRequest;
      let mutationContext: MutationContext | null;
      try {
        const admission = decodeAdmission(await request.json(), parseArtifactWriteRequest);
        artifact = admission.request;
        mutationContext = admission.mutation_context;
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        return Response.json({
          error: "invalid_artifact_request",
          message: error instanceof Error ? error.message : "Invalid artifact request"
        }, { status: 400 });
      }

      const policyViolation = binaryArtifactPolicyViolation(env, artifact);
      if (policyViolation && !isReviewCandidate(artifact)) {
        return Response.json({ error: policyViolation.code, message: policyViolation.message }, { status: 409 });
      }

      try {
        return Response.json(await routeArtifact(env, artifact, mutationContext));
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/documents") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let document: ManagedDocumentRequest;
      let mutationContext: MutationContext | null;
      try {
        const admission = decodeAdmission(await request.json(), parseManagedDocumentRequest);
        document = admission.request;
        mutationContext = admission.mutation_context;
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        return Response.json({
          error: "invalid_document_request",
          message: error instanceof Error ? error.message : "Invalid managed document request"
        }, { status: 400 });
      }

      try {
        return Response.json(await routeManagedDocument(env, document, mutationContext));
      } catch (error) {
        if (error instanceof AdmissionError) return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    console.info("Project OS scheduled maintenance started", {
      cron: controller.cron,
      mode,
      inbox: inboxPath(mode),
      artifact_inbox: artifactInboxPath(mode)
    });
    ctx.waitUntil(
      runScheduledMaintenance({
        inbox: () => processInbox(env),
        materialization: () => reconcileMaterializations(env),
        documents: () => reconcileManagedDocuments(env),
        search: () => reconcileSearchIndexes(env, controller.scheduledTime)
      })
        .then(([inbox, materialization, documents, search]) => {
          console.info("Project OS scheduled maintenance completed", { inbox, materialization, documents, search });
        })
        .catch((error) => {
          console.error("Project OS scheduled maintenance failed", {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
          throw error;
        })
    );
  }
} satisfies ExportedHandler<Env>;

export default worker;

interface RegistryProject {
  project_id: string;
  slug: string;
  status?: "active" | "paused" | "completed" | "archived";
}

interface InputRecoveryProjectSummary {
  project_id: string;
  scanned: number;
  completed: number;
  duplicate_cleaned: number;
  conflicts: number;
  withdrawn: number;
  failed: number;
}

interface VerifiedInputRecoveryProjectSummary extends InputRecoveryProjectSummary {
  remaining: number;
}

export interface MaterializationReconcileSummary {
  scanned: number;
  scheduled: number;
  current: number;
  failed: number;
}

export interface ManagedDocumentReconcileAllSummary {
  projects_scanned: number;
  projects_failed: number;
  provider_entries_scanned: number;
  captured: number;
  ingested: number;
  duplicates: number;
  restored: number;
  conflicts: number;
  cursor_resets: number;
  jobs_pending: number;
  job_failures: number;
}

export interface SearchFleetReconcileSummary {
  scanned: number;
  scheduled: number;
  current: number;
  rebuilding: number;
  failed: number;
}

interface ManagedDocumentProjectSummary {
  scanned: number;
  captured: number;
  ingested: number;
  duplicates: number;
  restored: number;
  conflicts: number;
  cursor_reset: boolean;
  jobs_pending: number;
  job_failures: number;
}

interface MaterializationStatusResponse {
  project_id: string;
  canonical_revision: number;
  projection_version: number;
  materialized_head: { revision: number; projection_version: number } | null;
  requested: { revision: number; projection_version: number } | null;
  active: { revision: number; projection_version: number } | null;
  blocked_error: string | null;
  convergence: ConvergenceHealth;
}

interface SearchSyncStatusResponse {
  project_id: string;
  canonical_revision: number;
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation_requested: number;
  document_generation_indexed: number;
  document_full_rebuild_required: boolean;
  last_error: string | null;
}

interface SearchFreshnessResponse {
  project_id: string;
  state: SearchFreshness;
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_generation_requested: number;
  document_generation_indexed: number;
  active_generation: number | null;
}

export async function searchProjectOs(request: Request, env: Env): Promise<Response> {
  let query;
  try {
    query = parseSearchQuery(await request.json());
  } catch {
    return Response.json({ error: "invalid_search_query" }, { status: 400 });
  }

  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const knownProjectIds = new Set(registry.projects.map((project) => project.project_id));

  for (const projectId of query.project_ids) {
    if (!knownProjectIds.has(projectId)) {
      return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
    }
  }

  const freshness = await mapWithConcurrency(query.project_ids, 8, (projectId) => readSearchFreshness(env, projectId));
  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const searchResponse = await searchIndex.fetch("https://search-index.internal/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query)
  });
  if (!searchResponse.ok) {
    return Response.json({ error: "search_unavailable", status: searchResponse.status }, { status: 503 });
  }

  const result = await searchResponse.json<{ hits: unknown[] }>();
  return Response.json({ hits: result.hits, freshness });
}

async function readSearchFreshness(env: Env, projectId: string): Promise<SearchFreshnessResponse> {
  const projectGuard = env.PROJECT_GUARD.getByName(projectId);
  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const [sourceResponse, indexResponse] = await Promise.all([
    projectGuard.fetch("https://project-guard.internal/search-sync-status", { method: "GET" }),
    searchIndex.fetch(`https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`, { method: "GET" })
  ]);

  const source = sourceResponse.ok ? await sourceResponse.json<SearchSyncStatusResponse>() : null;
  const indexed = indexResponse.ok ? await indexResponse.json<SearchIndexProjectStatus>() : null;
  if (!source || !indexed || indexed.active_generation === null) {
    return {
      project_id: projectId,
      state: "unknown",
      canonical_revision_requested: source?.canonical_revision_requested ?? 0,
      canonical_revision_indexed: source?.canonical_revision_indexed ?? 0,
      document_generation_requested: source?.document_generation_requested ?? 0,
      document_generation_indexed: source?.document_generation_indexed ?? 0,
      active_generation: indexed?.active_generation ?? null
    };
  }

  const canonicalLag = source.canonical_revision_requested > source.canonical_revision_indexed
    || indexed.canonical_revision_indexed < source.canonical_revision_requested;
  const documentLag = source.document_generation_requested > source.document_generation_indexed
    || indexed.document_generation_indexed < source.document_generation_requested
    || indexed.document_epoch !== source.document_epoch
    || indexed.document_epoch_started_at !== source.document_epoch_started_at;
  const lagging = canonicalLag || documentLag;
  const rebuilding = indexed.rebuild_state === "rebuilding" || indexed.freshness === "rebuilding";
  const failed = lagging && Boolean(source.last_error || indexed.last_error || indexed.freshness === "failed");

  return {
    project_id: projectId,
    state: rebuilding ? "rebuilding" : failed ? "failed" : lagging ? "lagging" : "current",
    canonical_revision_requested: source.canonical_revision_requested,
    canonical_revision_indexed: source.canonical_revision_indexed,
    document_generation_requested: source.document_generation_requested,
    document_generation_indexed: source.document_generation_indexed,
    active_generation: indexed.active_generation
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, values.length);
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function materializeExistingProjects(request: Request, env: Env): Promise<Response> {
  let projectIds: string[];
  try {
    const body = await request.json() as { project_ids?: unknown };
    if (!Array.isArray(body.project_ids) || body.project_ids.length === 0 || body.project_ids.some((item) => typeof item !== "string")) {
      throw new Error("project_ids must be a non-empty string array");
    }
    projectIds = [...new Set(body.project_ids.map((item) => assertSafeProjectId(item as string)))];
  } catch (error) {
    return Response.json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid materialization request"
    }, { status: 400 });
  }

  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const byId = new Map(registry.projects.map((project) => [project.project_id, project]));
  const persistence = createProductionPersistence(env);
  const results: Array<{ project_id: string; status: "materialized" | "pending"; revision: number }> = [];

  for (const projectId of projectIds) {
    const project = byId.get(projectId);
    if (!project) return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });

    await mirrorLegacyEvents(persistence.objects, projectId, project.slug);

    const guard = env.PROJECT_GUARD.getByName(projectId);
    const response = await guard.fetch("https://project-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });
    if (response.status === 409) {
      const blocked = await response.json<unknown>();
      return Response.json({ error: "materialization_blocked", project_id: projectId, detail: blocked }, { status: 409 });
    }
    if (!response.ok && response.status !== 202) {
      return Response.json({ error: "materialization_failed", project_id: projectId, status: response.status }, { status: 502 });
    }
    if (response.status === 202) {
      const pending = await response.json<{ revision: number }>();
      results.push({ project_id: projectId, status: "pending", revision: pending.revision });
      continue;
    }
    const materialized = await response.json<{ revision: number; materialized: boolean }>();
    if (!materialized.materialized) {
      return Response.json({ error: "materialization_failed", project_id: projectId }, { status: 502 });
    }
    results.push({ project_id: projectId, status: "materialized", revision: materialized.revision });
  }

  return Response.json({ results });
}

async function recoverInputs(request: Request, env: Env): Promise<Response> {
  let projectIds: string[];
  try {
    const body = await request.json() as { project_ids?: unknown };
    if (
      !Array.isArray(body.project_ids)
      || body.project_ids.length === 0
      || body.project_ids.some((item) => typeof item !== "string")
    ) {
      throw new Error("project_ids must be a non-empty string array");
    }
    projectIds = [...new Set(body.project_ids.map((item) => assertSafeProjectId(item as string)))];
  } catch (error) {
    return Response.json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid INPUTS recovery request"
    }, { status: 400 });
  }

  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const knownProjectIds = new Set(registry.projects.map((project) => project.project_id));

  for (const projectId of projectIds) {
    if (!knownProjectIds.has(projectId)) {
      return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
    }
  }

  const persistence = createProductionPersistence(env);
  const results: VerifiedInputRecoveryProjectSummary[] = [];
  for (const projectId of projectIds) {
    const project = registry.projects.find((candidate) => candidate.project_id === projectId)!;
    const guard = env.PROJECT_GUARD.getByName(projectId);
    const response = await guard.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    if (!response.ok) {
      return Response.json({
        error: "input_recovery_failed",
        project_id: projectId,
        status: response.status
      }, { status: 502 });
    }
    const summary = await response.json<InputRecoveryProjectSummary>();
    const remaining = await countProjectInputFiles(persistence, projectId, project.slug);
    results.push({ ...summary, remaining });
  }

  return Response.json({ results });
}

async function migrateLegacyLedger(env: Env): Promise<{ transactions: number; receipts: number }> {
  const persistence = createProductionPersistence(env);
  return mirrorLegacyLedger(persistence.objects);
}

export async function executeTransactionWithContinuity(
  env: Env,
  transaction: Transaction,
  candidate?: TransactionExecutor,
  context: MutationContext | null = null
): Promise<Receipt> {
  const status = continuityStatus(env.PROJECT_OS_CONTINUITY_MODE);
  const execution = await executeWithRollback({
    selectedPath: status.effective_path,
    transaction,
    context,
    stable: (tx) => routeStableTransaction(env, tx, context),
    candidate
  });
  return execution.receipt;
}

async function routeStableTransaction(env: Env, transaction: Transaction, context: MutationContext | null): Promise<Receipt> {
  if (transaction.operation === "project.create") {
    const stub = env.REGISTRY_GUARD.getByName("global");
    const response = await stub.fetch("https://registry-guard.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    });
    if (!response.ok) throw new Error(`RegistryGuard returned ${response.status}`);
    return response.json<Receipt>();
  }

  if (transaction.project_id === AUTO_PROJECT_ID) {
    throw new Error("Only project.create may use PRJ-AUTO");
  }

  const stub = env.PROJECT_GUARD.getByName(transaction.project_id);
  const response = await stub.fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admission_version: "1.0", request: transaction, mutation_context: context })
  });
  if (!response.ok) {
    const body: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
    if (body.error && ["mutation_context_missing", "mutation_context_expired", "mutation_context_invalid", "mutation_context_stale", "canonical_unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", "RULE_ADMISSION_STALE", "idempotency_payload_mismatch", "convergence_capacity_exceeded"].includes(body.error)) {
      throw new AdmissionError(body.error as AdmissionError["code"], response.status as AdmissionError["status"]);
    }
    throw new Error(`ProjectGuard returned ${response.status}`);
  }
  return response.json<Receipt>();
}

export async function routeArtifact(env: Env, artifact: ArtifactWriteRequest, context: MutationContext | null = null): Promise<ArtifactWriteReceipt> {
  const violation = binaryArtifactPolicyViolation(env, artifact);
  if (violation && !isReviewCandidate(artifact)) return {request_id:artifact.request_id,project_id:artifact.project_id,relative_path:artifact.relative_path,content_sha256:artifact.content_sha256,status:"rejected",code:violation.code,message:violation.message};
  const stub = env.PROJECT_GUARD.getByName(artifact.project_id);
  const response = await stub.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admission_version: "1.0", request: artifact, mutation_context: context })
  });
  if (!response.ok) throw await projectGuardRouteError(response, "artifact");
  return response.json<ArtifactWriteReceipt>();
}

export async function routeManagedDocument(env: Env, document: ManagedDocumentRequest, context: MutationContext | null = null): Promise<unknown> {
  const stub = env.PROJECT_GUARD.getByName(document.project_id);
  const response = await stub.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admission_version: "1.0", request: document, mutation_context: context })
  });
  if (!response.ok) throw await projectGuardRouteError(response, "document");
  return response.json();
}

async function projectGuardRouteError(response: Response, route: string): Promise<Error> {
  const body: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
  if (body.error && [409, 428, 503].includes(response.status) && (["mutation_context_missing", "mutation_context_expired", "mutation_context_invalid", "mutation_context_stale", "canonical_unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", "RULE_ADMISSION_STALE", "ARTIFACT_DESTINATION_FORBIDDEN", "idempotency_payload_mismatch", "convergence_capacity_exceeded"].includes(body.error) || Object.values(checkCatalogue).some(check => check.result_codes.includes(body.error!)))) {
    return new AdmissionError(body.error as AdmissionError["code"], response.status as AdmissionError["status"]);
  }
  return new Error(`ProjectGuard ${route} route returned ${response.status}`);
}

async function processInbox(env: Env): Promise<InboxProcessSummary> {
  const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
  const persistence = createProductionPersistence(env);
  const transactionSummary = await processTransactionInbox(
    persistence.objects,
    mode,
    (transaction, context) => executeTransactionWithContinuity(env, transaction, undefined, context)
  );
  const artifactSummary = await processArtifactInbox(
    persistence.objects,
    mode,
    (artifact, context) => routeArtifact(env, artifact, context),
    { maxScanEntries: ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION, maxWorkItems: ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION, respectRetryBackoff: true, rotateScan: true }
  );
  return {
    scanned: transactionSummary.scanned + artifactSummary.scanned,
    processed: transactionSummary.processed + artifactSummary.processed,
    failed: transactionSummary.failed + artifactSummary.failed
  };
}

export async function reconcileMaterializations(env: Env): Promise<MaterializationReconcileSummary> {
  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) throw new Error(`RegistryGuard materialization reconcile returned ${registryResponse.status}`);
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const eligibleProjects = registry.projects.filter((project) => project.status !== "archived");
  const summary: MaterializationReconcileSummary = {
    scanned: eligibleProjects.length,
    scheduled: 0,
    current: 0,
    failed: 0
  };

  let cursor = 0;
  const workerCount = Math.min(4, eligibleProjects.length);
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= eligibleProjects.length) return;
      const project = eligibleProjects[index];
      try {
        const outcome = await reconcileMaterializationProject(env, project.project_id);
        if (outcome === "scheduled") summary.scheduled += 1;
        else summary.current += 1;
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS materialization reconcile failed", {
          project_id: project.project_id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}

export async function reconcileMaterializationProject(
  env: Env,
  projectId: string
): Promise<"scheduled" | "current"> {
  const stub = env.PROJECT_GUARD.getByName(projectId);
  const response = await stub.fetch("https://project-guard.internal/reconcile-materialization", { method: "POST" });
  if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
  const status = await response.json<MaterializationStatusResponse>();
  const headCurrent = status.materialized_head !== null
    && status.materialized_head.revision === status.canonical_revision
    && status.materialized_head.projection_version === status.projection_version;
  return status.requested !== null || status.active !== null || !headCurrent ? "scheduled" : "current";
}

export async function reconcileSearchIndexes(
  env: Env,
  scheduledTime?: number
): Promise<SearchFleetReconcileSummary> {
  if (!searchSyncEnabled(env)) {
    return { scanned: 0, scheduled: 0, current: 0, rebuilding: 0, failed: 0 };
  }

  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) {
    throw new Error(`RegistryGuard search reconcile returned ${registryResponse.status}`);
  }

  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const projects = scheduledTime === undefined
    ? registry.projects
    : scheduledSearchProjects(registry.projects, scheduledTime);
  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const summary: SearchFleetReconcileSummary = {
    scanned: projects.length,
    scheduled: 0,
    current: 0,
    rebuilding: 0,
    failed: 0
  };

  let cursor = 0;
  const workerCount = Math.min(4, projects.length);
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= projects.length) return;

      const projectId = projects[index].project_id;
      try {
        const indexResponse = await searchIndex.fetch(
          `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`,
          { method: "GET" }
        );
        if (!indexResponse.ok) throw new Error(`SearchIndexGuard returned ${indexResponse.status}`);
        const indexed = await indexResponse.json<SearchIndexProjectStatus>();
        const missingHead = indexed.active_generation === null;

        const projectGuard = env.PROJECT_GUARD.getByName(projectId);
        const reconcileResponse = await projectGuard.fetch(
          "https://project-guard.internal/reconcile-search",
          missingHead
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ force_full: true })
              }
            : { method: "POST" }
        );
        if (!reconcileResponse.ok) throw new Error(`ProjectGuard returned ${reconcileResponse.status}`);
        const source = await reconcileResponse.json<SearchSyncStatusResponse>();

        const rebuilding = indexed.rebuild_state === "rebuilding" || indexed.freshness === "rebuilding";
        const canonicalLag = source.canonical_revision_requested > source.canonical_revision_indexed
          || indexed.canonical_revision_indexed < source.canonical_revision_requested;
        const documentLag = source.document_generation_requested > source.document_generation_indexed
          || indexed.document_generation_indexed < source.document_generation_requested;
        const lagging = missingHead || canonicalLag || documentLag;
        const failed = lagging && Boolean(source.last_error || indexed.last_error || indexed.freshness === "failed");

        if (rebuilding) summary.rebuilding += 1;
        else if (failed) summary.failed += 1;
        else if (lagging) summary.scheduled += 1;
        else summary.current += 1;
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS search reconcile failed", {
          project_id: projectId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}

function scheduledSearchProjects(projects: RegistryProject[], scheduledTime: number): RegistryProject[] {
  if (projects.length === 0) return [];
  const window = Math.floor(scheduledTime / 300_000);
  return [projects[window % projects.length]];
}

export async function reconcileManagedDocuments(env: Env): Promise<ManagedDocumentReconcileAllSummary> {
  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) throw new Error(`RegistryGuard document reconcile returned ${registryResponse.status}`);
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const summary: ManagedDocumentReconcileAllSummary = {
    projects_scanned: registry.projects.length,
    projects_failed: 0,
    provider_entries_scanned: 0,
    captured: 0,
    ingested: 0,
    duplicates: 0,
    restored: 0,
    conflicts: 0,
    cursor_resets: 0,
    jobs_pending: 0,
    job_failures: 0
  };

  let cursor = 0;
  const workerCount = Math.min(4, registry.projects.length);
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= registry.projects.length) return;
      const project = registry.projects[index];
      try {
        const stub = env.PROJECT_GUARD.getByName(project.project_id);
        const response = await stub.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
        if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
        const projectSummary = await response.json<ManagedDocumentProjectSummary>();
        summary.provider_entries_scanned += projectSummary.scanned;
        summary.captured += projectSummary.captured;
        summary.ingested += projectSummary.ingested;
        summary.duplicates += projectSummary.duplicates;
        summary.restored += projectSummary.restored;
        summary.conflicts += projectSummary.conflicts;
        summary.cursor_resets += projectSummary.cursor_reset ? 1 : 0;
        summary.jobs_pending += projectSummary.jobs_pending;
        summary.job_failures += projectSummary.job_failures;
      } catch (error) {
        summary.projects_failed += 1;
        console.error("Project OS managed document reconcile failed", {
          project_id: project.project_id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}

function authorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  if (typeof env.INGRESS_TOKEN === "string" && env.INGRESS_TOKEN.length > 0
      && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;
  const operatorToken = env.CONTROL_TOWER_OPERATOR_TOKEN;
  return Boolean(operatorToken && validOperatorToken(operatorToken)
    && secureStringEqual(authorization, `Bearer ${operatorToken}`));
}

function validOperatorToken(token: string, now = Date.now()): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const issuedAt = Number(token.slice(0, separator));
  if (!Number.isSafeInteger(issuedAt)) return false;
  if (issuedAt > now + OPERATOR_TOKEN_FUTURE_SKEW_MS) return false;
  return now - issuedAt <= OPERATOR_TOKEN_TTL_MS;
}

function secureStringEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
