import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "./domain/artifact-write";
import { parseArtifactWriteRequest } from "./domain/artifact-write";
import { binaryArtifactPolicyViolation } from "./artifacts/policy";
import { continuityStatus } from "./continuity/policy";
import { executeWithRollback, type TransactionExecutor } from "./continuity/rollback";
import type { Env } from "./env";
import { parseManagedDocumentRequest, type ManagedDocumentRequest } from "./domain/managed-document-request";
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

export { ProjectGuard } from "./durable/project-guard";
export { RegistryGuard } from "./durable/registry-guard";
export { inboxPath, artifactInboxPath } from "./inbox/processor";

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
      try {
        transaction = parseTransaction(await request.json());
      } catch (error) {
        return Response.json({
          error: "invalid_transaction",
          message: error instanceof Error ? error.message : "Invalid transaction"
        }, { status: 400 });
      }

      return Response.json(await executeTransactionWithContinuity(env, transaction));
    }

    if (request.method === "POST" && url.pathname === "/v1/artifacts") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let artifact: ArtifactWriteRequest;
      try {
        artifact = parseArtifactWriteRequest(await request.json());
      } catch (error) {
        return Response.json({
          error: "invalid_artifact_request",
          message: error instanceof Error ? error.message : "Invalid artifact request"
        }, { status: 400 });
      }

      const policyViolation = binaryArtifactPolicyViolation(env, artifact);
      if (policyViolation) {
        return Response.json({ error: "binary_artifact_policy_violation", message: policyViolation }, { status: 400 });
      }

      return Response.json(await routeArtifact(env, artifact));
    }

    if (request.method === "POST" && url.pathname === "/v1/documents") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });

      let document: ManagedDocumentRequest;
      try {
        document = parseManagedDocumentRequest(await request.json());
      } catch (error) {
        return Response.json({
          error: "invalid_document_request",
          message: error instanceof Error ? error.message : "Invalid document request"
        }, { status: 400 });
      }

      return Response.json(await routeManagedDocument(env, document));
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

export default worker;

interface RegistryProject {
  project_id: string;
  name?: string;
  slug?: string;
}

interface MaterializationStatusResponse {
  canonical_revision: number;
  projection_version: number;
  requested: unknown | null;
  active: unknown | null;
  materialized_head: { revision: number; projection_version: number } | null;
}

interface MaterializationReconcileSummary {
  scanned: number;
  scheduled: number;
  current: number;
  failed: number;
}

interface SearchSyncStatusResponse {
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_generation_requested: number;
  document_generation_indexed: number;
  last_error: string | null;
}

interface SearchFleetReconcileSummary {
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

interface ManagedDocumentReconcileAllSummary {
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

interface RecoverySummary {
  project_id: string;
  scanned: number;
  completed: number;
  duplicate_cleaned: number;
  conflicts: number;
  withdrawn: number;
  failed: number;
}

async function recoverInputs(request: Request, env: Env): Promise<Response> {
  let projectIds: string[];
  try {
    const body = await request.json() as { project_ids?: unknown };
    if (!Array.isArray(body.project_ids) || body.project_ids.length === 0 || body.project_ids.length > 100) {
      throw new Error("project_ids must be a non-empty array of at most 100 project IDs");
    }
    if (body.project_ids.some((projectId) => typeof projectId !== "string" || !/^PRJ-[0-9]{4}$/.test(projectId))) {
      throw new Error("project_ids must contain only exact four-digit project IDs");
    }
    projectIds = body.project_ids as string[];
    if (new Set(projectIds).size !== projectIds.length) throw new Error("project_ids must be unique");
  } catch (error) {
    return Response.json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid recovery request"
    }, { status: 400 });
  }

  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const known = new Set(registry.projects.map((project) => project.project_id));
  for (const projectId of projectIds) {
    if (!known.has(projectId)) return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
  }

  const results: RecoverySummary[] = [];
  for (const projectId of projectIds) {
    const stub = env.PROJECT_GUARD.getByName(projectId);
    const response = await stub.fetch("https://project-guard.internal/recover-inputs", { method: "POST" });
    if (!response.ok) {
      return Response.json({ error: "recovery_failed", project_id: projectId, status: response.status }, { status: 502 });
    }
    results.push(await response.json<RecoverySummary>());
  }

  return Response.json({ results });
}

export async function searchProjectOs(request: Request, env: Env): Promise<Response> {
  let parsed;
  try {
    parsed = parseSearchQuery(await request.json());
  } catch (error) {
    return Response.json({
      error: "invalid_search_query",
      message: error instanceof Error ? error.message : "Invalid search query"
    }, { status: 400 });
  }

  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const indexResponse = await searchIndex.fetch("https://search-index.internal/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed)
  });
  if (!indexResponse.ok) return Response.json({ error: "search_unavailable" }, { status: 502 });

  const body = await indexResponse.json<unknown>();
  return Response.json(body);
}

