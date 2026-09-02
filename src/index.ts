import type { Env } from "./env";
import type { DurableInboxProcessSummary } from "./inbox/runtime";
import { artifactInboxPath, inboxPath } from "./inbox/processor";
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
      const handoffStatus = handoff.status;
      await handoff.text();
      if (!handoff.ok) {
        console.error("Project OS Dropbox webhook durable handoff failed", { status: handoffStatus });
        return Response.json({ error: "durable_change_handoff_failed" }, { status: 503 });
      }

      ctx.waitUntil(processInboxThroughGuard(env).catch((error) => {
        console.error("Project OS webhook inbox processing failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }));
      return new Response("", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/process-inbox") {
      if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
      try {
        return Response.json(await processInboxThroughGuard(env));
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
        const inbox = await processInboxThroughGuard(env);
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

async function processInboxThroughGuard(env: Env): Promise<DurableInboxProcessSummary> {
  const response = await env.DROPBOX_CHANGE_GUARD.getByName("global").fetch(
    "https://dropbox-change-guard.internal/process-inbox",
    { method: "POST" }
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`DropboxChangeGuard inbox processing returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as DurableInboxProcessSummary;
}

function authorized(request: Request, env: Env): boolean {
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
