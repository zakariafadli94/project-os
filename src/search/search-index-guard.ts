import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { CanonicalSnapshotRequest, DocumentBatchRequest } from "./contract";
import { initializeSearchIndexSchema, SearchIndexStore } from "./sqlite-store";

export class SearchIndexGuard extends DurableObject<Env> {
  private readonly store: SearchIndexStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSearchIndexSchema(ctx.storage);
    this.store = new SearchIndexStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/status") {
        const projectId = url.searchParams.get("project_id");
        if (!projectId) return Response.json({ error: "invalid_project_id" }, { status: 400 });
        return Response.json(this.store.status(projectId));
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

      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const message = errorMessage(error);
      return Response.json({ error: errorCode(message), message }, { status: conflictStatus(message) });
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
  ) return 409;
  return 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