async function materializeExistingProjects(request: Request, env: Env): Promise<Response> {
  let projectIds: string[];
  try {
    const body = await request.json() as { project_ids?: unknown };
    if (!Array.isArray(body.project_ids) || body.project_ids.length === 0 || body.project_ids.length > 100) {
      throw new Error("project_ids must be a non-empty array of at most 100 project IDs");
    }
    if (body.project_ids.some((projectId) => typeof projectId !== "string" || !/^PRJ-[0-9]{4,}$/.test(projectId))) {
      throw new Error("project_ids must contain only valid project IDs");
    }
    projectIds = body.project_ids as string[];
    if (new Set(projectIds).size !== projectIds.length) throw new Error("project_ids must be unique");
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
  const known = new Set(registry.projects.map((project) => project.project_id));
  for (const projectId of projectIds) {
    if (!known.has(projectId)) return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
  }

  const results: Array<{ project_id: string; revision: number }> = [];
  for (const projectId of projectIds) {
    const stub = env.PROJECT_GUARD.getByName(projectId);
    const response = await stub.fetch("https://project-guard.internal/materialize", { method: "POST" });
    if (!response.ok) return Response.json({ error: "materialization_failed", project_id: projectId }, { status: 502 });
    const result = await response.json<{ revision: number }>();
    results.push({ project_id: projectId, revision: result.revision });
  }
  return Response.json({ projects: results });
}

async function migrateLegacyLedger(env: Env): Promise<unknown> {
  const persistence = createProductionPersistence(env);
  await mirrorLegacyEvents(persistence.objects, "legacy", "v2");
  await mirrorLegacyLedger(persistence.objects, "legacy", "v2");
  return { migrated: true };
}

async function executeTransactionWithContinuity(env: Env, transaction: Transaction): Promise<Receipt> {
  const mode = env.PROJECT_OS_CONTINUITY_MODE ?? "stable";
  const stable: TransactionExecutor = (candidate) => routeStableTransaction(env, candidate);

  if (mode === "stable") return stable(transaction);

  if (mode === "automatic") {
    return executeWithRollback(transaction, stable, stable);
  }

  return executeWithRollback(transaction, stable, stable);
}

async function routeStableTransaction(env: Env, transaction: Transaction): Promise<Receipt> {
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
    body: JSON.stringify(transaction)
  });
  if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
  return response.json<Receipt>();
}

async function routeArtifact(env: Env, artifact: ArtifactWriteRequest): Promise<ArtifactWriteReceipt> {
  const stub = env.PROJECT_GUARD.getByName(artifact.project_id);
  const response = await stub.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(artifact)
  });
  if (!response.ok) throw new Error(`ProjectGuard artifact route returned ${response.status}`);
  return response.json<ArtifactWriteReceipt>();
}

async function routeManagedDocument(env: Env, document: ManagedDocumentRequest): Promise<unknown> {
  const stub = env.PROJECT_GUARD.getByName(document.project_id);
  const response = await stub.fetch("https://project-guard.internal/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document)
  });
  if (!response.ok) throw new Error(`ProjectGuard document route returned ${response.status}`);
  return response.json();
}

async function processInbox(env: Env): Promise<InboxProcessSummary> {
  const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
  const persistence = createProductionPersistence(env);
  const transactionSummary = await processTransactionInbox(
    persistence.objects,
    mode,
    (transaction) => executeTransactionWithContinuity(env, transaction)
  );
  const artifactSummary = await processArtifactInbox(
    persistence.objects,
    mode,
    (artifact) => routeArtifact(env, artifact)
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
  const summary: MaterializationReconcileSummary = {
    scanned: registry.projects.length,
    scheduled: 0,
    current: 0,
    failed: 0
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
        const stub = env.MATERIALIZATION_GUARD.getByName(project.project_id);
        const response = await stub.fetch("https://materialization-guard.internal/reconcile", {
          method: "POST"
        });
        if (!response.ok) throw new Error(`MaterializationGuard returned ${response.status}`);
        const status = await response.json<MaterializationStatusResponse>();
        const headCurrent = status.materialized_head !== null
          && status.materialized_head.revision === status.canonical_revision
          && status.materialized_head.projection_version === status.projection_version;
        const workPending = status.requested !== null || status.active !== null || !headCurrent;
        if (workPending) summary.scheduled += 1;
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
  if (typeof env.INGRESS_TOKEN !== "string" || env.INGRESS_TOKEN.length === 0) return false;
  const authorization = request.headers.get("authorization");
  return Boolean(authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`));
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