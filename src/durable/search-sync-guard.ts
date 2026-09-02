import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

const SEARCH_SYNC_RETRY_DELAY_MS = 1_000;

/**
 * Owns only the durable wake/retry alarm for per-project search synchronization.
 * Canonical/search outbox state remains inside ProjectGuard; this guard merely
 * asks the bound ProjectGuard to drain one derived search unit at a time.
 */
export class SearchSyncGuard extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/wake") {
      return this.serialize(async () => {
        const projectId = this.ctx.id.name;
        if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
          return Response.json({ error: "invalid_project_id" }, { status: 400 });
        }
        await this.arm();
        return Response.json({ project_id: projectId, pending: true });
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      await this.ctx.storage.deleteAlarm();
      const projectId = this.ctx.id.name;
      if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) return;

      let moreWork = true;
      try {
        const response = await this.env.PROJECT_GUARD.getByName(projectId).fetch(
          "https://project-guard.internal/drain-search",
          { method: "POST" }
        );
        if (response.status === 404) {
          moreWork = false;
        } else if (!response.ok) {
          throw new Error(`ProjectGuard search drain returned ${response.status}`);
        } else {
          const body = await response.json<{ more_work?: unknown }>();
          moreWork = body.more_work === true;
        }
      } catch (error) {
        console.error("Project OS search synchronization drain failed", {
          project_id: projectId,
          message: error instanceof Error ? error.message : String(error)
        });
        moreWork = true;
      }

      if (moreWork) await this.arm();
    });
  }

  private async arm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + SEARCH_SYNC_RETRY_DELAY_MS);
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
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
