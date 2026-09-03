import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { processDurableInbox } from "../inbox/runtime";
import { reconcileManagedDocuments } from "../index-neutral";

const REQUESTED_GENERATION_KEY = "dropbox-change-requested-generation-v1";
const COMPLETED_GENERATION_KEY = "dropbox-change-completed-generation-v1";
const PROCESSING_GENERATION_KEY = "dropbox-change-processing-generation-v1";
const LAST_ERROR_KEY = "dropbox-change-last-error-v1";
const FAILURE_COUNT_KEY = "dropbox-change-failure-count-v1";
const CHANGE_ALARM_DELAY_MS = 1_000;
const CHANGE_FAST_RETRY_LIMIT = 5;
const CHANGE_DEFER_DELAY_MS = 300_000;

export interface DropboxChangeGuardStatus {
  requested_generation: number;
  completed_generation: number;
  alarm_scheduled: boolean;
  alarm_at: number | null;
  processing_generation: number | null;
  last_error: string | null;
  failure_count: number;
}

export class DropboxChangeGuard extends DurableObject<Env> {
  private workQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, private readonly runtimeEnv: Env) {
    super(ctx, runtimeEnv);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/notify") {
      const requestedGeneration = await this.registerNotification();
      await this.ensureAlarm();
      const completedGeneration = await this.ctx.storage.get<number>(COMPLETED_GENERATION_KEY) ?? 0;
      return Response.json({
        status: "registered",
        requested_generation: requestedGeneration,
        completed_generation: completedGeneration
      });
    }

    if (request.method === "POST" && url.pathname === "/process-inbox") {
      return this.serializeWork(async () => Response.json(await processDurableInbox(this.runtimeEnv)));
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.status());
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    return this.serializeWork(() => this.reconcileChanges());
  }

  private async registerNotification(): Promise<number> {
    return this.ctx.storage.transaction(async (transaction) => {
      const requested = await transaction.get<number>(REQUESTED_GENERATION_KEY) ?? 0;
      const completed = await transaction.get<number>(COMPLETED_GENERATION_KEY) ?? 0;
      const processing = await transaction.get<number>(PROCESSING_GENERATION_KEY);

      // A burst of Dropbox webhooks represents one durable unit of pending work,
      // not one unit per callback. While a generation is already pending, avoid
      // rewriting the requested counter. If reconciliation is actively running,
      // preserve exactly one follow-up generation so changes arriving after its
      // provider cursor snapshot cannot be lost.
      let next = requested;
      if (processing !== undefined) {
        const followUp = processing + 1;
        if (requested < followUp) {
          next = followUp;
          await transaction.put(REQUESTED_GENERATION_KEY, next);
        }
      } else if (requested <= completed) {
        next = completed + 1;
        await transaction.put(REQUESTED_GENERATION_KEY, next);
      }
      return next;
    });
  }

  private async reconcileChanges(): Promise<void> {
    const requestedGeneration = await this.ctx.storage.get<number>(REQUESTED_GENERATION_KEY) ?? 0;
    const completedGeneration = await this.ctx.storage.get<number>(COMPLETED_GENERATION_KEY) ?? 0;
    if (requestedGeneration <= completedGeneration) {
      await this.ctx.storage.delete(PROCESSING_GENERATION_KEY);
      return;
    }

    const processingGeneration = requestedGeneration;
    await this.ctx.storage.put(PROCESSING_GENERATION_KEY, processingGeneration);

    try {
      const summary = await reconcileManagedDocuments(this.runtimeEnv);
      if (summary.projects_failed > 0) {
        throw new Error(`Managed-document fleet reconciliation failed for ${summary.projects_failed} project(s)`);
      }
      await this.ctx.storage.put(COMPLETED_GENERATION_KEY, processingGeneration);
      await this.ctx.storage.delete(LAST_ERROR_KEY);
      await this.ctx.storage.delete(FAILURE_COUNT_KEY);
    } catch (error) {
      const failureCount = (await this.ctx.storage.get<number>(FAILURE_COUNT_KEY) ?? 0) + 1;
      await this.ctx.storage.put(FAILURE_COUNT_KEY, failureCount);
      await this.ctx.storage.put(LAST_ERROR_KEY, errorMessage(error));
      await this.ctx.storage.delete(PROCESSING_GENERATION_KEY);
      const retryDelay = failureCount <= CHANGE_FAST_RETRY_LIMIT
        ? CHANGE_ALARM_DELAY_MS
        : CHANGE_DEFER_DELAY_MS;
      await this.ctx.storage.setAlarm(Date.now() + retryDelay);
      console.error("Project OS Dropbox change reconciliation deferred", {
        requested_generation: requestedGeneration,
        completed_generation: completedGeneration,
        failure_count: failureCount,
        retry_delay_ms: retryDelay,
        message: errorMessage(error)
      });
      return;
    }

    await this.ctx.storage.delete(PROCESSING_GENERATION_KEY);
    const latestRequested = await this.ctx.storage.get<number>(REQUESTED_GENERATION_KEY) ?? 0;
    const latestCompleted = await this.ctx.storage.get<number>(COMPLETED_GENERATION_KEY) ?? 0;
    if (latestRequested > latestCompleted) {
      await this.ctx.storage.setAlarm(Date.now() + CHANGE_ALARM_DELAY_MS);
    }
  }

  private async status(): Promise<DropboxChangeGuardStatus> {
    const [requestedGeneration, completedGeneration, alarm, processingGeneration, lastError, failureCount] = await Promise.all([
      this.ctx.storage.get<number>(REQUESTED_GENERATION_KEY),
      this.ctx.storage.get<number>(COMPLETED_GENERATION_KEY),
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get<number>(PROCESSING_GENERATION_KEY),
      this.ctx.storage.get<string>(LAST_ERROR_KEY),
      this.ctx.storage.get<number>(FAILURE_COUNT_KEY)
    ]);
    return {
      requested_generation: requestedGeneration ?? 0,
      completed_generation: completedGeneration ?? 0,
      alarm_scheduled: alarm !== null,
      alarm_at: alarm,
      processing_generation: processingGeneration ?? null,
      last_error: lastError ?? null,
      failure_count: failureCount ?? 0
    };
  }

  private async ensureAlarm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHANGE_ALARM_DELAY_MS);
    }
  }

  private async serializeWork<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.workQueue;
    let release!: () => void;
    this.workQueue = new Promise<void>((resolve) => { release = resolve; });
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
