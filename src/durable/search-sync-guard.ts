import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { searchSyncEnabled } from "../search/sync-mode";

const FAILURE_COUNT_KEY = "search-sync-failure-count-v1";
const SEARCH_SYNC_RETRY_DELAY_MS = 1_000;
const SEARCH_SYNC_FAST_RETRY_LIMIT = 5;
const SEARCH_SYNC_DEFER_DELAY_MS = 300_000;

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
        if (!searchSyncEnabled(this.env)) {
          return Response.json({ project_id: projectId, pending: false, sync_enabled: false });
        }
        await this.armIfAbsent(SEARCH_SYNC_RETRY_DELAY_MS);
        return Response.json({ project_id: projectId, pending: true, sync_enabled: true });
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      await this.ctx.storage.deleteAlarm();
      if (!searchSyncEnabled(this.env)) return;

      const projectId = this.ctx.id.name;
      if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) return;

      let moreWork = false;
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
        const failureCount = (await this.ctx.storage.get<number>(FAILURE_COUNT_KEY) ?? 0) + 1;
        await this.ctx.storage.put(FAILURE_COUNT_KEY, failureCount);
        const retryDelay = failureCount <= SEARCH_SYNC_FAST_RETRY_LIMIT
          ? SEARCH_SYNC_RETRY_DELAY_MS
          : SEARCH_SYNC_DEFER_DELAY_MS;
        await this.ctx.storage.setAlarm(Date.now() + retryDelay);
        console.error("Project OS search synchronization drain deferred", {
          project_id: projectId,
          failure_count: failureCount,
          retry_delay_ms: retryDelay,
          message: errorMessage(error)
        });
        return;
      }

      await this.ctx.storage.delete(FAILURE_COUNT_KEY);
      if (moreWork) {
        await this.ctx.storage.setAlarm(Date.now() + SEARCH_SYNC_RETRY_DELAY_MS);
      }
    });
  }

  private async armIfAbsent(delayMs: number): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_048);
}
