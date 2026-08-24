import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "./domain/artifact-write";
import { parseArtifactWriteRequest } from "./domain/artifact-write";
import { continuityStatus } from "./continuity/policy";
import { executeWithRollback, type TransactionExecutor } from "./continuity/rollback";
import type { Env } from "./env";
import { parseManagedDocumentRequest, type ManagedDocumentRequest } from "./domain/managed-document-request";
import type { Receipt } from "./domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "./domain/transaction";
import { DropboxClient, DropboxConflictError, type DropboxEntry } from "./dropbox/client";
import {
  type LayoutMode,
  machineArtifactRequestPath,
  machineTransactionPath,
  parseLayoutMode
} from "./dropbox/layout";
import { assertSafeProjectId, PROJECT_OS_ROOT, transactionPath } from "./dropbox/paths";
import { ResilientDropboxTransport } from "./dropbox/resilient-transport";
import { mirrorLegacyEvents, mirrorLegacyLedger } from "./migration/workspace-v2";
import { verifyDropboxSignature } from "./webhook/dropbox";

export { ProjectGuard } from "./durable/project-guard";
export { RegistryGuard } from "./durable/registry-guard";

export function inboxPath(mode: LayoutMode): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/transactions/incoming`
    : `${PROJECT_OS_ROOT}/TRANSACTIONS/incoming`;
}

export function artifactInboxPath(mode: LayoutMode): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/artifacts/incoming`
    : `${PROJECT_OS_ROOT}/ARTIFACTS/incoming`;
}

function terminalTransactionPath(mode: LayoutMode, status: "committed" | "rejected" | "conflicts", transactionId: string): string {
  return mode === "v2"
    ? machineTransactionPath(status, transactionId)
    : transactionPath(status, transactionId);
}

function terminalArtifactRequestPath(mode: LayoutMode, status: "committed" | "rejected" | "conflicts", requestId: string): string {
  return mode === "v2"
    ? machineArtifactRequestPath(status, requestId)
    : `${PROJECT_OS_ROOT}/ARTIFACTS/${status}/${requestId}.json`;
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
          message: error instanceof Error ? error.message : "Invalid managed document request"
        }, { status: 400 });
      }

      return Response.json(await routeManagedDocument(env, document));
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
      Promise.all([
        processInbox(env),
        reconcileMaterializations(env),
        reconcileManagedDocuments(env)
      ])
        .then(([inbox, materialization, documents]) => {
          console.info("Project OS scheduled maintenance completed", { inbox, materialization, documents });
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
}

interface ManagedDocumentProjectSummary {
  scanned: number;
  captured: number;
  ingested: number;
  duplicates: number;
  restored: number;
  conflicts: number;
  cursor_reset: boolean;
}

interface MaterializationStatusResponse {
  project_id: string;
  canonical_revision: number;
  projection_version: number;
  materialized_head: { revision: number; projection_version: number } | null;
  requested: { revision: number; projection_version: number } | null;
  active: { revision: number; projection_version: number } | null;
  blocked_error: string | null;
}

interface InboxProcessSummary {
  scanned: number;
  processed: number;
  failed: number;
}

interface PreparedTransactionInboxEntry {
  entry: DropboxEntry;
  raw?: string | null;
  transaction?: Transaction;
  loadError?: unknown;
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

  const client = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  const transport = new ResilientDropboxTransport(client);
  const results: Array<{ project_id: string; status: "materialized"; revision: number }> = [];

  for (const projectId of projectIds) {
    const project = byId.get(projectId);
    if (!project) return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });

    await mirrorLegacyEvents(transport, projectId, project.slug);

    const guard = env.PROJECT_GUARD.getByName(projectId);
    const response = await guard.fetch("https://project-guard.internal/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "workspace-v2" })
    });
    if (!response.ok) {
      return Response.json({ error: "materialization_failed", project_id: projectId, status: response.status }, { status: 502 });
    }
    const materialized = await response.json<{ revision: number; materialized: boolean }>();
    if (!materialized.materialized) {
      return Response.json({ error: "materialization_failed", project_id: projectId }, { status: 502 });
    }
    results.push({ project_id: projectId, status: "materialized", revision: materialized.revision });
  }

  return Response.json({ results });
}

async function migrateLegacyLedger(env: Env): Promise<{ transactions: number; receipts: number }> {
  const client = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  return mirrorLegacyLedger(new ResilientDropboxTransport(client));
}

