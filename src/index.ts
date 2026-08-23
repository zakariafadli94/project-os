import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "./domain/artifact-write";
import { parseArtifactWriteRequest } from "./domain/artifact-write";
import type { Env } from "./env";
import type { Receipt } from "./domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "./domain/transaction";
import { DropboxClient, DropboxConflictError } from "./dropbox/client";
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

interface InboxProcessSummary {
  scanned: number;
  processed: number;
  failed: number;
}

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
      return Response.json({ status: "ok", service: "project-os-guard" });
    }

    if (url.pathname === "/dropbox/webhook") {
      if (request.method === "GET") {
        const challenge = url.searchParams.get("challenge");
        if (!challenge) return new Response("missing challenge", { status: 400 });
        return new Response(challenge, { headers: { "content-type": "text/plain" } });
      }

      if (request.method === "POST") {
        const body = await request.text();
        const signature = request.headers.get("X-Dropbox-Signature") ?? "";
        if (!await verifyDropboxSignature(env.DROPBOX_APP_SECRET, body, signature)) {
          return new Response("forbidden", { status: 403 });
        }
        ctx.waitUntil(processInbox(env).catch((error) => {
          console.error("Project OS inbox processing failed", {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
        }));
        return new Response("ok");
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

      return Response.json(await routeTransaction(env, transaction));
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

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    console.info("Project OS scheduled inbox scan started", {
      cron: controller.cron,
      mode,
      inbox: inboxPath(mode),
      artifact_inbox: artifactInboxPath(mode)
    });
    ctx.waitUntil(
      processInbox(env)
        .then((summary) => console.info("Project OS inbox scan completed", summary))
        .catch((error) => console.error("Project OS scheduled inbox scan failed", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }))
    );
  }
} satisfies ExportedHandler<Env>;

export default worker;

async function routeTransaction(env: Env, transaction: Transaction): Promise<Receipt> {
  if (transaction.operation === "project.create") {
    const registry = env.REGISTRY_GUARD.getByName("global");
    const response = await registry.fetch("https://registry-guard.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction)
    });
    if (!response.ok) throw new Error(`RegistryGuard returned ${response.status}`);
    return response.json<Receipt>();
  }

  const stub = env.PROJECT_GUARD.getByName(assertSafeProjectId(transaction.project_id));
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

async function processInbox(env: Env): Promise<InboxProcessSummary> {
  const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
  const client = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  const transactionSummary = await processTransactionInbox(env, client, mode);
  const artifactSummary = await processArtifactInbox(env, client, mode);
  return {
    scanned: transactionSummary.scanned + artifactSummary.scanned,
    processed: transactionSummary.processed + artifactSummary.processed,
    failed: transactionSummary.failed + artifactSummary.failed
  };
}

async function processTransactionInbox(env: Env, client: DropboxClient, mode: LayoutMode): Promise<InboxProcessSummary> {
  const entries = await client.listFolder(inboxPath(mode));
  const transactionEntries = entries
    .filter((item) => item.tag === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const summary: InboxProcessSummary = {
    scanned: transactionEntries.length,
    processed: 0,
    failed: 0
  };

  for (const entry of transactionEntries) {
    const sourcePath = entry.path_display;
    if (!sourcePath) {
      summary.failed += 1;
      console.error("Project OS inbox entry missing path_display", { name: entry.name });
      continue;
    }
    const raw = await client.download(sourcePath);
    if (raw === null) {
      summary.failed += 1;
      console.error("Project OS inbox entry disappeared before processing", { name: entry.name, sourcePath });
      continue;
    }

    const filenameTransactionId = transactionIdFromFilename(entry.name);
    let transaction: Transaction;
    try {
      transaction = parseTransaction(JSON.parse(raw));
      if (!filenameTransactionId || filenameTransactionId !== transaction.transaction_id) {
        throw new Error("Transaction filename must exactly match transaction_id");
      }
    } catch (error) {
      const fallbackId = filenameTransactionId ?? await syntheticInboxId("TXN-INVALID", entry.name, raw);
      const rejectedPath = terminalTransactionPath(mode, "rejected", fallbackId);
      await safeAdd(client, rejectedPath, `${JSON.stringify({
        status: "rejected",
        code: "INVALID_TRANSACTION_FILE",
        message: error instanceof Error ? error.message : "Invalid transaction file",
        source_name: entry.name
      }, null, 2)}\n`);
      await archiveSource(client, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
      summary.processed += 1;
      continue;
    }

    let receipt: Receipt;
    try {
      receipt = await routeTransaction(env, transaction);
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
    await archiveSource(client, sourcePath, archivePath);
    summary.processed += 1;
  }

  return summary;
}

async function processArtifactInbox(env: Env, client: DropboxClient, mode: LayoutMode): Promise<InboxProcessSummary> {
  const entries = await client.listFolder(artifactInboxPath(mode));
  const artifactEntries = entries
    .filter((item) => item.tag === "file" && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const summary: InboxProcessSummary = {
    scanned: artifactEntries.length,
    processed: 0,
    failed: 0
  };

  for (const entry of artifactEntries) {
    const sourcePath = entry.path_display;
    if (!sourcePath) {
      summary.failed += 1;
      console.error("Project OS artifact inbox entry missing path_display", { name: entry.name });
      continue;
    }
    const raw = await client.download(sourcePath);
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
      await safeAdd(client, rejectedPath, `${JSON.stringify({
        status: "rejected",
        code: "INVALID_ARTIFACT_FILE",
        message: error instanceof Error ? error.message : "Invalid artifact file",
        source_name: entry.name
      }, null, 2)}\n`);
      await archiveSource(client, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
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
    await archiveSource(client, sourcePath, terminalPath);
    summary.processed += 1;
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

async function safeAdd(client: DropboxClient, path: string, content: string): Promise<void> {
  const writer = new ResilientDropboxTransport(client);
  try {
    await writer.upload(path, content, "add");
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const existing = await client.download(path);
    if (existing !== content) throw new Error(`Conflicting terminal inbox artifact at ${path}`);
  }
}

async function archiveSource(client: DropboxClient, source: string, destination: string): Promise<void> {
  const writer = new ResilientDropboxTransport(client);
  try {
    await writer.move(source, destination);
    return;
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;

    const sourceStillExists = await client.download(source);
    if (sourceStillExists === null) return;

    const destinationExists = await client.download(destination);
    if (destinationExists === sourceStillExists) {
      await writer.delete(source);
      return;
    }
    if (destinationExists !== null) throw error;

    await safeAdd(client, destination, sourceStillExists);
    await writer.delete(source);
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
