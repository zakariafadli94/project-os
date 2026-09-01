import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  parseSearchQuery,
  type CanonicalSnapshotRequest,
  type DocumentBatchRequest
} from "./contract";
import { SearchRebuildCoordinator } from "./rebuild";
import { initializeSearchIndexSchema, SearchIndexStore } from "./sqlite-store";

const REBUILD_ALARM_DELAY_MS = 1_000;

export class SearchIndexGuard extends DurableObject<Env> {
  private readonly store: SearchIndexStore;
  private readonly rebuild: SearchRebuildCoordinator;
  private readonly state: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    initializeSearchIndexSchema(ctx.storage);
    this.store = new SearchIndexStore(ctx.storage);
    this.rebuild = new SearchRebuildCoordinator(ctx.storage, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/status") {
        const projectId = url.searchParams.get("project_id");
        if (!projectId) return Response.json({ error: "invalid_project_id" }, { status: 400 });
        return Response.json(this.store.status(projectId));
      }

      if (request.method === "GET" && url.pathname === "/rebuild-status") {
        const projectId = url.searchParams.get("project_id");
        if (!projectId) return Response.json({ error: "invalid_project_id" }, { status: 400 });
        const status = this.rebuild.status(projectId);
        if (!status) return Response.json({ error: "rebuild_not_found" }, { status: 404 });
        return Response.json(status);
      }

      if (request.method === "POST" && url.pathname === "/rebuild-project") {
        const body = await request.json() as { project_id?: unknown };
        if (
          !body
          || typeof body !== "object"
          || typeof body.project_id !== "string"
          || Object.keys(body).some((key) => key !== "project_id")
        ) {
          return Response.json({ error: "invalid_rebuild_request" }, { status: 400 });
        }
        const status = await this.rebuild.start(body.project_id);
        await this.ensureRebuildAlarm();
        return Response.json(status, { status: 202 });
      }

      if (request.method === "POST" && url.pathname === "/apply-canonical") {
        const body = await request.json() as CanonicalSnapshotRequest;
        const result = this.store.applyCanonical(body);
        return Response.json({ ...result, project: this.store.status(body.project_id) });
      }

      if (request.method === "POST" && url.pathname === "/apply-documents") {
        const body = await request.json() as DocumentBatchRequest;
        const result = this.store.applyDocuments(body);
        return Response.json({ ...result, project: this.store.status(body.project_id) });
      }

      if (request.method === "POST" && url.pathname === "/search") {
        const query = parseSearchQuery(await request.json());
        return Response.json({ hits: this.store.search(query) });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const message = errorMessage(error);
      return Response.json({ error: errorCode(message), message }, { status: conflictStatus(message) });
    }
  }

  async alarm(): Promise<void> {
    await this.rebuild.runNext();
    await this.ensureRebuildAlarm();
  }

  private async ensureRebuildAlarm(): Promise<void> {
    if (!this.rebuild.hasRunnableWork()) return;
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + REBUILD_ALARM_DELAY_MS);
    }
  }
}

function errorCode(message: string): string {
  const match = /^([A-Z][A-Z0-9_]+)$/.exec(message);
  return match?.[1] ?? "SEARCH_INDEX_REQUEST_FAILED";
}

function conflictStatus(message: string): number {
  if (
    message.includes("MISMATCH")
    || message.includes("GAP")
    || message.includes("STALE")
    || message.includes("REQUIRES")
    || message.includes("NOT_INITIALIZED")
    || message.includes("SOURCE_CHANGED")
  ) return 409;
  return 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
