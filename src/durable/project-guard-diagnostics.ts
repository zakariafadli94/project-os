import type { Env } from "../env";
import { SubrequestResilientProjectGuard } from "./project-guard-subrequest-resilient";

/**
 * Production ProjectGuard request boundary for provider diagnostics.
 *
 * Provider client instances live for the Durable Object lifetime, so the request
 * counter must be reset at a top-level serialized ProjectGuard request, never
 * inside an individual provider operation such as download(). Serializing this
 * thin boundary also prevents a concurrent request from resetting another
 * request's diagnostic counter while it is performing provider I/O.
 */
export class DiagnosticProjectGuard extends SubrequestResilientProjectGuard {
  private diagnosticsQueue: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    return this.serializeDiagnostics(async () => {
      const url = new URL(request.url);
      this.persistence.diagnostics?.beginOperation(`ProjectGuard ${request.method} ${url.pathname}`);
      return super.fetch(request);
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