export async function executeTransactionWithContinuity(
  env: Env,
  transaction: Transaction,
  candidate?: TransactionExecutor
): Promise<Receipt> {
  const status = continuityStatus(env.PROJECT_OS_CONTINUITY_MODE);
  const execution = await executeWithRollback({
    selectedPath: status.effective_path,
    transaction,
    stable: (tx) => routeStableTransaction(env, tx),
    candidate
  });
  return execution.receipt;
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
  const client = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  const transport = new ResilientDropboxTransport(client);
  const transactionSummary = await processTransactionInbox(env, transport, mode);
  const artifactSummary = await processArtifactInbox(env, transport, mode);
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
        const stub = env.PROJECT_GUARD.getByName(project.project_id);
        const response = await stub.fetch("https://project-guard.internal/reconcile-materialization", {
          method: "POST"
        });
        if (!response.ok) throw new Error(`ProjectGuard returned ${response.status}`);
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
    cursor_resets: 0
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

async function prepareTransactionInboxEntries(
  transport: ResilientDropboxTransport,
  entries: DropboxEntry[]
): Promise<PreparedTransactionInboxEntry[]> {
  const prepared: PreparedTransactionInboxEntry[] = [];

  for (const entry of entries) {
    const sourcePath = entry.path_display;
    if (!sourcePath) {
      prepared.push({ entry });
      continue;
    }

    let raw: string | null;
    try {
      raw = await transport.download(sourcePath);
    } catch (error) {
      prepared.push({ entry, loadError: error });
      continue;
    }

    let transaction: Transaction | undefined;
    if (raw !== null) {
      try {
        const parsed = parseTransaction(JSON.parse(raw));
        if (transactionIdFromFilename(entry.name) === parsed.transaction_id) transaction = parsed;
      } catch {
        // Invalid entries remain eligible for rejection/cleanup after valid work is ordered.
      }
    }
    prepared.push({ entry, raw, transaction });
  }

  return prepared.sort(comparePreparedTransactionEntries);
}

function comparePreparedTransactionEntries(a: PreparedTransactionInboxEntry, b: PreparedTransactionInboxEntry): number {
  if (a.transaction && b.transaction) {
    if (a.transaction.project_id === b.transaction.project_id) {
      const revisionOrder = a.transaction.base_revision - b.transaction.base_revision;
      if (revisionOrder !== 0) return revisionOrder;
    }
    const createdOrder = a.transaction.created_at.localeCompare(b.transaction.created_at);
    if (createdOrder !== 0) return createdOrder;
    return a.entry.name.localeCompare(b.entry.name);
  }
  if (a.transaction) return -1;
  if (b.transaction) return 1;
  return a.entry.name.localeCompare(b.entry.name);
}

async function processTransactionInbox(env: Env, transport: ResilientDropboxTransport, mode: LayoutMode): Promise<InboxProcessSummary> {
  const listedEntries = await transport.listFolder(inboxPath(mode));
  const transactionEntries = listedEntries
    .filter((item) => item.tag === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const preparedEntries = await prepareTransactionInboxEntries(transport, transactionEntries);
  const summary: InboxProcessSummary = {
    scanned: transactionEntries.length,
    processed: 0,
    failed: 0
  };

  for (const prepared of preparedEntries) {
    const entry = prepared.entry;
    try {
      const sourcePath = entry.path_display;
      if (!sourcePath) {
        summary.failed += 1;
        console.error("Project OS inbox entry missing path_display", { name: entry.name });
        continue;
      }
      if (prepared.loadError) {
        summary.failed += 1;
        console.error("Project OS inbox entry could not be loaded", {
          name: entry.name,
          sourcePath,
          message: prepared.loadError instanceof Error ? prepared.loadError.message : String(prepared.loadError)
        });
        continue;
      }
      const raw = prepared.raw;
      if (raw === null || raw === undefined) {
        summary.failed += 1;
        console.error("Project OS inbox entry disappeared before processing", { name: entry.name, sourcePath });
        continue;
      }

      const filenameTransactionId = transactionIdFromFilename(entry.name);
      let transaction: Transaction;
      try {
        transaction = prepared.transaction ?? parseTransaction(JSON.parse(raw));
        if (!filenameTransactionId || filenameTransactionId !== transaction.transaction_id) {
          throw new Error("Transaction filename must exactly match transaction_id");
        }
      } catch (error) {
        const fallbackId = filenameTransactionId ?? await syntheticInboxId("TXN-INVALID", entry.name, raw);
        const rejectedPath = terminalTransactionPath(mode, "rejected", fallbackId);
        await safeAdd(transport, rejectedPath, `${JSON.stringify({
          status: "rejected",
          code: "INVALID_TRANSACTION_FILE",
          message: error instanceof Error ? error.message : "Invalid transaction file",
          source_name: entry.name
        }, null, 2)}\n`);
        await archiveSource(transport, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
        summary.processed += 1;
        continue;
      }

      let receipt: Receipt;
      try {
        receipt = await executeTransactionWithContinuity(env, transaction);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS transaction processing failed", transaction.transaction_id, error);
        continue;
      }

      const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
      const canonicalTerminalPath = terminalTransactionPath(mode, statusFolder, transaction.transaction_id);
      const archivePath = receipt.status === "committed"
        ? canonicalTerminalPath
        : canonicalTerminalPath.replace(/\.json$/, ".source.json");
      await archiveSource(transport, sourcePath, archivePath);
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Project OS transaction inbox entry failed", {
        name: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return summary;
}

async function processArtifactInbox(env: Env, transport: ResilientDropboxTransport, mode: LayoutMode): Promise<InboxProcessSummary> {
  const entries = await transport.listFolder(artifactInboxPath(mode));
  const artifactEntries = entries
    .filter((item) => item.tag === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const summary: InboxProcessSummary = {
    scanned: artifactEntries.length,
    processed: 0,
    failed: 0
  };

  for (const entry of artifactEntries) {
    try {
      const sourcePath = entry.path_display;
      if (!sourcePath) {
        summary.failed += 1;
        console.error("Project OS artifact inbox entry missing path_display", { name: entry.name });
        continue;
      }
      const raw = await transport.download(sourcePath);
      if (raw === null) {
        summary.failed += 1;
        console.error("Project OS artifact inbox entry disappeared before processing", { name: entry.name, sourcePath });
        continue;
      }

      const filenameRequestId = artifactRequestIdFromFilename(entry.name);
      let artifact: ArtifactWriteRequest;
      try {
        artifact = parseArtifactWriteRequest(JSON.parse(raw));
        if (!filenameRequestId || filenameRequestId !== artifact.request_id) {
          throw new Error("Artifact filename must exactly match request_id");
        }
      } catch (error) {
        const fallbackId = filenameRequestId ?? await syntheticInboxId("ART-INVALID", entry.name, raw);
        const rejectedPath = terminalArtifactRequestPath(mode, "rejected", fallbackId);
        await safeAdd(transport, rejectedPath, `${JSON.stringify({
          status: "rejected",
          code: "INVALID_ARTIFACT_FILE",
          message: error instanceof Error ? error.message : "Invalid artifact file",
          source_name: entry.name
        }, null, 2)}\n`);
        await archiveSource(transport, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
        summary.processed += 1;
        continue;
      }

      let receipt: ArtifactWriteReceipt;
      try {
        receipt = await routeArtifact(env, artifact);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS artifact processing failed", artifact.request_id, error);
        continue;
      }

      const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
      const terminalPath = terminalArtifactRequestPath(mode, statusFolder, artifact.request_id);
      await archiveSource(transport, sourcePath, terminalPath);
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Project OS artifact inbox entry failed", {
        name: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return summary;
}

function authorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return Boolean(authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`));
}

function transactionIdFromFilename(filename: string): string | null {
  const match = /^(TXN-[A-Z0-9-]{10,})\.json$/.exec(filename);
  return match?.[1] ?? null;
}

function artifactRequestIdFromFilename(filename: string): string | null {
  const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(filename);
  return match?.[1] ?? null;
}

async function syntheticInboxId(prefix: "TXN-INVALID" | "ART-INVALID", filename: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${filename}\0${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${prefix}-${hex.slice(0, 24)}`;
}

async function safeAdd(transport: ResilientDropboxTransport, path: string, content: string): Promise<void> {
  try {
    await transport.upload(path, content, "add");
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const existing = await transport.download(path);
    if (existing !== content) throw new Error(`Conflicting terminal inbox artifact at ${path}`);
  }
}

async function archiveSource(transport: ResilientDropboxTransport, source: string, destination: string): Promise<void> {
  try {
    await transport.move(source, destination);
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const sourceStillExists = await transport.download(source);
    if (sourceStillExists === null) return;
    const destinationExists = await transport.download(destination);
    if (destinationExists === sourceStillExists) return;
    throw error;
  }
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
