import type { Env } from "./env";
import { processReferralInbox } from "./inbox/referral-processor";
import { artifactInboxPath, inboxPath, type InboxProcessSummary } from "./inbox/processor";
import neutralWorker, { reconcileMaterializations } from "./index-neutral";
import { parseLayoutMode } from "./persistence/layout";
import { verifyDropboxSignature } from "./webhook/dropbox";

export * from "./index-neutral";

const worker = {
  ...neutralWorker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/dropbox/webhook") {
      const rawBody = await request.text();
      const valid = await verifyDropboxSignature(
        env.DROPBOX_APP_SECRET,
        rawBody,
        request.headers.get("x-dropbox-signature")
      );
      if (!valid) return new Response("invalid signature", { status: 401 });

      const changeGuard = env.DROPBOX_CHANGE_GUARD.getByName("global");
      const handoff = await changeGuard.fetch("https://dropbox-change-guard.internal/notify", { method: "POST" });
      if (!handoff.ok) {
        console.error("Project OS Dropbox webhook durable handoff failed", { status: handoff.status });
        return Response.json({ error: "durable_change_handoff_failed" }, { status: 503 });
      }

      ctx.waitUntil(processInboxFirst(env, ctx).catch((error) => {
        console.error("Project OS webhook inbox processing failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }));
      return new Response("", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/process-inbox") {
      return processInboxRequest(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/search/rebuild") {
      return rebuildSearchIndexes(request, env);
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/search/status") {
      return searchAdminStatus(request, env);
    }

    return neutralWorker.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
    console.info("Project OS scheduled maintenance started", {
      cron: controller.cron,
      mode,
      inbox: inboxPath(mode),
      artifact_inbox: artifactInboxPath(mode)
    });

    ctx.waitUntil((async () => {
      try {
        const inbox = await processInboxFirst(env, ctx);
        const materialization = await reconcileMaterializations(env);
        console.info("Project OS scheduled maintenance completed", { inbox, materialization });
      } catch (error) {
        console.error("Project OS scheduled maintenance failed", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }
    })());
  }
} satisfies ExportedHandler<Env>;

export default worker;

interface RegistryProject {
  project_id: string;
}

async function rebuildSearchIndexes(request: Request, env: Env): Promise<Response> {
  if (!authorizedIngress(request, env)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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
    if (new Set(projectIds).size !== projectIds.length) {
      throw new Error("project_ids must be unique");
    }
  } catch (error) {
    return Response.json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid search rebuild request"
    }, { status: 400 });
  }

  const knownProjectIds = await registeredProjectIds(env);
  if (!knownProjectIds) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  for (const projectId of projectIds) {
    if (!knownProjectIds.has(projectId)) {
      return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
    }
  }

  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const projects: unknown[] = [];
  for (const projectId of projectIds) {
    const response = await searchIndex.fetch("https://search-index.internal/rebuild-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId })
    });
    if (!response.ok) {
      return Response.json({ error: "search_rebuild_failed", project_id: projectId, status: response.status }, { status: 502 });
    }
    projects.push(await response.json<unknown>());
  }

  return Response.json({ projects }, { status: 202 });
}

async function searchAdminStatus(request: Request, env: Env): Promise<Response> {
  if (!authorizedIngress(request, env)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const projectId = new URL(request.url).searchParams.get("project_id");
  if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
    return Response.json({ error: "invalid_project_id" }, { status: 400 });
  }

  const knownProjectIds = await registeredProjectIds(env);
  if (!knownProjectIds) return Response.json({ error: "registry_unavailable" }, { status: 502 });
  if (!knownProjectIds.has(projectId)) {
    return Response.json({ error: "project_not_found", project_id: projectId }, { status: 404 });
  }

  const projectGuard = env.PROJECT_GUARD.getByName(projectId);
  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const [sourceResponse, indexResponse, rebuildResponse] = await Promise.all([
    projectGuard.fetch("https://project-guard.internal/search-sync-status", { method: "GET" }),
    searchIndex.fetch(`https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`, { method: "GET" }),
    searchIndex.fetch(`https://search-index.internal/rebuild-status?project_id=${encodeURIComponent(projectId)}`, { method: "GET" })
  ]);

  if (!sourceResponse.ok || !indexResponse.ok || (rebuildResponse.status !== 404 && !rebuildResponse.ok)) {
    return Response.json({
      error: "search_status_unavailable",
      project_id: projectId,
      source_status: sourceResponse.status,
      index_status: indexResponse.status,
      rebuild_status: rebuildResponse.status
    }, { status: 502 });
  }

  return Response.json({
    project_id: projectId,
    source: await sourceResponse.json<unknown>(),
    index: await indexResponse.json<unknown>(),
    rebuild: rebuildResponse.ok ? await rebuildResponse.json<unknown>() : null
  });
}

async function registeredProjectIds(env: Env): Promise<Set<string> | null> {
  const registry = env.REGISTRY_GUARD.getByName("global");
  const response = await registry.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!response.ok) return null;
  const body = await response.json<{ projects: RegistryProject[] }>();
  return new Set(body.projects.map((project) => project.project_id));
}

function authorizedIngress(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return !!authorization && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`);
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

async function processInboxRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const base = await neutralWorker.fetch(request, env, ctx);
  if (!base.ok) return base;

  const existing = await base.json<InboxProcessSummary & Record<string, unknown>>();
  const referral = await processReferralInbox(env);
  return Response.json({
    ...existing,
    scanned: existing.scanned + referral.scanned,
    processed: existing.processed + referral.processed,
    failed: existing.failed + referral.failed
  });
}

async function processInboxFirst(env: Env, ctx: ExecutionContext): Promise<InboxProcessSummary> {
  const response = await processInboxRequest(new Request("https://project-os.internal/v1/admin/process-inbox", {
    method: "POST",
    headers: { authorization: `Bearer ${env.INGRESS_TOKEN}` }
  }), env, ctx);

  if (!response.ok) {
    throw new Error(`Project OS inbox processing returned ${response.status}`);
  }

  const summary = await response.json<InboxProcessSummary>();
  return {
    scanned: summary.scanned,
    processed: summary.processed,
    failed: summary.failed
  };
}
