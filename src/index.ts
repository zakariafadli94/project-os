import type { Env } from "./env";
import type { Receipt } from "./domain/receipt";
import { AUTO_PROJECT_ID, parseTransaction, type Transaction } from "./domain/transaction";
import { DropboxClient, DropboxConflictError } from "./dropbox/client";
import { type LayoutMode, machineTransactionPath, parseLayoutMode } from "./dropbox/layout";
import { assertSafeProjectId, PROJECT_OS_ROOT, transactionPath } from "./dropbox/paths";
import { mirrorLegacyEvents } from "./migration/workspace-v2";
import { verifyDropboxSignature } from "./webhook/dropbox";

export { ProjectGuard } from "./durable/project-guard";
export { RegistryGuard } from "./durable/registry-guard";

export function inboxPath(mode: LayoutMode): string {
  return mode === "v2"
    ? `${PROJECT_OS_ROOT}/.project-os/transactions/incoming`
    : `${PROJECT_OS_ROOT}/TRANSACTIONS/incoming`;
}

function terminalTransactionPath(mode: LayoutMode, status: "committed" | "rejected" | "conflicts", transactionId: string): string {
  return mode === "v2"
    ? machineTransactionPath(status, transactionId)
    : transactionPath(status, transactionId);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
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
      ctx.waitUntil(processInbox(env));
      return new Response("", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/workspace-v2/materialize") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return materializeExistingProjects(request, env);
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

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processInbox(env));
  }
} satisfies ExportedHandler<Env>;

export default worker;

interface RegistryProject {
  project_id: string;
  slug: string;
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
  const results: Array<{ project_id: string; status: "materialized"; revision: number }> = [];

  for (const projectId of projectIds) {
    const project = byId.get(projectId);
    if (!project) return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });

    await mirrorLegacyEvents(client, projectId, project.slug);

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

async function routeTransaction(env: Env, transaction: Transaction): Promise<Receipt> {
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

async function processInbox(env: Env): Promise<void> {
  const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
  const client = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  const entries = await client.listFolder(inboxPath(mode));

  for (const entry of entries.filter((item) => item.tag === "file" && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = entry.path_display;
    if (!sourcePath) continue;
    const raw = await client.download(sourcePath);
    if (raw === null) continue;

    const filenameTransactionId = transactionIdFromFilename(entry.name);
    let transaction: Transaction;
    try {
      transaction = parseTransaction(JSON.parse(raw));
      if (!filenameTransactionId || filenameTransactionId !== transaction.transaction_id) {
        throw new Error("Transaction filename must exactly match transaction_id");
      }
    } catch (error) {
      const syntheticId = filenameTransactionId ?? await syntheticTransactionId(entry.name, raw);
      const rejectedPath = terminalTransactionPath(mode, "rejected", syntheticId);
      await safeAdd(client, rejectedPath, `${JSON.stringify({
        status: "rejected",
        code: "INVALID_TRANSACTION_FILE",
        message: error instanceof Error ? error.message : "Invalid transaction file",
        source_name: entry.name
      }, null, 2)}\n`);
      await archiveSource(client, sourcePath, rejectedPath.replace(/\.json$/, ".source.json"));
      continue;
    }

    let receipt: Receipt;
    try {
      receipt = await routeTransaction(env, transaction);
    } catch (error) {
      console.error("Project OS transaction processing failed", transaction.transaction_id, error);
      continue;
    }

    const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
    const canonicalTerminalPath = terminalTransactionPath(mode, statusFolder, transaction.transaction_id);
    const archivePath = receipt.status === "committed"
      ? canonicalTerminalPath
      : canonicalTerminalPath.replace(/\.json$/, ".source.json");
    await archiveSource(client, sourcePath, archivePath);
  }
}

function authorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return Boolean(authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`));
}

function transactionIdFromFilename(filename: string): string | null {
  const match = /^(TXN-[A-Z0-9-]{10,})\.json$/.exec(filename);
  return match?.[1] ?? null;
}

async function syntheticTransactionId(filename: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${filename}\0${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `TXN-INVALID-${hex.slice(0, 24)}`;
}

async function safeAdd(client: DropboxClient, path: string, content: string): Promise<void> {
  try {
    await client.upload(path, content, "add");
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const existing = await client.download(path);
    if (existing !== content) throw new Error(`Conflicting terminal transaction artifact at ${path}`);
  }
}

async function archiveSource(client: DropboxClient, source: string, destination: string): Promise<void> {
  try {
    await client.move(source, destination);
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const sourceStillExists = await client.download(source);
    if (sourceStillExists === null) return;
    const destinationExists = await client.download(destination);
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
