import type { Env } from "../env";
import { SearchSyncProjectGuard } from "./project-guard-search-sync";

/**
 * Production ProjectGuard request boundary for provider diagnostics.
 *
 * Provider client instances live for the Durable Object lifetime, so the request
 * counter must be reset at a top-level serialized ProjectGuard request, never
 * inside an individual provider operation such as download(). Serializing this
 * thin boundary also prevents a concurrent request from resetting another
 * request's diagnostic counter while it is performing provider I/O.
 */
export class DiagnosticProjectGuard extends SearchSyncProjectGuard {
  private diagnosticsQueue: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const correlationId = request.headers.get("x-project-os-correlation-id");
    const trace = correlationId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(correlationId)
      ? { correlation_id: correlationId, project_id: this.ctx.id.name ?? null, route: url.pathname }
      : null;
    if (trace) console.log("project_os_guard_received", trace);
    // These routes are observational and must remain available while a
    // provider-backed reconciliation holds the diagnostics counter. They do
    // not reset that counter, so they can safely bypass this outer queue.
    if (request.method === "GET" && ["/mutation-context", "/request-status", "/execution-status", "/receipt"].includes(url.pathname)) {
      try {
        const response = await super.fetch(request);
        if (trace) console.log("project_os_guard_finished", { ...trace, status: response.status, elapsed_ms: Date.now() - started });
        return response;
      } catch (error) {
        if (trace) console.warn("project_os_guard_failed", { ...trace, elapsed_ms: Date.now() - started });
        throw error;
      }
    }
    return this.serializeDiagnostics(async () => {
      if (trace) console.log("project_os_guard_acquired", { ...trace, queue_ms: Date.now() - started });
      this.persistence.diagnostics?.beginOperation(`ProjectGuard ${request.method} ${url.pathname}`);
      try {
        const response = await super.fetch(request);
        if (trace) console.log("project_os_guard_finished", { ...trace, status: response.status, elapsed_ms: Date.now() - started });
        return response;
      } catch (error) {
        if (trace) console.warn("project_os_guard_failed", { ...trace, elapsed_ms: Date.now() - started });
        throw error;
      }
    });
  }

  private async serializeDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.diagnosticsQueue;
    let release!: () => void;
    this.diagnosticsQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
