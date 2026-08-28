import type { Env } from "./env";
import { artifactInboxPath, inboxPath, type InboxProcessSummary } from "./inbox/processor";
import neutralWorker, {
  reconcileManagedDocuments,
  reconcileMaterializations
} from "./index-neutral";
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

      ctx.waitUntil((async () => {
        await processInboxFirst(env, ctx);
        await reconcileManagedDocuments(env);
      })());
      return new Response("", { status: 200 });
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
        const [materialization, documents] = await Promise.all([
          reconcileMaterializations(env),
          reconcileManagedDocuments(env)
        ]);
        console.info("Project OS scheduled maintenance completed", { inbox, materialization, documents });
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

async function processInboxFirst(env: Env, ctx: ExecutionContext): Promise<InboxProcessSummary> {
  const response = await neutralWorker.fetch(new Request("https://project-os.internal/v1/admin/process-inbox", {
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
